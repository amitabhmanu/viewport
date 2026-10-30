// Bundles each hook into one file under hooks/dist so a hook starts without
// resolving hundreds of modules, and copies the tree-sitter grammars beside them.
import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { URL } from "node:url";
import { build } from "esbuild";

const out = new URL("../../hooks/dist/", import.meta.url);
const entries = ["session-start", "post-tool-use", "stop", "subagent-stop"];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: Object.fromEntries(entries.map((e) => [e, `src/${e}.ts`])),
  outdir: out.pathname,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["viewport-src"],
  // Some bundled CommonJS code calls require(); give ESM output one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});

const require = createRequire(import.meta.url);
for (const wasm of [
  "web-tree-sitter/web-tree-sitter.wasm",
  "tree-sitter-python/tree-sitter-python.wasm",
  "tree-sitter-typescript/tree-sitter-typescript.wasm",
  "tree-sitter-typescript/tree-sitter-tsx.wasm",
]) {
  await copyFile(require.resolve(wasm), new URL(basename(wasm), out));
}
