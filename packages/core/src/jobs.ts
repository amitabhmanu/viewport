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
