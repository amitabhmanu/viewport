import { type EdgeKind, type ModelEdge, edgeKey } from "../schema.js";
import { ModelGraph, QueryError } from "./graph.js";

export type Level = "simple" | "medium" | "complex";

/** Maximum elements (nodes, not counting stubs) per sub-view at each level. */
export const ELEMENT_BUDGET: Record<Level, number> = { simple: 5, medium: 7, complex: Number.POSITIVE_INFINITY };

/** Edge kinds a view draws as arrows. `contains` is drawn as nesting and `decided_by` in panels. */
export type ViewEdgeKind = Exclude<EdgeKind, "contains" | "decided_by">;

export interface ViewEdge {
  from: string;
  to: string;
  kind: ViewEdgeKind;
  /** Model edges this view edge stands for. A lifted edge stands for several. */
  sources: string[];
  /** Text on the arrow: a branch's condition. */
  label?: string;
}

export interface View {
  id: string;
  title: string;
  /** Nodes drawn in full. */
  elements: string[];
  /** Nodes drawn as a "continues in…" stub because they belong elsewhere. */
  stubs: string[];
  edges: ViewEdge[];
}

export interface SplitView extends View {
  part: number;
  parts: number;
  /** For each stub that is shown in full in a sibling sub-view, that sub-view's id. */
  continuesIn: Record<string, string>;
}

export type ViewName =
  | "overview"
  | "containers"
  | `components:${string}`
  | "code-map"
  | "processes"
  | `process:${string}`
  | "rules"
  | "data"
  | "coverage"
  | "deploy";

/** Builds a default view, before splitting. */
export function buildView(graph: ModelGraph, name: ViewName): View {
  if (name === "overview") return overview(graph);
  if (name === "containers") return containers(graph);
  if (name === "code-map") return codeMap(graph);
  if (name === "processes") return processes(graph);
  if (name === "rules") return rules(graph);
  if (name === "data") return data(graph);
  if (name === "coverage") return coverage(graph);
  if (name === "deploy") return deploy(graph);
  if (name.startsWith("components:")) return components(graph, name.slice("components:".length));
  if (name.startsWith("process:")) return processView(graph, name.slice("process:".length));
  throw new QueryError(`unknown view '${name}'`);
}

/**
 * The system with the people who use it, the external systems it depends on and,
 * once they are modeled, the business processes people use it for.
 */
function overview(graph: ModelGraph): View {
  const system = graph.ofKind("system")[0];
  if (!system) throw new QueryError("the model has no system node yet");
  const actors = graph.ofKind("actor").map((n) => n.id);
  const externals = graph.ofKind("external").map((n) => n.id);
  const procs = graph.ofKind("process").map((n) => n.id);
  const lift = (id: string) => {
    const kind = graph.nodes.get(id)?.kind;
    return kind === "external" || kind === "actor" || kind === "process" ? id : system.id;
  };
  return {
    id: "overview",
    title: system.name,
    elements: [system.id, ...actors, ...externals, ...procs].sort(),
    stubs: [],
    edges: lifted(graph.model.edges, lift),
  };
}

/** Containers, actors and externals, with component dependencies lifted to containers. */
function containers(graph: ModelGraph): View {
  const keep = new Set([...graph.ofKind("container"), ...graph.ofKind("actor"), ...graph.ofKind("external")].map((n) => n.id));
  const lift = (id: string) => {
    const c = graph.containerOf(id);
    return keep.has(c) ? c : undefined;
  };
  return { id: "containers", title: "Containers", elements: [...keep].sort(), stubs: [], edges: lifted(graph.model.edges, lift) };
}

/** Components of one container, with neighbours outside it as stubs. */
function components(graph: ModelGraph, containerId: string): View {
  const container = graph.node(containerId);
  if (container.kind !== "container") throw new QueryError(`'${containerId}' is not a container`);
  const inside = new Set(graph.children(containerId));
  const stubs = new Set<string>();
  const lift = (id: string) => {
    const kind = graph.nodes.get(id)?.kind;
    return kind === undefined || kind === "system" || kind === "decision" ? undefined : id;
  };
  const edges = lifted(graph.model.edges, lift).filter((e) => inside.has(e.from) || inside.has(e.to));
  for (const e of edges) for (const id of [e.from, e.to]) if (!inside.has(id)) stubs.add(id);
  return { id: `components:${containerId}`, title: container.name, elements: [...inside].sort(), stubs: [...stubs].sort(), edges };
}

/** Every component, grouped by container order, with no edges: the map from parts to code. */
function codeMap(graph: ModelGraph): View {
  const comps = graph.ofKind("component").map((n) => n.id);
  comps.sort((a, b) => graph.containerOf(a).localeCompare(graph.containerOf(b)) || a.localeCompare(b));
  return { id: "code-map", title: "Code map", elements: comps, stubs: [], edges: [] };
}

/** The business processes and the people who use them: where the requirements phase starts. */
function processes(graph: ModelGraph): View {
  const procs = graph.ofKind("process").map((n) => n.id);
  if (procs.length === 0) throw new QueryError("the model has no processes yet");
  const inView = new Set(procs);
  for (const p of procs) for (const e of graph.incoming(p, "uses")) inView.add(e.from);
  const keep = (id: string) => (inView.has(id) ? id : undefined);
  return { id: "processes", title: "Processes", elements: [...inView].sort(), stubs: [], edges: lifted(graph.model.edges, keep, ["uses"]) };
}

/**
 * One process: its steps in order, with branch conditions on the arrows, and the
 * business rules and assumptions that bear on it. Which component does each step
 * is in the side panel, so the diagram stays about the business.
 */
function processView(graph: ModelGraph, id: string): View {
  const process = graph.node(id);
  if (process.kind !== "process") throw new QueryError(`'${id}' is not a process`);
  const steps = graph.children(id);
  const ruled = [id, ...steps].flatMap((s) => graph.outgoing(s, "constrained_by").map((e) => e.to));
  const assumed = [id, ...steps, ...ruled].flatMap((s) => graph.outgoing(s, "assumes").map((e) => e.to));
  const elements = [...new Set([...steps, ...ruled, ...assumed])];
  const inView = new Set(elements);
  const keep = (n: string) => (inView.has(n) ? n : undefined);
  return { id: `process:${id}`, title: process.name, elements, stubs: [], edges: lifted(graph.model.edges, keep, ["next", "constrained_by", "assumes"]) };
}

/** Every business rule with the assumptions behind it; open assumptions are the ones to confirm. */
function rules(graph: ModelGraph): View {
  const ids = [...graph.ofKind("rule"), ...graph.ofKind("assumption")].map((n) => n.id);
  if (ids.length === 0) throw new QueryError("the model has no rules or assumptions yet");
  const inView = new Set(ids);
  const keep = (id: string) => (inView.has(id) ? id : undefined);
  return { id: "rules", title: "Rules and assumptions", elements: ids.sort(), stubs: [], edges: lifted(graph.model.edges, keep, ["assumes"]) };
}

/** The data the system keeps, who owns each entity, and who reads or writes it. */
function data(graph: ModelGraph): View {
  const entities = graph.ofKind("entity").map((n) => n.id);
  if (entities.length === 0) throw new QueryError("the model has no entities yet");
  const inView = new Set(entities);
  for (const id of entities) for (const k of ["owns", "reads", "writes"] as const) for (const e of graph.incoming(id, k)) inView.add(e.from);
  const keep = (id: string) => (inView.has(id) ? id : undefined);
  return { id: "data", title: "Data", elements: [...inView].sort(), stubs: [], edges: lifted(graph.model.edges, keep, ["owns", "reads", "writes"]) };
}

/** Test groups and the processes and rules they cover; a process with no arrow in has no tests. */
function coverage(graph: ModelGraph): View {
  const tests = graph.ofKind("test").map((n) => n.id);
  const procs = graph.ofKind("process").map((n) => n.id);
  if (tests.length === 0 && procs.length === 0) throw new QueryError("the model has no tests or processes yet");
  const covered = graph.ofKind("rule").filter((r) => graph.incoming(r.id, "covers").length > 0).map((r) => r.id);
  const inView = new Set([...procs, ...tests, ...covered]);
  const lift = (id: string) => {
    if (inView.has(id)) return id;
    return graph.nodes.get(id)?.kind === "step" ? graph.parent(id) : undefined;
  };
  return { id: "coverage", title: "Test coverage", elements: [...inView].sort(), stubs: [], edges: lifted(graph.model.edges, lift, ["covers"]) };
}

/** Where each container runs, with dependencies between containers and on external systems. */
function deploy(graph: ModelGraph): View {
  const runtimes = graph.ofKind("runtime").map((n) => n.id);
  if (runtimes.length === 0) throw new QueryError("the model has no runtimes yet");
  const inView = new Set([...runtimes, ...graph.ofKind("container").map((n) => n.id), ...graph.ofKind("external").map((n) => n.id)]);
  const lift = (id: string) => {
    const c = graph.containerOf(id);
    return inView.has(c) ? c : undefined;
  };
  return { id: "deploy", title: "Deployment", elements: [...inView].sort(), stubs: [], edges: lifted(graph.model.edges, lift, ["runs_on", "depends_on"]) };
}

const FLOW_KINDS: ViewEdgeKind[] = ["uses", "depends_on"];

/**
 * Maps each edge of the given kinds through `lift`, drops self-loops and merges
 * duplicates. A `next` edge keeps its branch condition as the arrow's label.
 */
function lifted(edges: ModelEdge[], lift: (id: string) => string | undefined, kinds: ViewEdgeKind[] = FLOW_KINDS): ViewEdge[] {
  const wanted = new Set<string>(kinds);
  const out = new Map<string, ViewEdge>();
  for (const e of edges) {
    if (!wanted.has(e.kind)) continue;
    const from = lift(e.from);
    const to = lift(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${e.kind}:${from}->${to}`;
    const existing = out.get(key);
    if (existing) existing.sources.push(edgeKey(e));
    else out.set(key, { from, to, kind: e.kind as ViewEdgeKind, sources: [edgeKey(e)], ...(e.when ? { label: e.when } : {}) });
  }
  return [...out.values()].sort((a, b) => `${a.kind}:${a.from}->${a.to}`.localeCompare(`${b.kind}:${b.from}->${b.to}`));
}

/**
 * Splits a view into sub-views of at most `budget` elements. Elements are ordered
 * along dependencies (entry points first) so each part reads as a step in a story,
 * then grouped by container when the view spans several. Edges that cross parts
 * appear in both, with the far end drawn as a stub linking to its part.
 */
export function splitView(graph: ModelGraph, view: View, level: Level): SplitView[] {
  const budget = ELEMENT_BUDGET[level];
  if (view.elements.length <= budget) return [{ ...view, part: 1, parts: 1, continuesIn: {} }];

  const ordered = narrativeOrder(view);
  const groups = new Map<string, string[]>();
  for (const id of ordered) {
    const key = graph.nodes.get(id)?.kind === "component" ? graph.containerOf(id) : "";
    const list = groups.get(key) ?? [];
    list.push(id);
    groups.set(key, list);
  }
  const chunks: string[][] = [];
  for (const members of groups.values()) {
    for (let i = 0; i < members.length; i += budget) chunks.push(members.slice(i, i + budget));
  }

  const partOf = new Map<string, number>();
  chunks.forEach((c, i) => c.forEach((id) => partOf.set(id, i)));
  return chunks.map((chunk, i) => {
    const mine = new Set(chunk);
    const edges = view.edges.filter((e) => mine.has(e.from) || mine.has(e.to));
    const stubs = new Set<string>();
    for (const e of edges) for (const id of [e.from, e.to]) if (!mine.has(id)) stubs.add(id);
    const continuesIn: Record<string, string> = {};
    for (const s of stubs) {
      const p = partOf.get(s);
      if (p !== undefined) continuesIn[s] = `${view.id}#${p + 1}`;
    }
    return {
      id: `${view.id}#${i + 1}`,
      title: `${view.title} (${i + 1} of ${chunks.length})`,
      elements: chunk,
      stubs: [...stubs].sort(),
      edges,
      part: i + 1,
      parts: chunks.length,
      continuesIn,
    };
  });
}

/** Topological order over the view's edges, entry points first; cycles fall back to id order. */
function narrativeOrder(view: View): string[] {
  const inView = new Set(view.elements);
  const indegree = new Map(view.elements.map((id) => [id, 0]));
  const next = new Map<string, string[]>();
  for (const e of view.edges) {
    if (!inView.has(e.from) || !inView.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < view.elements.length) {
    const ready = view.elements.filter((id) => !done.has(id) && indegree.get(id) === 0);
    const pick = ready[0] ?? view.elements.filter((id) => !done.has(id)).sort()[0]!;
    order.push(pick);
    done.add(pick);
    for (const t of next.get(pick) ?? []) indegree.set(t, (indegree.get(t) ?? 1) - 1);
  }
  return order;
}

export interface CompletenessReport {
  missingElements: string[];
  missingEdges: string[];
}

/** Every element and edge of the parent must appear in at least one sub-view. */
export function checkCompleteness(parent: View, parts: View[]): CompletenessReport {
  const elements = new Set(parts.flatMap((p) => p.elements));
  const key = (e: ViewEdge) => `${e.kind}:${e.from}->${e.to}`;
  const edges = new Set(parts.flatMap((p) => p.edges.map(key)));
  return {
    missingElements: parent.elements.filter((id) => !elements.has(id)),
    missingEdges: parent.edges.map(key).filter((k) => !edges.has(k)),
  };
}

/** At most this many paths are drawn for one process; the rest of its steps go in a last part. */
const MAX_PATHS = 12;

/**
 * Splits a process view by scenario (D-011): one part per path through the steps,
 * the path that takes no conditional branch first. Each part carries the rules and
 * assumptions of its steps. A path longer than the budget is cut into several parts,
 * and steps on no path (a loop with no way in) go in a last part.
 */
export function splitByScenario(graph: ModelGraph, view: View, level: Level): SplitView[] {
  const budget = ELEMENT_BUDGET[level];
  if (view.elements.length <= budget) return [{ ...view, part: 1, parts: 1, continuesIn: {} }];

  const steps = view.elements.filter((id) => graph.nodes.get(id)?.kind === "step");
  const next = view.edges.filter((e) => e.kind === "next");
  const out = new Map<string, ViewEdge[]>();
  for (const e of next) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  // Unconditional arrows first, so the first path found is the happy path.
  for (const list of out.values()) list.sort((a, b) => Number(a.label !== undefined) - Number(b.label !== undefined) || (a.label ?? "").localeCompare(b.label ?? "") || a.to.localeCompare(b.to));
  const hasIn = new Set(next.map((e) => e.to));
  const starts = steps.filter((s) => !hasIn.has(s));

  const paths: { steps: string[]; when?: string }[] = [];
  const walk = (at: string, path: string[], when: string | undefined) => {
    if (paths.length >= MAX_PATHS) return;
    const onward = (out.get(at) ?? []).filter((e) => !path.includes(e.to));
    if (onward.length === 0) {
      paths.push({ steps: path, ...(when !== undefined ? { when } : {}) });
      return;
    }
    for (const e of onward) walk(e.to, [...path, e.to], when ?? e.label);
  };
  for (const s of starts) walk(s, [s], undefined);

  const attached = (ids: string[]) => {
    const own = new Set(ids);
    const extra: string[] = [];
    for (const e of view.edges) if ((e.kind === "constrained_by" || e.kind === "assumes") && own.has(e.from) && !own.has(e.to)) {
      own.add(e.to);
      extra.push(e.to);
    }
    // Assumptions behind the rules just added.
    for (const e of view.edges) if (e.kind === "assumes" && own.has(e.from) && !own.has(e.to)) {
      own.add(e.to);
      extra.push(e.to);
    }
    return extra;
  };

  const chunks: { elements: string[]; title: string }[] = [];
  paths.forEach((p, i) => {
    const name = i === 0 && p.when === undefined ? "Main path" : p.when !== undefined ? `When ${p.when}` : `Path ${i + 1}`;
    let current: string[] = [];
    const flush = () => {
      if (current.length > 0) chunks.push({ elements: current, title: name });
      current = [];
    };
    for (const s of p.steps) {
      const withRules = [s, ...attached([s]).filter((x) => !current.includes(x))];
      if (current.length > 0 && current.length + withRules.length > budget) flush();
      current.push(...withRules);
    }
    flush();
  });
  const placed = new Set(chunks.flatMap((c) => c.elements));
  const rest = view.elements.filter((id) => !placed.has(id));
  if (rest.length > 0) {
    if (chunks.length === 0) chunks.push({ elements: rest, title: view.title });
    else if (rest.every((id) => graph.nodes.get(id)?.kind !== "step")) chunks[0]!.elements.push(...rest);
    else chunks.push({ elements: rest, title: "Other steps" });
  }

  const partOf = new Map<string, number>();
  chunks.forEach((c, i) => c.elements.forEach((id) => partOf.has(id) || partOf.set(id, i)));
  return chunks.map((chunk, i) => {
    const mine = new Set(chunk.elements);
    const edges = view.edges.filter((e) => mine.has(e.from) || mine.has(e.to));
    const stubs = new Set<string>();
    for (const e of edges) for (const id of [e.from, e.to]) if (!mine.has(id)) stubs.add(id);
    const continuesIn: Record<string, string> = {};
    for (const s of stubs) {
      const p = partOf.get(s);
      if (p !== undefined) continuesIn[s] = `${view.id}#${p + 1}`;
    }
    return {
      id: `${view.id}#${i + 1}`,
      title: `${view.title}: ${chunk.title}`,
      elements: chunk.elements,
      stubs: [...stubs].sort(),
      edges,
      part: i + 1,
      parts: chunks.length,
      continuesIn,
    };
  });
}

/** Builds a default view and splits it for a level, asserting that nothing was lost. */
export function view(graph: ModelGraph, name: ViewName, level: Level = "medium"): SplitView[] {
  const full = buildView(graph, name);
  const parts = name.startsWith("process:") ? splitByScenario(graph, full, level) : splitView(graph, full, level);
  const report = checkCompleteness(full, parts);
  if (report.missingElements.length > 0 || report.missingEdges.length > 0) {
    throw new QueryError(`split of '${name}' lost ${JSON.stringify(report)}`);
  }
  return parts;
}
