import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { glob } from "tinyglobby";
import { Language, Parser, type Node } from "web-tree-sitter";
import { initParser, wasmPath } from "./wasm.js";

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
      await initParser();
      const file = flavor === "tsx" ? "tree-sitter-tsx.wasm" : "tree-sitter-typescript.wasm";
      const language = await Language.load(wasmPath(`tree-sitter-typescript/${file}`));
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

/** A package in the repo's own workspace, which other packages import by name. */
export interface WorkspacePackage {
  name: string;
  /** Repo-relative directory holding its package.json. */
  dir: string;
  /** Export subpath ("." or "./x", maybe with one `*`) to repo-relative targets, most preferred first. */
  exports: [subpath: string, targets: string[]][];
}

/**
 * Packages listed by `pnpm-workspace.yaml` or the root package.json's `workspaces`.
 * Their imports by name go through node_modules symlinks, which the scanner skips,
 * so they are resolved here to the package's files in the repo.
 */
export async function readWorkspacePackages(root: string): Promise<WorkspacePackage[]> {
  const patterns = [...pnpmWorkspaceGlobs(await readText(join(root, "pnpm-workspace.yaml"))), ...npmWorkspaceGlobs(await readText(join(root, "package.json")))];
  const include = patterns.filter((p) => !p.startsWith("!")).map((p) => posix.join(p, "package.json"));
  if (include.length === 0) return [];
  const ignore = ["**/node_modules/**", ...patterns.filter((p) => p.startsWith("!")).map((p) => posix.join(p.slice(1), "package.json"))];
  const manifests = (await glob(include, { cwd: root, ignore, onlyFiles: true })).sort();
  const out: WorkspacePackage[] = [];
  for (const manifest of manifests) {
    let pkg: { name?: unknown; exports?: unknown; main?: unknown; module?: unknown; types?: unknown; typings?: unknown };
    try {
      pkg = JSON.parse(await readFile(join(root, manifest), "utf8")) as typeof pkg;
    } catch {
      continue;
    }
    if (typeof pkg.name !== "string") continue;
    const dir = posix.dirname(manifest);
    const at = (t: string) => posix.normalize(posix.join(dir, t));
    const exports = exportSubpaths(pkg.exports).map(([sub, targets]): [string, string[]] => [sub, targets.map(at)]);
    const fields = [pkg.types, pkg.typings, pkg.module, pkg.main].filter((f): f is string => typeof f === "string");
    const rootTargets = [...fields.map(at), at("src/index"), at("index")];
    const dot = exports.find(([sub]) => sub === ".");
    if (dot) dot[1].push(...rootTargets);
    else exports.unshift([".", rootTargets]);
    out.push({ name: pkg.name, dir, exports });
  }
  return out;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** The `packages:` list of a pnpm-workspace.yaml, read without a YAML parser. */
export function pnpmWorkspaceGlobs(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) {
      inPackages = /^packages\s*:/.test(line);
      continue;
    }
    const item = inPackages ? /^\s+-\s*(.+?)\s*$/.exec(line) : null;
    if (item) out.push(item[1]!.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return out;
}

function npmWorkspaceGlobs(text: string): string[] {
  try {
    const ws = (JSON.parse(text) as { workspaces?: unknown }).workspaces;
    const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** An `exports` field as subpath → targets, every condition's target kept in order. */
function exportSubpaths(exports: unknown): [string, string[]][] {
  if (exports === undefined || exports === null) return [];
  const isSubpathMap = typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((k) => k.startsWith("."));
  if (!isSubpathMap) return [[".", exportTargets(exports)]];
  return Object.entries(exports as Record<string, unknown>).map(([sub, v]): [string, string[]] => [sub, exportTargets(v)]);
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("./") ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
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
 * Repo files a specifier refers to: relative paths, tsconfig `paths` aliases,
 * `baseUrl`-relative modules and packages of the repo's own workspace. Other
 * packages from node_modules resolve to nothing.
 */
export function resolveTsImport(
  spec: string,
  fromFile: string,
  files: ReadonlySet<string>,
  tsPaths: TsPaths,
  packages: readonly WorkspacePackage[] = [],
): string[] {
  const bases: string[] = [];
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    bases.push(posix.join(posix.dirname(fromFile), spec));
  } else {
    for (const [pattern, targets] of tsPaths.paths) {
      const middle = matchPattern(pattern, spec);
      if (middle !== undefined) bases.push(...targets.map((t) => t.replace("*", middle)));
    }
    if (tsPaths.baseUrl !== undefined) bases.push(posix.join(tsPaths.baseUrl, spec));
    bases.push(...workspaceBases(spec, packages));
  }
  for (const base of bases) {
    const hit = moduleFile(posix.normalize(base), files);
    if (hit) return [hit];
  }
  return [];
}

/** What a single `*` in a pattern matched in `spec` ("" without a star), or undefined if no match. */
function matchPattern(pattern: string, spec: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star === -1) return spec === pattern ? "" : undefined;
  const head = pattern.slice(0, star);
  const tail = pattern.slice(star + 1);
  if (spec.length < head.length + tail.length || !spec.startsWith(head) || !spec.endsWith(tail)) return undefined;
  return spec.slice(head.length, spec.length - tail.length);
}

const BUILD_DIR = /^(dist|lib|build|out)\//;

/**
 * Candidate files for an import of a workspace package. Targets under a build
 * folder (dist, lib, build, out) are also tried under src, since the scanner
 * reads source and build output is usually ignored.
 */
function workspaceBases(spec: string, packages: readonly WorkspacePackage[]): string[] {
  const pkg = packages.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
  if (!pkg) return [];
  const sub = spec === pkg.name ? "." : `.${spec.slice(pkg.name.length)}`;
  const targets: string[] = [];
  for (const [pattern, list] of pkg.exports) {
    const middle = matchPattern(pattern, sub);
    if (middle !== undefined) targets.push(...list.map((t) => t.replace("*", middle)));
  }
  if (sub !== ".") targets.push(posix.join(pkg.dir, sub), posix.join(pkg.dir, "src", sub));
  return targets.flatMap((t) => {
    const inPkg = posix.relative(pkg.dir, t);
    return BUILD_DIR.test(inPkg) ? [t, posix.join(pkg.dir, inPkg.replace(BUILD_DIR, "src/"))] : [t];
  });
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
