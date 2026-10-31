import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  type Decision,
  ExplainOutput,
  type GradeCase,
  GradeOutput,
  type Job,
  MODEL_VERSION,
  type Model,
  applyExplanation,
  applyGrade,
  claimJob,
  enqueueJob,
  explainJsonSchema,
  explainPrompt,
  finishJob,
  gradeCase,
  gradeJsonSchema,
  gradePrompt,
  logEvent,
  openState,
  readLedger,
  readModel,
  requeueStale,
  ungradedAnswers,
  viewportPaths,
} from "@viewport/core";

export interface ClaudeOptions {
  /** The Claude Code command line to run, before its arguments. Defaults to `claude`, or VIEWPORT_CLAUDE. */
  command?: string[];
  model?: string;
  timeoutMs?: number;
}

export interface WorkerOptions extends ClaudeOptions {
  /** The explainer's instructions: agents/viewport-explainer.md and skills/viewport-explaining/SKILL.md. */
  explainFiles: string[];
  /** The grader's instructions: agents/viewport-grader.md. */
  gradeFiles: string[];
}

/** Read-only tools for a job that may look at the code; none for one that must not. */
const READ_TOOLS = ["Read", "Grep", "Glob"];

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
  // Answers saved while no daemon was running, or before there was a grader, get graded now.
  for (const c of ungradedAnswers(db)) enqueueJob(db, "grade", { answerId: c.answerId });

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
    const [model, ledger] = await Promise.all([readModelFor(paths.model), readLedger(paths.ledger)]);
    if (job.kind === "explain") {
      const subjects = (job.payload.subjects as string[] | undefined) ?? [];
      const system = await instructions(options.explainFiles);
      const output = await runClaude(root, options, explainPrompt(model, ledger, subjects), explainJsonSchema(), system, READ_TOOLS);
      await applyExplanation(paths.model, db, ledger, subjects, ExplainOutput.parse(output));
    } else if (job.kind === "grade") {
      const c = gradeCase(db, job.payload.answerId as number);
      const result = await gradeAnswer(root, options, model, ledger, c, await instructions(options.gradeFiles));
      applyGrade(db, c.answerId, result);
      logEvent(db, "grade", String(c.itemId), { answerId: c.answerId, grade: result.grade, looks: result.looks });
    } else {
      throw new Error(`unknown job kind '${job.kind}'`);
    }
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

/**
 * Reads the model, and says plainly when it is in a newer format than this daemon was
 * built for, which happens when the plugin is rebuilt while an old daemon keeps running.
 */
export async function readModelFor(path: string): Promise<Model> {
  try {
    return await readModel(path);
  } catch (err) {
    let version: unknown;
    try {
      version = (JSON.parse(await readFile(path, "utf8")) as { version?: unknown }).version;
    } catch {
      throw err;
    }
    if (typeof version === "number" && version > MODEL_VERSION) {
      throw new Error(`the model is version ${version}, but this daemon is older than that and reads up to version ${MODEL_VERSION}`);
    }
    throw err;
  }
}

/** An agent's instructions: its agent and skill files, without their frontmatter. */
export async function instructions(files: string[]): Promise<string> {
  return (await Promise.all(files.map((f) => readFile(f, "utf8")))).map((t) => t.replace(/^---[\s\S]*?---\n/, "").trim()).join("\n\n");
}

/**
 * Grades one written answer. The first look uses only the model, the ledger and the key,
 * with no tools; a partial or wrong grade gets a second look that may read the code, and
 * that grade stands.
 */
export async function gradeAnswer(
  root: string,
  options: ClaudeOptions,
  model: Model,
  ledger: Decision[],
  c: GradeCase,
  system: string,
): Promise<GradeOutput & { looks: 1 | 2 }> {
  const first = GradeOutput.parse(await runClaude(root, options, gradePrompt(model, ledger, c, false), gradeJsonSchema(), system, []));
  if (first.grade === "correct") return { ...first, looks: 1 };
  const second = GradeOutput.parse(await runClaude(root, options, gradePrompt(model, ledger, c, true), gradeJsonSchema(), system, READ_TOOLS));
  return { ...second, looks: 2 };
}

/** One headless run: prompt on stdin, JSON on stdout, structured output checked against `schema`. */
export async function runClaude(root: string, options: ClaudeOptions, prompt: string, schema: object, system: string, tools: string[]): Promise<unknown> {
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
    "--tools",
    tools.join(","),
    ...(tools.length > 0 ? ["--allowed-tools", tools.join(",")] : []),
    "--append-system-prompt",
    system,
  ];
  const child = spawn(cmd!, args, { cwd: root, env: jobEnv(process.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // Without a shell, Windows finds claude.exe (the native installer) but not npm's claude.cmd.
      reject(
        e.code === "ENOENT"
          ? new Error(`could not run '${cmd}': install Claude Code's native build, or set VIEWPORT_CLAUDE to the claude executable`)
          : e,
      );
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  const stdout = Buffer.concat(out).toString("utf8");
  if (code !== 0) throw new Error(`claude exited with ${code}: ${failureDetail(stdout, Buffer.concat(err).toString("utf8"))}`);
  const result = JSON.parse(stdout) as { structured_output?: unknown; result?: string; is_error?: boolean };
  if (result.is_error) throw new Error(`claude reported an error: ${String(result.result).slice(0, 300)}`);
  return result.structured_output ?? JSON.parse(result.result ?? "null");
}

/**
 * The environment for a job. VIEWPORT_JOBS_USE_LOGIN=1 drops ANTHROPIC_API_KEY, so a
 * key meant for something else doesn't take precedence over the developer's claude.ai login.
 */
export function jobEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, VIEWPORT_JOB: "1" };
  if (env.VIEWPORT_JOBS_USE_LOGIN) delete next.ANTHROPIC_API_KEY;
  return next;
}

/**
 * Why a run failed. With JSON output, Claude Code puts the real error in stdout's
 * `result`; stderr often holds only warnings, so both are kept, the result first.
 */
export function failureDetail(stdout: string, stderr: string): string {
  let result: string | undefined;
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    if (typeof parsed.result === "string" && parsed.result.trim() !== "") result = parsed.result.trim();
  } catch {
    if (stdout.trim() !== "") result = stdout.trim();
  }
  return [result, stderr.trim()].filter((s) => s !== undefined && s !== "").join(" | ").slice(0, 600) || "no output";
}
