import type { Model } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { PHASES, boxNotes, homeView, phaseOf, phaseStart, trail, viewTitle, zoomTarget } from "./labels.js";

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
