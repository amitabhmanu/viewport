import type { DatabaseSync } from "node:sqlite";

/** Familiarity halves in this many days without fresh evidence. */
export const HALF_LIFE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Views alone never lift a score past this: exposure is not learning. */
export const VIEW_CAP = 0.3;

/**
 * What moves a familiarity score, from the architecture's human model. Generative
 * evidence (a right answer or guess) moves it most; having to look something up
 * lowers it a little; a flag is engagement, not understanding, so it moves nothing.
 */
export type Evidence = "correct" | "partial" | "wrong" | "lookup" | "view";

function apply(score: number, evidence: Evidence): number {
  switch (evidence) {
    case "correct":
      return score + 0.5 * (1 - score);
    case "partial":
      return score + 0.15 * (1 - score);
    case "wrong":
      return score * 0.5;
    case "lookup":
      return Math.max(0, score - 0.05);
    case "view":
      return score >= VIEW_CAP ? score : Math.min(VIEW_CAP, score + 0.02);
  }
}

/** A stored score decayed to `now`. */
export function decayed(score: number, updatedAt: string, now: Date): number {
  const days = Math.max(0, (now.getTime() - Date.parse(updatedAt)) / DAY_MS);
  return score * 0.5 ** (days / HALF_LIFE_DAYS);
}

/** Records evidence about the developer's grasp of each subject (a node id or decision id). */
export function addEvidence(db: DatabaseSync, subjects: string[], evidence: Evidence, now = new Date()): void {
  const get = db.prepare("SELECT score, updated_at FROM familiarity WHERE subject = ?");
  const put = db.prepare(
    "INSERT INTO familiarity (subject, score, updated_at) VALUES (?, ?, ?) ON CONFLICT(subject) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at",
  );
  for (const subject of new Set(subjects)) {
    const row = get.get(subject) as { score: number; updated_at: string } | undefined;
    const current = row ? decayed(row.score, row.updated_at, now) : 0;
    put.run(subject, apply(current, evidence), now.toISOString());
  }
}

/** Every subject's familiarity as of `now`; subjects with no evidence are 0 and left out. */
export function familiarityScores(db: DatabaseSync, now = new Date()): Record<string, number> {
  const rows = db.prepare("SELECT subject, score, updated_at FROM familiarity").all() as { subject: string; score: number; updated_at: string }[];
  return Object.fromEntries(rows.map((r) => [r.subject, decayed(r.score, r.updated_at, now)]));
}
