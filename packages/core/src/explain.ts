import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { content } from "./changes.js";
import { stableStringify } from "./fsutil.js";
import { openJobs } from "./jobs.js";
import { readModel, writeModel } from "./model-store.js";
import { ModelGraph } from "./query/graph.js";
import type { Decision, Model, ModelNode } from "./schema.js";
import { writeQuizItems } from "./engage.js";

/** Subjects per explainer run: enough to batch a checkpoint, few enough to stay fast and focused. */
export const EXPLAIN_BATCH = 8;
/** Questions the explainer may write per subject. */
export const QUESTIONS_PER_SUBJECT = 2;

const Level = z.string().min(1).max(400);

/** What the explainer returns: takeaways at three levels, and questions with their answers. */
export const ExplainOutput = z.object({
  takeaways: z.array(z.object({ subject: z.string().min(1), simple: Level, medium: Level, complex: Level })),
  questions: z.array(
    z.object({
      subject: z.string().min(1),
      kind: z.enum(["why", "what-if", "predict"]),
      question: z.string().min(1).max(400),
      choices: z.array(z.string().min(1)).optional(),
      answer: z.string().min(1).max(600),
      stretch: z.boolean().optional(),
    }),
  ),
});
export type ExplainOutput = z.infer<typeof ExplainOutput>;

/** The schema for `claude -p --json-schema`, which rejects a `$schema` URL it cannot resolve. */
export function explainJsonSchema(): Record<string, unknown> {
  const { $schema: _s, ...schema } = z.toJSONSchema(ExplainOutput) as Record<string, unknown>;
  return schema;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const nodeHash = (n: ModelNode) => hash(content(n));
const decisionHash = (d: Decision) => hash(stableStringify(d));

/**
 * Node kinds the explainer writes takeaways and questions for: the ones the viewer
 * draws. Decision nodes are covered by their ledger entries.
 */
export const EXPLAINED_KINDS: ReadonlySet<ModelNode["kind"]> = new Set(["system", "actor", "external", "container", "component", "process", "rule", "entity", "runtime"]);

/**
 * Nodes and decisions that are new or changed since they were last explained, and not
 * already waiting in an explain job.
 */
export function explainDue(db: DatabaseSync, model: Model, ledger: Decision[]): string[] {
  const done = new Map((db.prepare("SELECT subject, hash FROM explained").all() as { subject: string; hash: string }[]).map((r) => [r.subject, r.hash]));
  const queued = new Set(openJobs(db, "explain").flatMap((j) => (j.payload.subjects as string[] | undefined) ?? []));
  const due: string[] = [];
  for (const n of model.nodes) if (EXPLAINED_KINDS.has(n.kind) && done.get(n.id) !== nodeHash(n) && !queued.has(n.id)) due.push(n.id);
  for (const d of ledger) if (done.get(d.id) !== decisionHash(d) && !queued.has(d.id)) due.push(d.id);
  return due;
}

/** Records that these subjects were explained as they stand now, so a checkpoint skips them until they change. */
export function markExplained(db: DatabaseSync, model: Model, ledger: Decision[], subjects: string[], at = new Date().toISOString()): void {
  const upsert = db.prepare("INSERT INTO explained (subject, hash, at) VALUES (?, ?, ?) ON CONFLICT(subject) DO UPDATE SET hash = excluded.hash, at = excluded.at");
  for (const s of subjects) {
    const node = model.nodes.find((n) => n.id === s);
    const decision = ledger.find((d) => d.id === s);
    if (node) upsert.run(s, nodeHash(node), at);
    else if (decision) upsert.run(s, decisionHash(decision), at);
  }
}

/** The explainer's brief for one batch: the subjects in full, with just enough around them to place them. */
export function explainPrompt(model: Model, ledger: Decision[], subjects: string[]): string {
  const graph = new ModelGraph(model);
  const system = graph.ofKind("system")[0];
  const lines = [
    `Explain these parts of ${system ? `${system.name} (${system.purpose})` : "the system"} for the developer who owns it, following the viewport-explaining instructions.`,
    "",
  ];
  for (const s of subjects) lines.push(...subjectBrief(graph, ledger, s), "");
  lines.push(`Write a takeaway for every subject above and at most ${QUESTIONS_PER_SUBJECT} questions each. Use only the subject ids given.`);
  return lines.join("\n");
}

/** One subject as an agent sees it: the node or decision in full, and what it connects to. */
export function subjectBrief(graph: ModelGraph, ledger: Decision[], s: string): string[] {
  const name = (id: string) => graph.nodes.get(id)?.name ?? id;
  const node = graph.nodes.get(s);
  const decision = ledger.find((d) => d.id === s);
  if (node) {
    const { sync: _s, source: _o, changedAt: _c, takeaway: _t, takeaways: _ts, ...rest } = node;
    if (rest.kind === "component") delete (rest as { fingerprint?: string }).fingerprint;
    const out = graph.outgoing(node.id).filter((e) => e.kind === "depends_on" || e.kind === "uses");
    const inc = graph.incoming(node.id).filter((e) => e.kind === "depends_on" || e.kind === "uses");
    const lines = [`## ${s}`, JSON.stringify(rest)];
    if (graph.parent(s)) lines.push(`Inside: ${name(graph.parent(s)!)}`);
    if (out.length > 0) lines.push(`Depends on: ${out.map((e) => `${name(e.to)}${e.mode ? ` (${e.mode})` : ""}`).join(", ")}`);
    if (inc.length > 0) lines.push(`Used by: ${inc.map((e) => name(e.from)).join(", ")}`);
    const shaped = ledger.filter((d) => d.affects.includes(s));
    if (shaped.length > 0) lines.push(`Decisions: ${shaped.map((d) => `${d.id} ${d.title} (chose ${d.chosen})`).join("; ")}`);
    return lines;
  }
  if (decision) {
    const { at: _a, commit: _c, ...rest } = decision;
    return [`## ${s}`, JSON.stringify(rest)];
  }
  return [`## ${s}`, "(no longer in the model)"];
}

/**
 * Stores what the explainer wrote: takeaways on the model's nodes (a decision's on its
 * decision node, if the model has one) and questions in the quiz. Anything about a
 * subject outside the batch is dropped. Every subject in the batch is then marked
 * explained, so a run that skipped one does not loop.
 */
export async function applyExplanation(modelPath: string, db: DatabaseSync, ledger: Decision[], subjects: string[], output: ExplainOutput): Promise<{ takeaways: number; questions: number }> {
  const batch = new Set(subjects);
  const model = await readModel(modelPath);
  const nodeFor = (subject: string) => (model.nodes.some((n) => n.id === subject) ? subject : model.nodes.find((n) => n.kind === "decision" && n.id === subject.toLowerCase())?.id);
  const takeaways = new Map<string, NonNullable<ModelNode["takeaways"]>>();
  for (const t of output.takeaways) {
    const id = batch.has(t.subject) ? nodeFor(t.subject) : undefined;
    if (id) takeaways.set(id, { simple: t.simple, medium: t.medium, complex: t.complex });
  }
  let written = model;
  if (takeaways.size > 0) {
    const nodes = model.nodes.map((n) => (takeaways.has(n.id) ? { ...n, takeaways: takeaways.get(n.id)!, takeaway: takeaways.get(n.id)!.medium } : n));
    written = await writeModel(modelPath, { ...model, nodes });
  }
  const perSubject = new Map<string, number>();
  const questions = output.questions.filter((q) => {
    if (!batch.has(q.subject)) return false;
    if (q.kind === "predict" && (!q.choices || q.choices.length < 2 || !q.choices.includes(q.answer))) return false;
    const n = (perSubject.get(q.subject) ?? 0) + 1;
    perSubject.set(q.subject, n);
    return n <= QUESTIONS_PER_SUBJECT;
  });
  if (questions.length > 0) writeQuizItems(db, questions.map(({ choices, stretch, ...q }) => ({ ...q, ...(choices ? { choices } : {}), ...(stretch ? { stretch } : {}) })));
  markExplained(db, written, ledger, subjects);
  return { takeaways: takeaways.size, questions: questions.length };
}
