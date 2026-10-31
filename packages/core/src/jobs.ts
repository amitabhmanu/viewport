import type { DatabaseSync } from "node:sqlite";

/** Background work the daemon runs one at a time with `claude -p`: explaining now, grading next. */
export interface Job {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

interface JobRow {
  id: number;
  kind: string;
  payload: string;
  status: Job["status"];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    status: r.status,
    createdAt: r.created_at,
    ...(r.started_at !== null ? { startedAt: r.started_at } : {}),
    ...(r.finished_at !== null ? { finishedAt: r.finished_at } : {}),
    ...(r.error !== null ? { error: r.error } : {}),
  };
}

export function enqueueJob(db: DatabaseSync, kind: string, payload: object, at = new Date().toISOString()): Job {
  const row = db.prepare("INSERT INTO jobs (kind, payload, created_at) VALUES (?, ?, ?) RETURNING *").get(kind, JSON.stringify(payload), at) as unknown as JobRow;
  return toJob(row);
}

/** Jobs waiting or running, oldest first. */
export function openJobs(db: DatabaseSync, kind?: string): Job[] {
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE status IN ('queued', 'running')${kind ? " AND kind = ?" : ""} ORDER BY id`)
    .all(...(kind ? [kind] : [])) as unknown as JobRow[];
  return rows.map(toJob);
}

/** Takes the oldest queued job and marks it running, or returns undefined. */
export function claimJob(db: DatabaseSync, at = new Date().toISOString()): Job | undefined {
  const row = db
    .prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1) RETURNING *")
    .get(at) as JobRow | undefined;
  return row && toJob(row);
}

export function finishJob(db: DatabaseSync, id: number, error?: string, at = new Date().toISOString()): void {
  db.prepare("UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?").run(error === undefined ? "done" : "failed", at, error ?? null, id);
}

/** Jobs left running by a daemon that stopped go back in the queue. */
export function requeueStale(db: DatabaseSync): number {
  return Number(db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run().changes);
}

export function recentJobs(db: DatabaseSync, limit = 20): Job[] {
  return (db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as unknown as JobRow[]).map(toJob);
}

/** Whether background jobs are working, for the viewer and the session-start message. */
export interface JobHealth {
  /** Jobs that failed since the last one that worked, newest first. */
  failedInARow: number;
  lastError?: string;
  lastFailedAt?: string;
  /** What to do about `lastError`, when it is a problem Viewport recognizes. */
  hint?: string;
}

/** Counts the jobs that failed since the last one that finished well. */
export function jobHealth(db: DatabaseSync): JobHealth {
  const rows = db
    .prepare("SELECT status, error, finished_at FROM jobs WHERE status IN ('done', 'failed') ORDER BY finished_at DESC, id DESC LIMIT 500")
    .all() as unknown as Pick<JobRow, "status" | "error" | "finished_at">[];
  const failed = rows.findIndex((r) => r.status === "done");
  const failedInARow = failed === -1 ? rows.length : failed;
  if (failedInARow === 0) return { failedInARow: 0 };
  const last = rows[0]!;
  const hint = jobErrorHint(last.error ?? "");
  return {
    failedInARow,
    ...(last.error !== null ? { lastError: last.error } : {}),
    ...(last.finished_at !== null ? { lastFailedAt: last.finished_at } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

/** A fix for the job failures Viewport has seen in practice. */
export function jobErrorHint(error: string): string | undefined {
  if (/ANTHROPIC_API_KEY|credit balance|invalid x-api-key|authentication_error/i.test(error)) {
    return "Background jobs run claude -p, which uses ANTHROPIC_API_KEY from the environment ahead of your claude.ai login. Remove the key from the environment Claude Code starts in, or set VIEWPORT_JOBS_USE_LOGIN=1 so jobs ignore it, then restart Claude Code.";
  }
  if (/daemon is older than|"path":\s*\[\s*"version"\s*\]/.test(error)) {
    return "The viewer's daemon was built before the model's current format. Run pnpm build, then node bin/viewportd stop; the next Claude Code session starts a fresh daemon.";
  }
  if (/could not run '/.test(error)) {
    return "Install Claude Code's native build, or set VIEWPORT_CLAUDE to the claude executable, then restart Claude Code.";
  }
  return undefined;
}
