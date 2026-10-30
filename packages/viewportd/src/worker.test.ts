import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enqueueJob, initWorkspace, openState, readModel, recentJobs, viewportPaths, writeModelFromAgent } from "@viewport/core";
import { afterEach, describe, expect, it } from "vitest";
import { type Worker, startWorker } from "./worker.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../../../", import.meta.url));
const EXPLAINER = [join(PLUGIN, "agents/viewport-explainer.md"), join(PLUGIN, "skills/viewport-explaining/SKILL.md")];

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
    worker = startWorker(root, { command: [process.execPath, FAKE], explainFiles: EXPLAINER });
    await expect.poll(() => jobs(root)[0]?.status, { timeout: 10_000 }).toBe("done");

    const model = await readModel(viewportPaths(root).model);
    expect(model.nodes.find((n) => n.id === "app.orders")?.takeaways).toEqual({ simple: "app.orders simply", medium: "app.orders in context", complex: "app.orders in depth" });
    const check = openState(viewportPaths(root).stateDb);
    expect((check.prepare("SELECT COUNT(*) AS n FROM quiz_items").get() as { n: number }).n).toBe(2);
    check.close();

    const call = JSON.parse((await readFile(log, "utf8")).trim()) as { args: string[]; job: string };
    expect(call.job).toBe("1");
    expect(call.args).toEqual(expect.arrayContaining(["-p", "--json-schema", "--allowed-tools", "Read,Grep,Glob"]));
    expect(call.args[call.args.indexOf("--append-system-prompt") + 1]).toContain("Explaining a system to its owner");
  });

  it("marks a job failed when claude fails, and keeps going", async () => {
    const root = await workspace();
    process.env.FAKE_CLAUDE_FAIL = "1";
    const db = openState(viewportPaths(root).stateDb);
    enqueueJob(db, "explain", { subjects: ["app.orders"] });
    enqueueJob(db, "nonsense", {});
    db.close();
    worker = startWorker(root, { command: [process.execPath, FAKE], explainFiles: EXPLAINER });
    await expect.poll(() => jobs(root).map((j) => j.status), { timeout: 10_000 }).toEqual(["failed", "failed"]);
    expect(jobs(root).map((j) => j.error)).toEqual(["unknown job kind 'nonsense'", expect.stringContaining("exited with 2: boom")]);
  });
});
