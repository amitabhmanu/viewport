import type { DatabaseSync } from "node:sqlite";
import type { Decision } from "./schema.js";

export interface Flag {
  id: number;
  at: string;
  /** The node id, edge key or decision id the developer flagged. */
  subject: string;
  text: string;
  status: "pending" | "delivered" | "resolved";
  answer?: string;
  decisionId?: string;
  resolvedAt?: string;
}

interface FlagRow {
  id: number;
  at: string;
  subject: string;
  text: string;
  status: Flag["status"];
  answer: string | null;
  decision_id: string | null;
  resolved_at: string | null;
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
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
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

/** Every flag, answered or not, oldest first: what the viewer shows on each flagged element. */
export function listFlags(db: DatabaseSync): Flag[] {
  const rows = db.prepare("SELECT * FROM flags ORDER BY at, id").all() as unknown as FlagRow[];
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
  /** What a good answer says (for `predict`, the right choice). The grader reads it; the developer never sees it before answering. */
  answer?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stores quiz and prediction items written by the explainer. Each is first due one
 * day later, the first step of the spaced ladder. Phase 4 builds the scheduling on top.
 */
export function writeQuizItems(db: DatabaseSync, items: QuizItemInput[], now = new Date()): number[] {
  const insert = db.prepare(
    "INSERT INTO quiz_items (created_at, subject, kind, question, choices, due_at, answer) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
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
      if (item.kind === "predict" && item.answer !== undefined && !(item.choices ?? []).includes(item.answer)) {
        throw new EngageError(`the answer to '${item.question}' must be one of its choices`);
      }
      const row = insert.get(now.toISOString(), item.subject, item.kind, item.question, choices, due, item.answer ?? null) as { id: number };
      ids.push(row.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return ids;
}

export interface Prediction {
  decisionId: string;
  at: string;
  /** The option the developer picked, or undefined when they skipped. */
  guess?: string;
  skipped: boolean;
  correct?: boolean;
}

interface PredictionRow {
  decision_id: string;
  at: string;
  guess: string | null;
  skipped: number;
  correct: number | null;
}

/**
 * Stores the developer's guess at a decision before its choice is revealed, or that
 * they skipped. One per decision: the first answer stands, so a reveal cannot be undone.
 */
export function recordPrediction(db: DatabaseSync, decision: Pick<Decision, "id" | "chosen" | "options">, guess: string | undefined, at = new Date().toISOString()): Prediction {
  const existing = predictionFor(db, decision.id);
  if (existing) return existing;
  if (guess !== undefined && !decision.options.some((o) => o.name === guess)) throw new EngageError(`'${guess}' is not an option of ${decision.id}`);
  const correct = guess === undefined ? null : guess === decision.chosen ? 1 : 0;
  db.prepare("INSERT INTO predictions (at, decision_id, guess, skipped, correct) VALUES (?, ?, ?, ?, ?)").run(at, decision.id, guess ?? null, guess === undefined ? 1 : 0, correct);
  return predictionFor(db, decision.id)!;
}

export function predictionFor(db: DatabaseSync, decisionId: string): Prediction | undefined {
  const row = db.prepare("SELECT * FROM predictions WHERE decision_id = ? ORDER BY id LIMIT 1").get(decisionId) as PredictionRow | undefined;
  return row && toPrediction(row);
}

export function listPredictions(db: DatabaseSync): Prediction[] {
  const rows = db.prepare("SELECT * FROM predictions WHERE id IN (SELECT MIN(id) FROM predictions GROUP BY decision_id) ORDER BY id").all() as unknown as PredictionRow[];
  return rows.map(toPrediction);
}

function toPrediction(row: PredictionRow): Prediction {
  return {
    decisionId: row.decision_id,
    at: row.at,
    ...(row.guess !== null ? { guess: row.guess } : {}),
    skipped: row.skipped === 1,
    ...(row.correct !== null ? { correct: row.correct === 1 } : {}),
  };
}
