import { type Model, edgeKey } from "../schema.js";
import { type RawImport, resolvePythonImport } from "./python.js";

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

/** Rolls file-level imports up to dependencies between the components that own the files. */
export function componentDependencies(
  imports: Map<string, RawImport[]>,
  owner: Map<string, string>,
  allFiles: ReadonlySet<string>,
  roots: string[],
): ComponentDependency[] {
  const deps = new Map<string, ComponentDependency>();
  for (const [file, raws] of imports) {
    const from = owner.get(file);
    if (!from) continue;
    for (const raw of raws) {
      for (const target of resolvePythonImport(raw, file, allFiles, roots)) {
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
  /** Imports between components with no `depends_on` edge in the model. */
  missing: ComponentDependency[];
  /** Keys of component-to-component sync or async edges that no import supports. */
  unsupported: string[];
}

/**
 * Compares observed dependencies with the model. Edges to externals and `data`
 * edges are not checked: imports cannot confirm them.
 */
export function diffDependencies(model: Model, observed: ComponentDependency[]): DependencyDiff {
  const components = new Set(model.nodes.filter((n) => n.kind === "component").map((n) => n.id));
  const declared = model.edges.filter(
    (e) => e.kind === "depends_on" && e.mode !== "data" && components.has(e.from) && components.has(e.to),
  );
  const declaredPairs = new Set(declared.map((e) => `${e.from}->${e.to}`));
  const observedPairs = new Set(observed.map((d) => `${d.from}->${d.to}`));
  return {
    missing: observed.filter((d) => !declaredPairs.has(`${d.from}->${d.to}`)),
    unsupported: declared.filter((e) => !observedPairs.has(`${e.from}->${e.to}`)).map(edgeKey).sort(),
  };
}
