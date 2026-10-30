import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: { alias: { "@viewport/core": src("core"), "@viewport/viewportd": src("viewportd") } },
  test: { include: ["src/**/*.test.ts", "e2e/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
