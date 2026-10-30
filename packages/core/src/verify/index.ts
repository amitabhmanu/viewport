import { join } from "node:path";
import { viewportPaths } from "../paths.js";
import type { Config, Model, ModelEdge, ModelNode } from "../schema.js";
import { edgeKey } from "../schema.js";
import { type ComponentDependency, type ImportResolver, componentDependencies, diffDependencies } from "./dependencies.js";
import { resolvePythonImport } from "./python.js";
import { readTsPaths, resolveTsImport } from "./typescript.js";
import { checkFreshness } from "./freshness.js";
import { scanImports } from "./import-cache.js";
import { coverage, listSources } from "./sources.js";

export interface VerificationReport {
  scope: "full" | "incremental";
  files: number;
  unclaimed: string[];
  doubleClaimed: { file: string; components: string[] }[];
  missingDependencies: ComponentDependency[];
  /** Only computed in full scope. */
  unsupportedEdges: string[];
  /** Only computed in full scope. */
  staleComponents: string[];
  unknownFreshness: string[];
  notes: string[];
  durationMs: number;
}

export interface VerifyOptions {
  /** Repo-relative paths that just changed. When set, only these files are checked. */
  changedFiles?: string[];
}

/**
 * Checks the model against the code: file coverage, import-based dependencies and,
 * in full scope, freshness against git. Deterministic and model-free; no LLM calls.
 */
export async function verify(root: string, model: Model, config: Config, options: VerifyOptions = {}): Promise<VerificationReport> {
  const started = performance.now();
  const paths = viewportPaths(root);
  const all = await listSources(root, config);
  const allSet = new Set(all);
  const incremental = options.changedFiles !== undefined;
  const subject = incremental ? (options.changedFiles ?? []).filter((f) => allSet.has(f)) : all;

  const cov = coverage(all, model);
  const subjectSet = new Set(subject);
  const imports = await scanImports(root, subject, join(paths.localDir, "imports.json"));
  const tsPaths = config.languages.includes("typescript") ? await readTsPaths(root, config.typescript.tsconfig) : { paths: [] };
  const resolve: ImportResolver = (file, found, i) =>
    found.lang === "python"
      ? resolvePythonImport(found.imports[i]!, file, allSet, config.python.roots)
      : resolveTsImport(found.imports[i]!.specifier, file, allSet, tsPaths);
  const observed = componentDependencies(imports, cov.owner, resolve);
  const diff = diffDependencies(model, observed);

  const report: VerificationReport = {
    scope: incremental ? "incremental" : "full",
    files: subject.length,
    unclaimed: cov.unclaimed.filter((f) => subjectSet.has(f)),
    doubleClaimed: cov.doubleClaimed.filter((d) => subjectSet.has(d.file)),
    missingDependencies: diff.missing,
    unsupportedEdges: incremental ? [] : diff.unsupported,
    staleComponents: [],
    unknownFreshness: [],
    notes: [],
    durationMs: 0,
  };
  if (!incremental) {
    const fresh = await checkFreshness(root, model, cov.owner);
    report.staleComponents = fresh.stale;
    report.unknownFreshness = fresh.unknown;
    if (fresh.skipped) report.notes.push(`freshness skipped: ${fresh.skipped}`);
  }
  report.durationMs = Math.round(performance.now() - started);
  return report;
}

/** True when a report asks for no model changes. */
export function isClean(report: VerificationReport): boolean {
  return (
    report.unclaimed.length === 0 &&
    report.doubleClaimed.length === 0 &&
    report.missingDependencies.length === 0 &&
    report.unsupportedEdges.length === 0 &&
    report.staleComponents.length === 0
  );
}

/**
 * Applies a full report's findings to sync states: flagged components and edges
 * become `stale`; everything else checked becomes `ok`. Incremental reports only
 * mark things stale, never `ok`, because they saw part of the code.
 */
export function applyReport(model: Model, report: VerificationReport): Model {
  const staleNodes = new Set(report.staleComponents);
  for (const d of report.missingDependencies) staleNodes.add(d.from);
  for (const d of report.doubleClaimed) d.components.forEach((c) => staleNodes.add(c));
  const staleEdges = new Set(report.unsupportedEdges);
  const unknown = new Set(report.unknownFreshness);
  const full = report.scope === "full";
  const graphKinds = new Map(model.nodes.map((n) => [n.id, n.kind]));

  const nodes = model.nodes.map((n): ModelNode => {
    if (n.kind !== "component") return n;
    if (staleNodes.has(n.id)) return { ...n, sync: "stale" };
    if (full) return { ...n, sync: unknown.has(n.id) ? "unverified" : "ok" };
    return n;
  });
  const edges = model.edges.map((e): ModelEdge => {
    if (staleEdges.has(edgeKey(e))) return { ...e, sync: "stale" };
    // A full scan checks every sync or async edge between components against imports.
    if (full && e.kind === "depends_on" && e.mode !== "data" && graphKinds.get(e.from) === "component" && graphKinds.get(e.to) === "component") return { ...e, sync: "ok" };
    return e;
  });
  return { ...model, nodes, edges };
}

export { componentDependencies, diffDependencies } from "./dependencies.js";
export type { ComponentDependency, DependencyDiff, ImportEvidence, ImportResolver } from "./dependencies.js";
export { extractTsImports, readTsPaths, resolveTsImport } from "./typescript.js";
export type { TsImport, TsPaths } from "./typescript.js";
export { extractPythonImports, resolvePythonImport } from "./python.js";
export type { RawImport } from "./python.js";
export { coverage, listSources } from "./sources.js";
export { checkFreshness, fingerprintFiles, filesByComponent, headCommit, uncommittedFiles } from "./freshness.js";
