import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@viewport/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@viewport/viewportd": fileURLToPath(new URL("../viewportd/src/index.ts", import.meta.url)),
    },
  },
  // Hook tests must never leave a viewer daemon running.
  test: { env: { VIEWPORT_NO_DAEMON: "1" } },
});
