import type { DatabaseSync } from "node:sqlite";
import { listFlags, listPredictions } from "./engage.js";
import { blastRadius } from "./model-edit.js";
import { ModelGraph, QueryError } from "./query/graph.js";
import { type Level, type ViewName, view } from "./query/views.js";
import { dueQuiz, startOfDay } from "./quiz.js";
import { salienceScores } from "./salience.js";
import type { Decision, Model } from "./schema.js";

const LADDER: Level[] = ["simple", "medium", "complex"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Fewer answers than this say too little about an area to suggest anything. */
export const SUGGEST_AFTER = 3;
const STEP_UP_SHARE = 0.75;
const STEP_DOWN_SHARE = 0.34;
/** A right answer to a question posed a level up says more about being ready for that level. */
const STRETCH_WEIGHT = 2;

export interface LevelSuggestion {
  to: Level;
  answers: number;
  right: number;
}

export interface AreaLevel {
  /** The area: a view of the Map, remembered by its name (D-015). */
  view: string;
  /** The level to show: the one asked for, else the one remembered, else medium. */
  level: Level;
  suggestion?: LevelSuggestion;
}

interface LevelRow {
  level: Level | null;
  since: string;
}

const levelRow = (db: DatabaseSync, area: string) => db.prepare("SELECT level, since FROM levels WHERE area = ?").get(area) as LevelRow | undefined;

/** Remembers the level chosen for an area. Evidence for a suggestion starts over from here. */
export function setAreaLevel(db: DatabaseSync, area: string, level: Level, now = new Date()): void {
  db.prepare("INSERT INTO levels (area, level, since) VALUES (?, ?, ?) ON CONFLICT(area) DO UPDATE SET level = excluded.level, since = excluded.since").run(area, level, now.toISOString());
}

/** Says no to a suggestion: it comes back only on answers given after this. */
export function dismissSuggestion(db: DatabaseSync, area: string, now = new Date()): void {
  db.prepare("INSERT INTO levels (area, level, since) VALUES (?, NULL, ?) ON CONFLICT(area) DO UPDATE SET since = excluded.since").run(area, now.toISOString());
}

/** Every node a view shows and everything inside them, plus the decisions that shaped those. */
function areaSubjects(model: Model, name: string): Set<string> {
  const graph = new ModelGraph(model);
  const subjects = new Set(view(graph, name as ViewName, "complex").flatMap((p) => p.elements));
  for (const id of [...subjects]) for (const child of graph.children(id)) subjects.add(child);
  for (const e of model.edges) if (e.kind === "decided_by" && subjects.has(e.from)) subjects.add(e.to.toUpperCase());
  return subjects;
}

/**
 * A level to try, from quiz answers about this area since the level was last chosen or
 * a suggestion last turned down. Only ever a suggestion: the viewer never switches on
 * its own.
 */
export function suggestLevel(db: DatabaseSync, model: Model, area: string, level: Level, since: string | undefined): LevelSuggestion | undefined {
  let subjects: Set<string>;
  try {
    subjects = areaSubjects(model, area);
  } catch (err) {
    // A view with nothing in it yet, such as a phase the model has no layer for.
    if (err instanceof QueryError) return undefined;
    throw err;
  }
  const rows = db
    .prepare("SELECT i.subject, i.stretch, a.grade FROM quiz_answers a JOIN quiz_items i ON i.id = a.item_id WHERE a.grade IS NOT NULL AND a.at > ?")
    .all(since ?? "") as { subject: string; stretch: number; grade: "correct" | "partial" | "wrong" }[];
  const here = rows.filter((r) => subjects.has(r.subject));
  const weighed = here.reduce((n, r) => n + (r.stretch ? STRETCH_WEIGHT : 1), 0);
  if (weighed < SUGGEST_AFTER) return undefined;
  const earned = here.reduce((n, r) => n + (r.stretch ? STRETCH_WEIGHT : 1) * (r.grade === "correct" ? 1 : r.grade === "partial" ? 0.5 : 0), 0);
  const step = earned / weighed >= STEP_UP_SHARE ? 1 : earned / weighed <= STEP_DOWN_SHARE ? -1 : 0;
  const to = LADDER[LADDER.indexOf(level) + step];
  if (step === 0 || to === undefined) return undefined;
  return { to, answers: here.length, right: here.filter((r) => r.grade === "correct").length };
}

/** The level to show for a view, and any suggestion to try another. `asked` is a level named in the link. */
export function areaLevel(db: DatabaseSync, model: Model, area: string, asked?: Level): AreaLevel {
  const row = levelRow(db, area);
  const level = asked ?? row?.level ?? "medium";
  const suggestion = suggestLevel(db, model, area, level, row?.since);
  return { view: area, level, ...(suggestion ? { suggestion } : {}) };
}

export type DebtBand = "high" | "some";

export interface DebtItem {
  id: string;
  name: string;
  debt: number;
  /** Components a change here touches. */
  reach: number;
  familiarity: number;
  band?: DebtBand;
}

export interface ComprehensionDebt {
  /** Of everything weighted by reach, how much the developer has not yet shown they understand, as a whole percent. */
  gap: number;
  /** Components, most debt first. */
  items: DebtItem[];
  /** Containers, by how much debt their components carry on average. */
  containers: DebtItem[];
}

const band = (share: number): DebtBand | undefined => (share >= 0.6 ? "high" : share >= 0.3 ? "some" : undefined);

/**
 * Comprehension debt = blast radius × (1 − familiarity): how much could break in a
 * part, discounted by what the developer has shown they understand. Bands compare
 * with the widest reach in the model, so a part the developer knows well never shows,
 * however central it is.
 */
export function comprehensionDebt(model: Model, familiarity: Record<string, number>): ComprehensionDebt {
  const raw = model.nodes.flatMap((n) => {
    if (n.kind !== "component") return [];
    const known = familiarity[n.id] ?? 0;
    const reach = blastRadius(model, [n.id]).length;
    return [{ id: n.id, name: n.name, reach, familiarity: known, debt: reach * (1 - known) }];
  });
  const widest = Math.max(1, ...raw.map((i) => i.reach));
  const withBand = (i: Omit<DebtItem, "band">): DebtItem => {
    const b = band(i.debt / widest);
    return b ? { ...i, band: b } : i;
  };
  const items = raw.map(withBand).sort((a, b) => b.debt - a.debt || a.id.localeCompare(b.id));
  const graph = new ModelGraph(model);
  const containers = model.nodes.flatMap((n) => {
    if (n.kind !== "container") return [];
    const inside = new Set(graph.children(n.id));
    const parts = raw.filter((i) => inside.has(i.id));
    if (parts.length === 0) return [];
    const mean = (pick: (i: (typeof parts)[number]) => number) => parts.reduce((sum, i) => sum + pick(i), 0) / parts.length;
    return [withBand({ id: n.id, name: n.name, reach: mean((i) => i.reach), familiarity: mean((i) => i.familiarity), debt: mean((i) => i.debt) })];
  });
  const total = raw.reduce((sum, i) => sum + i.reach, 0);
  const gap = total === 0 ? 0 : Math.round((100 * raw.reduce((sum, i) => sum + i.debt, 0)) / total);
  return { gap, items, containers };
}

export type DigestDecision = Pick<Decision, "id" | "title" | "reversibility">;

export interface Digest {
  /** Decisions of the last day, most worth knowing first, at most three. */
  decisions: DigestDecision[];
  moreDecisions: number;
  /** One-way decisions the developer has not guessed at or skipped, however old. */
  oneWay: DigestDecision[];
  quizDue: number;
  /** Flags Claude answered in the last day. */
  answers: number;
}

const brief = ({ id, title, reversibility }: Decision): DigestDecision => ({ id, title, reversibility });

/** A short account of the last day, for the top of Today and one line at SessionStart. */
export function dailyDigest(db: DatabaseSync, model: Model, ledger: Decision[], familiarity: Record<string, number>, now = new Date()): Digest {
  const salience = salienceScores(model, ledger, familiarity, now);
  const worth = (a: Decision, b: Decision) => (salience[b.id] ?? 0) - (salience[a.id] ?? 0);
  const replaced = new Set(ledger.flatMap((d) => (d.supersedes ? [d.supersedes] : [])));
  const live = ledger.filter((d) => !replaced.has(d.id));
  const after = now.getTime() - DAY_MS;
  const recent = live.filter((d) => Date.parse(d.at) > after).sort(worth);
  const looked = new Set(listPredictions(db).map((p) => p.decisionId));
  return {
    decisions: recent.slice(0, 3).map(brief),
    moreDecisions: Math.max(0, recent.length - 3),
    oneWay: live.filter((d) => d.reversibility === "one-way" && !looked.has(d.id)).sort(worth).map(brief),
    quizDue: dueQuiz(db, now).length,
    answers: listFlags(db).filter((f) => f.resolvedAt !== undefined && Date.parse(f.resolvedAt) > after).length,
  };
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The digest in one line, or nothing when there is nothing to say. */
export function digestLine(d: Digest): string | undefined {
  const total = d.decisions.length + d.moreDecisions;
  const parts = [
    ...(d.oneWay.length > 0 ? [`${count(d.oneWay.length, "one-way decision")} to look at, starting with "${d.oneWay[0]!.title}"`] : []),
    ...(total > 0 ? [`${count(total, "new decision")} since yesterday`] : []),
    ...(d.quizDue > 0 ? [`${count(d.quizDue, "question")} due`] : []),
    ...(d.answers > 0 ? [`${count(d.answers, "answer")} from Claude`] : []),
  ];
  return parts.length === 0 ? undefined : `Viewport: ${parts.join(", ")}. See Today in the viewer.`;
}

/** True once a day: the first session of the day gets the digest line, later ones stay quiet. */
export function takeDigestTurn(db: DatabaseSync, now = new Date()): boolean {
  const shown = db.prepare("SELECT 1 FROM events WHERE kind = 'digest' AND at >= ? LIMIT 1").get(startOfDay(now).toISOString());
  if (shown !== undefined) return false;
  db.prepare("INSERT INTO events (at, kind, subject, payload) VALUES (?, 'digest', NULL, '{}')").run(now.toISOString());
  return true;
}
