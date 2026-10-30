import type { SplitView } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { NODE, layout } from "./layout.js";

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
