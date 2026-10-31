import { describe, expect, it } from "vitest";
import { EngageError, writeQuizItems } from "./engage.js";
import { answerQuiz, dueQuiz, schedule } from "./quiz.js";
import { openState } from "./state.js";

const DAY = 24 * 60 * 60 * 1000;

describe("quiz", () => {
  it("serves due questions without their answers, at most three a day", () => {
    const db = openState(":memory:");
    const created = new Date("2026-10-30T10:00:00");
    writeQuizItems(
      db,
      [1, 2, 3, 4].map((i) => ({ subject: "app.orders", kind: "why" as const, question: `q${i}`, answer: `a${i}` })),
      created,
    );
    const tomorrow = new Date(created.getTime() + DAY);
    expect(dueQuiz(db, created)).toEqual([]);
    const due = dueQuiz(db, tomorrow);
    expect(due.map((q) => q.question)).toEqual(["q1", "q2", "q3"]);
    expect(due[0]).not.toHaveProperty("answer");
    answerQuiz(db, due[0]!.id, "because", 4, tomorrow);
    expect(dueQuiz(db, tomorrow).map((q) => q.question)).toEqual(["q2", "q3"]);
  });

  it("grades predict items at once and climbs or resets the ladder", () => {
    const db = openState(":memory:");
    const now = new Date("2026-10-30T10:00:00Z");
    const [id] = writeQuizItems(db, [{ subject: "D-001", kind: "predict", question: "Which queue?", choices: ["Redis", "SQS"], answer: "SQS" }], now);
    expect(answerQuiz(db, id!, "SQS", 3, now)).toMatchObject({ grade: "correct", expected: "SQS", nextDue: new Date(now.getTime() + 3 * DAY).toISOString() });
    expect(answerQuiz(db, id!, "Redis", 5, now)).toMatchObject({ grade: "wrong", nextDue: new Date(now.getTime() + DAY).toISOString() });
    for (const _ of [1, 2, 3]) schedule(db, id!, "correct", now);
    expect(schedule(db, id!, "correct", now)).toBe("9999-12-31T00:00:00.000Z");
  });

  it("keeps ungraded answers on their rung and checks input", () => {
    const db = openState(":memory:");
    const now = new Date("2026-10-30T10:00:00Z");
    const [id] = writeQuizItems(db, [{ subject: "app.orders", kind: "what-if", question: "If storage slows?", answer: "Orders back up" }], now);
    const result = answerQuiz(db, id!, "Requests time out", 2, now);
    expect(result).not.toHaveProperty("grade");
    expect(result.nextDue).toBe(new Date(now.getTime() + DAY).toISOString());
    expect(() => answerQuiz(db, id!, "x", 6, now)).toThrow(EngageError);
    expect(() => answerQuiz(db, id!, " ", 3, now)).toThrow(EngageError);
    expect(() => writeQuizItems(db, [{ subject: "D-1", kind: "predict", question: "?", choices: ["a", "b"], answer: "c" }])).toThrow(EngageError);
  });
});
