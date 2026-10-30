import { type Model, edgeKey } from "../schema.js";
import type { FileImports } from "./import-cache.js";

export interface ImportEvidence {
  file: string;
  line: number;
  target: string;
}

export interface ComponentDependency {
  from: string;
  to: string;
  evidence: ImportEvidence[];
}

/** Turns one parsed import into the repo files it refers to. */
export type ImportResolver = (file: string, found: FileImports, index: number) => string[];

/** Rolls file-level imports up to dependencies between the components that own the files. */
export function componentDependencies(
  imports: Map<string, FileImports>,
  owner: Map<string, string>,
  resolve: ImportResolver,
): ComponentDependency[] {
  const deps = new Map<string, ComponentDependency>();
  for (const [file, found] of imports) {
    const from = owner.get(file);
    if (!from) continue;
    for (let i = 0; i < found.imports.length; i++) {
      const raw = found.imports[i]!;
      for (const target of resolve(file, found, i)) {
        const to = owner.get(target);
        if (!to || to === from) continue;
        const key = `${from}->${to}`;
        const dep = deps.get(key) ?? { from, to, evidence: [] };
        dep.evidence.push({ file, line: raw.line, target });
        deps.set(key, dep);
      }
    }
  }
  return [...deps.values()].sort((a, b) => `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`));
}

export interface DependencyDiff {
  /** Imports between components with no `depends_on` edge (of any mode) in the model. */
  missing: ComponentDependency[];
  /** Keys of component-to-component sync or async edges that no import supports. */
  unsupported: string[];
}

/**
 * Compares observed dependencies with the model. Any `depends_on` edge covers an
 * import, whatever its mode. Only `sync` and `async` edges between components must
 * be backed by an import: `data` edges and edges to externals may rest on things
 * imports cannot show, such as a shared store or an HTTP call.
 */
export function diffDependencies(model: Model, observed: ComponentDependency[]): DependencyDiff {
  const components = new Set(model.nodes.filter((n) => n.kind === "component").map((n) => n.id));
  const between = model.edges.filter((e) => e.kind === "depends_on" && components.has(e.from) && components.has(e.to));
  const declaredPairs = new Set(between.map((e) => `${e.from}->${e.to}`));
  const observedPairs = new Set(observed.map((d) => `${d.from}->${d.to}`));
  return {
    missing: observed.filter((d) => !declaredPairs.has(`${d.from}->${d.to}`)),
    unsupported: between
      .filter((e) => e.mode !== "data" && !observedPairs.has(`${e.from}->${e.to}`))
      .map(edgeKey)
      .sort(),
  };
}
