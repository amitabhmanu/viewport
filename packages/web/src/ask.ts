import type { AskQuery, ModelEdge, ModelNode, SplitView, Subgraph } from "@viewport/core";

/** Slices offered in the Ask form, as [label, query]. */
export const SLICES: [string, AskQuery][] = [
  ["Async dependencies", { q: "slice", mode: "async" }],
  ["Sync dependencies", { q: "slice", mode: "sync" }],
  ["Data dependencies", { q: "slice", mode: "data" }],
  ["Calls to external systems", { q: "slice", externals: true }],
  ["Changed since modeled", { q: "slice", sync: "stale" }],
  ["Not yet checked", { q: "slice", sync: "unverified" }],
];

/** An Ask query read from URL parameters, or undefined when they don't make one. */
export function parseAsk(params: URLSearchParams): AskQuery | undefined {
  const get = (k: string) => params.get(k) || undefined;
  if (params.get("q") === "trace") {
    const from = get("from");
    if (!from) return undefined;
    const to = get("to");
    const direction = get("direction");
    return { q: "trace", from, ...(to ? { to } : {}), ...(direction === "upstream" || direction === "downstream" ? { direction } : {}) };
  }
  if (params.get("q") === "slice") {
    const mode = get("mode");
    const sync = get("sync");
    const decidedBy = get("decidedBy");
    const query: AskQuery = {
      q: "slice",
      ...(params.get("externals") === "true" ? { externals: true } : {}),
      ...(mode === "sync" || mode === "async" || mode === "data" ? { mode } : {}),
      ...(sync === "ok" || sync === "stale" || sync === "unverified" ? { sync } : {}),
      ...(decidedBy ? { decidedBy } : {}),
    };
    return Object.keys(query).length > 1 ? query : undefined;
  }
  return undefined;
}

export function askHref(query: AskQuery): string {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  return `/ask?${params.toString()}`;
}

/** A plain-language title for a query. */
export function askTitle(query: AskQuery, nodes: Map<string, ModelNode>): string {
  const name = (id: string) => nodes.get(id)?.name ?? id;
  if (query.q === "trace") {
    if (query.to) return `How ${name(query.from)} reaches ${name(query.to)}`;
    return query.direction === "upstream" ? `What depends on ${name(query.from)}` : `What ${name(query.from)} depends on`;
  }
  const preset = SLICES.find(([, s]) => JSON.stringify(s) === JSON.stringify(query));
  if (preset) return preset[0];
  if (query.decidedBy && Object.keys(query).length === 2) return `Shaped by ${name(query.decidedBy)}`;
  return "Custom slice";
}

/** A query result as a one-part view the Map's diagram can draw. */
export function askView(result: Subgraph, edges: ModelEdge[], title: string): SplitView {
  const byKey = new Map(edges.map((e) => [`${e.kind}:${e.from}->${e.to}`, e]));
  return {
    id: "ask",
    title,
    part: 1,
    parts: 1,
    elements: result.nodes,
    stubs: [],
    continuesIn: {},
    edges: result.edges.flatMap((key) => {
      const e = byKey.get(key);
      return e && (e.kind === "depends_on" || e.kind === "uses") ? [{ from: e.from, to: e.to, kind: e.kind, sources: [key] }] : [];
    }),
  };
}
