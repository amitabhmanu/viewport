import type { SplitView } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { END, NODE, START, layout } from "./layout.js";

const ids = Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(2, "0")}`);
const big: SplitView = {
  id: "components:app#1",
  title: "App",
  part: 1,
  parts: 1,
  elements: ids,
  stubs: [],
  continuesIn: {},
  edges: ids.slice(1).map((id, i) => ({ from: ids[Math.floor(i / 2)]!, to: id, kind: "depends_on" as const, sources: [] })),
};

describe("layout", () => {
  it("places every element without overlap and routes every edge", async () => {
    const out = await layout(big);
    expect(out.boxes).toHaveLength(30);
    expect(out.routes).toHaveLength(29);
    for (const r of out.routes) expect(r.points.length).toBeGreaterThanOrEqual(2);
    for (const a of out.boxes)
      for (const b of out.boxes)
        if (a !== b) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    expect(out.boxes[0]!.width).toBe(NODE.width);
  });

  it("lays out the same view the same way every time", async () => {
    expect(await layout(big)).toEqual(await layout(big));
  });

  it("lays out 30 components quickly", async () => {
    const start = performance.now();
    await layout(big);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("process flow layout", () => {
  const kinds: Record<string, "step" | "rule" | "assumption"> = { place: "step", cancel: "step", refund: "step", "refund-rule": "rule", full: "assumption" };
  const flow: SplitView = {
    id: "process:ordering",
    title: "Ordering",
    part: 1,
    parts: 1,
    elements: ["place", "cancel", "refund", "refund-rule", "full"],
    stubs: [],
    continuesIn: {},
    edges: [
      { kind: "next", from: "cancel", to: "refund", label: "the order had shipped", sources: [] },
      { kind: "constrained_by", from: "refund", to: "refund-rule", sources: [] },
      { kind: "assumes", from: "refund-rule", to: "full", sources: [] },
    ],
  };

  it("runs from a start to an end, left to right, with rules hanging under their step", async () => {
    const out = await layout(flow, (id) => kinds[id]);
    const box = (id: string) => out.boxes.find((b) => b.id === id)!;
    expect(box(START).terminal).toBe("start");
    expect(box(END).terminal).toBe("end");
    expect(box("cancel").x).toBeLessThan(box("refund").x);
    expect(box("place").x).toBe(box("cancel").x);
    expect(box("refund-rule").x).toBe(box("refund").x);
    expect(box("refund-rule").y).toBeGreaterThan(box("refund").y);
    expect(box("full").y).toBeGreaterThan(box("refund-rule").y);
    for (const a of out.boxes)
      for (const b of out.boxes)
        if (a !== b) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    const next = out.routes.find((r) => r.id === "next:cancel->refund")!;
    expect(next.labelAt).toBeDefined();
    expect(out.routes.filter((r) => r.plain)).toHaveLength(4);
    expect(out.routes.find((r) => r.kind === "assumes")?.points).toHaveLength(4);
  });

  it("keeps the plain layout without kinds", async () => {
    expect((await layout(flow)).boxes.some((b) => b.terminal)).toBe(false);
  });
});
