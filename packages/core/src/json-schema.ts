import { z } from "zod";
import { Config, Decision, ModelShape } from "./schema.js";

/**
 * JSON Schema for the files the agent writes, for use in skills. Cross-reference
 * rules (unknown ids, containment) are not expressible here; the MCP server
 * enforces them on write.
 */
export function viewportJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Viewport files",
    $defs: {
      model: z.toJSONSchema(ModelShape, { io: "input" }),
      decision: z.toJSONSchema(Decision, { io: "input" }),
      config: z.toJSONSchema(Config, { io: "input" }),
    },
  };
}
