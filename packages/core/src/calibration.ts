import type { DatabaseSync } from "node:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A partial answer counts as half right. */
const CREDIT = { correct: 1, partial: 0.5, wrong: 0 } as const;

export interface CalibrationBucket {
  /** Confidence given before the grade, 1 (guessing) to 5 (certain). */
  confidence: number;
  answers: number;
  /** Share right, partial answers counting half. */
  right: number;
}

export interface CalibrationWeek {
  /** Monday of the week, local time, as YYYY-MM-DD. */
  week: string;
  answers: number;
  /** Mean confidence mapped to 0–1 (1 → 0, 5 → 1), to compare with `right`. */
  sure: number;
  right: number;
}

export interface Calibration {
  buckets: CalibrationBucket[];
  weeks: CalibrationWeek[];
  answers: number;
}

function monday(at: string): string {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * How sure the developer was against how right they turned out, over graded quiz
 * answers from the last `weeks` weeks: by confidence level, and week by week.
 */
export function calibration(db: DatabaseSync, now = new Date(), weeks = 8): Calibration {
  const since = new Date(now.getTime() - weeks * 7 * DAY_MS).toISOString();
  const rows = db
    .prepare("SELECT at, confidence, grade FROM quiz_answers WHERE grade IS NOT NULL AND confidence IS NOT NULL AND at >= ? ORDER BY at")
    .all(since) as { at: string; confidence: number; grade: keyof typeof CREDIT }[];
  const buckets = [1, 2, 3, 4, 5].map((confidence) => {
    const mine = rows.filter((r) => r.confidence === confidence);
    return { confidence, answers: mine.length, right: mine.length === 0 ? 0 : mine.reduce((n, r) => n + CREDIT[r.grade], 0) / mine.length };
  });
  const byWeek = new Map<string, typeof rows>();
  for (const r of rows) byWeek.set(monday(r.at), [...(byWeek.get(monday(r.at)) ?? []), r]);
  const series = [...byWeek].map(([week, rs]) => ({
    week,
    answers: rs.length,
    sure: rs.reduce((n, r) => n + (r.confidence - 1) / 4, 0) / rs.length,
    right: rs.reduce((n, r) => n + CREDIT[r.grade], 0) / rs.length,
  }));
  return { buckets, weeks: series, answers: rows.length };
}
