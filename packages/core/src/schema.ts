import { z } from "zod";

/** Lowercase slug ids such as `orders`, `orders.api` or `d-014`. */
export const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "ids are lowercase slugs: letters, digits, '.', '_' and '-'");

export const NodeKind = z.enum([
  "system",
  "actor",
  "external",
  "container",
  "component",
  "decision",
  "process",
  "step",
  "rule",
  "assumption",
  "entity",
  "test",
  "runtime",
]);
export type NodeKind = z.infer<typeof NodeKind>;

export const Source = z.enum(["agent", "verified"]);
export const SyncState = z.enum(["ok", "stale", "unverified"]);
export const Reversibility = z.enum(["easy", "costly", "one-way"]);

const nodeBase = {
  id: Id,
  name: z.string().min(1),
  /** One sentence a reader should leave with. Written before the view is rendered. */
  takeaway: z.string().min(1).optional(),
  /** The takeaway at each level of detail, written by the explainer. */
  takeaways: z.object({ simple: z.string().min(1), medium: z.string().min(1), complex: z.string().min(1) }).optional(),
  source: Source.default("agent"),
  sync: SyncState.default("unverified"),
  /** Commit at which this node was last updated. */
  changedAt: z.string().min(1).optional(),
};

export const SystemNode = z.object({ ...nodeBase, kind: z.literal("system"), purpose: z.string().min(1) });
export const ActorNode = z.object({ ...nodeBase, kind: z.literal("actor"), goal: z.string().min(1) });
export const ExternalNode = z.object({
  ...nodeBase,
  kind: z.literal("external"),
  role: z.string().min(1),
  protocol: z.string().min(1).optional(),
});
export const ContainerNode = z.object({
  ...nodeBase,
  kind: z.literal("container"),
  role: z.string().min(1),
  tech: z.string().min(1).optional(),
});
export const ComponentNode = z.object({
  ...nodeBase,
  kind: z.literal("component"),
  role: z.string().min(1),
  tech: z.string().min(1).optional(),
  /** Globs, relative to the repo root, for the source files this component owns. */
  paths: z.array(z.string().min(1)).min(1),
  /** Hash of the component's files when it was last modeled; a mismatch means stale. */
  fingerprint: z.string().min(1).optional(),
});
export const DecisionNode = z.object({
  ...nodeBase,
  kind: z.literal("decision"),
  reversibility: Reversibility,
  blastRadius: z.number().int().nonnegative(),
});

/** A business process: what someone outside the code wants done, end to end. */
export const ProcessNode = z.object({ ...nodeBase, kind: z.literal("process"), goal: z.string().min(1) });
/** One step of a process, inside it by `contains` and ordered by `next` edges. */
export const StepNode = z.object({ ...nodeBase, kind: z.literal("step"), does: z.string().min(1) });
/** A business rule the system must keep, in plain words. */
export const RuleNode = z.object({ ...nodeBase, kind: z.literal("rule"), statement: z.string().min(1) });
export const AssumptionStatus = z.enum(["open", "confirmed", "rejected"]);
/** Something taken as true about the business that only the developer can confirm. */
export const AssumptionNode = z.object({
  ...nodeBase,
  kind: z.literal("assumption"),
  statement: z.string().min(1),
  status: AssumptionStatus.default("open"),
});
export const Sensitivity = z.enum(["public", "internal", "pii", "secret"]);
/** A thing the system stores or passes around: order, user, session. */
export const EntityNode = z.object({
  ...nodeBase,
  kind: z.literal("entity"),
  description: z.string().min(1),
  sensitivity: Sensitivity.default("internal"),
  /** Names it goes by in the code (class, type or table), checked against the owner's files. */
  code: z.array(z.string().min(1)).default([]),
});
/** A group of tests, by the files that hold them. */
export const TestNode = z.object({
  ...nodeBase,
  kind: z.literal("test"),
  /** Globs, relative to the repo root, for the test files. */
  paths: z.array(z.string().min(1)).min(1),
});
/** Where containers run once deployed: a host, a function platform, a managed service. */
export const RuntimeNode = z.object({ ...nodeBase, kind: z.literal("runtime"), role: z.string().min(1), tech: z.string().min(1).optional() });

export const ModelNode = z.discriminatedUnion("kind", [
  SystemNode,
  ActorNode,
  ExternalNode,
  ContainerNode,
  ComponentNode,
  DecisionNode,
  ProcessNode,
  StepNode,
  RuleNode,
  AssumptionNode,
  EntityNode,
  TestNode,
  RuntimeNode,
]);
export type ModelNode = z.infer<typeof ModelNode>;

export const EdgeKind = z.enum([
  "contains",
  "depends_on",
  "uses",
  "decided_by",
  "next",
  "implements",
  "constrained_by",
  "assumes",
  "owns",
  "reads",
  "writes",
  "covers",
  "runs_on",
]);
export type EdgeKind = z.infer<typeof EdgeKind>;
export const DependencyMode = z.enum(["sync", "async", "data"]);

export const ModelEdge = z
  .object({
    kind: EdgeKind,
    /** A node id, or for `decided_by` also an edge key (see `edgeKey`). */
    from: z.string().min(1),
    to: Id,
    mode: DependencyMode.optional(),
    protocol: z.string().min(1).optional(),
    /** For `next`: the condition under which the process takes this branch. */
    when: z.string().min(1).optional(),
    source: Source.default("agent"),
    sync: SyncState.default("unverified"),
  })
  .refine((e) => (e.kind === "depends_on") === (e.mode !== undefined), {
    message: "depends_on edges need a mode, and only depends_on edges may have one",
    path: ["mode"],
  })
  .refine((e) => e.when === undefined || e.kind === "next", { message: "only next edges may have a when", path: ["when"] });
export type ModelEdge = z.infer<typeof ModelEdge>;

export function edgeKey(e: Pick<ModelEdge, "kind" | "from" | "to">): string {
  return `${e.kind}:${e.from}->${e.to}`;
}

/** Which node kinds each edge kind may connect, as [from, to]. */
const EDGE_ENDS: Record<Exclude<EdgeKind, "decided_by">, [NodeKind[], NodeKind[]]> = {
  contains: [
    ["system", "container", "process"],
    ["container", "component", "step"],
  ],
  depends_on: [
    ["container", "component"],
    ["container", "component", "external"],
  ],
  uses: [["actor"], ["system", "container", "process"]],
  next: [["step"], ["step"]],
  implements: [["component"], ["process", "step"]],
  constrained_by: [["process", "step", "entity"], ["rule"]],
  assumes: [["process", "step", "rule", "entity"], ["assumption"]],
  owns: [["container", "component"], ["entity"]],
  reads: [["component", "external"], ["entity"]],
  writes: [["component", "external"], ["entity"]],
  covers: [["test"], ["process", "step", "rule"]],
  runs_on: [["container"], ["runtime"]],
};

/** What each `contains` parent may hold. */
const CONTAINS: Partial<Record<NodeKind, NodeKind>> = { system: "container", container: "component", process: "step" };

/** The schema version written today. Version 1 models are read as they are: v2 only adds kinds. */
export const MODEL_VERSION = 2;

export const ModelShape = z.object({
  version: z.union([z.literal(1), z.literal(MODEL_VERSION)]),
  /** Bumped on every write. Cursors in local state point at revisions. */
  revision: z.number().int().nonnegative(),
  nodes: z.array(ModelNode),
  edges: z.array(ModelEdge),
});

/** The system model, with cross-reference checks on top of the per-item shapes. */
export const Model = ModelShape.superRefine((m, ctx) => {
  const kinds = new Map<string, NodeKind>();
  m.nodes.forEach((n, i) => {
    if (kinds.has(n.id)) ctx.addIssue({ code: "custom", message: `duplicate node id '${n.id}'`, path: ["nodes", i, "id"] });
    kinds.set(n.id, n.kind);
  });

  const keys = new Set<string>();
  m.edges.forEach((e, i) => {
    const key = edgeKey(e);
    if (keys.has(key)) ctx.addIssue({ code: "custom", message: `duplicate edge '${key}'`, path: ["edges", i] });
    keys.add(key);
  });

  m.edges.forEach((e, i) => {
    const at = ["edges", i];
    const toKind = kinds.get(e.to);
    if (toKind === undefined) {
      ctx.addIssue({ code: "custom", message: `edge '${edgeKey(e)}' points to unknown node '${e.to}'`, path: [...at, "to"] });
      return;
    }
    if (e.kind === "decided_by") {
      if (toKind !== "decision") ctx.addIssue({ code: "custom", message: `decided_by must point to a decision, not a ${toKind}`, path: [...at, "to"] });
      if (!kinds.has(e.from) && !keys.has(e.from)) {
        ctx.addIssue({ code: "custom", message: `decided_by comes from unknown node or edge '${e.from}'`, path: [...at, "from"] });
      }
      return;
    }
    const fromKind = kinds.get(e.from);
    if (fromKind === undefined) {
      ctx.addIssue({ code: "custom", message: `edge '${edgeKey(e)}' comes from unknown node '${e.from}'`, path: [...at, "from"] });
      return;
    }
    const [froms, tos] = EDGE_ENDS[e.kind];
    if (!froms.includes(fromKind) || !tos.includes(toKind)) {
      ctx.addIssue({ code: "custom", message: `${e.kind} cannot connect a ${fromKind} to a ${toKind}`, path: at });
    }
    if (e.kind === "contains" && CONTAINS[fromKind] !== toKind) {
      ctx.addIssue({ code: "custom", message: `a ${fromKind} cannot contain a ${toKind}`, path: at });
    }
  });

  const parents = new Map<string, number>();
  const owners = new Map<string, number>();
  for (const e of m.edges) {
    if (e.kind === "contains") parents.set(e.to, (parents.get(e.to) ?? 0) + 1);
    if (e.kind === "owns") owners.set(e.to, (owners.get(e.to) ?? 0) + 1);
  }
  m.nodes.forEach((n, i) => {
    if (n.kind === "entity" && (owners.get(n.id) ?? 0) > 1) {
      ctx.addIssue({ code: "custom", message: `entity '${n.id}' has ${owners.get(n.id)} owners`, path: ["nodes", i] });
    }
    if (n.kind !== "container" && n.kind !== "component" && n.kind !== "step") return;
    const count = parents.get(n.id) ?? 0;
    if (count > 1) ctx.addIssue({ code: "custom", message: `${n.kind} '${n.id}' has ${count} parents`, path: ["nodes", i] });
    if (n.kind !== "container" && count === 0) {
      const parent = n.kind === "component" ? "container" : "process";
      ctx.addIssue({ code: "custom", message: `${n.kind} '${n.id}' is not inside any ${parent}`, path: ["nodes", i] });
    }
  });

  const process = new Map<string, string>();
  for (const e of m.edges) if (e.kind === "contains" && kinds.get(e.from) === "process") process.set(e.to, e.from);
  m.edges.forEach((e, i) => {
    if (e.kind === "next" && process.has(e.from) && process.has(e.to) && process.get(e.from) !== process.get(e.to)) {
      ctx.addIssue({ code: "custom", message: `next edge '${edgeKey(e)}' joins steps of different processes`, path: ["edges", i] });
    }
  });
});
export type Model = z.infer<typeof Model>;

export function emptyModel(): Model {
  return { version: MODEL_VERSION, revision: 0, nodes: [], edges: [] };
}

export const DecisionOption = z.object({
  name: z.string().min(1),
  tradeoff: z.string().min(1),
});

/** One line of ledger.jsonl. */
export const Decision = z
  .object({
    id: z.string().regex(/^D-\d{3,}$/, "decision ids look like D-001"),
    at: z.iso.datetime({ offset: true }),
    commit: z.string().min(1).optional(),
    title: z.string().min(1),
    options: z.array(DecisionOption).min(2),
    chosen: z.string().min(1),
    why: z.string().min(1),
    reversibility: Reversibility,
    blastRadius: z.number().int().nonnegative(),
    /** Node ids and edge keys this decision shaped. */
    affects: z.array(z.string().min(1)).default([]),
    /** Statements the agent could not confirm; shown with a flag in the viewer. */
    assumptions: z.array(z.string().min(1)).default([]),
    /** A decision this one replaces, for example after a developer's flag. */
    supersedes: z.string().regex(/^D-\d{3,}$/).optional(),
  })
  .refine((d) => d.options.some((o) => o.name === d.chosen), {
    message: "chosen must name one of the options",
    path: ["chosen"],
  });
export type Decision = z.infer<typeof Decision>;
export type DecisionInput = z.input<typeof Decision>;

export const Config = z.object({
  version: z.literal(1),
  /** Globs for source files that components must claim. */
  sources: z.array(z.string().min(1)).min(1),
  ignore: z.array(z.string().min(1)).default([]),
  languages: z.array(z.enum(["python", "typescript"])).min(1),
  python: z
    .object({
      /** Directories, relative to the repo root, that absolute imports resolve from. */
      roots: z.array(z.string().min(1)).min(1).default(["src", "."]),
    })
    .default({ roots: ["src", "."] }),
  typescript: z
    .object({
      /** tsconfig, relative to the repo root, whose `baseUrl` and `paths` resolve aliases. */
      tsconfig: z.string().min(1).default("tsconfig.json"),
    })
    .default({ tsconfig: "tsconfig.json" }),
});
export type Config = z.infer<typeof Config>;
