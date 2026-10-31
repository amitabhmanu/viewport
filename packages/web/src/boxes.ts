import type { ModelNode, SplitView, ViewEdgeKind } from "@viewport/core";
import { EDGE_LABEL, KIND_LABEL, arrowText } from "./labels.js";

/** Measures a string's width in pixels for a CSS font, such as "600 14px system-ui". */
export type Measure = (text: string, font: string) => number;

let context: CanvasRenderingContext2D | null | undefined;

/**
 * Text width from a canvas when there is one (the viewer), else an estimate from the
 * font size (tests). Boxes are cut to what fits, not to a character count, so a
 * line of wide letters never runs past the edge.
 */
export const measure: Measure = (text, font) => {
  if (context === undefined) context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (context) {
    context.font = font;
    return context.measureText(text).width;
  }
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
  return text.length * size * (/\b(600|700|bold)\b/.test(font) ? 0.6 : 0.55);
};

/** The page's font family, for measuring text the way the diagram draws it. */
export function fontFamily(): string {
  return typeof document === "undefined" ? "system-ui" : getComputedStyle(document.body).fontFamily || "system-ui";
}

/** Cuts text to fit a width, ending in "…" when it had to cut. */
export function fit(text: string, width: number, font: string, m: Measure = measure): string {
  if (m(text, font) <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (m(`${text.slice(0, mid).trimEnd()}…`, font) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Wraps text at spaces into at most `lines` lines of a width; the last line ends in "…" if text is left over. */
export function wrap(text: string, width: number, lines: number, font: string, m: Measure = measure): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  let k = 0;
  while (k < words.length) {
    const next = line ? `${line} ${words[k]}` : words[k]!;
    if (!line || m(next, font) <= width) {
      line = next;
      k++;
      continue;
    }
    // The last line takes whatever is left, cut to fit.
    if (out.length === lines - 1) break;
    out.push(fit(line, width, font, m));
    line = "";
  }
  const rest = [line, ...words.slice(k)].filter(Boolean).join(" ");
  if (rest) out.push(fit(rest, width, font, m));
  return out;
}

/** The look a box takes: a family that sets its colour, shared by kinds that belong together. */
export const KIND_FAMILY: Record<ModelNode["kind"], string> = {
  system: "structure",
  actor: "people",
  external: "outside",
  container: "structure",
  component: "structure",
  decision: "structure",
  process: "flow",
  step: "flow",
  rule: "rule",
  assumption: "assumption",
  entity: "data",
  test: "test",
  runtime: "runtime",
};

/** Short kind names for the corner of a box, where space is tight. */
export const KIND_SHORT: Record<ModelNode["kind"], string> = {
  ...KIND_LABEL,
  external: "External",
  rule: "Rule",
};

/** The kinds of the boxes a part shows, in the order they first appear. Stubs are left out. */
export function kindsIn(part: SplitView, nodes: Map<string, ModelNode>): ModelNode["kind"][] {
  return [...new Set(part.elements.flatMap((id) => (nodes.get(id) ? [nodes.get(id)!.kind] : [])))];
}

export interface ArrowKey {
  /** The classes a sample line takes, as on the diagram. */
  className: string;
  label: string;
}

const MODE_LABEL: Record<string, string> = { sync: "Calls", async: "Sends to, without waiting", data: "Shares data with" };

/**
 * One key entry per kind of arrow a part draws. Dependencies split by how they
 * connect (calls, messages, shared data), since only the line style tells them apart.
 */
export function arrowKeys(part: SplitView, mode: (sources: string[]) => string | undefined): ArrowKey[] {
  const seen = new Map<string, ArrowKey>();
  for (const e of part.edges) {
    // Arrows that say what they do in words on the line need no key.
    if (arrowText(e.kind, undefined) !== undefined) continue;
    const m = e.kind === "depends_on" ? mode(e.sources) : undefined;
    const key = `${e.kind}:${m ?? ""}`;
    if (seen.has(key)) continue;
    seen.set(key, { className: `edge ${e.kind}${m ? ` ${m}` : ""}`, label: arrowLabel(e.kind, m) });
  }
  return [...seen.values()];
}

function arrowLabel(kind: ViewEdgeKind, mode: string | undefined): string {
  if (kind === "depends_on") return (mode && MODE_LABEL[mode]) ?? "Depends on";
  if (kind === "next") return "Then";
  return EDGE_LABEL[kind].out;
}
