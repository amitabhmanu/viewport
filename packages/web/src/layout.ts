import type { ModelNode, SplitView, ViewEdgeKind } from "@viewport/core";
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { measure } from "./boxes.js";

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  stub: boolean;
  /** The start or end of a process: a small circle, not a part of the model. */
  terminal?: "start" | "end";
}

export interface Route {
  id: string;
  from: string;
  to: string;
  kind: ViewEdgeKind;
  label?: string;
  points: { x: number; y: number }[];
  /** A line that stands for no model arrow (to a process's end), so it can't be selected. */
  plain?: boolean;
  /** Where the layout put the arrow's text, when it reserved room for it. */
  labelAt?: { x: number; y: number };
}

export interface Layout {
  width: number;
  height: number;
  boxes: Box[];
  routes: Route[];
}

/** Box sizes: room for a name, two lines of description and a note. */
export const NODE = { width: 200, height: 84, stubWidth: 160, stubHeight: 44 } as const;

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

/** Lays out a sub-view. A process view, given each element's kind, reads as a flow. */
export async function layout(part: SplitView, kindOf?: (id: string) => ModelNode["kind"] | undefined): Promise<Layout> {
  if (kindOf && part.id.startsWith("process:") && part.elements.some((id) => kindOf(id) === "step")) return flowLayout(part, kindOf);
  return layeredLayout(part);
}

async function layeredLayout(part: SplitView): Promise<Layout> {
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

export const START = "__start";
export const END = "__end";
const TERMINAL = 18;
const GUTTER = 14;
const HANG_GAP = 20;
const LABEL_FONT = "11px system-ui";

/**
 * A process as a flow: from a start dot, steps left to right along their "next"
 * arrows, to an end dot. Each step's business rules hang under it, and their
 * assumptions under those, joined by arrows in a gutter to the left, so the flow
 * itself stays one straight line. ELK lays out the steps with their hanging boxes
 * as one tall block, so nothing overlaps.
 */
export async function flowLayout(part: SplitView, kindOf: (id: string) => ModelNode["kind"] | undefined): Promise<Layout> {
  const steps = part.elements.filter((id) => kindOf(id) === "step");
  const stepSet = new Set(steps);
  const next = part.edges.filter((e) => e.kind === "next" && stepSet.has(e.from) && stepSet.has(e.to));
  const hangEdges = part.edges.filter((e) => e.kind !== "next");

  // Each rule or assumption hangs under the first step (in the process's order) that reaches it.
  const owner = new Map<string, string>();
  const hung = new Map<string, { id: string; depth: number }[]>(steps.map((s) => [s, []]));
  const hang = (from: string, root: string, depth: number) => {
    for (const e of hangEdges) {
      if (e.from !== from || stepSet.has(e.to) || owner.has(e.to)) continue;
      owner.set(e.to, root);
      hung.get(root)!.push({ id: e.to, depth });
      hang(e.to, root, depth + 1);
    }
  };
  for (const s of steps) hang(s, s, 1);
  const depthOf = new Map([...hung.values()].flat().map((h) => [h.id, h.depth]));
  const loose = part.elements.filter((id) => !stepSet.has(id) && !owner.has(id)).sort();
  const maxDepth = Math.max(0, ...[...hung.values()].flat().map((h) => h.depth));
  const gutter = maxDepth > 0 ? GUTTER * maxDepth : 0;
  const blockHeight = (s: string) => NODE.height + hung.get(s)!.length * (NODE.height + HANG_GAP);

  const hasIn = new Set(next.map((e) => e.to));
  const hasOut = new Set(next.map((e) => e.from));
  const edges: { id: string; from: string; to: string; label?: string | undefined }[] = [
    ...steps.filter((s) => !hasIn.has(s)).map((s) => ({ id: `start:${START}->${s}`, from: START, to: s })),
    ...[...next].sort((a, b) => `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`)).map((e) => ({ id: `next:${e.from}->${e.to}`, from: e.from, to: e.to, label: e.label })),
    ...steps.filter((s) => !hasOut.has(s)).map((s) => ({ id: `end:${s}->${END}`, from: s, to: END })),
  ];
  const port = (id: string, side: "in" | "out") => `${id}.${side}`;
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "48",
      "elk.spacing.nodeNode": "32",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.placement": "CENTER",
      // Steps sit as early as their arrows allow, so a process's starting steps line up at the start.
      "elk.layered.layering.strategy": "LONGEST_PATH_SOURCE",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.randomSeed": "1",
      "elk.padding": "[top=16,left=16,bottom=16,right=16]",
    },
    children: [
      ...[START, END].filter((t) => edges.some((e) => e.from === t || e.to === t)).map((id) => ({ id, width: TERMINAL, height: TERMINAL })),
      ...steps.map((id) => ({
        id,
        width: gutter + NODE.width,
        height: blockHeight(id),
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: [
          { id: port(id, "in"), x: gutter, y: NODE.height / 2, width: 0, height: 0 },
          { id: port(id, "out"), x: gutter + NODE.width, y: NODE.height / 2, width: 0, height: 0 },
        ],
      })),
      ...loose.map((id) => ({ id, width: NODE.width, height: NODE.height })),
    ],
    edges: edges.map((e) => ({
      id: e.id,
      sources: [stepSet.has(e.from) ? port(e.from, "out") : e.from],
      targets: [stepSet.has(e.to) ? port(e.to, "in") : e.to],
      ...(e.label ? { labels: [{ text: e.label, width: Math.min(180, measure(e.label, LABEL_FONT)) + 4, height: 14 }] } : {}),
    })),
  };
  const out = await elk.layout(graph);
  const at = new Map((out.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));

  const boxes: Box[] = [];
  const place = new Map<string, Box>();
  const add = (b: Box) => {
    boxes.push(b);
    place.set(b.id, b);
  };
  for (const t of [START, END]) if (at.has(t)) add({ id: t, ...at.get(t)!, width: TERMINAL, height: TERMINAL, stub: false, terminal: t === START ? "start" : "end" });
  for (const s of steps) {
    const p = at.get(s)!;
    add({ id: s, x: p.x + gutter, y: p.y, width: NODE.width, height: NODE.height, stub: false });
    hung.get(s)!.forEach((h, i) => add({ id: h.id, x: p.x + gutter, y: p.y + (i + 1) * (NODE.height + HANG_GAP), width: NODE.width, height: NODE.height, stub: false }));
  }
  for (const id of loose) add({ id, ...at.get(id)!, width: NODE.width, height: NODE.height, stub: false });

  const routes: Route[] = [];
  for (const e of out.edges ?? []) {
    if (!e.id.startsWith("next:")) continue;
    const section = e.sections?.[0];
    const [from, to] = e.id.slice("next:".length).split("->") as [string, string];
    const view = next.find((n) => n.from === from && n.to === to);
    const label = e.labels?.[0];
    routes.push({
      id: e.id,
      from,
      to,
      kind: "next",
      ...(view?.label ? { label: view.label } : {}),
      points: section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [],
      ...(label ? { labelAt: { x: label.x ?? 0, y: (label.y ?? 0) + (label.height ?? 0) / 2 } } : {}),
    });
  }
  // The start and end arrows are drawn as plain lines, not model arrows.
  for (const e of out.edges ?? []) {
    if (e.id.startsWith("next:")) continue;
    const section = e.sections?.[0];
    const [from, to] = e.id.slice(e.id.indexOf(":") + 1).split("->") as [string, string];
    routes.push({ id: e.id, from, to, kind: "next", plain: true, points: section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : [] });
  }
  // Rules and assumptions: down the gutter from the left of the source to the left of the target.
  for (const e of hangEdges) {
    const a = place.get(e.from);
    const b = place.get(e.to);
    if (!a || !b) continue;
    // Hanging in the same column: through the gutter, one lane per depth. Otherwise (a rule shared with a step elsewhere), straight across.
    const depth = a.x === b.x && b.y > a.y ? (depthOf.get(e.to) ?? 1) : 0;
    const points =
      depth > 0
        ? [
            // Out low on the left and in high, clear of the flow's arrows, which meet the middle.
            { x: a.x, y: a.y + a.height - 18 },
            { x: a.x - GUTTER * depth + GUTTER / 2, y: a.y + a.height - 18 },
            { x: a.x - GUTTER * depth + GUTTER / 2, y: b.y + 18 },
            { x: b.x, y: b.y + 18 },
          ]
        : [
            { x: a.x + a.width / 2, y: a.y + a.height },
            { x: a.x + a.width / 2, y: b.y + b.height / 2 },
            { x: b.x + (a.x < b.x ? 0 : b.width), y: b.y + b.height / 2 },
          ];
    routes.push({ id: `${e.kind}:${e.from}->${e.to}`, from: e.from, to: e.to, kind: e.kind, points });
  }
  return { width: out.width ?? 0, height: out.height ?? 0, boxes, routes };
}
