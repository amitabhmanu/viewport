import type { ModelNode, SplitView, ViewEdgeKind } from "@viewport/core";
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  stub: boolean;
}

export interface Route {
  id: string;
  from: string;
  to: string;
  kind: ViewEdgeKind;
  label?: string;
  points: { x: number; y: number }[];
}

export interface Layout {
  width: number;
  height: number;
  boxes: Box[];
  routes: Route[];
}

export const NODE = { width: 200, height: 72, stubWidth: 160, stubHeight: 44 } as const;

const elk = new ELK();

/** ELK's input for a sub-view. Sorted, with fixed options, so the same view always lays out the same way. */
export function elkGraph(part: SplitView): ElkNode {
  const ids = [...part.elements, ...part.stubs].sort();
  const stub = new Set(part.stubs);
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.nodeNode": "36",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.randomSeed": "1",
      "elk.padding": "[top=16,left=16,bottom=16,right=16]",
    },
    children: ids.map((id) => ({
      id,
      width: stub.has(id) ? NODE.stubWidth : NODE.width,
      height: stub.has(id) ? NODE.stubHeight : NODE.height,
    })),
    edges: [...part.edges]
      .sort((a, b) => `${a.kind}:${a.from}->${a.to}`.localeCompare(`${b.kind}:${b.from}->${b.to}`))
      .map((e) => ({ id: `${e.kind}:${e.from}->${e.to}`, sources: [e.from], targets: [e.to] })),
  };
}

export async function layout(part: SplitView): Promise<Layout> {
  const graph = elkGraph(part);
  const stub = new Set(part.stubs);
  const out = await elk.layout(graph);
  const byKey = new Map(part.edges.map((e) => [`${e.kind}:${e.from}->${e.to}`, e]));
  return {
    width: out.width ?? 0,
    height: out.height ?? 0,
    boxes: (out.children ?? []).map((c) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0, stub: stub.has(c.id) })),
    routes: (out.edges ?? []).map((e) => {
      const section = e.sections?.[0];
      const points = section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [];
      const edge = byKey.get(e.id);
      return { id: e.id, from: e.sources[0]!, to: e.targets[0]!, kind: edge?.kind ?? "depends_on", ...(edge?.label ? { label: edge.label } : {}), points };
    }),
  };
}

/** Which marker a node carries: stale beats unverified; ok nodes, and kinds verification does not check, carry none. */
export function syncMarker(node: ModelNode | undefined): "stale" | "unverified" | undefined {
  if (node === undefined || (node.kind !== "component" && node.kind !== "test")) return undefined;
  return node.sync === "ok" ? undefined : node.sync;
}
