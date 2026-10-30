import type { Change, Decision, Level, Model, ModelNode, Prediction, SplitView } from "@viewport/core";

/** The line under a node's name. Simple says what it does; medium adds the technology; complex leads with it. */
export function subtitle(node: ModelNode, level: Level): string {
  const role = "role" in node ? node.role : "purpose" in node ? node.purpose : "goal" in node ? node.goal : "";
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
};

/** How a view name reads in the breadcrumb. */
export function viewTitle(name: string, nodes: Map<string, ModelNode>): string {
  if (name === "overview") return "Overview";
  if (name === "containers") return "Containers";
  if (name === "code-map") return "Code map";
  if (name.startsWith("components:")) return nodes.get(name.slice("components:".length))?.name ?? name;
  return name;
}

/** The breadcrumb trail to a view: overview, then containers, then the container. */
export function trail(name: string): string[] {
  if (name === "overview") return ["overview"];
  if (name === "containers" || name === "code-map") return ["overview", name];
  return ["overview", "containers", name];
}

/** Where clicking a node leads: the next level down, if there is one. */
export function zoomTarget(node: ModelNode): string | undefined {
  if (node.kind === "system") return "containers";
  if (node.kind === "container") return `components:${node.id}`;
  return undefined;
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

/** The view that shows a node in full: its container's components, the containers, or the overview. */
export function homeView(model: Model, id: string): string {
  const node = model.nodes.find((n) => n.id === id);
  if (node?.kind === "component") {
    const parent = model.edges.find((e) => e.kind === "contains" && e.to === id)?.from;
    return parent ? `components:${parent}` : "containers";
  }
  return node?.kind === "container" ? "containers" : "overview";
}

/** What opening a node catches the reader up on: the node, and changed edges that touch it. */
export function seenWith(id: string, changes: Change[]): string[] {
  return changes.filter((c) => c.subject === id || (c.what === "edge" && c.nodes.includes(id))).map((c) => c.subject);
}

export const CHANGE_LABEL: Record<Change["change"], string> = { added: "New", changed: "Changed", removed: "Removed" };

/** The ledger's order: widest reach first; among equals, the newest. */
export function rank(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => b.blastRadius - a.blastRadius || Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

const REACH: Record<Decision["reversibility"], number> = { "one-way": 3, costly: 2, easy: 1 };

/**
 * Decisions still waiting for a guess, most worth thinking about first: hard-to-undo
 * calls with a wide reach, then the newest. Replaced decisions are left out.
 * (Phase 4e folds in familiarity.)
 */
export function toPredict(ledger: Decision[], predictions: Prediction[]): Decision[] {
  const done = new Set(predictions.map((p) => p.decisionId));
  const replaced = new Set(ledger.flatMap((d) => (d.supersedes ? [d.supersedes] : [])));
  return ledger
    .filter((d) => !done.has(d.id) && !replaced.has(d.id))
    .sort((a, b) => REACH[b.reversibility] * Math.max(1, b.blastRadius) - REACH[a.reversibility] * Math.max(1, a.blastRadius) || Date.parse(b.at) - Date.parse(a.at));
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
