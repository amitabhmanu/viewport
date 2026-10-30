import type { ModelEdge, ModelNode } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { askHref, askTitle, askView, parseAsk } from "./ask.js";

const nodes = new Map([
  ["app.api", { id: "app.api", name: "API" }],
  ["app.db", { id: "app.db", name: "Storage" }],
] as [string, ModelNode][]);

describe("ask", () => {
  it("round-trips queries through the URL and drops bad ones", () => {
    for (const query of [
      { q: "trace", from: "app.api", to: "app.db" },
      { q: "trace", from: "app.api", direction: "upstream" },
      { q: "slice", externals: true },
      { q: "slice", sync: "stale", decidedBy: "d-001" },
    ] as const) {
      expect(parseAsk(new URL(askHref(query), "http://x").searchParams)).toEqual(query);
    }
    expect(parseAsk(new URLSearchParams("q=trace"))).toBeUndefined();
    expect(parseAsk(new URLSearchParams("q=slice&mode=bogus"))).toBeUndefined();
  });

  it("titles queries in plain words", () => {
    expect(askTitle({ q: "trace", from: "app.api", to: "app.db" }, nodes)).toBe("How API reaches Storage");
    expect(askTitle({ q: "trace", from: "app.db", direction: "upstream" }, nodes)).toBe("What depends on Storage");
    expect(askTitle({ q: "slice", mode: "async" }, nodes)).toBe("Async dependencies");
  });

  it("turns a result into a one-part view of flow edges", () => {
    const edges = [
      { kind: "depends_on", from: "app.api", to: "app.db", mode: "sync" },
      { kind: "contains", from: "app", to: "app.api" },
    ] as ModelEdge[];
    const view = askView({ nodes: ["app.api", "app.db"], edges: ["depends_on:app.api->app.db", "contains:app->app.api"] }, edges, "t");
    expect(view.edges).toEqual([{ from: "app.api", to: "app.db", kind: "depends_on", sources: ["depends_on:app.api->app.db"] }]);
  });
});
