import type { Decision, Model, ModelNode } from "@viewport/core";
import { KIND_FAMILY } from "./boxes.js";
import { KIND_LABEL, homeView, subtitle } from "./labels.js";
import { mapHref } from "./router.js";

export interface JumpItem {
  id: string;
  name: string;
  /** "Step", "Decision": shown beside the name. */
  kind: string;
  family: string;
  detail: string;
  href: string;
}

/** Everything the jump box can reach: every part of the model where it is shown in full, and every decision in the ledger. */
export function jumpItems(model: Model, ledger: Decision[]): JumpItem[] {
  const parts = model.nodes
    .filter((n) => n.kind !== "decision")
    .map((n: ModelNode) => ({ id: n.id, name: n.name, kind: KIND_LABEL[n.kind], family: KIND_FAMILY[n.kind], detail: subtitle(n, "simple"), href: mapHref(homeView(model, n.id), { focus: n.id }) }));
  const decisions = ledger.map((d) => ({ id: d.id, name: d.title, kind: "Decision", family: "structure", detail: d.why, href: `/ledger#${d.id}` }));
  return [...parts, ...decisions];
}

/**
 * Items matching a query, best first: a name that starts with it, then a word in
 * the name that does, then the name or id containing it, then the description.
 * Every word of the query must match somewhere.
 */
export function search(items: JumpItem[], query: string, limit = 12): JumpItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.slice(0, limit);
  const scored: [number, JumpItem][] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    const id = item.id.toLowerCase();
    const detail = item.detail.toLowerCase();
    let score = 0;
    for (const w of words) {
      const s =
        name.startsWith(w) ? 40
        : name.split(/[\s\-_.:/]+/).some((part) => part.startsWith(w)) ? 30
        : name.includes(w) || id.includes(w) ? 20
        : detail.includes(w) ? 5
        : 0;
      if (s === 0) {
        score = 0;
        break;
      }
      score += s;
    }
    if (score > 0) scored.push([score, item]);
  }
  return scored
    .sort(([a, x], [b, y]) => b - a || x.name.length - y.name.length || x.name.localeCompare(y.name))
    .slice(0, limit)
    .map(([, item]) => item);
}

/** True for the keys that open the jump box: Ctrl+K or Cmd+K anywhere, or / outside a text field. */
export function opensJump(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">, typing: boolean): boolean {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") return true;
  return e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey;
}

