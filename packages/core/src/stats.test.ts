import { describe, expect, it } from "vitest";
import { logEvent } from "./asks.js";
import { markSeen } from "./changes.js";
import { raiseFlag, recordPrediction, resolveFlag, writeQuizItems } from "./engage.js";
import { applyGrade } from "./grade.js";
import { answerQuiz } from "./quiz.js";
import { openState } from "./state.js";
import { engagementStats, formatStats } from "./stats.js";

describe("engagementStats", () => {
  it("counts a week of engagement from state.db", () => {
    const db = openState(":memory:");
    const now = new Date();
    const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    logEvent(db, "edit", "a.ts");
    logEvent(db, "edit", "b.ts");
    logEvent(db, "edit", "c.ts", {}, old);
    logEvent(db, "query", "app.api");
    recordPrediction(db, { id: "D-001", chosen: "A", options: [{ name: "A", tradeoff: "" }] }, "A");
    recordPrediction(db, { id: "D-002", chosen: "A", options: [{ name: "A", tradeoff: "" }] }, undefined);
    const flag = raiseFlag(db, "app.orders", "why?", new Date(now.getTime() - 4 * 60_000).toISOString());
    resolveFlag(db, flag.id, "because");
    raiseFlag(db, "app.api", "and this?");
    const [a, b] = writeQuizItems(db, [1, 2].map((n) => ({ subject: "app.orders", kind: "why" as const, question: `q${n}`, answer: "k" })));
    applyGrade(db, answerQuiz(db, a!, "x", 5).answerId, { grade: "wrong", feedback: "." });
    answerQuiz(db, b!, "y", 3);
    markSeen(db, ["app.orders"], 1);

    const s = engagementStats(db, new Date(Date.now() + 1000));
    expect(s).toMatchObject({
      edits: 2,
      predictions: { made: 1, correct: 1, skipped: 1 },
      quiz: { answered: 2, correct: 0, wrong: 1, ungraded: 1 },
      flags: { raised: 2, answered: 1 },
      lookups: 1,
      viewed: 1,
      calibrationGap: 1,
    });
    expect(s.flags.medianMinutesToAnswer).toBeGreaterThanOrEqual(4);
    expect(formatStats(s)).toContain("| Predictions made (right) | 1 (100%); 1 skipped |");
    expect(formatStats(s)).toContain("| Calibration gap (sure minus right) | +1 |");
  });
});
