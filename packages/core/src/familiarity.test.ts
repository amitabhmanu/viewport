import { describe, expect, it } from "vitest";
import { calibration } from "./calibration.js";
import { recordPrediction, writeQuizItems } from "./engage.js";
import { HALF_LIFE_DAYS, VIEW_CAP, addEvidence, familiarityScores } from "./familiarity.js";
import { applyGrade } from "./grade.js";
import { answerQuiz } from "./quiz.js";
import { recency, salience, salienceScores } from "./salience.js";
import type { Decision } from "./schema.js";
import { openState } from "./state.js";
import { shopModel } from "./test-helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-30T10:00:00Z");
const later = (days: number) => new Date(now.getTime() + days * DAY);

describe("familiarity", () => {
  it("rises most on right answers, falls on wrong ones and lookups, and halves every 14 days", () => {
    const db = openState(":memory:");
    addEvidence(db, ["app.orders"], "correct", now);
    expect(familiarityScores(db, now)["app.orders"]).toBeCloseTo(0.5);
    addEvidence(db, ["app.orders"], "partial", now);
    expect(familiarityScores(db, now)["app.orders"]).toBeCloseTo(0.575);
    addEvidence(db, ["app.orders"], "lookup", now);
    expect(familiarityScores(db, now)["app.orders"]).toBeCloseTo(0.525);
    addEvidence(db, ["app.orders"], "wrong", now);
    expect(familiarityScores(db, now)["app.orders"]).toBeCloseTo(0.2625);
    expect(familiarityScores(db, later(HALF_LIFE_DAYS))["app.orders"]).toBeCloseTo(0.13125);
  });

  it("lets views lift a score only up to a cap", () => {
    const db = openState(":memory:");
    for (let i = 0; i < 40; i++) addEvidence(db, ["app.storage"], "view", now);
    expect(familiarityScores(db, now)["app.storage"]).toBeCloseTo(VIEW_CAP);
    addEvidence(db, ["app.storage"], "correct", now);
    addEvidence(db, ["app.storage"], "view", now);
    expect(familiarityScores(db, now)["app.storage"]).toBeCloseTo(0.65);
  });

  it("learns from graded quiz answers and guesses at decisions", () => {
    const db = openState(":memory:");
    const [why, predict] = writeQuizItems(
      db,
      [
        { subject: "app.orders", kind: "why", question: "Why?", answer: "Because." },
        { subject: "D-001", kind: "predict", question: "Which?", choices: ["A", "B"], answer: "B" },
      ],
      now,
    );
    const { answerId } = answerQuiz(db, why!, "because", 4, now);
    expect(familiarityScores(db)).not.toHaveProperty("app.orders");
    applyGrade(db, answerId, { grade: "correct", feedback: "Yes." });
    answerQuiz(db, predict!, "A", 5, now);
    recordPrediction(db, { id: "D-002", chosen: "X", options: [{ name: "X", tradeoff: "" }] }, "X");
    const scores = familiarityScores(db);
    expect(scores["app.orders"]).toBeGreaterThan(0.4);
    expect(scores["D-001"]).toBe(0);
    expect(scores["D-002"]).toBeGreaterThan(0.4);
  });
});

describe("salience", () => {
  it("multiplies unfamiliarity, reach, recency and reversibility", () => {
    expect(salience({ familiarity: 0, blastRadius: 4, at: now.toISOString(), reversibility: "one-way" }, now)).toBe(12);
    expect(salience({ familiarity: 0.5, blastRadius: 4, at: now.toISOString(), reversibility: "costly" }, now)).toBe(3);
    expect(salience({ familiarity: 0, blastRadius: 0, at: later(-7).toISOString() }, now)).toBeCloseTo(0.5);
    expect(recency(later(-70).toISOString(), now)).toBe(0.1);
  });

  it("puts an unfamiliar one-way decision above a familiar wide one, and scores nodes by reach", () => {
    const decision = (id: string, blastRadius: number, reversibility: Decision["reversibility"]): Decision => ({
      id,
      at: now.toISOString(),
      title: id,
      options: [{ name: "A", tradeoff: "" }],
      chosen: "A",
      why: "",
      reversibility,
      blastRadius,
      affects: [],
      assumptions: [],
    });
    const scores = salienceScores(shopModel(), [decision("D-001", 2, "one-way"), decision("D-002", 5, "easy")], { "D-002": 0.8 }, now);
    expect(scores["D-001"]!).toBeGreaterThan(scores["D-002"]!);
    expect(scores.app!).toBeGreaterThan(scores["app.api"]!);
    expect(scores).not.toHaveProperty("d-001");
  });
});

describe("calibration", () => {
  it("compares confidence with grades by level and by week", () => {
    const db = openState(":memory:");
    const items = writeQuizItems(
      db,
      [1, 2, 3, 4].map((n) => ({ subject: "app.orders", kind: "why" as const, question: `q${n}`, answer: "a" })),
      now,
    );
    const grades = ["correct", "wrong", "partial", "correct"] as const;
    const confidences = [5, 5, 3, 1];
    items.forEach((id, i) => applyGrade(db, answerQuiz(db, id, "x", confidences[i]!, now).answerId, { grade: grades[i]!, feedback: "." }));
    answerQuiz(db, items[0]!, "ungraded", 4, now);

    const c = calibration(db, later(1));
    expect(c.answers).toBe(4);
    expect(c.buckets.map((b) => [b.answers, b.right])).toEqual([
      [1, 1],
      [0, 0],
      [1, 0.5],
      [0, 0],
      [2, 0.5],
    ]);
    expect(c.weeks).toHaveLength(1);
    expect(c.weeks[0]).toMatchObject({ answers: 4, sure: 0.625, right: 0.625 });
  });
});
