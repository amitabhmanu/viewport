import { describe, expect, it } from "vitest";
import { addPin, listPins, logEvent, removePin } from "./asks.js";
import { openState } from "./state.js";

describe("asks", () => {
  it("pins each query once, whatever its key order", () => {
    const db = openState(":memory:");
    addPin(db, "Path", { q: "trace", from: "app.api", to: "app.storage" });
    const again = addPin(db, "API to storage", { to: "app.storage", from: "app.api", q: "trace" } as never);
    addPin(db, "Async", { q: "slice", mode: "async" });
    expect(listPins(db).map((p) => p.title)).toEqual(["API to storage", "Async"]);
    removePin(db, again.id);
    expect(listPins(db).map((p) => p.query)).toEqual([{ q: "slice", mode: "async" }]);
    expect(() => addPin(db, "bad", { q: "nope" } as never)).toThrow();
  });

  it("logs events", () => {
    const db = openState(":memory:");
    logEvent(db, "query", "app.api", { q: "trace" }, "2026-10-30T10:00:00.000Z");
    expect(db.prepare("SELECT kind, subject, payload FROM events").all()).toEqual([{ kind: "query", subject: "app.api", payload: '{"q":"trace"}' }]);
  });
});
