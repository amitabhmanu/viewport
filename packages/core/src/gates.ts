import type { DatabaseSync } from "node:sqlite";
import picomatch from "picomatch";
import { predictionFor } from "./engage.js";
import { familiarityScores } from "./familiarity.js";
import { jobHealth } from "./jobs.js";
import { blastRadius } from "./model-edit.js";
import { salience } from "./salience.js";
import type { Decision, GateSettings, Model } from "./schema.js";

/**
 * Catch-up gates (D-017). At a milestone, enough new decisions or touched components
 * since the last gate, Claude pauses: further edits are refused and the developer's
 * next prompt waits until they show, through the quiz and predictions, that they
 * follow the work's most salient parts. Opt out in config (`gates.enabled`) or with
 * VIEWPORT_NO_GATES.
 */

/** Edits Claude may still make after a gate opens mid-turn, to leave the code in a working state. */
export const GATE_GRACE_EDITS = 3;
/** Failed jobs in a row after which written answers count once given, since nobody can grade them. */
const JOBS_DOWN = 3;
const CURSOR = "gates";

export interface GateSubject {
  id: string;
  kind: "decision" | "component";
  name: string;
  familiarity: number;
  met: boolean;
  /** The gate's own question about this subject. */
  itemId: number;
  question: string;
  /** For decisions: whether the developer has guessed it on its prediction card. */
  predicted?: boolean;
  /** Whether the developer has answered the gate's question since the gate opened. */
  answered: boolean;
  /** Answered and waiting for the grader. */
  grading: boolean;
  /** Answers to the gate's question since it opened. */
  answers: number;
}

export interface Gate {
  id: number;
  openedAt: string;
  session?: string;
  threshold: number;
  subjects: GateSubject[];
  closedAt?: string;
  outcome?: "passed" | "skipped" | "released";
  /** Why a released gate let the developer through. */
  note?: string;
}

/** The work since the last gate: what makes a milestone. */
export interface Work {
  since: string;
  decisions: string[];
  components: string[];
}

interface GateRow {
  id: number;
  opened_at: string;
  session: string | null;
  subjects: string;
  closed_at: string | null;
  outcome: NonNullable<Gate["outcome"]> | null;
}

/** Whether gates are off for this run: switched off in config, or by the environment (evaluation runs, Viewport's own jobs). */
export function gatesOff(settings: GateSettings, env: NodeJS.ProcessEnv = process.env): boolean {
  return !settings.enabled || Boolean(env.VIEWPORT_NO_GATES);
}

/** When the work that counts toward the next milestone began: the last gate, or the first time gates were checked. */
export function gateCursor(db: DatabaseSync, now = new Date()): string {
  const last = db.prepare("SELECT MAX(opened_at) AS at FROM gates").get() as { at: string | null };
  if (last.at !== null) return last.at;
  const cursor = db.prepare("SELECT at FROM cursors WHERE name = ?").get(CURSOR) as { at: string } | undefined;
  if (cursor !== undefined) return cursor.at;
  // Turning gates on starts the count now, rather than gating on everything ever built.
  db.prepare("INSERT INTO cursors (name, revision, at) VALUES (?, 0, ?)").run(CURSOR, now.toISOString());
  return now.toISOString();
}

/** Decisions logged and components Claude edited since `since`. */
export function workSince(db: DatabaseSync, model: Model, ledger: Decision[], since: string): Work {
  const decisions = ledger.filter((d) => d.at > since && d.supersedes === undefined).map((d) => d.id);
  const files = (db.prepare("SELECT DISTINCT subject FROM events WHERE kind = 'edit' AND at > ?").all(since) as { subject: string }[]).map((r) => r.subject);
  const matchers = model.nodes.flatMap((n) => (n.kind === "component" ? [{ id: n.id, match: picomatch(n.paths) }] : []));
  const components = new Set<string>();
  for (const f of files) for (const m of matchers) if (m.match(f)) components.add(m.id);
  // Components a new decision shaped count as touched too.
  for (const d of ledger.filter((x) => decisions.includes(x.id))) for (const c of blastRadius(model, d.affects)) components.add(c);
  return { since, decisions, components: [...components].sort() };
}

export function isMilestone(work: Work, settings: GateSettings): boolean {
  return work.decisions.length >= settings.decisions || work.components.length >= settings.components;
}

function openRow(db: DatabaseSync): GateRow | undefined {
  return db.prepare("SELECT * FROM gates WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1").get() as GateRow | undefined;
}

/** The most salient of the work, at most `settings.subjects`, leaving out what the developer already knows well enough. */
export function pickSubjects(model: Model, ledger: Decision[], work: Work, familiarity: Record<string, number>, settings: GateSettings, now = new Date()): string[] {
  const ranked = [
    ...work.decisions.map((id) => {
      const d = ledger.find((x) => x.id === id)!;
      return { id, score: salience({ familiarity: familiarity[id] ?? 0, blastRadius: d.blastRadius, at: d.at, reversibility: d.reversibility }, now) };
    }),
    ...work.components.map((id) => {
      const n = model.nodes.find((x) => x.id === id);
      return { id, score: salience({ familiarity: familiarity[id] ?? 0, blastRadius: blastRadius(model, [id]).length, at: n?.changedAt }, now) };
    }),
  ];
  return ranked
    .filter((s) => (familiarity[s.id] ?? 0) < settings.threshold)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, settings.subjects)
    .map((s) => s.id);
}

/** The gate's question about one subject, with an answer key the grader checks against. */
export function gateQuestion(model: Model, ledger: Decision[], subject: string): { question: string; answer: string } {
  const d = ledger.find((x) => x.id === subject);
  if (d !== undefined) {
    const others = d.options.filter((o) => o.name !== d.chosen).map((o) => `"${o.name}"`);
    const chosen = d.options.find((o) => o.name === d.chosen);
    return {
      question: `${d.title}: why did Claude choose "${d.chosen}" over ${others.join(" or ")}, and what does it give up?`,
      answer: `${d.why} Trade-off of the choice: ${chosen?.tradeoff ?? "not recorded"}. Alternatives: ${d.options
        .filter((o) => o.name !== d.chosen)
        .map((o) => `${o.name} (${o.tradeoff})`)
        .join("; ")}.`,
    };
  }
  const node = model.nodes.find((n) => n.id === subject);
  const name = node && "name" in node ? node.name : subject;
  const role = node && "role" in node ? node.role : "";
  const dependents = blastRadius(model, [subject]).filter((c) => c !== subject);
  return {
    question: `In your own words: what is ${name} for, and what would stop working if it broke?`,
    answer: `${role}.${dependents.length > 0 ? ` Components that depend on it directly: ${dependents.join(", ")}.` : " Nothing else depends on it directly."}`,
  };
}

/**
 * Opens a gate if the work since the last one makes a milestone and no gate is open.
 * Returns the new gate, or undefined when nothing opened.
 */
export function checkMilestone(
  db: DatabaseSync,
  model: Model,
  ledger: Decision[],
  settings: GateSettings,
  session: string | undefined,
  now = new Date(),
): Gate | undefined {
  if (openRow(db) !== undefined) return undefined;
  const work = workSince(db, model, ledger, gateCursor(db, now));
  if (!isMilestone(work, settings)) return undefined;
  const familiarity = familiarityScores(db, now);
  const subjects = pickSubjects(model, ledger, work, familiarity, settings, now);
  const at = now.toISOString();
  db.exec("BEGIN");
  try {
    // Opened even when every subject is already known, so the next milestone counts from here; such a gate passes at once.
    const id = Number(db.prepare("INSERT INTO gates (opened_at, session, subjects) VALUES (?, ?, ?)").run(at, session ?? null, JSON.stringify(subjects)).lastInsertRowid);
    const insert = db.prepare("INSERT INTO quiz_items (created_at, subject, kind, question, due_at, answer, gate_id) VALUES (?, ?, 'why', ?, ?, ?, ?)");
    for (const s of subjects) {
      const q = gateQuestion(model, ledger, s);
      insert.run(at, s, q.question, at, q.answer, id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const gate = currentGate(db, model, ledger, settings, now);
  return gate?.closedAt === undefined ? gate : undefined;
}

function close(db: DatabaseSync, id: number, outcome: NonNullable<Gate["outcome"]>, now: Date): void {
  db.prepare("UPDATE gates SET closed_at = ?, outcome = ? WHERE id = ? AND closed_at IS NULL").run(now.toISOString(), outcome, id);
}

function describe(db: DatabaseSync, model: Model, ledger: Decision[], row: GateRow, settings: GateSettings, now: Date): Gate {
  const familiarity = familiarityScores(db, now);
  const items = db.prepare("SELECT id, subject, question FROM quiz_items WHERE gate_id = ?").all(row.id) as { id: number; subject: string; question: string }[];
  const answers = db.prepare("SELECT grade FROM quiz_answers WHERE item_id = ? AND at >= ? ORDER BY id DESC");
  const subjects = (JSON.parse(row.subjects) as string[]).map((id): GateSubject => {
    const item = items.find((i) => i.subject === id)!;
    const decision = ledger.find((d) => d.id === id);
    const node = model.nodes.find((n) => n.id === id);
    const given = answers.all(item.id, row.opened_at) as { grade: string | null }[];
    const score = familiarity[id] ?? 0;
    return {
      id,
      kind: decision ? "decision" : "component",
      name: decision?.title ?? (node && "name" in node ? node.name : id),
      familiarity: score,
      met: score >= settings.threshold,
      itemId: item.id,
      question: item.question,
      ...(decision ? { predicted: predictionFor(db, id) !== undefined } : {}),
      answered: given.length > 0,
      grading: given[0] !== undefined && given[0].grade === null,
      answers: given.length,
    };
  });
  return {
    id: row.id,
    openedAt: row.opened_at,
    ...(row.session !== null ? { session: row.session } : {}),
    threshold: settings.threshold,
    subjects,
    ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
  };
}

/**
 * The open gate as of now, closing it first if the developer has caught up, or
 * releasing it if every subject still short has been answered while background
 * jobs are failing, so a broken grader never holds work up. Undefined when no gate is open;
 * a gate closed by this call is returned once with its outcome.
 */
export function currentGate(db: DatabaseSync, model: Model, ledger: Decision[], settings: GateSettings, now = new Date()): Gate | undefined {
  const row = openRow(db);
  if (row === undefined) return undefined;
  const gate = describe(db, model, ledger, row, settings, now);
  const short = gate.subjects.filter((s) => !s.met);
  if (short.length === 0) {
    close(db, row.id, "passed", now);
    return { ...gate, closedAt: now.toISOString(), outcome: "passed" };
  }
  if (short.every((s) => s.answered) && jobHealth(db).failedInARow >= JOBS_DOWN) {
    close(db, row.id, "released", now);
    return { ...gate, closedAt: now.toISOString(), outcome: "released", note: "Background jobs are failing, so your answers could not be graded; they count as given." };
  }
  return gate;
}

/** Closes the open gate without catching up. Returns false when none was open. */
export function skipGate(db: DatabaseSync, now = new Date()): boolean {
  const row = openRow(db);
  if (row === undefined) return false;
  close(db, row.id, "skipped", now);
  return true;
}

/** Edits Claude made since the gate opened, to allow a few for finishing what was in hand. */
export function editsSinceGate(db: DatabaseSync, gate: Pick<Gate, "openedAt">): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'edit' AND at >= ?").get(gate.openedAt) as { n: number }).n;
}

/** Gates opened, passed, skipped and released, newest first. */
export function listGates(db: DatabaseSync, model: Model, ledger: Decision[], settings: GateSettings, limit = 20, now = new Date()): Gate[] {
  const rows = db.prepare("SELECT * FROM gates ORDER BY id DESC LIMIT ?").all(limit) as unknown as GateRow[];
  return rows.map((r) => describe(db, model, ledger, r, settings, now));
}

/** What still stands between the developer and Claude carrying on, in one line per subject. */
export function gateProgress(gate: Gate): string {
  const met = gate.subjects.filter((s) => s.met).length;
  return `${met} of ${gate.subjects.length} caught up`;
}

/** A cheap check, before reading the model: is any gate open? */
export function hasOpenGate(db: DatabaseSync): boolean {
  return openRow(db) !== undefined;
}
