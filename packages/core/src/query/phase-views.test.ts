import { describe, expect, it } from "vitest";
import type { Model } from "../schema.js";
import { shopModelV2 } from "../test-helpers.js";
import { ModelGraph, QueryError } from "./graph.js";
import { buildView, checkCompleteness, splitByScenario, view } from "./views.js";

const meta = { source: "agent" as const, sync: "unverified" as const };
const shop = () => new ModelGraph(shopModelV2());
const arrows = (edges: { kind: string; from: string; to: string }[]) => edges.map((e) => `${e.kind}:${e.from}->${e.to}`);

/**
 * py-shop plus a longer returns process: request -> approve -> ship-back -> inspect
 * -> credit, with "rejected" branching from approve to close, and a rule on approve.
 */
function withReturns(): ModelGraph {
  const m: Model = shopModelV2();
  const steps = ["request", "approve", "ship-back", "inspect", "credit", "close"];
  m.nodes.push(
    { ...meta, kind: "process", id: "returns", name: "Returns", goal: "Take items back" },
    ...steps.map((s) => ({ ...meta, kind: "step" as const, id: `returns.${s}`, name: s, does: s })),
    { ...meta, kind: "rule", id: "thirty-days", name: "30 days", statement: "Returns are accepted within 30 days" },
    { ...meta, kind: "assumption", id: "calendar-days", name: "Calendar days", statement: "The 30 days are calendar days", status: "open" },
  );
  m.edges.push(
    ...steps.map((s) => ({ ...meta, kind: "contains" as const, from: "returns", to: `returns.${s}` })),
    ...[
      ["request", "approve"],
      ["approve", "ship-back"],
      ["ship-back", "inspect"],
      ["inspect", "credit"],
    ].map(([a, b]) => ({ ...meta, kind: "next" as const, from: `returns.${a}`, to: `returns.${b}` })),
    { ...meta, kind: "next", from: "returns.approve", to: "returns.close", when: "the request is rejected" },
    { ...meta, kind: "constrained_by", from: "returns.approve", to: "thirty-days" },
    { ...meta, kind: "assumes", from: "thirty-days", to: "calendar-days" },
  );
  return new ModelGraph(m);
}

describe("phase views", () => {
  it("overview grows to show the processes people use", () => {
    const v = buildView(shop(), "overview");
    expect(v.elements).toContain("ordering");
    expect(arrows(v.edges)).toContain("uses:customer->ordering");
  });

  it("processes view shows processes and who uses them", () => {
    const v = buildView(shop(), "processes");
    expect(v.elements).toEqual(["customer", "ordering"]);
    expect(arrows(v.edges)).toEqual(["uses:customer->ordering"]);
  });

  it("a process view shows steps, branch labels, rules and assumptions, but not components", () => {
    const v = buildView(shop(), "process:ordering");
    expect([...v.elements].sort()).toEqual(["full-refund", "ordering.cancel", "ordering.place", "ordering.refund", "refund-shipped"]);
    expect(v.edges.find((e) => e.kind === "next")).toMatchObject({ from: "ordering.cancel", to: "ordering.refund", label: "the order had shipped" });
    expect(arrows(v.edges)).toContain("constrained_by:ordering.refund->refund-shipped");
    expect(arrows(v.edges)).toContain("assumes:refund-shipped->full-refund");
    expect(() => buildView(shop(), "process:app")).toThrow(QueryError);
  });

  it("rules, data, coverage and deploy views", () => {
    const g = shop();
    expect(buildView(g, "rules").elements).toEqual(["full-refund", "refund-shipped"]);
    const data = buildView(g, "data");
    expect(data.elements).toEqual(["app.orders", "app.storage", "order"]);
    expect(arrows(data.edges)).toEqual(["owns:app.orders->order", "writes:app.storage->order"]);
    const cov = buildView(g, "coverage");
    expect(cov.elements).toEqual(["checkout-tests", "ordering"]);
    // The test covers a step; the view lifts it to the step's process.
    expect(cov.edges).toEqual([{ from: "checkout-tests", to: "ordering", kind: "covers", sources: ["covers:checkout-tests->ordering.place"] }]);
    const dep = buildView(g, "deploy");
    expect(dep.elements).toEqual(["app", "payment-provider", "server"]);
    expect(arrows(dep.edges)).toEqual(["depends_on:app->payment-provider", "runs_on:app->server"]);
  });

  it("says when a phase has nothing modeled yet", () => {
    const m = shopModelV2();
    m.nodes = m.nodes.filter((n) => n.kind !== "runtime" && n.kind !== "entity");
    m.edges = m.edges.filter((e) => e.kind !== "runs_on" && e.kind !== "owns" && e.kind !== "writes");
    expect(() => buildView(new ModelGraph(m), "deploy")).toThrow("no runtimes yet");
    expect(() => buildView(new ModelGraph(m), "data")).toThrow("no entities yet");
  });
});

describe("splitting a process by scenario", () => {
  it("keeps a process that fits whole", () => {
    expect(view(shop(), "process:ordering", "simple")).toHaveLength(1);
  });

  it("draws the main path first, then each branch, with rules beside their steps", () => {
    const g = withReturns();
    const full = buildView(g, "process:returns");
    const parts = splitByScenario(g, full, "simple");
    expect(parts.map((p) => p.title)).toEqual(["Returns: Main path", "Returns: Main path", "Returns: When the request is rejected"]);
    expect(parts[0]!.elements).toEqual(["returns.request", "returns.approve", "thirty-days", "calendar-days", "returns.ship-back"]);
    expect(parts[1]!.elements).toEqual(["returns.inspect", "returns.credit"]);
    // A step shared by two paths appears in both.
    expect(parts[2]!.elements).toContain("returns.approve");
    expect(parts[2]!.elements).toContain("returns.close");
    for (const p of parts) expect(p.elements.length).toBeLessThanOrEqual(5);
    expect(checkCompleteness(full, parts)).toEqual({ missingElements: [], missingEdges: [] });
    // The cut between the two main-path parts links across.
    expect(parts[1]!.continuesIn["returns.ship-back"]).toBe("process:returns#1");
  });

  it("shows the whole process at complex detail", () => {
    expect(view(withReturns(), "process:returns", "complex")).toHaveLength(1);
  });

  it("puts steps that no path reaches in a last part", () => {
    const m: Model = shopModelV2();
    const loop = ["a", "b", "c", "d", "e", "f"];
    m.nodes.push(
      { ...meta, kind: "process", id: "loop", name: "Loop", goal: "Go round" },
      ...loop.map((s) => ({ ...meta, kind: "step" as const, id: `loop.${s}`, name: s, does: s })),
    );
    m.edges.push(
      ...loop.map((s) => ({ ...meta, kind: "contains" as const, from: "loop", to: `loop.${s}` })),
      ...loop.map((s, i) => ({ ...meta, kind: "next" as const, from: `loop.${s}`, to: `loop.${loop[(i + 1) % loop.length]}` })),
    );
    const parts = view(new ModelGraph(m), "process:loop", "simple");
    expect(parts.flatMap((p) => p.elements).sort()).toEqual(loop.map((s) => `loop.${s}`));
  });
});
