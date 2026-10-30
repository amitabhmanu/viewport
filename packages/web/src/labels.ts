import type { Level, ModelNode, SplitView } from "@viewport/core";

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
