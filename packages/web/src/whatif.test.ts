import type { Change, Decision, Model, ModelEdge, ModelNode, Prediction } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { askHref, askSubject, askTitle, askView, compareGroups, followUp, impactLines, parseAsk } from "./ask.js";

const meta = { source: "agent", sync: "unverified" } as const;
const model = {
  version: 2,
  revision: 3,
  nodes: [
    { ...meta, kind: "actor", id: "customer", name: "Customer", goal: "Buy" },
    { ...meta, kind: "component", id: "app.orders", name: "Orders", role: "Takes orders", paths: ["src/orders/**"] },
    { ...meta, kind: "component", id: "app.payments", name: "Payments", role: "Charges cards", paths: ["src/payments/**"] },
    { ...meta, kind: "process", id: "ordering", name: "Ordering", goal: "Buy things" },
    { ...meta, kind: "rule", id: "refunds", name: "Refund rule", statement: "Refund shipped orders" },
    { ...meta, kind: "decision", id: "d-002", name: "Call payments directly", reversibility: "easy", blastRadius: 2 },
  ],
  edges: [
    { ...meta, kind: "depends_on", from: "app.orders", to: "app.payments", mode: "sync" },
    { ...meta, kind: "decided_by", from: "depends_on:app.orders->app.payments", to: "d-002" },
  ],
} as Model;
const nodes = new Map(model.nodes.map((n) => [n.id, n] as [string, ModelNode]));
const decision = { id: "D-002", title: "Call payments directly", options: [], chosen: "x", why: "y", reversibility: "easy", blastRadius: 2, affects: [], assumptions: [], at: "2026-10-31T00:00:00Z" } as unknown as Decision;

describe("what-if and compare questions", () => {
  it("round-trip through the URL", () => {
    for (const query of [
      { q: "fails", node: "app.payments" },
      { q: "changes", node: "refunds" },
      { q: "compare", from: 4 },
      { q: "compare", from: 4, to: 9 },
      { q: "options", decision: "D-002" },
    ] as const) {
      expect(parseAsk(new URL(askHref(query), "http://x").searchParams)).toEqual(query);
    }
    expect(parseAsk(new URLSearchParams("q=compare&from=x"))).toBeUndefined();
    expect(parseAsk(new URLSearchParams("q=fails"))).toBeUndefined();
  });

  it("title and subject in plain words", () => {
    expect(askTitle({ q: "fails", node: "app.payments" }, nodes)).toBe("If Payments fails");
    expect(askTitle({ q: "changes", node: "refunds" }, nodes)).toBe("If Refund rule changes");
    expect(askTitle({ q: "compare", from: 4 }, nodes)).toBe("Revision 4 against now");
    expect(askTitle({ q: "options", decision: "D-002" }, nodes)).toBe("Options for Call payments directly");
    expect(askSubject({ q: "options", decision: "D-002" })).toBe("d-002");
    expect(askSubject({ q: "compare", from: 1 })).toBeUndefined();
  });

  it("draws every arrow kind but containment and decisions", () => {
    const edges = [
      { kind: "implements", from: "app.orders", to: "ordering" },
      { kind: "decided_by", from: "app.orders", to: "d-002" },
    ] as ModelEdge[];
    const view = askView({ nodes: ["app.orders", "ordering"], edges: ["implements:app.orders->ordering", "decided_by:app.orders->d-002"] }, edges, "t");
    expect(view.edges.map((e) => e.kind)).toEqual(["implements"]);
  });

  it("sums up an impact in lines", () => {
    expect(impactLines({ "app.payments": "fails", "app.orders": "down", ordering: "affected", customer: "affected" }, nodes)).toEqual([
      "Goes down: Orders.",
      "Processes affected: Ordering.",
      "People affected: Customer.",
    ]);
  });

  it("keeps steps apart from processes", () => {
    const withStep = new Map(nodes).set("place", { ...meta, kind: "step", id: "place", name: "Place order", does: "Save it" });
    expect(impactLines({ ordering: "affected", place: "affected" }, withStep)).toEqual(["Processes affected: Ordering.", "Steps affected: Place order."]);
  });

  it("splits a comparison into parts and connections, in plain words, added first", () => {
    const change = (subject: string, what: Change["what"], kind: Change["change"], label: string): Change => ({ subject, what, change: kind, label, nodes: [] });
    const groups = compareGroups(
      [
        change("refunds", "node", "changed", "Refund rule"),
        change("gone", "node", "removed", "Gone"),
        change("depends_on:app.orders->app.payments", "edge", "added", "Orders → Payments"),
        change("ordering", "node", "added", "Ordering"),
      ],
      nodes,
    );
    expect(groups.map((g) => [g.title, g.items.map((i) => `${i.change.label} (${i.what})`)])).toEqual([
      ["Parts", ["Ordering (process)", "Refund rule (business rule)", "Gone (part)"]],
      ["Connections", ["Orders → Payments (dependency)"]],
    ]);
    expect(compareGroups([change("ordering", "node", "added", "Ordering")], nodes).map((g) => g.title)).toEqual(["Parts"]);
  });

  it("ends with a decision to guess, else a what-if, on the most salient part", () => {
    const result = ["app.payments", "app.orders"];
    const salience = { "app.orders": 0.9, "app.payments": 0.1 };
    expect(followUp(result, "app.payments", model, [decision], [], salience)).toEqual({
      text: "Orders was shaped by “Call payments directly”. Can you guess which way it went?",
      href: "/ledger#D-002",
    });
    const guessed = [{ decisionId: "D-002" }] as Prediction[];
    expect(followUp(result, "app.payments", model, [decision], guessed, salience)).toEqual({
      text: "What would break if Orders failed?",
      href: "/ask?q=fails&node=app.orders",
    });
    expect(followUp(["customer"], undefined, model, [], [], {})).toBeUndefined();
  });
});
