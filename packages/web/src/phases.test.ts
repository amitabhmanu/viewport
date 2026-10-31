import type { Change, Model } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { PHASES, arrowText, boxNotes, changesByProcess, homeView, phaseOf, phaseStart, trail, viewTitle, zoomTarget } from "./labels.js";

const meta = { source: "agent", sync: "unverified" } as const;
const model = {
  version: 2,
  revision: 1,
  nodes: [
    { ...meta, kind: "process", id: "ordering", name: "Ordering", goal: "Buy" },
    { ...meta, kind: "step", id: "ordering.place", name: "Place", does: "Place it" },
    { ...meta, kind: "step", id: "ordering.refund", name: "Refund", does: "Refund it" },
    { ...meta, kind: "assumption", id: "full", name: "Full refund", statement: "Refunds are whole", status: "open" },
    { ...meta, kind: "entity", id: "order", name: "Order", description: "An order", sensitivity: "pii", code: [] },
    { ...meta, kind: "test", id: "checkout", name: "Checkout tests", paths: ["tests/*"] },
  ],
  edges: [
    { ...meta, kind: "contains", from: "ordering", to: "ordering.place" },
    { ...meta, kind: "contains", from: "ordering", to: "ordering.refund" },
    { ...meta, kind: "covers", from: "checkout", to: "ordering.place" },
  ],
} as Model;
const nodes = new Map(model.nodes.map((n) => [n.id, n]));

describe("today's changes by process", () => {
  const graph = {
    nodes: [
      { kind: "process", id: "ordering", name: "Ordering" },
      { kind: "process", id: "billing", name: "Billing" },
      { kind: "step", id: "ordering.place", name: "Place" },
      { kind: "component", id: "orders", name: "Orders" },
      { kind: "component", id: "shared", name: "Shared" },
      { kind: "component", id: "misc", name: "Misc" },
    ],
    edges: [
      { kind: "contains", from: "ordering", to: "ordering.place" },
      { kind: "implements", from: "orders", to: "ordering.place" },
      { kind: "implements", from: "shared", to: "ordering" },
      { kind: "implements", from: "shared", to: "billing" },
    ],
  } as unknown as Model;
  const change = (subject: string, nodes: string[] = [subject]) => ({ subject, what: "node", change: "changed", label: subject, nodes }) as Change;

  it("files a change under the process its part serves, under both if it serves two, and the rest last", () => {
    const groups = changesByProcess([change("misc"), change("orders"), change("shared"), change("ordering.place")], graph);
    expect(groups.map((g) => [g.process, g.changes.map((c) => c.subject)])).toEqual([
      ["ordering", ["orders", "shared", "ordering.place"]],
      ["billing", ["shared"]],
      [undefined, ["misc"]],
    ]);
  });

  it("finds a process through either end of a dependency, and leaves decisions with the rest", () => {
    const groups = changesByProcess([change("depends_on:misc->orders", ["misc", "orders"]), change("D-001", [])], graph);
    expect(groups.map((g) => g.process)).toEqual(["ordering", undefined]);
  });

  it("files rules, their assumptions, tests and data under the process they bear on", () => {
    const fuller = {
      nodes: [...graph.nodes, ...["rule", "assumption", "test", "entity", "runtime"].map((kind) => ({ kind, id: kind, name: kind }))],
      edges: [
        ...graph.edges,
        { kind: "constrained_by", from: "ordering.place", to: "rule" },
        { kind: "assumes", from: "rule", to: "assumption" },
        { kind: "covers", from: "test", to: "ordering.place" },
        { kind: "owns", from: "orders", to: "entity" },
      ],
    } as unknown as Model;
    const groups = changesByProcess(["rule", "assumption", "test", "entity", "runtime"].map((id) => change(id)), fuller);
    expect(groups.map((g) => [g.process, g.changes.map((c) => c.subject)])).toEqual([
      ["ordering", ["rule", "assumption", "test", "entity"]],
      [undefined, ["runtime"]],
    ]);
  });

  it("is one group when the model has no processes", () => {
    const groups = changesByProcess([change("orders")], { ...graph, nodes: [], edges: [] });
    expect(groups).toEqual([{ process: undefined, changes: [change("orders")] }]);
  });
});

describe("arrow text", () => {
  it("names what a part does with data, and keeps a branch's condition", () => {
    expect(arrowText("owns", undefined)).toBe("owns");
    expect(arrowText("reads", undefined)).toBe("reads");
    expect(arrowText("writes", undefined)).toBe("writes");
    expect(arrowText("next", "the order had shipped")).toBe("the order had shipped");
    expect(arrowText("depends_on", undefined)).toBeUndefined();
  });
});

describe("phases", () => {
  it("files every view under one phase", () => {
    expect(phaseOf("overview")?.label).toBe("Architecture");
    expect(phaseOf("components:app")?.label).toBe("Architecture");
    expect(phaseOf("process:ordering")?.label).toBe("Requirements");
    expect(phaseOf("rules")?.label).toBe("Requirements");
    expect(phaseOf("code-map")?.label).toBe("Build");
    expect(PHASES.map((p) => p.label)).toEqual(["Requirements", "Architecture", "Data", "Build", "Verification", "Deploy"]);
  });

  it("starts Requirements at the rules when there are no processes", () => {
    const requirements = PHASES[0]!;
    expect(phaseStart(requirements, model)).toBe("processes");
    expect(phaseStart(requirements, { ...model, nodes: model.nodes.filter((n) => n.kind !== "process") })).toBe("rules");
  });

  it("names process views, zooms into a process and finds the home of each kind", () => {
    expect(viewTitle("process:ordering", nodes)).toBe("Ordering");
    expect(viewTitle("coverage", nodes)).toBe("Test coverage");
    expect(trail("process:ordering")).toEqual(["processes", "process:ordering"]);
    expect(trail("data")).toEqual(["data"]);
    expect(zoomTarget(nodes.get("ordering")!)).toBe("process:ordering");
    expect(homeView(model, "ordering.place")).toBe("process:ordering");
    expect(homeView(model, "ordering")).toBe("processes");
    expect(homeView(model, "full")).toBe("rules");
    expect(homeView(model, "order")).toBe("data");
    expect(homeView(model, "checkout")).toBe("coverage");
  });

  it("notes personal data, assumptions to confirm and steps no test covers", () => {
    const notes = boxNotes(model);
    expect(notes.get("order")).toBe("Personal data");
    expect(notes.get("full")).toBe("To confirm");
    expect(notes.get("ordering.refund")).toBe("No tests");
    expect(notes.has("ordering.place")).toBe(false);
    // The process counts as covered once one of its steps is.
    expect(notes.has("ordering")).toBe(false);
  });

  it("says nothing about coverage before any tests are modeled", () => {
    const untested = { ...model, nodes: model.nodes.filter((n) => n.kind !== "test"), edges: model.edges.filter((e) => e.kind !== "covers") };
    expect(boxNotes(untested).has("ordering.refund")).toBe(false);
  });
});
