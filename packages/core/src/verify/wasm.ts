import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "web-tree-sitter";

/**
 * A `.wasm` file from a package. Bundled builds (the hooks) ship the files next to
 * the bundle, so look there first; otherwise resolve through node_modules.
 */
export function wasmPath(specifier: string): string {
  const beside = fileURLToPath(new URL(basename(specifier), import.meta.url));
  if (existsSync(beside)) return beside;
  return createRequire(import.meta.url).resolve(specifier);
}

let ready: Promise<void> | undefined;

/** Initializes web-tree-sitter once, finding its runtime the same way as the grammars. */
export function initParser(): Promise<void> {
  ready ??= Parser.init({ locateFile: () => wasmPath("web-tree-sitter/web-tree-sitter.wasm") });
  return ready;
}
