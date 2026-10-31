import { describe, expect, it } from "vitest";
import { Decision, Model, ModelEdge, emptyModel } from "./schema.js";
import { shopModel, shopModelV2 } from "./test-helpers.js";

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

describe("Model v2 layers", () => {
  const meta = { source: "agent" as const, sync: "unverified" as const };

  it("accepts processes, rules, assumptions, entities, tests and runtimes", () => {
    expect(issues(shopModelV2())).toEqual([]);
  });

  it("still reads version 1 models", () => {
    expect(issues({ ...shopModel(), version: 1 })).toEqual([]);
    expect(issues({ ...shopModel(), version: 3 }).length).toBeGreaterThan(0);
  });

  it("fills entity and assumption defaults", () => {
    const m = Model.parse({ ...emptyModel(), nodes: [
      { kind: "entity", id: "user", name: "User", description: "Someone with an account" },
      { kind: "assumption", id: "a", name: "A", statement: "Users have one email" },
    ] });
    expect(m.nodes[0]).toMatchObject({ sensitivity: "internal", code: [] });
    expect(m.nodes[1]).toMatchObject({ status: "open" });
  });

  it("rejects a step outside any process, and a step in two", () => {
    const m = shopModelV2();
    m.edges = m.edges.filter((e) => !(e.kind === "contains" && e.to === "ordering.refund"));
    expect(issues(m)).toContain("step 'ordering.refund' is not inside any process");
    const two = shopModelV2();
    two.nodes.push({ ...meta, kind: "process", id: "returns", name: "Returns", goal: "Send items back" });
    two.edges.push({ ...meta, kind: "contains", from: "returns", to: "ordering.refund" });
    expect(issues(two)).toContain("step 'ordering.refund' has 2 parents");
  });

  it("rejects next edges between processes and wrong edge ends", () => {
    const m = shopModelV2();
    m.nodes.push(
      { ...meta, kind: "process", id: "returns", name: "Returns", goal: "Send items back" },
      { ...meta, kind: "step", id: "returns.ship", name: "Ship back", does: "Customer ships the item" },
    );
    m.edges.push(
      { ...meta, kind: "contains", from: "returns", to: "returns.ship" },
      { ...meta, kind: "next", from: "ordering.refund", to: "returns.ship" },
      { ...meta, kind: "covers", from: "app.api", to: "ordering.place" },
      { ...meta, kind: "contains", from: "app", to: "ordering.place" },
    );
    const found = issues(m);
    expect(found).toContain("next edge 'next:ordering.refund->returns.ship' joins steps of different processes");
    expect(found).toContain("covers cannot connect a component to a step");
    expect(found).toContain("a container cannot contain a step");
  });

  it("allows one owner per entity", () => {
    const m = shopModelV2();
    m.edges.push({ ...meta, kind: "owns", from: "app.storage", to: "order" });
    expect(issues(m)).toContain("entity 'order' has 2 owners");
  });
});

describe("ModelEdge", () => {
  it("requires a mode on depends_on and forbids it elsewhere", () => {
    expect(ModelEdge.safeParse({ kind: "depends_on", from: "a", to: "b" }).success).toBe(false);
    expect(ModelEdge.safeParse({ kind: "contains", from: "a", to: "b", mode: "sync" }).success).toBe(false);
    expect(ModelEdge.safeParse({ kind: "depends_on", from: "a", to: "b", mode: "async" }).success).toBe(true);
  });

  it("allows when only on next edges", () => {
    expect(ModelEdge.safeParse({ kind: "next", from: "a", to: "b", when: "it shipped" }).success).toBe(true);
    expect(ModelEdge.safeParse({ kind: "uses", from: "a", to: "b", when: "it shipped" }).success).toBe(false);
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
