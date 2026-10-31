import type { Change, Decision, Level, Model, ModelNode, Prediction, SplitView, ViewEdgeKind } from "@viewport/core";

/** The line under a node's name. Simple says what it does; medium adds the technology; complex leads with it. */
export function subtitle(node: ModelNode, level: Level): string {
  const role =
    "role" in node ? node.role
    : "purpose" in node ? node.purpose
    : "goal" in node ? node.goal
    : "does" in node ? node.does
    : "statement" in node ? node.statement
    : "description" in node ? node.description
    : node.kind === "test" ? (node.paths.length === 1 ? node.paths[0]! : `${node.paths.length} sets of test files`)
    : "";
  const tech = "tech" in node && node.tech ? node.tech : "protocol" in node && node.protocol ? node.protocol : undefined;
  if (level === "simple" || tech === undefined) return role;
  if (level === "medium") return `${role} · ${tech}`;
  return `${tech} · ${node.id}`;
}

export const KIND_LABEL: Record<ModelNode["kind"], string> = {
  system: "System",
  actor: "Person",
  external: "External system",
  container: "Container",
  component: "Component",
  decision: "Decision",
  process: "Process",
  step: "Step",
  rule: "Business rule",
  assumption: "Assumption",
  entity: "Data",
  test: "Tests",
  runtime: "Runtime",
};

const VIEW_TITLE: Record<string, string> = {
  overview: "Overview",
  containers: "Containers",
  "code-map": "Code map",
  processes: "Processes",
  rules: "Rules and assumptions",
  data: "Data",
  coverage: "Test coverage",
  deploy: "Deployment",
};

/** How a view name reads in the breadcrumb. */
export function viewTitle(name: string, nodes: Map<string, ModelNode>): string {
  if (VIEW_TITLE[name]) return VIEW_TITLE[name];
  const inside = name.startsWith("components:") ? name.slice("components:".length) : name.startsWith("process:") ? name.slice("process:".length) : undefined;
  return inside !== undefined ? (nodes.get(inside)?.name ?? inside) : name;
}

/** The breadcrumb trail to a view: from its phase's entry view down to it. */
export function trail(name: string): string[] {
  if (name === "overview") return ["overview"];
  if (name === "containers") return ["overview", name];
  if (name.startsWith("components:")) return ["overview", "containers", name];
  if (name.startsWith("process:")) return ["processes", name];
  return [name];
}

/** Where clicking a node leads: the next level down, if there is one. */
export function zoomTarget(node: ModelNode): string | undefined {
  if (node.kind === "system") return "containers";
  if (node.kind === "container") return `components:${node.id}`;
  if (node.kind === "process") return `process:${node.id}`;
  return undefined;
}

export interface Phase {
  label: string;
  /** Where the phase starts on the Map. */
  view: string;
  /** Other views in the phase, as links beside the phase bar. */
  more: { view: string; label: string }[];
  /** The phase has something to show once the model has a node of one of these kinds. */
  needs: ModelNode["kind"][];
  /** True for the views that belong to this phase. */
  holds: (view: string) => boolean;
}

/** The phases of building a system, each a set of default views over the one model (D-012). */
export const PHASES: Phase[] = [
  {
    label: "Requirements",
    view: "processes",
    more: [{ view: "rules", label: "Rules and assumptions" }],
    needs: ["process", "rule", "assumption"],
    holds: (v) => v === "processes" || v === "rules" || v.startsWith("process:"),
  },
  { label: "Architecture", view: "overview", more: [], needs: ["system"], holds: (v) => v === "overview" || v === "containers" || v.startsWith("components:") },
  { label: "Data", view: "data", more: [], needs: ["entity"], holds: (v) => v === "data" },
  { label: "Build", view: "code-map", more: [], needs: ["component"], holds: (v) => v === "code-map" },
  { label: "Verification", view: "coverage", more: [], needs: ["test", "process"], holds: (v) => v === "coverage" },
  { label: "Deploy", view: "deploy", more: [], needs: ["runtime"], holds: (v) => v === "deploy" },
];

/** The phase a view belongs to. */
export function phaseOf(view: string): Phase | undefined {
  return PHASES.find((p) => p.holds(view));
}

/** Where a phase starts: its entry view, or for Requirements with rules but no processes, the rules. */
export function phaseStart(phase: Phase, model: Model): string {
  if (phase.view === "processes" && !model.nodes.some((n) => n.kind === "process")) return "rules";
  return phase.view;
}

/** Arrow names by edge kind, read from the arrow's start ("depends on") and from its end ("used by"). */
export const EDGE_LABEL: Record<ViewEdgeKind, { out: string; in: string; noun: string }> = {
  depends_on: { out: "Depends on", in: "Used by", noun: "Dependency" },
  uses: { out: "Uses", in: "Used by", noun: "Uses" },
  next: { out: "Next", in: "Comes after", noun: "Next step" },
  implements: { out: "Carries out", in: "Done by", noun: "Carries out" },
  constrained_by: { out: "Bound by", in: "Applies to", noun: "Business rule" },
  assumes: { out: "Assumes", in: "Assumed by", noun: "Assumption" },
  owns: { out: "Owns", in: "Owned by", noun: "Ownership" },
  reads: { out: "Reads", in: "Read by", noun: "Reads" },
  writes: { out: "Writes", in: "Written by", noun: "Writes" },
  covers: { out: "Covers", in: "Tested by", noun: "Test coverage" },
  runs_on: { out: "Runs on", in: "Runs", noun: "Runs on" },
};

const WRITTEN_ON_ARROW = new Set<ViewEdgeKind>(["owns", "reads", "writes"]);

/** Text on an arrow: a branch's condition, or what a part does with data, which the line's style alone can't say. */
export function arrowText(kind: ViewEdgeKind, label: string | undefined): string | undefined {
  return label ?? (WRITTEN_ON_ARROW.has(kind) ? EDGE_LABEL[kind].out.toLowerCase() : undefined);
}

/**
 * Short notes drawn on boxes: personal or secret data, assumptions still to confirm,
 * and steps and processes no test covers.
 */
export function boxNotes(model: Model): Map<string, string> {
  const notes = new Map<string, string>();
  const parent = new Map(model.edges.filter((e) => e.kind === "contains").map((e) => [e.to, e.from]));
  const direct = new Set(model.edges.filter((e) => e.kind === "covers").map((e) => e.to));
  const covered = new Set(direct);
  for (const [child, p] of parent) {
    // Covering a whole process covers each of its steps; a covered step counts for its process.
    if (direct.has(p)) covered.add(child);
    if (direct.has(child)) covered.add(p);
  }
  const anyTests = model.nodes.some((n) => n.kind === "test");
  for (const n of model.nodes) {
    if (n.kind === "entity" && (n.sensitivity === "pii" || n.sensitivity === "secret")) notes.set(n.id, n.sensitivity === "pii" ? "Personal data" : "Secret");
    if (n.kind === "assumption" && n.status !== "confirmed") notes.set(n.id, n.status === "open" ? "To confirm" : "Rejected");
    if (anyTests && (n.kind === "step" || n.kind === "process") && !covered.has(n.id)) notes.set(n.id, "No tests");
  }
  return notes;
}

/** The sub-view that shows an element in full, so a level switch keeps it in sight. */
export function partShowing(parts: SplitView[], id: string | undefined): number {
  if (id === undefined) return 0;
  const i = parts.findIndex((p) => p.elements.includes(id));
  return i === -1 ? 0 : i;
}

/**
 * A short sentence for a sub-view: which elements it covers and where its story goes
 * next. A stand-in until the explainer writes real takeaways (Phase 4).
 */
export function partSummary(part: SplitView, nodes: Map<string, ModelNode>): string {
  const names = part.elements.map((id) => nodes.get(id)?.name ?? id);
  const shown = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  const onward = Object.keys(part.continuesIn).length;
  return onward > 0 ? `${shown}; ${onward} connection${onward === 1 ? " continues" : "s continue"} in other parts.` : `${shown}.`;
}

const HOME: Partial<Record<ModelNode["kind"], string>> = {
  container: "containers",
  process: "processes",
  rule: "rules",
  assumption: "rules",
  entity: "data",
  test: "coverage",
  runtime: "deploy",
};

/** The view that shows a node in full: a component's or step's parent view, the view of its kind, or the overview. */
export function homeView(model: Model, id: string): string {
  const node = model.nodes.find((n) => n.id === id);
  if (node?.kind === "component" || node?.kind === "step") {
    const parent = model.edges.find((e) => e.kind === "contains" && e.to === id)?.from;
    if (node.kind === "step") return parent ? `process:${parent}` : "processes";
    return parent ? `components:${parent}` : "containers";
  }
  return (node && HOME[node.kind]) ?? "overview";
}

/** What opening a node catches the reader up on: the node, and changed edges that touch it. */
export function seenWith(id: string, changes: Change[]): string[] {
  return changes.filter((c) => c.subject === id || (c.what === "edge" && c.nodes.includes(id))).map((c) => c.subject);
}

export const CHANGE_LABEL: Record<Change["change"], string> = { added: "New", changed: "Changed", removed: "Removed" };

/**
 * The ledger's order: most salient first (new to the developer, wide-reaching, hard to
 * undo), then widest reach, then newest. Without scores it falls back to reach.
 */
export function rank(decisions: Decision[], salience: Record<string, number> = {}): Decision[] {
  const score = (d: Decision) => salience[d.id] ?? 0;
  return [...decisions].sort((a, b) => score(b) - score(a) || b.blastRadius - a.blastRadius || Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

const REACH: Record<Decision["reversibility"], number> = { "one-way": 3, costly: 2, easy: 1 };

/**
 * Decisions still waiting for a guess, most worth thinking about first: by salience,
 * then hard-to-undo calls with a wide reach, then the newest. Replaced decisions are left out.
 */
export function toPredict(ledger: Decision[], predictions: Prediction[], salience: Record<string, number> = {}): Decision[] {
  const done = new Set(predictions.map((p) => p.decisionId));
  const replaced = new Set(ledger.flatMap((d) => (d.supersedes ? [d.supersedes] : [])));
  const score = (d: Decision) => salience[d.id] ?? 0;
  return ledger
    .filter((d) => !done.has(d.id) && !replaced.has(d.id))
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        REACH[b.reversibility] * Math.max(1, b.blastRadius) - REACH[a.reversibility] * Math.max(1, a.blastRadius) ||
        Date.parse(b.at) - Date.parse(a.at),
    );
}

/** Changes most worth a look first: a change scores as its most salient subject or node. */
export function bySalience(changes: Change[], salience: Record<string, number>): Change[] {
  const score = (c: Change) => Math.max(salience[c.subject] ?? 0, ...c.nodes.map((n) => salience[n] ?? 0));
  return [...changes].sort((a, b) => score(b) - score(a));
}

export interface ChangeGroup {
  /** The process these changes bear on, or undefined for the rest. */
  process: string | undefined;
  changes: Change[];
}

/**
 * Today's changes by the process they bear on, the way the reader thinks about the
 * work. A change to a part that serves two processes shows under both. Keeps the given
 * order within a group, and the most relevant process first; with no processes in the
 * model there is just the one group.
 */
export function changesByProcess(changes: Change[], model: Model): ChangeGroup[] {
  const parent = new Map(model.edges.filter((e) => e.kind === "contains").map((e) => [e.to, e.from]));
  const kinds = new Map(model.nodes.map((n) => [n.id, n.kind]));
  const processOf = (id: string) => (kinds.get(id) === "process" ? id : kinds.get(id) === "step" ? parent.get(id) : undefined);
  const served = new Map<string, Set<string>>();
  const serve = (id: string, process: string | undefined) => {
    if (process !== undefined) served.set(id, (served.get(id) ?? new Set()).add(process));
  };
  for (const id of kinds.keys()) serve(id, processOf(id));
  // Outward from the steps, each kind after the ones its source depends on: parts and tests, rules, what rules assume, then data through the parts that use it.
  const spread = (edgeKinds: string[], known: "from" | "to") => {
    for (const e of model.edges) {
      if (!edgeKinds.includes(e.kind)) continue;
      for (const p of served.get(e[known]) ?? []) serve(known === "from" ? e.to : e.from, p);
    }
  };
  spread(["implements", "covers"], "to");
  spread(["constrained_by"], "from");
  spread(["assumes"], "from");
  spread(["owns", "reads", "writes"], "from");
  const groups = new Map<string | undefined, Change[]>();
  const add = (key: string | undefined, c: Change) => groups.set(key, [...(groups.get(key) ?? []), c]);
  for (const c of changes) {
    const processes = new Set([c.subject, ...c.nodes].flatMap((id) => [...(served.get(id) ?? [])]));
    if (processes.size === 0) add(undefined, c);
    for (const p of processes) add(p, c);
  }
  // The rest goes last, whatever it holds.
  return [...groups].sort(([a], [b]) => Number(a === undefined) - Number(b === undefined)).map(([process, list]) => ({ process, changes: list }));
}

/**
 * A decision's options in an order that does not give the answer away (agents tend
 * to list their pick first), the same every time for the same decision.
 */
export function shuffledOptions(d: Pick<Decision, "id" | "options">): Decision["options"] {
  let seed = [...d.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const out = [...d.options];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The explainer's takeaway at this level of detail, if it has written one. */
export function takeaway(node: ModelNode | undefined, level: Level): string | undefined {
  return node?.takeaways?.[level] ?? node?.takeaway;
}
