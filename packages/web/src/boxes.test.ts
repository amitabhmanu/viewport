import type { ModelNode, SplitView } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { arrowKeys, fit, kindsIn, wrap } from "./boxes.js";
import { subtitle } from "./labels.js";

// One pixel per character keeps the arithmetic readable.
const m = (text: string) => text.length;

describe("box text", () => {
  it("cuts text to the width it has, not a character count", () => {
    expect(fit("Orders", 10, "", m)).toBe("Orders");
    expect(fit("Refund shipped orders", 10, "", m)).toBe("Refund sh…");
  });

  it("wraps descriptions over two lines and marks what is left out", () => {
    expect(wrap("Charge the card, save the order, announce it", 20, 2, "", m)).toEqual(["Charge the card,", "save the order, ann…"]);
    expect(wrap("Mark the order cancelled", 20, 2, "", m)).toEqual(["Mark the order", "cancelled"]);
    expect(wrap("Short", 20, 2, "", m)).toEqual(["Short"]);
    expect(wrap("", 20, 2, "", m)).toEqual([]);
    expect(wrap("Supercalifragilisticexpialidocious word", 10, 2, "", m)).toEqual(["Supercali…", "word"]);
  });
});

describe("kinds and keys", () => {
  const nodes = new Map<string, ModelNode>(
    [
      { kind: "step", id: "a", name: "A", does: "x" },
      { kind: "step", id: "b", name: "B", does: "x" },
      { kind: "rule", id: "r", name: "R", statement: "x" },
    ].map((n) => [n.id, { ...n, source: "agent", sync: "ok" } as ModelNode]),
  );
  const part: SplitView = {
    id: "process:p#1",
    title: "P",
    part: 1,
    parts: 1,
    elements: ["a", "b", "r"],
    stubs: ["elsewhere"],
    continuesIn: {},
    edges: [
      { kind: "next", from: "a", to: "b", sources: [] },
      { kind: "constrained_by", from: "b", to: "r", sources: [] },
      { kind: "writes", from: "a", to: "r", sources: [] },
      { kind: "depends_on", from: "a", to: "b", sources: ["x"] },
      { kind: "depends_on", from: "b", to: "a", sources: ["y"] },
    ],
  };

  it("lists the kinds of the boxes shown, not of stubs", () => {
    expect(kindsIn(part, nodes)).toEqual(["step", "rule"]);
  });

  it("keys each kind of arrow once, splitting dependencies by how they connect", () => {
    const modes: Record<string, string> = { x: "sync", y: "async" };
    expect(arrowKeys(part, (s) => modes[s[0]!]).map((k) => k.label)).toEqual(["Then", "Bound by", "Calls", "Sends to, without waiting"]);
  });

  it("says where tests live in place of a description", () => {
    const one = { kind: "test", id: "t", name: "T", paths: ["tests/a.py"], source: "agent", sync: "ok" } as ModelNode;
    expect(subtitle(one, "medium")).toBe("tests/a.py");
    expect(subtitle({ ...one, paths: ["a", "b"] } as ModelNode, "medium")).toBe("2 sets of test files");
  });
});
