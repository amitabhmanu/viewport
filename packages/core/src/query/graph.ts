import { type Model, type ModelEdge, type ModelNode, edgeKey } from "../schema.js";

/** Read-only index over a model for queries. Build once per model revision. */
export class ModelGraph {
  readonly nodes = new Map<string, ModelNode>();
  readonly edges = new Map<string, ModelEdge>();
  private readonly out = new Map<string, ModelEdge[]>();
  private readonly in = new Map<string, ModelEdge[]>();

  constructor(readonly model: Model) {
    for (const n of model.nodes) this.nodes.set(n.id, n);
    for (const e of model.edges) {
      this.edges.set(edgeKey(e), e);
      push(this.out, e.from, e);
      push(this.in, e.to, e);
    }
  }

  node(id: string): ModelNode {
    const n = this.nodes.get(id);
    if (!n) throw new QueryError(`unknown node '${id}'`);
    return n;
  }

  outgoing(id: string, kind?: ModelEdge["kind"]): ModelEdge[] {
    return (this.out.get(id) ?? []).filter((e) => kind === undefined || e.kind === kind);
  }

  incoming(id: string, kind?: ModelEdge["kind"]): ModelEdge[] {
    return (this.in.get(id) ?? []).filter((e) => kind === undefined || e.kind === kind);
  }

  parent(id: string): string | undefined {
    return this.incoming(id, "contains")[0]?.from;
  }

  children(id: string): string[] {
    return this.outgoing(id, "contains").map((e) => e.to).sort();
  }

  /** The container a component sits in, or the node itself for anything else. */
  containerOf(id: string): string {
    return this.node(id).kind === "component" ? (this.parent(id) ?? id) : id;
  }

  /** Decisions linked by `decided_by` from this node or from any edge touching it. */
  decisionsFor(id: string): string[] {
    const touching = new Set([id, ...[...this.outgoing(id), ...this.incoming(id)].map(edgeKey)]);
    const out = new Set<string>();
    for (const e of this.model.edges) if (e.kind === "decided_by" && touching.has(e.from)) out.add(e.to);
    return [...out].sort();
  }

  ofKind<K extends ModelNode["kind"]>(kind: K): Extract<ModelNode, { kind: K }>[] {
    return this.model.nodes.filter((n): n is Extract<ModelNode, { kind: K }> => n.kind === kind);
  }
}

export class QueryError extends Error {}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
