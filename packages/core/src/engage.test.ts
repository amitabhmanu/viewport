import { describe, expect, it } from "vitest";
import { EngageError, raiseFlag, resolveFlag, unresolvedFlags, writeQuizItems } from "./engage.js";
import { openState } from "./state.js";

describe("flags", () => {
  it("lists unresolved flags oldest first and resolves them with an optional decision", () => {
    const db = openState(":memory:");
    raiseFlag(db, "app.orders", "why not a queue?", "2026-10-30T10:00:00.000Z");
    const second = raiseFlag(db, "D-001", "is this one-way?", "2026-10-30T11:00:00.000Z");
    expect(unresolvedFlags(db).map((f) => f.subject)).toEqual(["app.orders", "D-001"]);

    const resolved = resolveFlag(db, second.id, "Logged a replacement", "D-002");
    expect(resolved).toMatchObject({ status: "resolved", answer: "Logged a replacement", decisionId: "D-002" });
    expect(unresolvedFlags(db).map((f) => f.subject)).toEqual(["app.orders"]);
    expect(() => resolveFlag(db, 99, "x")).toThrow(EngageError);
  });
});

describe("writeQuizItems", () => {
  it("stores items due a day later", () => {
    const db = openState(":memory:");
    const now = new Date("2026-10-30T10:00:00.000Z");
    const ids = writeQuizItems(db, [{ subject: "D-001", kind: "predict", question: "Which queue?", choices: ["Redis", "SQS"] }], now);
    const row = db.prepare("SELECT * FROM quiz_items WHERE id = ?").get(ids[0]!) as { due_at: string; choices: string };
    expect(row.due_at).toBe("2026-10-31T10:00:00.000Z");
    expect(JSON.parse(row.choices)).toEqual(["Redis", "SQS"]);
  });

  it("rejects a predict item without choices and stores none of the batch", () => {
    const db = openState(":memory:");
    expect(() =>
      writeQuizItems(db, [
        { subject: "app.orders", kind: "why", question: "Why sync?" },
        { subject: "D-001", kind: "predict", question: "Which queue?" },
      ]),
    ).toThrow(/two choices/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM quiz_items").get()).toEqual({ n: 0 });
  });
});
