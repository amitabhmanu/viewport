import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { areaLevel, comprehensionDebt, dailyDigest, digestLine, dismissSuggestion, setAreaLevel, takeDigestTurn } from "./adapt.js";
import { recordPrediction, resolveFlag, raiseFlag, writeQuizItems } from "./engage.js";
import { answerQuiz, dueQuiz } from "./quiz.js";
import { openState } from "./state.js";
import type { Decision } from "./schema.js";
import { shopModelV2 } from "./test-helpers.js";
import { applyGrade } from "./grade.js";

const NOW = new Date("2026-11-02T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const model = shopModelV2();

const decision = (id: string, reversibility: Decision["reversibility"], at: Date, extra: Partial<Decision> = {}): Decision => ({
  id,
  at: at.toISOString(),
  title: `Call ${id}`,
  options: [
    { name: "A", tradeoff: "a" },
    { name: "B", tradeoff: "b" },
  ],
  chosen: "A",
  why: "because",
  reversibility,
  blastRadius: 2,
  affects: [],
  assumptions: [],
  ...extra,
} as Decision);

let db: DatabaseSync;
beforeEach(() => {
  db = openState(":memory:");
});
afterEach(() => db.close());

/** Answers `grades` about a subject, a day apart, each graded as given. */
function answer(subject: string, grades: ("correct" | "partial" | "wrong")[], stretch = false, from = ago(5)): void {
  grades.forEach((grade, i) => {
    const at = new Date(from.getTime() + i * 1000);
    const [id] = writeQuizItems(db, [{ subject, kind: "why", question: `Q${subject}${i}${stretch}${from.getTime()}`, answer: "a", ...(stretch ? { stretch } : {}) }], ago(9));
    const { answerId } = answerQuiz(db, id!, "my answer", 3, at);
    applyGrade(db, answerId, { grade, feedback: "ok" });
  });
}

describe("detail level per area", () => {
  it("defaults to medium, remembers per view, and a level in the link wins", () => {
    expect(areaLevel(db, model, "components:app").level).toBe("medium");
    setAreaLevel(db, "components:app", "simple", ago(1));
    expect(areaLevel(db, model, "components:app").level).toBe("simple");
    expect(areaLevel(db, model, "containers").level).toBe("medium");
    expect(areaLevel(db, model, "components:app", "complex").level).toBe("complex");
  });

  it("suggests stepping up after right answers about the area, and never changes the level", () => {
    answer("app.orders", ["correct", "correct", "correct"]);
    const area = areaLevel(db, model, "components:app");
    expect(area.suggestion).toEqual({ to: "complex", answers: 3, right: 3 });
    expect(area.level).toBe("medium");
  });

  it("suggests stepping down after wrong answers", () => {
    answer("app.orders", ["wrong", "wrong", "correct", "wrong"]);
    expect(areaLevel(db, model, "components:app").suggestion?.to).toBe("simple");
  });

  it("says nothing on too few answers, mixed answers, at the end of the ladder, or about other areas", () => {
    answer("app.orders", ["correct", "correct"]);
    expect(areaLevel(db, model, "components:app").suggestion).toBeUndefined();
    answer("app.payments", ["wrong", "partial"]);
    expect(areaLevel(db, model, "components:app").suggestion).toBeUndefined();
    expect(areaLevel(db, model, "deploy").suggestion).toBeUndefined();
    answer("app.storage", ["correct", "correct", "correct", "correct"]);
    expect(areaLevel(db, model, "components:app", "complex").suggestion).toBeUndefined();
  });

  it("counts a right answer posed a level up as more evidence", () => {
    answer("app.orders", ["correct", "correct"], true);
    expect(areaLevel(db, model, "components:app").suggestion?.to).toBe("complex");
  });

  it("starts the evidence over when a suggestion is turned down or a level chosen", () => {
    answer("app.orders", ["correct", "correct", "correct"]);
    dismissSuggestion(db, "components:app", ago(1));
    expect(areaLevel(db, model, "components:app").suggestion).toBeUndefined();
    expect(areaLevel(db, model, "components:app").level).toBe("medium");
    setAreaLevel(db, "components:app", "simple", ago(1));
    dismissSuggestion(db, "components:app", ago(1));
    expect(areaLevel(db, model, "components:app").level).toBe("simple");
    answer("app.orders", ["correct", "correct", "correct"], false, NOW);
    expect(areaLevel(db, model, "components:app").suggestion?.to).toBe("medium");
  });

  it("copes with a view that has nothing in it", () => {
    expect(areaLevel(db, { ...model, nodes: [], edges: [] }, "process:nope").suggestion).toBeUndefined();
  });
});

describe("questions posed a level up", () => {
  it("come at most one a day, and do not use up the allowance", () => {
    writeQuizItems(db, [
      { subject: "app.orders", kind: "why", question: "Hard one", stretch: true },
      { subject: "app.orders", kind: "why", question: "Hard two", stretch: true },
      { subject: "app.orders", kind: "why", question: "Plain", },
    ], ago(9));
    const due = dueQuiz(db, NOW);
    expect(due.map((q) => q.question)).toEqual(["Hard one", "Plain"]);
    expect(due[0]!.stretch).toBe(true);
    answerQuiz(db, due[0]!.id, "x", 3, NOW);
    expect(dueQuiz(db, NOW).map((q) => q.question)).toEqual(["Plain"]);
  });
});

describe("comprehension debt", () => {
  it("is reach times what the developer has not shown they know, most first", () => {
    const debt = comprehensionDebt(model, {});
    expect(debt.gap).toBe(100);
    const first = debt.items[0]!;
    expect(first.debt).toBe(first.reach);
    expect(first.band).toBe("high");
    for (let i = 1; i < debt.items.length; i++) expect(debt.items[i - 1]!.debt).toBeGreaterThanOrEqual(debt.items[i]!.debt);
  });

  it("falls as familiarity rises, and a well-known part carries no band however central", () => {
    const widest = comprehensionDebt(model, {}).items[0]!;
    const debt = comprehensionDebt(model, { [widest.id]: 0.9 });
    const part = debt.items.find((i) => i.id === widest.id)!;
    expect(part.debt).toBeCloseTo(widest.reach * 0.1);
    expect(part.band).toBeUndefined();
    expect(debt.gap).toBeLessThan(100);
  });

  it("averages over a container's components, and is zero with nothing to know", () => {
    expect(comprehensionDebt(model, {}).containers.map((c) => c.id)).toEqual(["app"]);
    expect(comprehensionDebt({ ...model, nodes: [], edges: [] }, {})).toEqual({ gap: 0, items: [], containers: [] });
  });
});

describe("daily digest", () => {
  it("keeps to the last day and at most three, and counts the rest", () => {
    const ledger = [decision("D-001", "easy", ago(3)), ...["D-002", "D-003", "D-004", "D-005"].map((id) => decision(id, "easy", ago(0.5)))];
    const digest = dailyDigest(db, model, ledger, {}, NOW);
    expect(digest.decisions).toHaveLength(3);
    expect(digest.decisions.map((d) => d.id)).not.toContain("D-001");
    expect(digest.moreDecisions).toBe(1);
  });

  it("holds one-way decisions until looked at, however old, and leaves out replaced ones", () => {
    const old = decision("D-001", "one-way", ago(20));
    const replaced = decision("D-002", "one-way", ago(20));
    const replacing = decision("D-003", "easy", ago(20), { supersedes: "D-002" });
    const ledger = [old, replaced, replacing];
    expect(dailyDigest(db, model, ledger, {}, NOW).oneWay.map((d) => d.id)).toEqual(["D-001"]);
    recordPrediction(db, old, undefined, NOW.toISOString());
    expect(dailyDigest(db, model, ledger, {}, NOW).oneWay).toEqual([]);
  });

  it("puts a one-way decision first in one line, and has nothing to say on a quiet day", () => {
    expect(digestLine(dailyDigest(db, model, [], {}, NOW))).toBeUndefined();
    const flag = raiseFlag(db, "app.orders", "Why?", ago(2).toISOString());
    resolveFlag(db, flag.id, "Because", undefined, ago(0.2).toISOString());
    writeQuizItems(db, [{ subject: "app.orders", kind: "why", question: "Q" }], ago(9));
    const line = digestLine(dailyDigest(db, model, [decision("D-001", "one-way", ago(0.5))], {}, NOW));
    expect(line).toBe('Viewport: 1 one-way decision to look at, starting with "Call D-001", 1 new decision since yesterday, 1 question due, 1 answer from Claude. See Today in the viewer.');
  });

  it("gets one turn a day", () => {
    expect(takeDigestTurn(db, NOW)).toBe(true);
    expect(takeDigestTurn(db, new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(takeDigestTurn(db, new Date(NOW.getTime() + DAY))).toBe(true);
  });
});
