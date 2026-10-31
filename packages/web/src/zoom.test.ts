import { describe, expect, it } from "vitest";
import { ZOOM, clampScale, fitScale } from "./Zoom.js";

describe("zoom", () => {
  it("fits a drawing to the frame, within readable limits", () => {
    expect(fitScale({ width: 500, height: 400 }, { width: 1000, height: 600 })).toBe(ZOOM.fitMax);
    expect(fitScale({ width: 1000, height: 400 }, { width: 800, height: 600 })).toBe(0.8);
    expect(fitScale({ width: 4000, height: 3000 }, { width: 800, height: 600 })).toBe(ZOOM.fitMin);
    expect(fitScale({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(1);
  });

  it("keeps manual zoom in range", () => {
    expect(clampScale(10)).toBe(ZOOM.max);
    expect(clampScale(0.01)).toBe(ZOOM.min);
    expect(clampScale(1.234)).toBe(1.23);
  });
});
