import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { stableStringify } from "./fsutil.js";
import { SCHEMA_OUT } from "./gen-schema.js";
import { viewportJsonSchema } from "./json-schema.js";

describe("generated JSON Schema", () => {
  it("is up to date (run `pnpm --filter @viewport/core gen:schema`)", async () => {
    expect(await readFile(SCHEMA_OUT, "utf8")).toBe(stableStringify(viewportJsonSchema()));
  });

  it("describes all node kinds", () => {
    const text = JSON.stringify(viewportJsonSchema());
    for (const kind of ["system", "actor", "external", "container", "component", "decision"]) {
      expect(text).toContain(`"${kind}"`);
    }
  });
});
