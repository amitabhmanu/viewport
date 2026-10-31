import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { EngageError } from "./engage.js";
import { addEvidence } from "./familiarity.js";
import { subjectBrief } from "./explain.js";
import { openJobs } from "./jobs.js";
import { ModelGraph } from "./query/graph.js";
import { type Grade, schedule } from "./quiz.js";
import type { Decision, Model } from "./schema.js";

/** What the grader returns for one answer. */
export const GradeOutput = z.object({
  grade: z.enum(["correct", "partial", "wrong"]),
  feedback: z.string().min(1).max(300),
});
export type GradeOutput = z.infer<typeof GradeOutput>;

/** The schema for `claude -p --json-schema`, without the `$schema` URL it cannot resolve. */
export function gradeJsonSchema(): Record<string, unknown> {
  const { $schema: _s, ...schema } = z.toJSONSchema(GradeOutput) as Record<string, unknown>;
  return schema;
}

/** A written answer waiting for, or holding, its grade. */
export interface GradeCase {
  answerId: number;
  itemId: number;
  subject: string;
  kind: "why" | "what-if";
  question: string;
  /** The explainer's answer key. */
  expected: string;
  answer: string;
  at: string;
}

interface CaseRow {
  answer_id: number;
  item_id: number;
  subject: string;
  kind: "why" | "what-if";
  question: string;
  expected: string | null;
  answer: string;
  at: string;
}

const toCase = (r: CaseRow): GradeCase => ({
  answerId: r.answer_id,
  itemId: r.item_id,
  subject: r.subject,
  kind: r.kind,
  question: r.question,
  expected: r.expected ?? "",
  answer: r.answer,
  at: r.at,
});

const CASE_SQL = `SELECT a.id AS answer_id, a.item_id, i.subject, i.kind, i.question, i.answer AS expected, a.answer, a.at
  FROM quiz_answers a JOIN quiz_items i ON i.id = a.item_id`;

export function gradeCase(db: DatabaseSync, answerId: number): GradeCase {
  const row = db.prepare(`${CASE_SQL} WHERE a.id = ?`).get(answerId) as CaseRow | undefined;
  if (row === undefined) throw new EngageError(`no quiz answer ${answerId}`);
  if (row.kind !== "why" && row.kind !== "what-if") throw new EngageError(`answer ${answerId} is not a written answer`);
  return toCase(row);
}

/** Written answers with no grade and no grade job waiting, oldest first: what a restarted daemon picks up. */
export function ungradedAnswers(db: DatabaseSync): GradeCase[] {
  const queued = new Set(openJobs(db, "grade").map((j) => j.payload.answerId as number));
  const rows = db.prepare(`${CASE_SQL} WHERE a.grade IS NULL AND i.kind IN ('why', 'what-if') ORDER BY a.id`).all() as unknown as CaseRow[];
  return rows.map(toCase).filter((c) => !queued.has(c.answerId));
}

/** Files the grader may read on a second look: the subject's own paths, or those of what it contains or a decision affects. */
export function subjectPaths(model: Model, ledger: Decision[], subject: string): string[] {
  const graph = new ModelGraph(model);
  const decision = ledger.find((d) => d.id === subject);
  const ids = decision
    ? decision.affects.flatMap((a) => {
        const edge = /^\w+:(.+)->(.+)$/.exec(a);
        return edge ? [edge[1]!, edge[2]!] : [a];
      })
    : [subject];
  const paths = new Set<string>();
  const visit = (id: string) => {
    const node = graph.nodes.get(id);
    if (node?.kind === "component") for (const p of node.paths) paths.add(p);
    for (const child of graph.children(id)) visit(child);
  };
  ids.forEach(visit);
  return [...paths].sort();
}

/**
 * The grader's brief for one answer. The first look has only the model, the ledger and
 * the answer key; a second look, for an answer the first called partial or wrong, also
 * names the code to read, since the developer may know something the key left out.
 */
export function gradePrompt(model: Model, ledger: Decision[], c: GradeCase, withCode: boolean): string {
  const graph = new ModelGraph(model);
  const lines = [
    "Grade the developer's answer to this Viewport quiz question, following the viewport-grader instructions.",
    "",
    "# What Viewport knows about the subject",
    ...subjectBrief(graph, ledger, c.subject),
    "",
    `# Question (${c.kind})`,
    c.question,
    "",
    "# Answer key",
    c.expected || "(none)",
    "",
    "# Developer's answer",
    c.answer,
  ];
  if (withCode) {
    const paths = subjectPaths(model, ledger, c.subject);
    lines.push(
      "",
      "# Second look",
      "A first look found this answer partial or wrong against the key. Read the code before you decide: the developer may be right where the key is incomplete.",
      paths.length > 0 ? `The subject's code: ${paths.join(", ")}` : "Find the subject's code with Glob and Grep.",
    );
  }
  return lines.join("\n");
}

/** A graded answer as the viewer shows it. */
export interface GradedAnswer {
  answerId: number;
  itemId: number;
  subject: string;
  question: string;
  answer: string;
  confidence: number | null;
  grade?: Grade;
  feedback?: string;
  expected?: string;
  at: string;
}

/**
 * Stores a grade, counts it as evidence of familiarity with the subject, and moves the
 * item along the ladder from when it was answered. A later
 * answer to the same item has already rescheduled it, so an older answer's grade is kept
 * but leaves the schedule alone.
 */
export function applyGrade(db: DatabaseSync, answerId: number, output: GradeOutput): void {
  const c = gradeCase(db, answerId);
  const latest = (db.prepare("SELECT MAX(id) AS id FROM quiz_answers WHERE item_id = ?").get(c.itemId) as { id: number }).id;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE quiz_answers SET grade = ?, feedback = ? WHERE id = ?").run(output.grade, output.feedback, answerId);
    if (latest === answerId) schedule(db, c.itemId, output.grade, new Date(c.at));
    addEvidence(db, [c.subject], output.grade);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Written answers from the last `days`, newest first, with grades and the key once graded. */
export function recentAnswers(db: DatabaseSync, now = new Date(), days = 7): GradedAnswer[] {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT a.id, a.item_id, i.subject, i.question, i.answer AS expected, a.answer, a.confidence, a.grade, a.feedback, a.at
       FROM quiz_answers a JOIN quiz_items i ON i.id = a.item_id
       WHERE a.at >= ? AND i.kind IN ('why', 'what-if') ORDER BY a.id DESC`,
    )
    .all(since) as {
    id: number;
    item_id: number;
    subject: string;
    question: string;
    expected: string | null;
    answer: string;
    confidence: number | null;
    grade: Grade | null;
    feedback: string | null;
    at: string;
  }[];
  return rows.map((r) => ({
    answerId: r.id,
    itemId: r.item_id,
    subject: r.subject,
    question: r.question,
    answer: r.answer,
    confidence: r.confidence,
    ...(r.grade !== null ? { grade: r.grade } : {}),
    ...(r.feedback !== null ? { feedback: r.feedback } : {}),
    ...(r.grade !== null && r.expected !== null ? { expected: r.expected } : {}),
    at: r.at,
  }));
}
