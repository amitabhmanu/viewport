import type { ModelNode, SplitView } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { partShowing, partSummary, subtitle, trail, viewTitle, zoomTarget } from "./labels.js";

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
