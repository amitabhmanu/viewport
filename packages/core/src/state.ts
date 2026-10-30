import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Local, per-person state: never committed. Each entry runs once, in order, and
 * is recorded in `schema_version`. Append new migrations; never edit old ones.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT,
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_at ON events(at);

  CREATE TABLE flags (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    subject TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'resolved')),
    answer TEXT,
    resolved_at TEXT
  );

  CREATE TABLE predictions (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    guess TEXT,
    skipped INTEGER NOT NULL DEFAULT 0,
    correct INTEGER
  );

  CREATE TABLE quiz_items (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('why', 'what-if', 'predict')),
    question TEXT NOT NULL,
    choices TEXT,
    step INTEGER NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL
  );

  CREATE TABLE quiz_answers (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES quiz_items(id),
    at TEXT NOT NULL,
    answer TEXT NOT NULL,
    confidence INTEGER CHECK (confidence BETWEEN 1 AND 5),
    grade TEXT CHECK (grade IN ('correct', 'partial', 'wrong')),
    feedback TEXT
  );

  CREATE TABLE familiarity (
    subject TEXT PRIMARY KEY,
    score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE cursors (
    name TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    at TEXT NOT NULL
  );
  `,
];

/** Opens (creating if needed) state.db in WAL mode and applies pending migrations. */
export function openState(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v] ?? "");
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(v + 1);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

export function stateVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  return row.v ?? 0;
}
