import { describe, expect, it } from "vitest";
import { writeQuizItems } from "./engage.js";
import { applyGrade, gradeCase, gradeJsonSchema, gradePrompt, recentAnswers, subjectPaths, ungradedAnswers } from "./grade.js";
import { openJobs } from "./jobs.js";
import { answerQuiz } from "./quiz.js";
import type { Decision } from "./schema.js";
import { openState } from "./state.js";
import { shopModel } from "./test-helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const decision: Decision = {
  id: "D-001",
  at: "2026-10-30T10:00:00.000Z",
  title: "Call payments synchronously",
  options: [
    { name: "Sync", tradeoff: "simple" },
    { name: "Queue", tradeoff: "decoupled" },
  ],
  chosen: "Sync",
  why: "Checkout needs the charge result",
  reversibility: "costly",
  blastRadius: 2,
  affects: ["depends_on:app.orders->app.payments"],
  assumptions: [],
};

describe("grading", () => {
  it("queues a grade job for written answers only", () => {
    const db = openState(":memory:");
    const now = new Date("2026-10-30T10:00:00Z");
    const [why, predict] = writeQuizItems(
      db,
      [
        { subject: "app.orders", kind: "why", question: "Why sync?", answer: "Checkout needs the charge result." },
        { subject: "D-001", kind: "predict", question: "Which?", choices: ["Sync", "Queue"], answer: "Sync" },
      ],
      now,
    );
    const written = answerQuiz(db, why!, "It needs the result", 3, now);
    answerQuiz(db, predict!, "Sync", 3, now);
    expect(openJobs(db, "grade").map((j) => j.payload)).toEqual([{ answerId: written.answerId }]);
    expect(ungradedAnswers(db)).toEqual([]);
    expect(recentAnswers(db, now)).toMatchObject([{ answerId: written.answerId, answer: "It needs the result" }]);
    expect(recentAnswers(db, now)[0]).not.toHaveProperty("expected");
  });

  it("reschedules from the answer time, but only for the item's latest answer", () => {
    const db = openState(":memory:");
    const now = new Date("2026-10-30T10:00:00Z");
    const [id] = writeQuizItems(db, [{ subject: "app.orders", kind: "what-if", question: "If payments is down?", answer: "Checkout fails." }], now);
    const first = answerQuiz(db, id!, "orders fail", 3, now);
    const later = new Date(now.getTime() + DAY);
    const second = answerQuiz(db, id!, "checkout errors", 4, later);

    applyGrade(db, first.answerId, { grade: "wrong", feedback: "Old answer." });
    const step = () => (db.prepare("SELECT step, due_at FROM quiz_items WHERE id = ?").get(id!) as { step: number; due_at: string });
    expect(step().step).toBe(0);
    expect(step().due_at).toBe(second.nextDue);

    applyGrade(db, second.answerId, { grade: "correct", feedback: "Yes: checkout fails with it." });
    expect(step()).toEqual({ step: 1, due_at: new Date(later.getTime() + 3 * DAY).toISOString() });
    expect(recentAnswers(db, later)[0]).toMatchObject({ grade: "correct", feedback: "Yes: checkout fails with it.", expected: "Checkout fails." });
  });

  it("briefs the grader with the model and key, and names the code on a second look", () => {
    const db = openState(":memory:");
    const model = shopModel();
    const [id] = writeQuizItems(db, [{ subject: "D-001", kind: "why", question: "Why charge synchronously?", answer: "Checkout needs the result." }]);
    const { answerId } = answerQuiz(db, id!, "speed", 2);
    const c = gradeCase(db, answerId);

    const first = gradePrompt(model, [decision], c, false);
    expect(first).toContain('"chosen":"Sync"');
    expect(first).toContain("# Answer key\nCheckout needs the result.");
    expect(first).toContain("# Developer's answer\nspeed");
    expect(first).not.toContain("Second look");
    expect(gradePrompt(model, [decision], c, true)).toContain("The subject's code: src/shop/orders/**, src/shop/payments/**");

    expect(subjectPaths(model, [], "app")).toContain("src/shop/storage/**");
    expect(gradeJsonSchema()).not.toHaveProperty("$schema");
  });
});
