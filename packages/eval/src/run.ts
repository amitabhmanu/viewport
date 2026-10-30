// Runs the scripted build tasks headless with Claude Code, with and without the
// plugin, and scores them against the Phase 2 gate. Costs tokens: run by hand or
// nightly, never in CI. Needs `pnpm build` first.
//
//   pnpm eval [--tasks py-refunds,ts-sharing] [--model sonnet] [--repeat 2] [--parallel 3] [--no-baseline] [--out DIR]
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { initWorkspace, readConfig, readLedger, readModel, verify, viewportPaths, writeModelFromAgent } from "@viewport/core";
import { BASELINES } from "./baselines.js";
import { type RunScore, formatSummary, gate, leftoverFindings, matchDecisions, totalTokens } from "./score.js";
import { type EvalTask, TASKS } from "./tasks.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);

const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "Task", "Agent", "Skill", "mcp__plugin_viewport_viewport"];

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  modelUsage?: Record<string, object>;
}

async function prepare(task: EvalTask, withViewport: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `viewport-eval-${task.id}-`));
  await cp(join(REPO, "fixtures", task.fixture), dir, { recursive: true, filter: (src) => !src.includes("__pycache__") });
  const git = (...args: string[]) => exec("git", ["-c", "user.email=eval@viewport", "-c", "user.name=eval", ...args], { cwd: dir });
  await git("init", "-q");
  if (withViewport) {
    await initWorkspace(dir);
    await writeModelFromAgent(dir, BASELINES[task.fixture]);
  }
  await git("add", "-A");
  await git("commit", "-qm", "fixture");
  return dir;
}

async function claude(dir: string, task: EvalTask, model: string, plugin: boolean): Promise<ClaudeResult> {
  const args = ["-p", "--model", model, "--output-format", "json", "--allowedTools", ...ALLOWED_TOOLS];
  if (plugin) args.push("--plugin-dir", REPO);
  args.push("--", task.prompt);
  const { stdout } = await exec("claude", args, { cwd: dir, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout) as ClaudeResult;
}

function hookTimes(dir: string): number[] {
  const db = new DatabaseSync(viewportPaths(dir).stateDb, { readOnly: true });
  try {
    const rows = db.prepare("SELECT json_extract(payload, '$.ms') AS ms FROM events WHERE kind = 'edit'").all() as { ms: number | null }[];
    return rows.map((r) => r.ms).filter((ms): ms is number => typeof ms === "number");
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function runTask(task: EvalTask, model: string, baseline: boolean, out: string, label: string): Promise<RunScore> {
  const score: RunScore = { task: label, ok: false, decisions: [], logged: 0, leftover: [], hookMs: [], tokens: 0, costUsd: 0 };
  try {
    const dir = await prepare(task, true);
    const result = await claude(dir, task, model, true);
    await writeFile(join(out, `${label}.json`), JSON.stringify(result, null, 2));
    const paths = viewportPaths(dir);
    const ledger = await readLedger(paths.ledger);
    const report = await verify(dir, await readModel(paths.model), await readConfig(paths.config));
    await cp(paths.dir, join(out, `${label}-viewport`), { recursive: true, filter: (src) => !src.endsWith(".db-wal") && !src.endsWith(".db-shm") });
    Object.assign(score, {
      ok: result.is_error !== true,
      decisions: matchDecisions(task.expected, ledger),
      logged: ledger.length,
      leftover: leftoverFindings(report),
      hookMs: hookTimes(dir),
      tokens: totalTokens(result as never),
      costUsd: result.total_cost_usd ?? 0,
    });
    await rm(dir, { recursive: true, force: true });

    if (baseline) {
      const plain = await prepare(task, false);
      const base = await claude(plain, task, model, false);
      score.baselineTokens = totalTokens(base as never);
      score.baselineCostUsd = base.total_cost_usd ?? 0;
      await rm(plain, { recursive: true, force: true });
    }
  } catch (err) {
    score.error = err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err);
  }
  return score;
}

const { values } = parseArgs({
  options: {
    tasks: { type: "string" },
    model: { type: "string", default: "sonnet" },
    // Token use varies a lot between runs of the same task; repeats steady the overhead figure.
    repeat: { type: "string", default: "1" },
    // Too many sessions at once load the machine and inflate hook times.
    parallel: { type: "string", default: "3" },
    "no-baseline": { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const chosen = values.tasks === undefined ? TASKS : TASKS.filter((t) => values.tasks!.split(",").includes(t.id));
if (chosen.length === 0) throw new Error(`no tasks match '${values.tasks}'; known: ${TASKS.map((t) => t.id).join(", ")}`);
const out = values.out ?? join(REPO, "eval", "results", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(out, { recursive: true });
await readFile(join(REPO, "hooks", "dist", "post-tool-use.mjs")).catch(() => {
  throw new Error("hooks are not built; run pnpm build first");
});

console.log(`Running ${chosen.length} task(s) x${values.repeat} with ${values.model}${values["no-baseline"] ? "" : " and a no-plugin baseline"} -> ${out}`);
const repeat = Math.max(1, Number(values.repeat));
const jobs = chosen.flatMap((t) => Array.from({ length: repeat }, (_, i) => ({ task: t, label: repeat > 1 ? `${t.id}-${i + 1}` : t.id })));
const runs: RunScore[] = new Array(jobs.length);
let next = 0;
const worker = async () => {
  for (let i = next++; i < jobs.length; i = next++) runs[i] = await runTask(jobs[i]!.task, values.model, !values["no-baseline"], out, jobs[i]!.label);
};
await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, worker));
const result = gate(runs);
const summary = formatSummary(runs, result);
await writeFile(join(out, "summary.md"), summary);
await writeFile(join(out, "scores.json"), JSON.stringify({ model: values.model, runs, gate: result }, null, 2));
console.log(summary);
process.exitCode = result.pass ? 0 : 1;
