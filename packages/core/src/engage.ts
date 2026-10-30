import type { DatabaseSync } from "node:sqlite";

export interface Flag {
  id: number;
  at: string;
  /** The node id, edge key or decision id the developer flagged. */
  subject: string;
  text: string;
  status: "pending" | "delivered" | "resolved";
  answer?: string;
  decisionId?: string;
}

interface FlagRow {
  id: number;
  at: string;
  subject: string;
  text: string;
  status: Flag["status"];
  answer: string | null;
  decision_id: string | null;
}

function toFlag(row: FlagRow): Flag {
  return {
    id: row.id,
    at: row.at,
    subject: row.subject,
    text: row.text,
    status: row.status,
    ...(row.answer !== null ? { answer: row.answer } : {}),
    ...(row.decision_id !== null ? { decisionId: row.decision_id } : {}),
  };
}

export class EngageError extends Error {}

/** Stores a developer's flag. The viewer calls this in Phase 4; tests and tools use it now. */
export function raiseFlag(db: DatabaseSync, subject: string, text: string, at = new Date().toISOString()): Flag {
  const row = db.prepare("INSERT INTO flags (at, subject, text) VALUES (?, ?, ?) RETURNING *").get(at, subject, text) as unknown as FlagRow;
  return toFlag(row);
}

/** Flags Claude has not answered yet, oldest first. Reading does not change their status. */
export function unresolvedFlags(db: DatabaseSync): Flag[] {
  const rows = db.prepare("SELECT * FROM flags WHERE status != 'resolved' ORDER BY at, id").all() as unknown as FlagRow[];
  return rows.map(toFlag);
}

/** Records Claude's answer to a flag, optionally linking the decision that replaced the flagged one. */
export function resolveFlag(db: DatabaseSync, id: number, answer: string, decisionId?: string, at = new Date().toISOString()): Flag {
  const row = db
    .prepare("UPDATE flags SET status = 'resolved', answer = ?, decision_id = ?, resolved_at = ? WHERE id = ? RETURNING *")
    .get(answer, decisionId ?? null, at, id) as unknown as FlagRow | undefined;
  if (row === undefined) throw new EngageError(`no flag ${id}`);
  return toFlag(row);
}

export type QuizKind = "why" | "what-if" | "predict";

export interface QuizItemInput {
  /** Node id, edge key or decision id the question is about. */
  subject: string;
  kind: QuizKind;
  question: string;
  /** For `predict` items: the options the developer picks from before the reveal. */
  choices?: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stores quiz and prediction items written by the explainer. Each is first due one
 * day later, the first step of the spaced ladder. Phase 4 builds the scheduling on top.
 */
export function writeQuizItems(db: DatabaseSync, items: QuizItemInput[], now = new Date()): number[] {
  const insert = db.prepare(
    "INSERT INTO quiz_items (created_at, subject, kind, question, choices, due_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
  );
  const due = new Date(now.getTime() + DAY_MS).toISOString();
  const ids: number[] = [];
  db.exec("BEGIN");
  try {
    for (const item of items) {
      if (item.kind === "predict" && (item.choices ?? []).length < 2) {
        throw new EngageError(`predict items need at least two choices: '${item.question}'`);
      }
      const choices = item.choices !== undefined ? JSON.stringify(item.choices) : null;
      const row = insert.get(now.toISOString(), item.subject, item.kind, item.question, choices, due) as { id: number };
      ids.push(row.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return ids;
}
