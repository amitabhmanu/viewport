import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuiz, claimJob, enqueueJob, finishJob, initWorkspace, openState, readModel, recentAnswers, recentJobs, viewportPaths, writeModelFromAgent, writeQuizItems } from "@viewport/core";
import { afterEach, describe, expect, it } from "vitest";
import { type Worker, failureDetail, jobEnv, readModelFor, startWorker } from "./worker.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../../../", import.meta.url));
const FILES = {
  explainFiles: [join(PLUGIN, "agents/viewport-explainer.md"), join(PLUGIN, "skills/viewport-explaining/SKILL.md")],
  gradeFiles: [join(PLUGIN, "agents/viewport-grader.md")],
};

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "viewport-worker-"));
  await cp(FIXTURE, root, { recursive: true });
  await initWorkspace(root);
  await writeModelFromAgent(root, {
    nodes: [
      { kind: "system", id: "shop", name: "Shop", purpose: "Take orders" },
      { kind: "container", id: "app", name: "App", role: "Runs the shop" },
      { kind: "component", id: "app.orders", name: "Orders", role: "Order lifecycle", paths: ["src/shop/orders/**"] },
    ],
    edges: [
      { kind: "contains", from: "shop", to: "app" },
      { kind: "contains", from: "app", to: "app.orders" },
    ],
  });
  return root;
}

const jobs = (root: string) => {
  const db = openState(viewportPaths(root).stateDb);
  try {
    return recentJobs(db);
  } finally {
    db.close();
  }
};

let worker: Worker | undefined;
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  delete process.env.FAKE_CLAUDE_FAIL;
});

describe("worker", () => {
  it("runs an explain job through claude -p and stores what comes back", async () => {
    const root = await workspace();
    const log = join(root, "claude.log");
    process.env.FAKE_CLAUDE_LOG = log;
    const db = openState(viewportPaths(root).stateDb);
    enqueueJob(db, "explain", { subjects: ["app.orders", "app"] });
    db.close();
    worker = startWorker(root, { command: [process.execPath, FAKE], ...FILES });
    await expect.poll(() => jobs(root)[0]?.status, { timeout: 10_000 }).toBe("done");

    const model = await readModel(viewportPaths(root).model);
    expect(model.nodes.find((n) => n.id === "app.orders")?.takeaways).toEqual({ simple: "app.orders simply", medium: "app.orders in context", complex: "app.orders in depth" });
    const check = openState(viewportPaths(root).stateDb);
    expect((check.prepare("SELECT COUNT(*) AS n FROM quiz_items").get() as { n: number }).n).toBe(2);
    check.close();

    const call = JSON.parse((await readFile(log, "utf8")).trim()) as { args: string[]; job: string };
    expect(call.job).toBe("1");
    expect(call.args).toEqual(expect.arrayContaining(["-p", "--json-schema", "--tools", "Read,Grep,Glob", "--allowed-tools", "Read,Grep,Glob"]));
    expect(call.args[call.args.indexOf("--append-system-prompt") + 1]).toContain("Explaining a system to its owner");
  });

  it("marks a job failed when claude fails, and keeps going", async () => {
    const root = await workspace();
    process.env.FAKE_CLAUDE_FAIL = "1";
    const db = openState(viewportPaths(root).stateDb);
    enqueueJob(db, "explain", { subjects: ["app.orders"] });
    enqueueJob(db, "nonsense", {});
    db.close();
    worker = startWorker(root, { command: [process.execPath, FAKE], ...FILES });
    await expect.poll(() => jobs(root).map((j) => j.status), { timeout: 10_000 }).toEqual(["failed", "failed"]);
    expect(jobs(root).map((j) => j.error)).toEqual(["unknown job kind 'nonsense'", expect.stringContaining("exited with 2: boom")]);
  });

  it("grades written answers, takes a second look with the code for partial or wrong, and reschedules", async () => {
    const root = await workspace();
    const log = join(root, "claude.log");
    process.env.FAKE_CLAUDE_LOG = log;
    const db = openState(viewportPaths(root).stateDb);
    const ids = writeQuizItems(db, [1, 2, 3].map((n) => ({ subject: "app.orders", kind: "why" as const, question: `Why ${n}?`, answer: "It needs the stock count." })));
    const answered = new Date(Date.now() - 60_000);
    answerQuiz(db, ids[0]!, "you're right, stock", 4, answered);
    answerQuiz(db, ids[1]!, "in the code it waits for stock", 3, answered);
    const left = answerQuiz(db, ids[2]!, "no idea", 1, answered);
    // As if the daemon stopped before this one was graded: the worker queues it again at start.
    finishJob(db, claimJob(db)!.id);
    finishJob(db, claimJob(db)!.id);
    finishJob(db, claimJob(db)!.id);
    enqueueJob(db, "grade", { answerId: left.answerId - 2 });
    enqueueJob(db, "grade", { answerId: left.answerId - 1 });
    db.close();

    worker = startWorker(root, { command: [process.execPath, FAKE], ...FILES });
    const graded = () => {
      const check = openState(viewportPaths(root).stateDb);
      try {
        return recentAnswers(check).map((a) => [a.question, a.grade, a.feedback]);
      } finally {
        check.close();
      }
    };
    await expect.poll(graded, { timeout: 10_000 }).toEqual([
      ["Why 3?", "wrong", "Second look: wrong."],
      ["Why 2?", "correct", "Second look: correct."],
      ["Why 1?", "correct", "First look: correct."],
    ]);
    const check = openState(viewportPaths(root).stateDb);
    const steps = check.prepare("SELECT step FROM quiz_items ORDER BY id").all().map((r) => (r as { step: number }).step);
    expect(steps).toEqual([1, 1, 0]);
    expect(recentAnswers(check)[0]?.expected).toBe("It needs the stock count.");
    check.close();

    const calls = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { args: string[] });
    expect(calls).toHaveLength(5);
    const tools = calls.map((c) => c.args[c.args.indexOf("--tools") + 1]);
    expect(tools.filter((t) => t === "")).toHaveLength(3);
    expect(tools.filter((t) => t === "Read,Grep,Glob")).toHaveLength(2);
    expect(calls[0]!.args[calls[0]!.args.indexOf("--append-system-prompt") + 1]).toContain("Grading an explain-back answer");
  });
});

describe("job failures", () => {
  it("reports Claude Code's own error from stdout, not just the warnings on stderr", () => {
    const stdout = JSON.stringify({ type: "result", is_error: true, result: "Credit balance is too low" });
    expect(failureDetail(stdout, "⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY is set\n")).toBe(
      "Credit balance is too low | ⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY is set",
    );
    expect(failureDetail("", "boom")).toBe("boom");
    expect(failureDetail("", "")).toBe("no output");
  });

  it("drops ANTHROPIC_API_KEY for jobs only when asked to use the login", () => {
    expect(jobEnv({ ANTHROPIC_API_KEY: "k" })).toEqual({ ANTHROPIC_API_KEY: "k", VIEWPORT_JOB: "1" });
    expect(jobEnv({ ANTHROPIC_API_KEY: "k", VIEWPORT_JOBS_USE_LOGIN: "1" })).toEqual({ VIEWPORT_JOBS_USE_LOGIN: "1", VIEWPORT_JOB: "1" });
  });

  it("says so when the model is newer than the daemon", async () => {
    const root = await workspace();
    const path = viewportPaths(root).model;
    const model = JSON.parse(await readFile(path, "utf8")) as { version: number };
    await writeFile(path, JSON.stringify({ ...model, version: 99 }));
    await expect(readModelFor(path)).rejects.toThrow("the model is version 99, but this daemon is older than that and reads up to version 2");
  });
});
