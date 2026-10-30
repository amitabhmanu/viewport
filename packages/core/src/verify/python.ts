import { posix } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import { initParser, wasmPath } from "./wasm.js";

/** One import statement as written, before resolution. */
export interface RawImport {
  /** Dotted module path, without leading dots. Empty for `from . import x`. */
  module: string;
  /** Number of leading dots; 0 for absolute imports. */
  level: number;
  /** Names after `import` in a `from` import; empty for plain `import a.b`. */
  names: string[];
  line: number;
}

let parserPromise: Promise<Parser> | undefined;

function pythonParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await initParser();
    const language = await Language.load(wasmPath("tree-sitter-python/tree-sitter-python.wasm"));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}

/** Every import statement in a Python file, including ones nested in functions or `if` blocks. */
export async function extractPythonImports(source: string): Promise<RawImport[]> {
  const parser = await pythonParser();
  const tree = parser.parse(source);
  if (!tree) return [];
  const imports: RawImport[] = [];
  const nodes = tree.rootNode.descendantsOfType(["import_statement", "import_from_statement"]);
  for (const node of nodes) {
    if (!node) continue;
    const line = node.startPosition.row + 1;
    if (node.type === "import_statement") {
      for (const name of node.childrenForFieldName("name")) {
        const dotted = dottedName(name);
        if (dotted) imports.push({ module: dotted, level: 0, names: [], line });
      }
      continue;
    }
    const moduleNode = node.childForFieldName("module_name");
    if (!moduleNode) continue;
    let module = "";
    let level = 0;
    if (moduleNode.type === "relative_import") {
      level = moduleNode.children.find((c) => c?.type === "import_prefix")?.text.length ?? 0;
      module = moduleNode.children.find((c) => c?.type === "dotted_name")?.text ?? "";
    } else {
      module = moduleNode.text;
    }
    const wildcard = node.children.some((c) => c?.type === "wildcard_import");
    const names = wildcard ? ["*"] : node.childrenForFieldName("name").flatMap((n) => {
      const d = n ? dottedName(n) : undefined;
      return d ? [d] : [];
    });
    imports.push({ module, level, names, line });
  }
  tree.delete();
  return imports;
}

function dottedName(node: Node | null): string | undefined {
  if (!node) return undefined;
  if (node.type === "aliased_import") return node.childForFieldName("name")?.text;
  return node.type === "dotted_name" ? node.text : undefined;
}

/**
 * Repo files an import refers to. Imports that resolve to nothing in the repo
 * (standard library, third-party packages) return an empty list.
 */
export function resolvePythonImport(imp: RawImport, fromFile: string, files: ReadonlySet<string>, roots: string[]): string[] {
  const parts = imp.module === "" ? [] : imp.module.split(".");
  let bases: string[];
  if (imp.level > 0) {
    let dir = posix.dirname(fromFile);
    for (let i = 1; i < imp.level; i++) dir = posix.dirname(dir);
    bases = [posix.join(dir, ...parts)];
  } else {
    bases = roots.map((r) => posix.join(r, ...parts));
  }

  for (const base of bases) {
    if (imp.names.length === 0 || imp.names.includes("*")) {
      const mod = moduleFile(base, files);
      if (mod) return [mod];
      continue;
    }
    // `from pkg import name` may import a submodule `pkg/name.py` or an attribute of `pkg`.
    const found = new Set<string>();
    for (const name of imp.names) {
      const sub = moduleFile(posix.join(base, ...name.split(".")), files);
      if (sub) found.add(sub);
      else {
        const mod = moduleFile(base, files);
        if (mod) found.add(mod);
      }
    }
    if (found.size > 0) return [...found].sort();
  }
  return [];
}

function moduleFile(base: string, files: ReadonlySet<string>): string | undefined {
  const normal = posix.normalize(base);
  if (normal === "." || normal.startsWith("..")) return undefined;
  for (const candidate of [`${normal}.py`, posix.join(normal, "__init__.py")]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}
