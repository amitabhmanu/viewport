import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  ExplainOutput,
  type Job,
  applyExplanation,
  claimJob,
  explainJsonSchema,
  explainPrompt,
  finishJob,
  openState,
  readLedger,
  readModel,
  requeueStale,
  viewportPaths,
} from "@viewport/core";

export interface WorkerOptions {
  /** The Claude Code command line to run, before its arguments. Defaults to `claude`, or VIEWPORT_CLAUDE. */
  command?: string[];
  model?: string;
  timeoutMs?: number;
  /** The explainer's instructions: agents/viewport-explainer.md and skills/viewport-explaining/SKILL.md. */
  explainFiles: string[];
}

export interface Worker {
  /** Looks for queued work now, rather than at the next tick. */
  kick(): void;
  stop(): Promise<void>;
}

const TICK_MS = 5_000;

/**
 * Runs Viewport's background jobs one at a time, each as a headless `claude -p` with
 * structured output and read-only tools. Jobs left running by a stopped daemon are
 * requeued at start. A job that fails or times out is marked failed and not retried.
 */
export function startWorker(root: string, options: WorkerOptions): Worker {
  const paths = viewportPaths(root);
  // One connection for the worker's life: opening and closing state.db per check would
  // create and remove its -wal and -shm files, which the daemon's watcher sees as new work.
  const db = openState(paths.stateDb);
  requeueStale(db);

  let busy: Promise<void> | undefined;
  let stopped = false;
  const loop = async () => {
    for (let job = claimJob(db); job && !stopped; job = claimJob(db)) {
      const current = job;
      try {
        await run(current);
        finishJob(db, current.id);
      } catch (err) {
        finishJob(db, current.id, err instanceof Error ? err.message : String(err));
      }
    }
  };
  const kick = () => {
    if (busy || stopped) return;
    // A locked or unreadable state.db waits for the next tick rather than stopping the daemon.
    busy = loop()
      .catch(() => undefined)
      .finally(() => {
        busy = undefined;
      });
  };

  const run = async (job: Job) => {
    if (job.kind !== "explain") throw new Error(`unknown job kind '${job.kind}'`);
    const subjects = (job.payload.subjects as string[] | undefined) ?? [];
    const [model, ledger] = await Promise.all([readModel(paths.model), readLedger(paths.ledger)]);
    const system = (await Promise.all(options.explainFiles.map((f) => readFile(f, "utf8")))).map((t) => t.replace(/^---[\s\S]*?---\n/, "").trim()).join("\n\n");
    const output = await claude(root, options, explainPrompt(model, ledger, subjects), explainJsonSchema(), system);
    await applyExplanation(paths.model, db, ledger, subjects, ExplainOutput.parse(output));
  };

  const timer = setInterval(kick, TICK_MS);
  timer.unref();
  kick();
  return {
    kick,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await busy;
      db.close();
    },
  };
}

/** One headless run: prompt on stdin, JSON on stdout, structured output checked against `schema`. */
async function claude(root: string, options: WorkerOptions, prompt: string, schema: object, system: string): Promise<unknown> {
  const [cmd, ...pre] = options.command ?? (process.env.VIEWPORT_CLAUDE ? [process.env.VIEWPORT_CLAUDE] : ["claude"]);
  const args = [
    ...pre,
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--model",
    options.model ?? "sonnet",
    "--allowed-tools",
    "Read,Grep,Glob",
    "--append-system-prompt",
    system,
  ];
  const child = spawn(cmd!, args, { cwd: root, env: { ...process.env, VIEWPORT_JOB: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (b: Buffer) => out.push(b));
  child.stderr.on("data", (b: Buffer) => err.push(b));
  child.stdin.end(prompt);
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`timed out after ${Math.round((options.timeoutMs ?? 300_000) / 1000)}s`));
    }, options.timeoutMs ?? 300_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  if (code !== 0) throw new Error(`claude exited with ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 300)}`);
  const result = JSON.parse(Buffer.concat(out).toString("utf8")) as { structured_output?: unknown; result?: string; is_error?: boolean };
  if (result.is_error) throw new Error(`claude reported an error: ${String(result.result).slice(0, 300)}`);
  return result.structured_output ?? JSON.parse(result.result ?? "null");
}
