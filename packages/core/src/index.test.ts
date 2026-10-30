import { describe, expect, it } from "vitest";
import { VIEWPORT_DIR } from "./index.js";

describe("core", () => {
  it("stores the model under .viewport", () => {
    expect(VIEWPORT_DIR).toBe(".viewport");
  });
});
