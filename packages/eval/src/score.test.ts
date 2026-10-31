import type { Decision } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { BASELINES } from "./baselines.js";
import { GRADER_LEDGER, GRADER_SET } from "./grader-set.js";
import { type RunScore, agreement, editsBeforeAnswer, gate, leftoverFindings, matchDecisions, median, totalTokens } from "./score.js";
import { TASKS } from "./tasks.js";

const decision = (id: string, title: string, chosen = "A", why = "because"): Decision => ({
  id,
  at: "2026-10-30T10:00:00.000Z",
  title,
  options: [
    { name: "A", tradeoff: "one" },
    { name: "B", tradeoff: "two" },
  ],
  chosen,
  why,
  reversibility: "easy",
  blastRadius: 1,
  affects: [],
  assumptions: [],
});

describe("matchDecisions", () => {
  it("finds the logged decision covering each expected one", () => {
    const expected = TASKS.find((t) => t.id === "ts-sharing")!.expected;
    const ledger = [decision("D-001", "Where sharing logic lives: a separate module"), decision("D-002", "How shares are stored: a list on each note")];
    expect(matchDecisions(expected, ledger).map((m) => m.matchedBy)).toEqual(["D-002", "D-001"]);
  });

  it("lets one entry that records two choices cover both", () => {
    const expected = TASKS.find((t) => t.id === "py-shipping")!.expected;
    const ledger = [decision("D-001", "Email client lives in notifications; sent on queue dispatch")];
    expect(matchDecisions(expected, ledger).map((m) => m.matchedBy)).toEqual(["D-001", "D-001"]);
  });

  it("leaves an expected decision unmatched when nothing covers it", () => {
    const expected = TASKS.find((t) => t.id === "py-refunds")!.expected;
    expect(matchDecisions(expected, [decision("D-001", "Rename a variable")])).toEqual([{ expected: expected[0]!.id }]);
  });
});

describe("leftoverFindings and totalTokens", () => {
  it("lists every kind of finding", () => {
    const left = leftoverFindings({
      scope: "full",
      files: 3,
      unclaimed: ["a.py"],
      doubleClaimed: [],
      missingDependencies: [{ from: "x", to: "y", evidence: [] }],
      unsupportedEdges: [],
      staleComponents: ["z"],
      unknownFreshness: [],
      emptyTests: ["t"],
      notes: [],
      durationMs: 1,
    });
    expect(left).toEqual(["unclaimed a.py", "missing x -> y", "changed since modeled z", "empty test group t"]);
  });

  it("sums tokens over every model", () => {
    expect(
      totalTokens({ modelUsage: { a: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }, b: { outputTokens: 10 } } }),
    ).toBe(20);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("gate", () => {
  const run = (over: Partial<RunScore>): RunScore => ({
    task: "t",
    ok: true,
    decisions: [{ expected: "e", matchedBy: "D-001" }],
    logged: 1,
    leftover: [],
    hookMs: [150, 200],
    tokens: 110,
    costUsd: 0.1,
    baselineTokens: 100,
    ...over,
  });

  it("passes when every threshold is met", () => {
    expect(gate([run({})]).pass).toBe(true);
  });

  it("fails on leftover findings, missed decisions, slow hooks or token overhead", () => {
    expect(gate([run({ leftover: ["unclaimed a.py"] })]).pass).toBe(false);
    expect(gate([run({ decisions: [{ expected: "e" }] })]).pass).toBe(false);
    expect(gate([run({ hookMs: [400, 500] })]).pass).toBe(false);
    expect(gate([run({ tokens: 200 })]).checks.find((c) => c.name === "plugin token overhead")?.pass).toBe(false);
  });

  it("skips the overhead check without a baseline", () => {
    const { baselineTokens: _b, ...noBaseline } = run({});
    expect(gate([noBaseline]).checks.map((c) => c.name)).not.toContain("plugin token overhead");
  });
});

describe("agreement", () => {
  it("counts matching grades, with errors as misses", () => {
    const score = agreement([
      { label: "correct", grade: "correct" },
      { label: "partial", grade: "wrong" },
      { label: "wrong" },
      { label: "wrong", grade: "wrong" },
    ]);
    expect(score).toEqual({ agreed: 2, total: 4, rate: 0.5, confusion: { "correct → correct": 1, "partial → wrong": 1, "wrong → error": 1, "wrong → wrong": 1 } });
  });
});

describe("grader set", () => {
  it("has 30 labelled answers about subjects the model or ledger knows, with every grade represented", () => {
    const ids = new Set([...BASELINES["py-shop"].nodes.map((n) => (n as { id: string }).id), ...GRADER_LEDGER.map((d) => d.id)]);
    const answers = GRADER_SET.flatMap((q) => q.answers);
    expect(answers).toHaveLength(30);
    expect(GRADER_SET.every((q) => ids.has(q.subject))).toBe(true);
    const counts = answers.reduce<Record<string, number>>((n, [, label]) => ({ ...n, [label]: (n[label] ?? 0) + 1 }), {});
    expect(Object.values(counts).every((n) => n >= 8)).toBe(true);
  });
});

describe("editsBeforeAnswer", () => {
  const turn = (id: string, ...names: string[]) => JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { id, content: names.map((name) => ({ type: "tool_use", name })) } });
  const resolve = "mcp__plugin_viewport_viewport__flags_resolve";

  it("skips edits issued in the same turn as the one that delivered the flag", () => {
    const transcript = [turn("m1", "Read", "Edit"), turn("m2", "Edit", "Edit", "Edit"), turn("m3", resolve), turn("m4", "Edit")].join("\n");
    // Edit events 1, 3, 4, 5, 7 with the flag raised as event 2: edit 3 delivers it, in turn m2.
    expect(editsBeforeAnswer(transcript, [1, 3, 4, 5, 7], 2)).toBe(0);
  });

  it("counts edits in later turns until the answer, and ignores subagents", () => {
    const sub = JSON.stringify({ type: "assistant", parent_tool_use_id: "t1", message: { id: "s1", content: [{ type: "tool_use", name: "Edit" }] } });
    const transcript = [turn("m1", "Edit"), turn("m2", "Edit"), sub, turn("m3", "Write"), turn("m4", "Edit", resolve)].join("\n");
    expect(editsBeforeAnswer(transcript, [1, 3, 4, 5], 2)).toBe(2);
    expect(editsBeforeAnswer([turn("m1", "Edit")].join("\n"), [1], 0)).toBeUndefined();
  });
});
