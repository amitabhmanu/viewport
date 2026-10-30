import { describe, expect, it } from "vitest";
import { Decision, Model, ModelEdge } from "./schema.js";
import { shopModel } from "./test-helpers.js";

function issues(m: unknown): string[] {
  const r = Model.safeParse(m);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe("Model", () => {
  it("accepts the py-shop model", () => {
    expect(issues(shopModel())).toEqual([]);
  });

  it("fills defaults for source and sync", () => {
    const m = shopModel();
    const raw = { ...m, nodes: m.nodes.map(({ source: _s, sync: _y, ...n }) => n) };
    const parsed = Model.parse(raw);
    expect(parsed.nodes.every((n) => n.source === "agent" && n.sync === "unverified")).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const m = shopModel();
    m.nodes.push({ ...m.nodes[0]! });
    expect(issues(m)).toContain("duplicate node id 'shop'");
  });

  it("rejects edges to unknown nodes", () => {
    const m = shopModel();
    m.edges.push({ kind: "depends_on", from: "app.api", to: "app.missing", mode: "sync", source: "agent", sync: "unverified" });
    expect(issues(m).join()).toMatch(/unknown node 'app.missing'/);
  });

  it("rejects a component outside any container", () => {
    const m = shopModel();
    m.edges = m.edges.filter((e) => !(e.kind === "contains" && e.to === "app.api"));
    expect(issues(m)).toContain("component 'app.api' is not inside any container");
  });

  it("rejects a system containing a component directly", () => {
    const m = shopModel();
    m.edges.push({ kind: "contains", from: "shop", to: "app.api", source: "agent", sync: "unverified" });
    expect(issues(m).join()).toMatch(/cannot contain a component|has 2 parents/);
  });

  it("rejects decided_by pointing at a non-decision", () => {
    const m = shopModel();
    m.edges.push({ kind: "decided_by", from: "app.api", to: "app.orders", source: "agent", sync: "unverified" });
    expect(issues(m)).toContain("decided_by must point to a decision, not a component");
  });

  it("rejects decided_by from an unknown edge key", () => {
    const m = shopModel();
    m.edges.push({ kind: "decided_by", from: "depends_on:app.api->app.storage", to: "d-001", source: "agent", sync: "unverified" });
    expect(issues(m).join()).toMatch(/unknown node or edge/);
  });

  it("rejects components without paths", () => {
    const m = shopModel();
    const api = m.nodes.find((n) => n.id === "app.api");
    if (api?.kind === "component") api.paths = [];
    expect(issues(m).length).toBeGreaterThan(0);
  });
});

describe("ModelEdge", () => {
  it("requires a mode on depends_on and forbids it elsewhere", () => {
    expect(ModelEdge.safeParse({ kind: "depends_on", from: "a", to: "b" }).success).toBe(false);
    expect(ModelEdge.safeParse({ kind: "contains", from: "a", to: "b", mode: "sync" }).success).toBe(false);
    expect(ModelEdge.safeParse({ kind: "depends_on", from: "a", to: "b", mode: "async" }).success).toBe(true);
  });
});

describe("Decision", () => {
  const base = {
    id: "D-001",
    at: "2026-10-30T13:00:00Z",
    title: "Queue between orders and notifications",
    options: [
      { name: "Direct call", tradeoff: "Simple, but slow requests block orders" },
      { name: "In-process queue", tradeoff: "Decoupled, but lost on restart" },
    ],
    chosen: "In-process queue",
    why: "Notifications must not slow down checkout",
    reversibility: "easy",
    blastRadius: 2,
  };

  it("accepts a valid decision and fills defaults", () => {
    const d = Decision.parse(base);
    expect(d.affects).toEqual([]);
    expect(d.assumptions).toEqual([]);
  });

  it("requires chosen to be one of the options", () => {
    expect(Decision.safeParse({ ...base, chosen: "Kafka" }).success).toBe(false);
  });

  it("requires at least two options", () => {
    expect(Decision.safeParse({ ...base, options: base.options.slice(1) }).success).toBe(false);
  });
});
