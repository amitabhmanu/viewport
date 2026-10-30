import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";

/** One import-like reference in a TypeScript or JavaScript file, before resolution. */
export interface TsImport {
  specifier: string;
  line: number;
}

const parsers = new Map<"ts" | "tsx", Promise<Parser>>();

function tsParser(flavor: "ts" | "tsx"): Promise<Parser> {
  let p = parsers.get(flavor);
  if (!p) {
    p = (async () => {
      const require = createRequire(import.meta.url);
      await Parser.init();
      const file = flavor === "tsx" ? "tree-sitter-tsx.wasm" : "tree-sitter-typescript.wasm";
      const language = await Language.load(require.resolve(`tree-sitter-typescript/${file}`));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    parsers.set(flavor, p);
  }
  return p;
}

/**
 * Static imports, `export … from`, `import x = require()`, dynamic `import("…")`
 * and `require("…")` calls with a string literal. Type-only imports count: they
 * are still a dependency between parts of the code.
 */
export async function extractTsImports(source: string, tsx = false): Promise<TsImport[]> {
  const parser = await tsParser(tsx ? "tsx" : "ts");
  const tree = parser.parse(source);
  if (!tree) return [];
  const out: TsImport[] = [];
  const add = (str: Node | null | undefined, at: Node) => {
    const text = str?.type === "string" ? str.namedChildren.find((c) => c?.type === "string_fragment")?.text : undefined;
    if (text) out.push({ specifier: text, line: at.startPosition.row + 1 });
  };
  for (const node of tree.rootNode.descendantsOfType(["import_statement", "export_statement", "call_expression"])) {
    if (!node) continue;
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const isLoader = fn?.type === "import" || (fn?.type === "identifier" && fn.text === "require");
      if (isLoader) add(node.childForFieldName("arguments")?.namedChildren[0], node);
      continue;
    }
    const source = node.childForFieldName("source");
    if (source) add(source, node);
    else if (node.type === "import_statement") {
      const req = node.namedChildren.find((c) => c?.type === "import_require_clause");
      add(req?.childForFieldName("source") ?? req?.namedChildren.find((c) => c?.type === "string"), node);
    }
  }
  tree.delete();
  return out.sort((a, b) => a.line - b.line);
}

/** Path mapping from tsconfig: `baseUrl` (repo-relative) and `paths` patterns. */
export interface TsPaths {
  baseUrl?: string;
  paths: [pattern: string, targets: string[]][];
}

/** Reads `compilerOptions.baseUrl` and `paths` from a tsconfig file; missing file means none. */
export async function readTsPaths(root: string, tsconfig: string): Promise<TsPaths> {
  let text: string;
  try {
    text = await readFile(join(root, tsconfig), "utf8");
  } catch {
    return { paths: [] };
  }
  const json = JSON.parse(stripJsonc(text)) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  const dir = posix.dirname(tsconfig);
  const opts = json.compilerOptions ?? {};
  const baseUrl = opts.baseUrl !== undefined ? posix.normalize(posix.join(dir, opts.baseUrl)) : undefined;
  const pathBase = baseUrl ?? dir;
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    paths: Object.entries(opts.paths ?? {}).map(([p, targets]) => [p, targets.map((t) => posix.normalize(posix.join(pathBase, t)))]),
  };
}

/** Removes comments and trailing commas from JSON-with-comments, leaving strings intact. */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const JS_TO_TS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Repo files a specifier refers to: relative paths, tsconfig `paths` aliases and
 * `baseUrl`-relative modules. Packages from node_modules resolve to nothing.
 */
export function resolveTsImport(spec: string, fromFile: string, files: ReadonlySet<string>, tsPaths: TsPaths): string[] {
  const bases: string[] = [];
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    bases.push(posix.join(posix.dirname(fromFile), spec));
  } else {
    for (const [pattern, targets] of tsPaths.paths) {
      const star = pattern.indexOf("*");
      if (star === -1 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1))) {
        const middle = star === -1 ? "" : spec.slice(star, spec.length - (pattern.length - star - 1));
        bases.push(...targets.map((t) => t.replace("*", middle)));
      }
    }
    if (tsPaths.baseUrl !== undefined) bases.push(posix.join(tsPaths.baseUrl, spec));
  }
  for (const base of bases) {
    const hit = moduleFile(posix.normalize(base), files);
    if (hit) return [hit];
  }
  return [];
}

function moduleFile(base: string, files: ReadonlySet<string>): string | undefined {
  if (base.startsWith("..")) return undefined;
  const ext = posix.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const candidates = [
    ...(JS_TO_TS[ext] ?? []).map((e) => stem + e),
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => posix.join(base, `index${e}`)),
  ];
  return candidates.find((c) => files.has(c));
}
