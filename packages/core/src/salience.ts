import { blastRadius } from "./model-edit.js";
import type { Decision, Model } from "./schema.js";

/** How much harder a change is to undo: weights from the architecture's salience score. */
export const REVERSIBILITY_WEIGHT: Record<Decision["reversibility"], number> = { "one-way": 3, costly: 1.5, easy: 1 };
/** Recency halves every this many days, so last week's change still beats last month's. */
export const RECENCY_HALF_LIFE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Old news still counts for something: a part nobody knows matters even when it is old. */
const RECENCY_FLOOR = 0.1;

export interface SalienceInput {
  familiarity: number;
  blastRadius: number;
  /** When the subject last changed, if known. */
  at?: string | undefined;
  reversibility?: Decision["reversibility"] | undefined;
}

export function recency(at: string | undefined, now: Date): number {
  if (at === undefined) return 0.5;
  const days = Math.max(0, (now.getTime() - Date.parse(at)) / DAY_MS);
  return Math.max(RECENCY_FLOOR, 0.5 ** (days / RECENCY_HALF_LIFE_DAYS));
}

/**
 * salience = (1 - familiarity) × blast radius × recency × reversibility weight.
 * New-to-you, wide-reaching and hard-to-undo rise; churn in familiar parts sinks.
 */
export function salience(input: SalienceInput, now = new Date()): number {
  const weight = input.reversibility ? REVERSIBILITY_WEIGHT[input.reversibility] : 1;
  return (1 - input.familiarity) * Math.max(1, input.blastRadius) * recency(input.at, now) * weight;
}

/** Salience of every node and decision, by id, for ranking the feed and the ledger. */
export function salienceScores(model: Model, ledger: Decision[], familiarity: Record<string, number>, now = new Date()): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const n of model.nodes) {
    if (n.kind === "decision") continue;
    scores[n.id] = salience({ familiarity: familiarity[n.id] ?? 0, blastRadius: blastRadius(model, [n.id]).length, at: n.changedAt }, now);
  }
  for (const d of ledger) {
    scores[d.id] = salience({ familiarity: familiarity[d.id] ?? 0, blastRadius: d.blastRadius, at: d.at, reversibility: d.reversibility }, now);
  }
  return scores;
}
