import type { DatabaseSync } from "node:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;
const CREDIT: Record<string, number> = { correct: 1, partial: 0.5, wrong: 0 };

/** The dogfood numbers for a period, all from state.db. */
export interface EngagementStats {
  since: string;
  until: string;
  edits: number;
  predictions: { made: number; correct: number; skipped: number };
  quiz: { answered: number; correct: number; partial: number; wrong: number; ungraded: number };
  flags: { raised: number; answered: number; medianMinutesToAnswer?: number };
  /** Traces and slices the developer ran: each one is a part they had to look up. */
  lookups: number;
  /** Changes opened from the viewer. */
  viewed: number;
  /** Mean confidence (as 0–1) minus mean credit over graded answers: above 0 is overconfident. */
  calibrationGap?: number;
  jobs: { done: number; failed: number };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Engagement over the last `days` days, for the weekly dogfood export. */
export function engagementStats(db: DatabaseSync, now = new Date(), days = 7): EngagementStats {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const until = now.toISOString();
  const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(since, until, ...args) as { n: number }).n;
  const events = (kind: string) => count("SELECT COUNT(*) AS n FROM events WHERE at >= ? AND at <= ? AND kind = ?", kind);

  const predictions = db.prepare("SELECT skipped, correct FROM predictions WHERE at >= ? AND at <= ?").all(since, until) as { skipped: number; correct: number | null }[];
  const answers = db.prepare("SELECT confidence, grade FROM quiz_answers WHERE at >= ? AND at <= ?").all(since, until) as { confidence: number | null; grade: string | null }[];
  const graded = answers.filter((a) => a.grade !== null && a.confidence !== null);
  const flags = db.prepare("SELECT at, resolved_at FROM flags WHERE at >= ? AND at <= ?").all(since, until) as { at: string; resolved_at: string | null }[];
  const answeredFlags = flags.filter((f) => f.resolved_at !== null);
  const minutes = median(answeredFlags.map((f) => (Date.parse(f.resolved_at!) - Date.parse(f.at)) / 60_000));
  const jobs = db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE created_at >= ? AND created_at <= ? GROUP BY status").all(since, until) as { status: string; n: number }[];
  const jobCount = (status: string) => jobs.find((j) => j.status === status)?.n ?? 0;

  return {
    since,
    until,
    edits: events("edit"),
    predictions: {
      made: predictions.filter((p) => p.skipped === 0).length,
      correct: predictions.filter((p) => p.correct === 1).length,
      skipped: predictions.filter((p) => p.skipped === 1).length,
    },
    quiz: {
      answered: answers.length,
      correct: answers.filter((a) => a.grade === "correct").length,
      partial: answers.filter((a) => a.grade === "partial").length,
      wrong: answers.filter((a) => a.grade === "wrong").length,
      ungraded: answers.filter((a) => a.grade === null).length,
    },
    flags: { raised: flags.length, answered: answeredFlags.length, ...(minutes !== undefined ? { medianMinutesToAnswer: Math.round(minutes * 10) / 10 } : {}) },
    lookups: count("SELECT COUNT(*) AS n FROM events WHERE at >= ? AND at <= ? AND kind = 'query'"),
    viewed: count("SELECT COUNT(*) AS n FROM cursors WHERE at >= ? AND at <= ? AND name LIKE 'seen:%'"),
    ...(graded.length > 0
      ? {
          calibrationGap:
            Math.round(
              (graded.reduce((n, a) => n + (a.confidence! - 1) / 4, 0) / graded.length - graded.reduce((n, a) => n + (CREDIT[a.grade!] ?? 0), 0) / graded.length) * 100,
            ) / 100,
        }
      : {}),
    jobs: { done: jobCount("done"), failed: jobCount("failed") },
  };
}

/** The stats as a short Markdown block for the dogfood log. */
export function formatStats(s: EngagementStats): string {
  const pct = (n: number, of: number) => (of === 0 ? "–" : `${Math.round((n / of) * 100)}%`);
  return [
    `### ${s.since.slice(0, 10)} to ${s.until.slice(0, 10)}`,
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Claude's edits | ${s.edits} |`,
    `| Predictions made (right) | ${s.predictions.made} (${pct(s.predictions.correct, s.predictions.made)}); ${s.predictions.skipped} skipped |`,
    `| Quiz answers | ${s.quiz.answered}: ${s.quiz.correct} right, ${s.quiz.partial} partly, ${s.quiz.wrong} wrong, ${s.quiz.ungraded} ungraded |`,
    `| Flags raised (answered) | ${s.flags.raised} (${s.flags.answered})${s.flags.medianMinutesToAnswer !== undefined ? `, median ${s.flags.medianMinutesToAnswer} min to answer` : ""} |`,
    `| Lookups (trace or slice) | ${s.lookups} |`,
    `| Changes opened | ${s.viewed} |`,
    `| Calibration gap (sure minus right) | ${s.calibrationGap === undefined ? "–" : `${s.calibrationGap > 0 ? "+" : ""}${s.calibrationGap}`} |`,
    `| Background jobs (failed) | ${s.jobs.done + s.jobs.failed} (${s.jobs.failed}) |`,
  ].join("\n");
}
