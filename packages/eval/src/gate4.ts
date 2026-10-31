// The Phase 4 gate, end to end. Claude builds a feature with the plugin while a
// simulated reviewer uses the viewer's API, as the developer would: it flags a part
// after Claude's first edit and guesses at each new decision. When the build stops,
// the daemon's worker writes takeaways and questions; the reviewer answers them, and
// the grader grades the written ones. Costs tokens: run by hand, never in CI. Needs
// `pnpm build` first. Grader agreement, the gate's third check, is `pnpm eval:grader`.
//
//   pnpm eval:gate4 [--task py-shipping] [--model sonnet] [--out DIR]
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { type Flag, type Prediction, initWorkspace, readLedger, viewportPaths, writeModelFromAgent } from "@viewport/core";
import { startDaemon } from "@viewport/viewportd";
import { BASELINES } from "./baselines.js";
import { editsBeforeAnswer } from "./score.js";
import { TASKS } from "./tasks.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
/** A flag raised mid-build must be answered within this many of Claude's edits after it. */
const FLAG_EDITS = 2;
const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "Task", "Agent", "Skill", "mcp__plugin_viewport_viewport"];

// The harness runs its own daemon, with the worker on; the session must not start another.
process.env.VIEWPORT_NO_DAEMON = "1";

const { values } = parseArgs({
  options: {
    task: { type: "string", default: "py-shipping" },
    model: { type: "string", default: "sonnet" },
    out: { type: "string" },
  },
});
const task = TASKS.find((t) => t.id === values.task);
if (!task) throw new Error(`unknown task '${values.task}'`);
const out = values.out ?? join(REPO, "eval", "results", `gate4-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(out, { recursive: true });

const root = await mkdtemp(join(tmpdir(), `viewport-gate4-${task.id}-`));
await cp(join(REPO, "fixtures", task.fixture), root, { recursive: true, filter: (src) => !src.includes("__pycache__") });
const git = (...args: string[]) => exec("git", ["-c", "user.email=eval@viewport", "-c", "user.name=eval", ...args], { cwd: root });
await git("init", "-q");
await initWorkspace(root);
await writeModelFromAgent(root, BASELINES[task.fixture]);
await git("add", "-A");
await git("commit", "-qm", "fixture");
const paths = viewportPaths(root);

const daemon = await startDaemon(root, {
  worker: {
    model: values.model,
    explainFiles: [join(REPO, "agents/viewport-explainer.md"), join(REPO, "skills/viewport-explaining/SKILL.md")],
    gradeFiles: [join(REPO, "agents/viewport-grader.md")],
  },
});
const api = async <T>(path: string, body?: object): Promise<T> => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${daemon.token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};
const read = <T>(sql: string, ...args: (string | number)[]): T[] => {
  const db = new DatabaseSync(paths.stateDb, { readOnly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
};
const log = (line: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

// The reviewer: one flag after Claude's first edit, and a guess at every new decision.
let flag: Flag | undefined;
let reviewing = true;
const guessed = new Set<string>();
const reviewer = (async () => {
  while (reviewing) {
    const edits = read<{ subject: string }>("SELECT subject FROM events WHERE kind = 'edit' ORDER BY id");
    if (flag === undefined && edits.length > 0) {
      flag = await api<Flag>("/api/flags", { subject: "app.orders", text: "How does an order reach the shipped state, and who sends the shipping email?" });
      log(`flagged app.orders after edit to ${edits[0]!.subject}`);
    }
    for (const d of await readLedger(paths.ledger)) {
      if (guessed.has(d.id)) continue;
      guessed.add(d.id);
      const guess = d.options[d.options.length - 1]!.name;
      const p = await api<Prediction>("/api/predictions", { decisionId: d.id, guess });
      log(`guessed ${guess} for ${d.id} (${d.title}): ${p.correct ? "right" : "wrong"}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
})();

log(`building '${task.id}' in ${root}`);
const started = Date.now();
const args = ["-p", "--model", values.model, "--output-format", "stream-json", "--verbose", "--allowedTools", ...ALLOWED_TOOLS, "--plugin-dir", REPO, "--", task.prompt];
const { stdout } = await exec("claude", args, { cwd: root, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
await writeFile(join(out, "session.jsonl"), stdout);
reviewing = false;
await reviewer;
log(`build finished in ${Math.round((Date.now() - started) / 1000)}s`);

// Flag latency: the edits Claude made after it could see the flag, up to its answer.
const flags = read<{ id: number; status: string; at: string; resolved_at: string | null; answer: string | null }>("SELECT * FROM flags ORDER BY id");
const answered = flags[0];
const flagEvent = read<{ id: number }>("SELECT id FROM events WHERE kind = 'flag' ORDER BY id LIMIT 1")[0];
const editsBefore = answered?.resolved_at && flagEvent ? editsBeforeAnswer(stdout, read<{ id: number }>("SELECT id FROM events WHERE kind = 'edit' ORDER BY id").map((e) => e.id), flagEvent.id) : undefined;

// After the build: wait for the explainer, then answer every question as a reviewer would.
const settle = async (what: string, limitMs: number) => {
  const until = Date.now() + limitMs;
  while (read("SELECT id FROM jobs WHERE status IN ('queued', 'running')").length > 0) {
    if (Date.now() > until) throw new Error(`${what} still running after ${limitMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
await settle("explain jobs", 15 * 60_000);
const items = read<{ id: number; subject: string; kind: string; question: string; choices: string | null; answer: string | null }>("SELECT * FROM quiz_items ORDER BY id");
log(`explainer wrote ${items.length} questions`);
for (const [i, item] of items.entries()) {
  // Half the written answers paraphrase the key, half are guesses, so both grades show up.
  const answer = item.choices ? (JSON.parse(item.choices) as string[])[0]! : i % 2 === 0 ? `I think: ${item.answer}` : "Not sure, probably for performance.";
  await api("/api/quiz", { itemId: item.id, answer, confidence: i % 2 === 0 ? 4 : 2 });
}
await settle("grade jobs", 15 * 60_000);
await daemon.close();

const quiz = read<{ kind: string; grade: string | null; feedback: string | null; question: string; answer: string }>(
  "SELECT i.kind, a.grade, a.feedback, i.question, a.answer FROM quiz_answers a JOIN quiz_items i ON i.id = a.item_id ORDER BY a.id",
);
const predictions = read<{ decision_id: string; correct: number | null }>("SELECT decision_id, correct FROM predictions");
const jobs = read<{ kind: string; status: string; error: string | null }>("SELECT kind, status, error FROM jobs");
const checks = [
  { name: "Predictions recorded for new decisions", pass: predictions.length > 0, detail: `${predictions.length} of ${guessed.size} decisions` },
  {
    name: `Mid-build flag answered within ${FLAG_EDITS} edits`,
    pass: editsBefore !== undefined && editsBefore <= FLAG_EDITS,
    detail: answered?.resolved_at ? `answered after ${editsBefore} edit(s): "${answered.answer?.slice(0, 160)}"` : `not answered (status ${answered?.status ?? "never raised"})`,
  },
  { name: "Quiz questions written by the explainer", pass: items.length > 0, detail: `${items.length} questions` },
  {
    name: "Every quiz answer graded",
    pass: quiz.length > 0 && quiz.every((q) => q.grade !== null),
    detail: `${quiz.filter((q) => q.grade).length} of ${quiz.length} graded; ${jobs.filter((j) => j.status === "failed").length} failed jobs`,
  },
];
const pass = checks.every((c) => c.pass);
const summary = [
  `# Phase 4 gate: ${task.id} with ${values.model}: ${pass ? "PASS" : "FAIL"}`,
  "",
  ...checks.map((c) => `- ${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`),
  "- Grader agreement with the labelled set: run `pnpm eval:grader` (gate: 80%)",
  "",
  "## Answers and grades",
  ...quiz.map((q) => `- [${q.kind}] ${q.question}\n  - answer: ${q.answer}\n  - grade: ${q.grade ?? "none"}${q.feedback ? `: ${q.feedback}` : ""}`),
  "",
  `Failed jobs: ${JSON.stringify(jobs.filter((j) => j.status === "failed"))}`,
].join("\n");
await cp(paths.dir, join(out, "viewport"), { recursive: true, filter: (src) => !src.endsWith(".db-wal") && !src.endsWith(".db-shm") });
await writeFile(join(out, "summary.md"), `${summary}\n`);
console.log(summary);
process.exitCode = pass ? 0 : 1;

