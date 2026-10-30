import { fileURLToPath } from "node:url";
import { stableStringify, writeFileAtomic } from "./fsutil.js";
import { viewportJsonSchema } from "./json-schema.js";

export const SCHEMA_OUT = fileURLToPath(new URL("../../../skills/viewport-modeling/schema.json", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFileAtomic(SCHEMA_OUT, stableStringify(viewportJsonSchema()));
  console.log(`wrote ${SCHEMA_OUT}`);
}
