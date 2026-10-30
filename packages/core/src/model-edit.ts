import { LedgerError, appendDecision, nextDecisionId, readLedger } from "./ledger.js";
import { readModel } from "./model-store.js";
import { viewportPaths } from "./paths.js";
import { ModelGraph } from "./query/graph.js";
import { type Decision, type DecisionInput, Model, type ModelEdge, ModelEdge as ModelEdgeSchema, ModelNode, edgeKey } from "./schema.js";
import { writeModelFromAgent, type WriteResult } from "./workspace.js";

export interface ModelPatch {
  /** Nodes to add, or to replace when a node with the same id exists. */
  nodes?: unknown[];
  /** Edges to add, or to replace when an edge with the same key exists. */
  edges?: unknown[];
}

/** Merges nodes and edges into a model by id and edge key. Validates each item, not the result. */
export function mergeIntoModel(model: Model, patch: ModelPatch): Model {
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  for (const raw of patch.nodes ?? []) {
    const node = ModelNode.parse(raw);
    nodes.set(node.id, node);
  }
  const edges = new Map(model.edges.map((e) => [edgeKey(e), e]));
  for (const raw of patch.edges ?? []) {
    const edge = ModelEdgeSchema.parse(raw);
    edges.set(edgeKey(edge), edge);
  }
  return { ...model, nodes: [...nodes.values()], edges: [...edges.values()] };
}

export interface ModelRemoval {
  nodes?: string[];
  /** Edge keys, as `kind:from->to`. */
  edges?: string[];
}

export class ModelEditError extends Error {}

/**
 * Removes nodes and edges. Edges touching a removed node go too, and so do
 * `decided_by` links from removed edges. Children are not removed: a container that
 * still holds components fails validation, so the caller must remove or move them.
 */
export function removeFromModel(model: Model, removal: ModelRemoval): Model {
  const ids = new Set(removal.nodes ?? []);
  const keys = new Set(removal.edges ?? []);
  const known = new Set(model.nodes.map((n) => n.id));
  const knownKeys = new Set(model.edges.map(edgeKey));
  const missing = [...[...ids].filter((id) => !known.has(id)), ...[...keys].filter((k) => !knownKeys.has(k))];
  if (missing.length > 0) throw new ModelEditError(`not in the model: ${missing.join(", ")}`);

  const gone = (e: ModelEdge) => keys.has(edgeKey(e)) || ids.has(e.from) || ids.has(e.to);
  const removedKeys = new Set(model.edges.filter(gone).map(edgeKey));
  const edges = model.edges.filter((e) => !gone(e) && !(e.kind === "decided_by" && removedKeys.has(e.from)));
  return { ...model, nodes: model.nodes.filter((n) => !ids.has(n.id)), edges };
}

/**
 * The components a change to `affects` touches: the components named, inside named
 * containers or systems, or at either end of named edges, plus every component that
 * depends on one of those directly. Computed from the model, never guessed.
 */
export function blastRadius(model: Model, affects: string[]): string[] {
  const graph = new ModelGraph(model);
  const touched = new Set<string>();
  const components = (id: string): string[] => {
    const node = graph.nodes.get(id);
    if (node === undefined) return [];
    switch (node.kind) {
      case "component":
        return [id];
      case "container":
        return graph.children(id);
      case "system":
        return graph.children(id).flatMap((c) => graph.children(c));
      case "external":
        return graph.incoming(id, "depends_on").flatMap((e) => components(e.from));
      default:
        return [];
    }
  };
  for (const ref of affects) {
    const edge = graph.edges.get(ref);
    const ends = edge !== undefined ? [edge.from, edge.to] : [ref];
    for (const id of ends) for (const c of components(id)) touched.add(c);
  }
  for (const id of [...touched]) {
    for (const e of graph.incoming(id, "depends_on")) for (const c of components(e.from)) touched.add(c);
  }
  return [...touched].sort();
}

export type DecisionRecord = Omit<DecisionInput, "id" | "at" | "blastRadius">;

export interface RecordedDecision {
  decision: Decision;
  /** Components counted in the blast radius. */
  touched: string[];
  write: WriteResult;
}

/**
 * Logs a decision: computes its blast radius from the model, appends it to the
 * ledger, and links it into the model as a decision node with `decided_by` edges
 * from everything it affects. Nothing is written when a reference is unknown.
 */
export async function recordDecision(root: string, input: DecisionRecord): Promise<RecordedDecision> {
  const paths = viewportPaths(root);
  const model = await readModel(paths.model);
  const graph = new ModelGraph(model);
  const affects = input.affects ?? [];
  const unknown = affects.filter((ref) => !graph.nodes.has(ref) && !graph.edges.has(ref));
  if (unknown.length > 0) {
    throw new ModelEditError(`affects names nothing in the model: ${unknown.join(", ")}; use node ids or edge keys such as depends_on:a->b`);
  }
  const touched = blastRadius(model, affects);
  const ledger = await readLedger(paths.ledger);
  if (input.supersedes !== undefined && !ledger.some((d) => d.id === input.supersedes)) {
    throw new LedgerError(`supersedes unknown decision ${input.supersedes}`);
  }

  // Validate the linked model before touching the ledger, so a bad write leaves both unchanged.
  const id = nextDecisionId(ledger);
  const linked = (decision: Pick<Decision, "id" | "title" | "reversibility" | "blastRadius">) =>
    Model.parse(
      mergeIntoModel(model, {
        nodes: [{ kind: "decision", id: decision.id.toLowerCase(), name: decision.title, reversibility: decision.reversibility, blastRadius: decision.blastRadius }],
        edges: affects.map((from) => ({ kind: "decided_by", from, to: decision.id.toLowerCase() })),
      }),
    );
  linked({ id, title: input.title, reversibility: input.reversibility, blastRadius: touched.length });

  const decision = await appendDecision(paths.ledger, { ...input, id, blastRadius: touched.length });
  const write = await writeModelFromAgent(root, linked(decision));
  return { decision, touched, write };
}

