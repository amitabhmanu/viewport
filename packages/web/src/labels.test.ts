import type { Change, Decision, Model, ModelNode, Prediction, SplitView } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { bySalience, homeView, partShowing, partSummary, rank, seenWith, shuffledOptions, subtitle, toPredict, trail, viewTitle, zoomTarget } from "./labels.js";

const orders = { kind: "component", id: "app.orders", name: "Orders", role: "Takes orders", tech: "FastAPI", paths: ["src/**"], source: "agent", sync: "ok" } as ModelNode;
const app = { kind: "container", id: "app", name: "App", role: "Runs the shop", source: "agent", sync: "ok" } as ModelNode;
const nodes = new Map([orders, app].map((n) => [n.id, n]));
const part = (elements: string[], continuesIn: Record<string, string> = {}): SplitView => ({
  id: "v#1",
  title: "v",
  part: 1,
  parts: 2,
  elements,
  stubs: Object.keys(continuesIn),
  edges: [],
  continuesIn,
});

describe("labels", () => {
  it("adds technology as the level rises", () => {
    expect(subtitle(orders, "simple")).toBe("Takes orders");
    expect(subtitle(orders, "medium")).toBe("Takes orders · FastAPI");
    expect(subtitle(orders, "complex")).toBe("FastAPI · app.orders");
    expect(subtitle(app, "complex")).toBe("Runs the shop");
  });

  it("names views and the trail to them", () => {
    expect(viewTitle("components:app", nodes)).toBe("App");
    expect(viewTitle("overview", nodes)).toBe("Overview");
    expect(trail("components:app")).toEqual(["overview", "containers", "components:app"]);
    expect(trail("overview")).toEqual(["overview"]);
  });

  it("zooms one level down", () => {
    expect(zoomTarget(app)).toBe("components:app");
    expect(zoomTarget(orders)).toBeUndefined();
  });

  it("finds the part that shows an element", () => {
    const parts = [part(["a", "b"]), part(["c"])];
    expect(partShowing(parts, "c")).toBe(1);
    expect(partShowing(parts, "zzz")).toBe(0);
    expect(partShowing(parts, undefined)).toBe(0);
  });

  it("summarizes a part", () => {
    expect(partSummary(part(["app.orders"], { x: "v#2" }), nodes)).toBe("Orders; 1 connection continues in other parts.");
    expect(partSummary(part(["a", "b", "c", "d"]), nodes)).toBe("a, b, c and 1 more.");
  });
});

describe("changes and ledger", () => {
  it("finds the view that shows a node", () => {
    const model = { version: 1, revision: 1, nodes: [app, orders], edges: [{ kind: "contains", from: "app", to: "app.orders", source: "agent", sync: "ok" }] } as Model;
    expect(homeView(model, "app.orders")).toBe("components:app");
    expect(homeView(model, "app")).toBe("containers");
    expect(homeView(model, "gone")).toBe("overview");
  });

  it("catches up on a node and the changed edges that touch it", () => {
    const changes = [
      { subject: "app.orders", what: "node", change: "changed", label: "Orders", nodes: ["app.orders"] },
      { subject: "depends_on:app.api->app.orders", what: "edge", change: "added", label: "", nodes: ["app.api", "app.orders"] },
      { subject: "depends_on:app.api->app.x", what: "edge", change: "added", label: "", nodes: ["app.api", "app.x"] },
    ] as Change[];
    expect(seenWith("app.orders", changes)).toEqual(["app.orders", "depends_on:app.api->app.orders"]);
  });

  it("ranks decisions by blast radius, then newest", () => {
    const d = (id: string, blastRadius: number, at: string) => ({ id, blastRadius, at }) as Decision;
    expect(rank([d("D-001", 1, "2026-10-01T00:00:00Z"), d("D-002", 3, "2026-10-02T00:00:00Z"), d("D-003", 1, "2026-10-03T00:00:00Z")]).map((x) => x.id)).toEqual([
      "D-002",
      "D-003",
      "D-001",
    ]);
  });

  it("puts salience ahead of reach when scores are known", () => {
    const d = (id: string, blastRadius: number) => ({ id, blastRadius, at: "2026-10-01T00:00:00Z" }) as Decision;
    expect(rank([d("D-001", 5), d("D-002", 1)], { "D-001": 0.4, "D-002": 3 }).map((x) => x.id)).toEqual(["D-002", "D-001"]);
  });

  it("orders changes by their most salient subject or node", () => {
    const changes = [
      { subject: "app.api", what: "node", change: "changed", label: "API", nodes: ["app.api"] },
      { subject: "depends_on:app.api->app.orders", what: "edge", change: "added", label: "", nodes: ["app.api", "app.orders"] },
      { subject: "D-001", what: "decision", change: "added", label: "", nodes: [] },
    ] as Change[];
    expect(bySalience(changes, { "app.api": 1, "app.orders": 4, "D-001": 2 }).map((c) => c.subject)).toEqual(["depends_on:app.api->app.orders", "D-001", "app.api"]);
  });
});

describe("predictions", () => {
  const d = (id: string, blastRadius: number, reversibility: Decision["reversibility"], extra: Partial<Decision> = {}) =>
    ({ id, blastRadius, reversibility, at: "2026-10-30T00:00:00Z", ...extra }) as Decision;

  it("queues unanswered decisions, hard-to-undo and wide-reaching first", () => {
    const ledger = [d("D-001", 4, "easy"), d("D-002", 2, "one-way"), d("D-003", 1, "costly"), d("D-004", 9, "one-way", { supersedes: "D-002" }), d("D-005", 5, "costly")];
    const answered = [{ decisionId: "D-005" }] as Prediction[];
    expect(toPredict(ledger, answered).map((x) => x.id)).toEqual(["D-004", "D-001", "D-003"]);
    expect(toPredict(ledger, answered, { "D-003": 5 }).map((x) => x.id)).toEqual(["D-003", "D-004", "D-001"]);
  });

  it("shuffles options the same way every time, keeping them all", () => {
    const options = ["A", "B", "C", "D"].map((name) => ({ name, tradeoff: name }));
    const once = shuffledOptions({ id: "D-007", options });
    expect(shuffledOptions({ id: "D-007", options })).toEqual(once);
    expect(once.map((o) => o.name).sort()).toEqual(["A", "B", "C", "D"]);
    const firsts = new Set(Array.from({ length: 20 }, (_, i) => shuffledOptions({ id: `D-${100 + i}`, options })[0]!.name));
    expect(firsts.size).toBeGreaterThan(1);
  });
});
