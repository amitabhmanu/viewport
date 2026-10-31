import type { DatabaseSync } from "node:sqlite";
import { EngageError, type QuizKind } from "./engage.js";
import { addEvidence } from "./familiarity.js";
import { enqueueJob } from "./jobs.js";

/** Days until an item comes back, by rung: right answers climb, wrong ones start over. */
export const LADDER_DAYS = [1, 3, 7, 21] as const;
/** At most this many questions a day, so the quiz stays a habit rather than a chore. */
export const QUIZ_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Past the last rung an item is retired: due on a date that never comes. */
const RETIRED = "9999-12-31T00:00:00.000Z";

export type Grade = "correct" | "partial" | "wrong";

/** A question as the developer sees it: never with its answer. */
export interface QuizItem {
  id: number;
  subject: string;
  kind: QuizKind;
  question: string;
  choices?: string[];
  step: number;
  dueAt: string;
}

export interface QuizResult {
  itemId: number;
  answerId: number;
  /** Graded at once for predict items; why and what-if answers wait for the grader. */
  grade?: Grade;
  /** For predict items, the right choice, shown once answered. */
  expected?: string;
  nextDue: string;
}

interface ItemRow {
  id: number;
  subject: string;
  kind: QuizKind;
  question: string;
  choices: string | null;
  step: number;
  due_at: string;
  answer: string | null;
}

const toItem = (r: ItemRow): QuizItem => ({
  id: r.id,
  subject: r.subject,
  kind: r.kind,
  question: r.question,
  ...(r.choices !== null ? { choices: JSON.parse(r.choices) as string[] } : {}),
  step: r.step,
  dueAt: r.due_at,
});

function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Questions due now, oldest first, up to what is left of today's allowance. */
export function dueQuiz(db: DatabaseSync, now = new Date(), perDay = QUIZ_PER_DAY): QuizItem[] {
  const answered = (db.prepare("SELECT COUNT(*) AS n FROM quiz_answers WHERE at >= ?").get(startOfDay(now).toISOString()) as { n: number }).n;
  const left = Math.max(0, perDay - answered);
  if (left === 0) return [];
  const rows = db.prepare("SELECT * FROM quiz_items WHERE due_at <= ? ORDER BY due_at, id LIMIT ?").all(now.toISOString(), left) as unknown as ItemRow[];
  return rows.map(toItem);
}

/** Moves an item along the ladder after a grade, and returns when it is next due. */
export function schedule(db: DatabaseSync, itemId: number, grade: Grade | undefined, now = new Date()): string {
  const item = db.prepare("SELECT step FROM quiz_items WHERE id = ?").get(itemId) as { step: number } | undefined;
  if (item === undefined) throw new EngageError(`no quiz item ${itemId}`);
  // Ungraded answers come back at the same rung; the grader moves them on.
  const step = grade === "correct" ? item.step + 1 : grade === "wrong" ? 0 : item.step;
  const days = LADDER_DAYS[step];
  const due = days === undefined ? RETIRED : new Date(now.getTime() + days * DAY_MS).toISOString();
  db.prepare("UPDATE quiz_items SET step = ?, due_at = ? WHERE id = ?").run(step, due, itemId);
  return due;
}

/**
 * Stores an answer with the confidence the developer gave before seeing any grade.
 * Predict items are graded against their answer key at once; the rest queue a grade job.
 */
export function answerQuiz(db: DatabaseSync, itemId: number, answer: string, confidence: number, now = new Date()): QuizResult {
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) throw new EngageError("confidence is a whole number from 1 to 5");
  const row = db.prepare("SELECT * FROM quiz_items WHERE id = ?").get(itemId) as ItemRow | undefined;
  if (row === undefined) throw new EngageError(`no quiz item ${itemId}`);
  if (answer.trim() === "") throw new EngageError("an answer cannot be empty");
  const grade: Grade | undefined = row.kind === "predict" && row.answer !== null ? (answer === row.answer ? "correct" : "wrong") : undefined;
  db.exec("BEGIN");
  try {
    const answerId = Number(
      db.prepare("INSERT INTO quiz_answers (item_id, at, answer, confidence, grade) VALUES (?, ?, ?, ?, ?)").run(itemId, now.toISOString(), answer.trim(), confidence, grade ?? null)
        .lastInsertRowid,
    );
    const nextDue = schedule(db, itemId, grade, now);
    if (row.kind !== "predict") enqueueJob(db, "grade", { answerId }, now.toISOString());
    else if (grade) addEvidence(db, [row.subject], grade, now);
    db.exec("COMMIT");
    return { itemId, answerId, ...(grade ? { grade } : {}), ...(row.kind === "predict" && row.answer !== null ? { expected: row.answer } : {}), nextDue };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
