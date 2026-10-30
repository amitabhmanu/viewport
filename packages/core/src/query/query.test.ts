import { describe, expect, it } from "vitest";
import type { Model } from "../schema.js";
import { shopModel } from "../test-helpers.js";
import { ModelGraph, QueryError } from "./graph.js";
import { get, slice, trace } from "./queries.js";
import { buildView, checkCompleteness, splitView, view } from "./views.js";

/** py-shop with the dependencies the code actually has. */
function shop(): ModelGraph {
  const m = shopModel();
  m.edges.push(
    { kind: "depends_on", from: "app.orders", to: "app.payments", mode: "sync", source: "agent", sync: "stale" },
    { kind: "depends_on", from: "app.orders", to: "app.storage", mode: "sync", source: "agent", sync: "unverified" },
  );
  return new ModelGraph(m);
}

/** One container with `n` components in a chain c01 -> c02 -> ..., plus a second container. */
function chain(n: number): ModelGraph {
  const ids = Array.from({ length: n }, (_, i) => `core.c${String(i + 1).padStart(2, "0")}`);
  const base = { source: "agent" as const, sync: "unverified" as const };
  const model: Model = {
    version: 1,
    revision: 0,
    nodes: [
      { ...base, kind: "system", id: "sys", name: "Sys", purpose: "p" },
      { ...base, kind: "container", id: "core", name: "Core", role: "r" },
      { ...base, kind: "container", id: "web", name: "Web", role: "r" },
      { ...base, kind: "component", id: "web.ui", name: "UI", role: "r", paths: ["web/**"] },
      ...ids.map((id) => ({ ...base, kind: "component" as const, id, name: id, role: "r", paths: [`${id}/**`] })),
    ],
    edges: [
      { ...base, kind: "contains", from: "sys", to: "core" },
      { ...base, kind: "contains", from: "sys", to: "web" },
      { ...base, kind: "contains", from: "web", to: "web.ui" },
      { ...base, kind: "depends_on", from: "web.ui", to: ids[0]!, mode: "sync" },
      ...ids.map((id) => ({ ...base, kind: "contains" as const, from: "core", to: id })),
      ...ids.slice(1).map((id, i) => ({ ...base, kind: "depends_on" as const, from: ids[i]!, to: id, mode: "sync" as const })),
    ],
  };
  return new ModelGraph(model);
}

describe("get", () => {
  it("returns a node with its parent, flow edges and decisions", () => {
    const d = get(shop(), "app.orders");
    expect(d.parent).toBe("app");
    expect(d.incoming.map((e) => e.from)).toEqual(["app.api"]);
    expect(d.outgoing.map((e) => e.to).sort()).toEqual(["app.notifications", "app.payments", "app.storage"]);
    expect(d.decisions).toEqual(["d-001"]);
  });

  it("fails clearly on unknown ids", () => {
    expect(() => get(shop(), "nope")).toThrow(QueryError);
  });
});

describe("trace", () => {
  it("finds the shortest path between two nodes", () => {
    expect(trace(shop(), "app.api", { to: "payment-provider" })).toEqual({
      nodes: ["app.api", "app.orders", "app.payments", "payment-provider"],
      edges: [
        "depends_on:app.api->app.orders",
        "depends_on:app.orders->app.payments",
        "depends_on:app.payments->payment-provider",
      ],
    });
  });

  it("returns everything reachable without a target, in either direction", () => {
    expect(trace(shop(), "app.orders").nodes).toEqual([
      "app.notifications",
      "app.orders",
      "app.payments",
      "app.storage",
      "payment-provider",
    ]);
    expect(trace(shop(), "app.payments", { direction: "upstream" }).nodes).toEqual(["app.api", "app.orders", "app.payments"]);
  });

  it("reports when there is no path", () => {
    expect(() => trace(shop(), "app.storage", { to: "app.api" })).toThrow(/no path/);
  });
});

describe("slice", () => {
  it("slices by externals, mode, decision and sync state", () => {
    expect(slice(shop(), { externals: true })).toEqual({
      nodes: ["app.payments", "payment-provider"],
      edges: ["depends_on:app.payments->payment-provider"],
    });
    expect(slice(shop(), { mode: "async" }).edges).toEqual(["depends_on:app.orders->app.notifications"]);
    expect(slice(shop(), { decidedBy: "d-001" }).nodes).toEqual(["app.notifications", "app.orders"]);
    expect(slice(shop(), { sync: "stale" }).edges).toEqual(["depends_on:app.orders->app.payments"]);
  });

  it("rejects decidedBy on a non-decision", () => {
    expect(() => slice(shop(), { decidedBy: "app" })).toThrow(QueryError);
  });
});

describe("default views", () => {
  it("overview lifts internal dependencies to the system", () => {
    const v = buildView(shop(), "overview");
    expect(v.elements).toEqual(["customer", "payment-provider", "shop"]);
    expect(v.edges.map((e) => `${e.kind}:${e.from}->${e.to}`)).toEqual([
      "depends_on:shop->payment-provider",
      "uses:customer->shop",
    ]);
  });

  it("containers view lifts component dependencies to containers", () => {
    const v = buildView(chain(3), "containers");
    expect(v.elements).toEqual(["core", "web"]);
    expect(v.edges).toEqual([{ from: "web", to: "core", kind: "depends_on", sources: ["depends_on:web.ui->core.c01"] }]);
  });

  it("components view shows outside neighbours as stubs", () => {
    const v = buildView(shop(), "components:app");
    expect(v.elements).toHaveLength(5);
    expect(v.stubs).toEqual(["payment-provider"]);
  });

  it("code map lists every component", () => {
    expect(buildView(chain(2), "code-map").elements).toEqual(["core.c01", "core.c02", "web.ui"]);
  });
});

describe("splitting", () => {
  it("keeps a small view whole", () => {
    expect(view(shop(), "components:app", "medium")).toHaveLength(1);
  });

  it("splits by the level's budget, in dependency order, with linked stubs", () => {
    const g = chain(12);
    const parts = view(g, "components:core", "medium");
    expect(parts.map((p) => p.elements.length)).toEqual([7, 5]);
    expect(parts[0]?.elements[0]).toBe("core.c01");
    expect(parts[0]?.stubs).toEqual(["core.c08", "web.ui"]);
    expect(parts[0]?.continuesIn).toEqual({ "core.c08": "components:core#2" });
    expect(parts[1]?.continuesIn).toEqual({ "core.c07": "components:core#1" });
    expect(view(g, "components:core", "simple")).toHaveLength(3);
    expect(view(g, "components:core", "complex")).toHaveLength(1);
  });

  it("groups by container before chunking when a view spans several", () => {
    const parts = view(chain(8), "code-map", "medium");
    for (const p of parts) expect(new Set(p.elements.map((id) => id.split(".")[0])).size).toBe(1);
  });

  it("never loses an element or edge", () => {
    for (const n of [1, 6, 7, 8, 15, 23]) {
      const g = chain(n);
      for (const level of ["simple", "medium", "complex"] as const) {
        const full = buildView(g, "components:core");
        expect(checkCompleteness(full, splitView(g, full, level))).toEqual({ missingElements: [], missingEdges: [] });
      }
    }
  });

  it("orders cycles deterministically", () => {
    const a = view(shop(), "components:app", "simple").map((p) => p.elements);
    const b = view(shop(), "components:app", "simple").map((p) => p.elements);
    expect(a).toEqual(b);
  });
});
