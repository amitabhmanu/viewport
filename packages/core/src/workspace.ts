import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { readConfig } from "./config-store.js";
import { stableStringify, writeFileAtomic } from "./fsutil.js";
import { readModel, writeModel } from "./model-store.js";
import { viewportPaths } from "./paths.js";
import { Config, Model, type ModelNode, emptyModel } from "./schema.js";
import { applyReport, coverage, filesByComponent, fingerprintFiles, headCommit, listSources, verify, type VerificationReport } from "./verify/index.js";

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.venv/**",
  "**/venv/**",
  "**/dist/**",
  "**/build/**",
  "**/__pycache__/**",
  "**/tests/**",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
];

export interface InitResult {
  created: string[];
  config: Config;
  files: number;
}

/**
 * Sets up `.viewport/` in a repo: a config with detected languages and source globs,
 * an empty model, and a `.gitignore` entry for local state. Existing files are kept.
 */
export async function initWorkspace(root: string): Promise<InitResult> {
  const paths = viewportPaths(root);
  const created: string[] = [];

  let config: Config;
  if (await exists(paths.config)) {
    config = await readConfig(paths.config);
  } else {
    config = await detectConfig(root);
    await writeFileAtomic(paths.config, stableStringify(config));
    created.push(".viewport/config.json");
  }
  if (!(await exists(paths.model))) {
    await writeFileAtomic(paths.model, stableStringify(emptyModel()));
    created.push(".viewport/model.json");
  }
  const gitignore = join(root, ".gitignore");
  const current = (await exists(gitignore)) ? await readFile(gitignore, "utf8") : "";
  if (!current.split("\n").some((l) => l.trim() === ".viewport/local/")) {
    await writeFile(gitignore, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}.viewport/local/\n`);
    created.push(".gitignore entry");
  }
  return { created, config, files: (await listSources(root, config)).length };
}

async function detectConfig(root: string): Promise<Config> {
  const opts = { cwd: root, ignore: DEFAULT_IGNORE, onlyFiles: true } as const;
  const hasSrc = await exists(join(root, "src"));
  const base = hasSrc ? "src/" : "";
  const py = (await glob([`${base}**/*.py`], opts)).length > 0;
  const ts = (await glob([`${base}**/*.{ts,tsx}`], { ...opts, ignore: [...DEFAULT_IGNORE, "**/*.d.ts"] })).length > 0;
  const languages: Config["languages"] = [];
  const sources: string[] = [];
  if (py) {
    languages.push("python");
    sources.push(`${base}**/*.py`);
  }
  if (ts) {
    languages.push("typescript");
    sources.push(`${base}**/*.{ts,tsx}`);
  }
  if (languages.length === 0) throw new Error("found no Python or TypeScript files to model");
  return Config.parse({ version: 1, sources, ignore: DEFAULT_IGNORE, languages });
}

export interface WriteResult {
  model: Model;
  report: VerificationReport;
  /** Components whose fingerprint was (re)taken in this write. */
  stamped: string[];
}

/**
 * The single way the agent changes the model before the MCP server exists: validate,
 * stamp changed or reviewed components with a fingerprint and the current commit,
 * verify against the code, record sync states, and write.
 */
export async function writeModelFromAgent(root: string, incoming: unknown, reviewed: string[] = []): Promise<WriteResult> {
  const paths = viewportPaths(root);
  const config = await readConfig(paths.config);
  const previous = await readModel(paths.model);
  const before = new Map(previous.nodes.map((n) => [n.id, n]));
  const draft = Model.parse({ ...(incoming as object), version: 1, revision: previous.revision });

  const files = await listSources(root, config);
  const owned = filesByComponent(coverage(files, draft).owner);
  const head = await headCommit(root);
  const review = new Set(reviewed);
  const stamped: string[] = [];
  const nodes: ModelNode[] = [];
  for (const node of draft.nodes) {
    const old = before.get(node.id);
    if (node.kind !== "component") {
      nodes.push(node);
      continue;
    }
    const changed = old === undefined || semantic(old) !== semantic(node) || review.has(node.id) || old.kind !== "component" || old.fingerprint === undefined;
    if (!changed) {
      nodes.push({ ...node, fingerprint: old.fingerprint, ...(old.changedAt ? { changedAt: old.changedAt } : {}) });
      continue;
    }
    stamped.push(node.id);
    nodes.push({
      ...node,
      source: "agent",
      fingerprint: await fingerprintFiles(root, owned.get(node.id) ?? []),
      ...(head ? { changedAt: head } : {}),
    });
  }
  const candidate = { ...draft, nodes };
  const report = await verify(root, candidate, config);
  const model = await writeModel(paths.model, applyReport(candidate, report));
  return { model, report, stamped: stamped.sort() };
}

/** A node's content without bookkeeping fields, for change detection. */
function semantic(node: ModelNode): string {
  const { sync: _s, source: _o, changedAt: _c, takeaway: _t, takeaways: _ts, ...rest } = node;
  if (rest.kind === "component") delete (rest as { fingerprint?: string }).fingerprint;
  return stableStringify(rest);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
