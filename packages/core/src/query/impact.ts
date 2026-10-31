import { type ModelEdge, edgeKey } from "../schema.js";
import { ModelGraph, QueryError } from "./graph.js";

/**
 * What happens to a node in a what-if. A failure: the part that `fails`, parts that
 * go `down` with it, parts that keep working but worse (`degraded`), and the steps,
 * processes and people `affected`. A change: the requirement that `changed`, the
 * code to `touch`, what is `affected` on the way, and the tests to `retest`.
 */
export type Effect = "fails" | "down" | "degraded" | "affected" | "changed" | "touch" | "retest";

export interface ImpactResult {
  nodes: string[];
  edges: string[];
  effect: Record<string, Effect>;
}

const CAN_FAIL = new Set(["container", "component", "external", "runtime"]);
const CAN_CHANGE = new Set(["process", "step", "rule", "assumption", "entity"]);
const STRENGTH: Partial<Record<Effect, number>> = { fails: 3, down: 2, degraded: 1 };

/**
 * What breaks if a part fails (D-013). A runtime takes down the containers on it, and
 * a container its components. Along `depends_on` edges, a sync caller of a part that
 * is down goes down too; an async or data dependent, or any caller of a degraded
 * part, degrades. Callers of a container are counted when any part inside it fails,
 * as degraded, since they cannot tell which part. Then the steps and processes that
 * broken parts implement, and the people who use those processes or the broken
 * containers, are affected.
 */
export function failureImpact(graph: ModelGraph, id: string): ImpactResult {
  const start = graph.node(id);
  if (!CAN_FAIL.has(start.kind)) throw new QueryError(`only containers, components, externals and runtimes can fail; '${id}' is a ${start.kind}`);
  const effect = new Map<string, Effect>([[id, "fails"]]);
  const edges = new Set<string>();
  /** Raises a node's effect; true when it got stronger, so its callers need another look. */
  const raise = (n: string, e: Effect, via?: ModelEdge): boolean => {
    const now = effect.get(n);
    if (now !== undefined && (STRENGTH[now] ?? 0) >= (STRENGTH[e] ?? 0)) {
      if (via && now === e) edges.add(edgeKey(via));
      return false;
    }
    effect.set(n, e);
    if (via) edges.add(edgeKey(via));
    return true;
  };

  const containers = start.kind === "runtime" ? graph.incoming(id, "runs_on").map((e) => (raise(e.from, "down", e), e.from)) : start.kind === "container" ? [id] : [];
  for (const c of containers) for (const comp of graph.children(c)) raise(comp, "down");

  const queue = [...effect.keys()];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const hard = (STRENGTH[effect.get(at)!] ?? 0) >= 2;
    const parent = graph.node(at).kind === "component" ? graph.parent(at) : undefined;
    const callers = [...graph.incoming(at, "depends_on"), ...(parent !== undefined ? graph.incoming(parent, "depends_on") : [])];
    for (const e of callers) {
      if (e.from === at || e.from === parent) continue;
      const next: Effect = hard && e.to === at && e.mode === "sync" ? "down" : "degraded";
      if (raise(e.from, next, e)) queue.push(e.from);
    }
  }

  const broken = [...effect].filter(([, e]) => STRENGTH[e] !== undefined).map(([n]) => n);
  const mark = (n: string, via?: ModelEdge) => {
    if (!effect.has(n)) effect.set(n, "affected");
    if (via) edges.add(edgeKey(via));
  };
  for (const n of broken) {
    for (const e of graph.outgoing(n, "implements")) {
      mark(e.to, e);
      const process = graph.node(e.to).kind === "step" ? graph.parent(e.to) : undefined;
      if (process !== undefined) mark(process);
    }
  }
  const processes = [...effect].filter(([n, e]) => e === "affected" && graph.node(n).kind === "process").map(([n]) => n);
  for (const n of [...processes, ...broken.filter((b) => graph.node(b).kind === "container")]) {
    for (const e of graph.incoming(n, "uses")) mark(e.from, e);
  }
  return result(effect, edges);
}

/**
 * What a change to a requirement touches: the components that implement the steps
 * or processes it bears on, or that own, write or read the entity, and the tests to
 * run again, being those that cover the changed things or any step or process the
 * touched components implement. An assumption reaches through what assumes it, and a
 * rule through what it constrains.
 */
export function changeImpact(graph: ModelGraph, id: string): ImpactResult {
  const start = graph.node(id);
  if (!CAN_CHANGE.has(start.kind)) throw new QueryError(`only processes, steps, rules, assumptions and entities can change here; '${id}' is a ${start.kind}`);
  const effect = new Map<string, Effect>([[id, "changed"]]);
  const edges = new Set<string>();
  const mark = (n: string, e: Effect, via?: ModelEdge) => {
    if (!effect.has(n)) effect.set(n, e);
    if (via) edges.add(edgeKey(via));
  };

  const seen = new Set<string>();
  const reach = (n: string): void => {
    if (seen.has(n)) return;
    seen.add(n);
    const kind = graph.node(n).kind;
    const through = kind === "assumption" ? graph.incoming(n, "assumes") : kind === "rule" ? graph.incoming(n, "constrained_by") : [];
    for (const e of through) {
      mark(e.from, "affected", e);
      reach(e.from);
    }
    if (kind === "process" || kind === "step") {
      for (const e of graph.incoming(n, "implements")) mark(e.from, "touch", e);
      if (kind === "process") for (const s of graph.children(n)) for (const e of graph.incoming(s, "implements")) mark(e.from, "touch", e);
    }
    if (kind === "entity") for (const k of ["owns", "writes", "reads"] as const) for (const e of graph.incoming(n, k)) mark(e.from, "touch", e);
  };
  reach(id);

  const targets = new Set(effect.keys());
  for (const [c, e] of [...effect]) {
    if (e !== "touch") continue;
    for (const imp of graph.outgoing(c, "implements")) {
      targets.add(imp.to);
      const process = graph.node(imp.to).kind === "step" ? graph.parent(imp.to) : undefined;
      if (process !== undefined) targets.add(process);
    }
  }
  for (const t of targets) for (const e of graph.incoming(t, "covers")) mark(e.from, "retest", e);
  // Every drawn arrow needs both ends in the result.
  for (const key of edges) {
    const e = graph.edges.get(key)!;
    if (!effect.has(e.to)) effect.set(e.to, "affected");
  }
  return result(effect, edges);
}

function result(effect: Map<string, Effect>, edges: Set<string>): ImpactResult {
  return { nodes: [...effect.keys()].sort(), edges: [...edges].sort(), effect: Object.fromEntries([...effect].sort(([a], [b]) => a.localeCompare(b))) };
}
