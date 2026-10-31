import type { AskQuery, Decision, Effect, Model, ModelEdge, ModelNode, Prediction, SplitView, Subgraph, ViewEdgeKind } from "@viewport/core";

/** Slices offered in the Ask form, as [label, query]. */
export const SLICES: [string, AskQuery][] = [
  ["Async dependencies", { q: "slice", mode: "async" }],
  ["Sync dependencies", { q: "slice", mode: "sync" }],
  ["Data dependencies", { q: "slice", mode: "data" }],
  ["Calls to external systems", { q: "slice", externals: true }],
  ["Changed since modeled", { q: "slice", sync: "stale" }],
  ["Not yet checked", { q: "slice", sync: "unverified" }],
];

/** The kinds of question the Ask form offers, in order. */
export const ASK_KINDS: [AskQuery["q"], string][] = [
  ["trace", "Trace"],
  ["slice", "Slice"],
  ["fails", "What if it fails"],
  ["changes", "What if it changes"],
  ["compare", "Compare revisions"],
  ["options", "Compare options"],
];

/** Node kinds that can fail in a what-if, and kinds a requirement change can start from. */
export const FAILABLE = new Set<ModelNode["kind"]>(["container", "component", "external", "runtime"]);
export const CHANGEABLE = new Set<ModelNode["kind"]>(["process", "step", "rule", "assumption", "entity"]);

/** An Ask query read from URL parameters, or undefined when they don't make one. */
export function parseAsk(params: URLSearchParams): AskQuery | undefined {
  const get = (k: string) => params.get(k) || undefined;
  const q = params.get("q");
  if (q === "trace") {
    const from = get("from");
    if (!from) return undefined;
    const to = get("to");
    const direction = get("direction");
    return { q: "trace", from, ...(to ? { to } : {}), ...(direction === "upstream" || direction === "downstream" ? { direction } : {}) };
  }
  if (q === "slice") {
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
  if (q === "fails" || q === "changes") {
    const node = get("node");
    return node ? { q, node } : undefined;
  }
  if (q === "compare") {
    const revision = (k: string) => {
      const v = get(k);
      return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
    };
    const from = revision("from");
    const to = revision("to");
    return from === undefined ? undefined : { q, from, ...(to !== undefined ? { to } : {}) };
  }
  if (q === "options") {
    const decision = get("decision");
    return decision ? { q, decision } : undefined;
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
  switch (query.q) {
    case "trace":
      if (query.to) return `How ${name(query.from)} reaches ${name(query.to)}`;
      return query.direction === "upstream" ? `What depends on ${name(query.from)}` : `What ${name(query.from)} depends on`;
    case "fails":
      return `If ${name(query.node)} fails`;
    case "changes":
      return `If ${name(query.node)} changes`;
    case "compare":
      return `Revision ${query.from} against ${query.to === undefined ? "now" : `revision ${query.to}`}`;
    case "options":
      return `Options for ${name(query.decision.toLowerCase())}`;
    case "slice": {
      const preset = SLICES.find(([, s]) => JSON.stringify(s) === JSON.stringify(query));
      if (preset) return preset[0];
      if (query.decidedBy && Object.keys(query).length === 2) return `Shaped by ${name(query.decidedBy)}`;
      return "Custom slice";
    }
  }
}

/** The node a query is about, if it is about one: shown as "Pinned here" when it is on the Map. */
export function askSubject(query: AskQuery): string | undefined {
  switch (query.q) {
    case "trace":
      return query.from;
    case "fails":
    case "changes":
      return query.node;
    case "options":
      return query.decision.toLowerCase();
    default:
      return undefined;
  }
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
      if (!e || e.kind === "contains" || e.kind === "decided_by") return [];
      return [{ from: e.from, to: e.to, kind: e.kind as ViewEdgeKind, sources: [key], ...(e.when ? { label: e.when } : {}) }];
    }),
  };
}

export const EFFECT_LABEL: Record<Effect, string> = {
  fails: "Fails",
  down: "Down",
  degraded: "Degraded",
  affected: "Affected",
  changed: "Changes",
  touch: "Change here",
  retest: "Retest",
};

/**
 * What a what-if comes to, as short lines: what goes down and what degrades, or what
 * code to touch and which tests to rerun, then the processes and people it reaches.
 */
export function impactLines(effect: Record<string, Effect>, nodes: Map<string, ModelNode>): string[] {
  const names = (pick: (id: string, e: Effect) => boolean) =>
    Object.entries(effect)
      .filter(([id, e]) => pick(id, e))
      .map(([id]) => nodes.get(id)?.name ?? id)
      .sort();
  const kindIs = (id: string, ...kinds: ModelNode["kind"][]) => kinds.includes(nodes.get(id)?.kind as ModelNode["kind"]);
  const lines: [string, string[]][] = [
    ["Goes down", names((_, e) => e === "down")],
    ["Keeps working, but degraded", names((_, e) => e === "degraded")],
    ["Code to change", names((_, e) => e === "touch")],
    ["Tests to run again", names((_, e) => e === "retest")],
    ["Processes affected", names((id, e) => e === "affected" && kindIs(id, "process", "step"))],
    ["People affected", names((id, e) => e === "affected" && kindIs(id, "actor"))],
  ];
  return lines.filter(([, list]) => list.length > 0).map(([label, list]) => `${label}: ${list.join(", ")}.`);
}

export interface FollowUp {
  text: string;
  href: string;
}

/**
 * One question to end an answer with, about the part of the result most worth a
 * thought (by salience): guess a decision that shaped it, if one is still waiting for
 * a guess; otherwise a what-if on it.
 */
export function followUp(
  result: string[],
  asked: string | undefined,
  model: Model,
  ledger: Decision[],
  predictions: Prediction[],
  salience: Record<string, number>,
): FollowUp | undefined {
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const guessed = new Set(predictions.map((p) => p.decisionId));
  const replaced = new Set(ledger.flatMap((d) => (d.supersedes ? [d.supersedes] : [])));
  const open = new Map(ledger.filter((d) => !guessed.has(d.id) && !replaced.has(d.id)).map((d) => [d.id.toLowerCase(), d]));
  const candidates = result
    .filter((id) => id !== asked && nodes.has(id) && nodes.get(id)!.kind !== "decision")
    .sort((a, b) => (salience[b] ?? 0) - (salience[a] ?? 0) || a.localeCompare(b));
  for (const id of candidates) {
    const touching = (key: string) => key === id || key.includes(`:${id}->`) || key.endsWith(`->${id}`);
    const shaped = model.edges.filter((e) => e.kind === "decided_by" && touching(e.from)).map((e) => open.get(e.to)).find((d) => d !== undefined);
    if (shaped) return { text: `${nodes.get(id)!.name} was shaped by “${shaped.title}”. Can you guess which way it went?`, href: `/ledger#${shaped.id}` };
  }
  const top = candidates.map((id) => nodes.get(id)!).find((n) => FAILABLE.has(n.kind) || CHANGEABLE.has(n.kind));
  if (!top) return undefined;
  return FAILABLE.has(top.kind)
    ? { text: `What would break if ${top.name} failed?`, href: askHref({ q: "fails", node: top.id }) }
    : { text: `What would a change to ${top.name} touch?`, href: askHref({ q: "changes", node: top.id }) };
}
