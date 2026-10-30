import { type DependencyMode, type ModelEdge, type ModelNode, type SyncState, edgeKey } from "../schema.js";
import type { z } from "zod";
import { ModelGraph, QueryError } from "./graph.js";

/** A set of nodes and edges returned by a query; edges are referenced by key. */
export interface Subgraph {
  nodes: string[];
  edges: string[];
}

export interface NodeDetail {
  node: ModelNode;
  parent?: string;
  children: string[];
  outgoing: ModelEdge[];
  incoming: ModelEdge[];
  decisions: string[];
}

export function get(graph: ModelGraph, id: string): NodeDetail {
  const node = graph.node(id);
  const parent = graph.parent(id);
  const isFlow = (e: ModelEdge) => e.kind !== "contains";
  return {
    node,
    ...(parent !== undefined ? { parent } : {}),
    children: graph.children(id),
    outgoing: graph.outgoing(id).filter(isFlow),
    incoming: graph.incoming(id).filter(isFlow),
    decisions: graph.decisionsFor(id),
  };
}

const FLOW: ReadonlySet<ModelEdge["kind"]> = new Set(["depends_on", "uses"]);

export interface TraceOptions {
  /** With `to`: the shortest dependency path. Without: everything reachable. */
  to?: string;
  direction?: "downstream" | "upstream";
}

/**
 * Follows `uses` and `depends_on` edges. With a target, returns one shortest path
 * (ties broken by id order, so results are stable); without one, the reachable subgraph.
 */
export function trace(graph: ModelGraph, from: string, options: TraceOptions = {}): Subgraph {
  graph.node(from);
  if (options.to !== undefined) graph.node(options.to);
  const upstream = options.direction === "upstream";
  const step = (id: string) =>
    (upstream ? graph.incoming(id) : graph.outgoing(id))
      .filter((e) => FLOW.has(e.kind))
      .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const next = (e: ModelEdge) => (upstream ? e.from : e.to);

  const via = new Map<string, ModelEdge>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === options.to) break;
    for (const e of step(id)) {
      const n = next(e);
      if (seen.has(n)) continue;
      seen.add(n);
      via.set(n, e);
      queue.push(n);
    }
  }

  if (options.to === undefined) {
    return { nodes: [...seen].sort(), edges: [...via.values()].map(edgeKey).sort() };
  }
  if (!seen.has(options.to)) throw new QueryError(`no path from '${from}' to '${options.to}'`);
  const nodes = [options.to];
  const edges: string[] = [];
  for (let at = options.to; at !== from; ) {
    const e = via.get(at)!;
    edges.unshift(edgeKey(e));
    at = upstream ? e.to : e.from;
    nodes.unshift(at);
  }
  return { nodes, edges };
}

export interface SliceFilter {
  /** External systems and everything that depends on them directly. */
  externals?: boolean;
  mode?: z.infer<typeof DependencyMode>;
  sync?: z.infer<typeof SyncState>;
  /** Everything a decision shaped. */
  decidedBy?: string;
}

/** The part of the model matching a concern. Filters combine with AND. */
export function slice(graph: ModelGraph, filter: SliceFilter): Subgraph {
  let edges = graph.model.edges.filter((e) => e.kind !== "contains" && e.kind !== "decided_by");
  let nodes: Set<string> | undefined;

  if (filter.externals) edges = edges.filter((e) => graph.nodes.get(e.to)?.kind === "external");
  if (filter.mode !== undefined) edges = edges.filter((e) => e.mode === filter.mode);
  if (filter.decidedBy !== undefined) {
    if (graph.nodes.get(filter.decidedBy)?.kind !== "decision") throw new QueryError(`'${filter.decidedBy}' is not a decision`);
    const shaped = new Set(graph.incoming(filter.decidedBy, "decided_by").map((e) => e.from));
    edges = edges.filter((e) => shaped.has(edgeKey(e)));
    nodes = new Set([...shaped].filter((id) => graph.nodes.has(id)));
  }
  if (filter.sync !== undefined) {
    const s = filter.sync;
    edges = edges.filter((e) => e.sync === s);
    const syncNodes = graph.model.nodes.filter((n) => n.sync === s && n.kind !== "decision").map((n) => n.id);
    nodes = new Set([...(nodes ?? syncNodes)].filter((id) => syncNodes.includes(id)));
  }

  const ids = new Set(nodes ?? []);
  for (const e of edges) {
    ids.add(e.from);
    ids.add(e.to);
  }
  return { nodes: [...ids].sort(), edges: edges.map(edgeKey).sort() };
}
