import { type ModelEdge, edgeKey } from "../schema.js";
import { ModelGraph, QueryError } from "./graph.js";

export type Level = "simple" | "medium" | "complex";

/** Maximum elements (nodes, not counting stubs) per sub-view at each level. */
export const ELEMENT_BUDGET: Record<Level, number> = { simple: 5, medium: 7, complex: Number.POSITIVE_INFINITY };

export interface ViewEdge {
  from: string;
  to: string;
  kind: "uses" | "depends_on";
  /** Model edges this view edge stands for. A lifted edge stands for several. */
  sources: string[];
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

export type ViewName = "overview" | "containers" | `components:${string}` | "code-map";

/** Builds a default view, before splitting. */
export function buildView(graph: ModelGraph, name: ViewName): View {
  if (name === "overview") return overview(graph);
  if (name === "containers") return containers(graph);
  if (name === "code-map") return codeMap(graph);
  if (name.startsWith("components:")) return components(graph, name.slice("components:".length));
  throw new QueryError(`unknown view '${name}'`);
}

/** The system with the people who use it and the external systems it depends on. */
function overview(graph: ModelGraph): View {
  const system = graph.ofKind("system")[0];
  if (!system) throw new QueryError("the model has no system node yet");
  const actors = graph.ofKind("actor").map((n) => n.id);
  const externals = graph.ofKind("external").map((n) => n.id);
  const lift = (id: string) => (graph.nodes.get(id)?.kind === "external" || graph.nodes.get(id)?.kind === "actor" ? id : system.id);
  return {
    id: "overview",
    title: system.name,
    elements: [system.id, ...actors, ...externals].sort(),
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

/** Maps each flow edge's ends through `lift`, drops self-loops and merges duplicates. */
function lifted(edges: ModelEdge[], lift: (id: string) => string | undefined): ViewEdge[] {
  const out = new Map<string, ViewEdge>();
  for (const e of edges) {
    if (e.kind !== "uses" && e.kind !== "depends_on") continue;
    const from = lift(e.from);
    const to = lift(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${e.kind}:${from}->${to}`;
    const existing = out.get(key);
    if (existing) existing.sources.push(edgeKey(e));
    else out.set(key, { from, to, kind: e.kind, sources: [edgeKey(e)] });
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

/** Builds a default view and splits it for a level, asserting that nothing was lost. */
export function view(graph: ModelGraph, name: ViewName, level: Level = "medium"): SplitView[] {
  const full = buildView(graph, name);
  const parts = splitView(graph, full, level);
  const report = checkCompleteness(full, parts);
  if (report.missingElements.length > 0 || report.missingEdges.length > 0) {
    throw new QueryError(`split of '${name}' lost ${JSON.stringify(report)}`);
  }
  return parts;
}
