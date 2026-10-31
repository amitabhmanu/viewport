import type { Change, DebtBand, Level, ModelNode, SplitView } from "@viewport/core";
import { useEffect, useMemo, useState } from "react";
import { KIND_FAMILY, KIND_SHORT, arrowKeys, fit, fontFamily, kindsIn, measure, wrap } from "./boxes.js";
import { CHANGE_LABEL, EDGE_LABEL, KIND_LABEL, arrowText, subtitle } from "./labels.js";
import { type Layout, layout, syncMarker } from "./layout.js";
import { Zoom } from "./Zoom.js";

interface Props {
  part: SplitView;
  nodes: Map<string, ModelNode>;
  /** Mode of each model depends_on edge, by edge key. */
  modes: Map<string, string>;
  level: Level;
  /** What changed since the reader last looked, by node id or edge key. */
  changed: Map<string, Change>;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onStub: (id: string) => void;
  /** Selecting an arrow, by its view edge key. */
  onSelectEdge?: (key: string) => void;
  selectedEdge?: string | undefined;
  /** Short notes on boxes, by node id: "Personal data", "To confirm", "No tests". */
  notes?: Map<string, string>;
  /** Boxes to shade by comprehension debt, by node id. */
  debt?: Map<string, DebtBand> | undefined;
  /** Draw inside a frame that fits the screen, zooms and pans (the Map). */
  zoom?: boolean;
}

/** One sub-view as an SVG diagram: boxes for elements, dashed boxes for stubs, arrows for dependencies. */
export function Diagram({ part, nodes, modes, level, changed, selected, onSelect, onOpen, onStub, onSelectEdge, selectedEdge, notes, debt, zoom }: Props) {
  const [laid, setLaid] = useState<Layout>();
  const kinds = new Map(part.elements.map((id) => [id, nodes.get(id)?.kind]));
  const kindKey = [...kinds].map(([id, k]) => `${id}:${k}`).join(",");
  useEffect(() => {
    let live = true;
    void layout(part, (id) => kinds.get(id)).then((l) => live && setLaid(l));
    return () => {
      live = false;
    };
    // Lays out again only when the part or its boxes' kinds change, not on every new nodes map.
  }, [part, kindKey]);
  const family = useMemo(fontFamily, []);
  // Name each box's kind only where kinds mix; a view of components alone needs no "Component" on every box.
  const mixed = kindsIn(part, nodes).length > 1;
  // Arrow text can reach past the last box; widen the drawing so it is not cut off.
  const labels = useMemo(() => (laid ? laid.routes.flatMap((r) => (arrowText(r.kind, r.label) && r.points.length > 1 ? [placeLabel(arrowText(r.kind, r.label)!, r.points, family, r.labelAt)] : [])) : []), [laid, family]);

  if (laid === undefined) return <div className="diagram-loading">Laying out…</div>;
  const width = Math.max(laid.width, ...labels.map((l) => l.right + 8));
  const drawing = (scale: number) => (
    <svg className="diagram" viewBox={`0 0 ${width} ${laid.height}`} width={width * scale} height={laid.height * scale} role="img" aria-label={part.title}>
      <defs>
        {/* Sized in the diagram's own units, so a thicker line keeps the same head. */}
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10.5" markerHeight="10.5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arrowhead" />
        </marker>
        <marker id="arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10.5" markerHeight="10.5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arrowhead accent" />
        </marker>
      </defs>
      {laid.routes.map((r) => {
        const edge = part.edges.find((e) => `${e.kind}:${e.from}->${e.to}` === r.id);
        const mode = liftedMode(edge?.sources ?? [], modes);
        const fresh = (edge?.sources ?? []).some((k) => changed.has(k));
        const points = r.points.map((p) => `${p.x},${p.y}`).join(" ");
        const lit = r.id === selectedEdge || (selected !== undefined && (r.from === selected || r.to === selected));
        return (
          <g key={r.id}>
            <polyline
              data-edge={r.id}
              className={`edge ${r.plain ? "plain" : r.kind}${mode ? ` ${mode}` : ""}${fresh ? " fresh" : ""}${lit ? " lit" : ""}`}
              points={points}
              markerEnd={lit || fresh ? "url(#arrow-accent)" : "url(#arrow)"}
            />
            {onSelectEdge && !r.plain && (
              <polyline
                className="edge-hit"
                points={points}
                role="button"
                tabIndex={0}
                aria-label={`${EDGE_LABEL[r.kind].noun}: ${nodes.get(r.from)?.name ?? r.from} to ${nodes.get(r.to)?.name ?? r.to}`}
                onClick={() => onSelectEdge(r.id)}
                onKeyDown={(e) => e.key === "Enter" && onSelectEdge(r.id)}
              />
            )}
          </g>
        );
      })}
      {laid.boxes.map((b) => {
        if (b.terminal) {
          return (
            <g key={b.id} className={`terminal ${b.terminal}`} transform={`translate(${b.x + b.width / 2},${b.y + b.height / 2})`} aria-label={b.terminal === "start" ? "Start" : "End"}>
              <circle r={b.width / 2} />
              {b.terminal === "end" && <circle r={b.width / 2 - 4} className="inner" />}
              <title>{b.terminal === "start" ? "Start" : "End"}</title>
            </g>
          );
        }
        const node = nodes.get(b.id);
        const name = node?.name ?? b.id;
        const marker = b.stub ? undefined : syncMarker(node);
        const target = part.continuesIn[b.id];
        const change = b.stub ? undefined : changed.get(b.id);
        const band = b.stub ? undefined : debt?.get(b.id);
        const note = b.stub ? undefined : (notes?.get(b.id) ?? (band === "high" ? "Least known" : undefined));
        const kind = node?.kind;
        const cls = ["node", kind ?? "unknown", kind ? `family-${KIND_FAMILY[kind]}` : "", b.stub ? "stub" : "", selected === b.id ? "selected" : "", marker ?? "", change ? "fresh" : "", band ? `debt-${band}` : ""].filter(Boolean).join(" ");
        return (
          <g
            key={b.id}
            data-node={b.id}
            className={cls}
            transform={`translate(${b.x},${b.y})`}
            tabIndex={0}
            role="button"
            aria-label={b.stub ? `${name}, continues elsewhere` : `${KIND_LABEL[node?.kind ?? "component"]} ${name}`}
            onClick={() => (b.stub ? onStub(b.id) : onSelect(b.id))}
            onDoubleClick={() => !b.stub && onOpen(b.id)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (b.stub) onStub(b.id);
              else if (e.shiftKey) onOpen(b.id);
              else onSelect(b.id);
            }}
          >
            <rect width={b.width} height={b.height} rx={kind === "actor" ? b.height / 2 : kind === "step" ? 18 : 8} />
            {(() => {
              if (b.stub) {
                return (
                  <>
                    <text x={12} y={18} className="name">
                      {fit(name, b.width - 24, `500 14px ${family}`)}
                    </text>
                    <text x={12} y={34} className="sub">
                      {target ? `→ continues in part ${target.split("#")[1]}` : "→ elsewhere"}
                    </text>
                  </>
                );
              }
              // The kind sits bottom right, out of the name's way, unless a change badge holds that corner.
              const label = mixed && kind ? KIND_SHORT[kind].toUpperCase() : undefined;
              const labelTop = label !== undefined && change !== undefined;
              const labelEnd = b.width - (labelTop && marker ? 26 : 12);
              const labelWidth = labelTop ? measure(label, `600 10px ${family}`) + label.length * 0.6 : 0;
              const nameRoom = (labelTop ? labelEnd - labelWidth - 8 : marker ? b.width - 30 : b.width - 12) - 12;
              return (
                <>
                  {label && (
                    <text x={labelEnd} y={labelTop ? 23 : b.height - 10} className="kind-label" textAnchor="end">
                      {label}
                    </text>
                  )}
                  <text x={12} y={24} className="name">
                    {fit(name, nameRoom, `600 14px ${family}`)}
                  </text>
                  {node &&
                    wrap(subtitle(node, level), b.width - 24, 2, `12px ${family}`).map((line, i) => (
                      <text key={i} x={12} y={43 + i * 14} className="sub">
                        {line}
                      </text>
                    ))}
                </>
              );
            })()}
            {change && (
              <text x={b.width - 12} y={b.height - 10} className="badge" textAnchor="end">
                {CHANGE_LABEL[change.change]}
              </text>
            )}
            {note && (
              <text x={12} y={b.height - 10} className={`note ${note === "No tests" || note === "Rejected" ? "gap" : ""}`}>
                {note}
              </text>
            )}
            {marker && (
              <g className="marker" transform={`translate(${b.width - 14},14)`}>
                <circle r={6} />
                <title>{markerTitle(node?.kind, marker)}</title>
              </g>
            )}
          </g>
        );
      })}
      {/* Last, so no line or box covers the text. */}
      {labels.map((l, i) => (
        <text key={i} className="edge-label" x={l.x} y={l.y} textAnchor={l.anchor} dominantBaseline="middle">
          {l.text}
        </text>
      ))}
    </svg>
  );
  return zoom ? (
    <Zoom width={width} height={laid.height} fitKey={part.id}>
      {drawing}
    </Zoom>
  ) : (
    drawing(1)
  );
}

/** What the boxes and lines of a part mean, for the kinds this part draws. */
export function Legend({ part, nodes, modes }: { part: SplitView; nodes: Map<string, ModelNode>; modes: Map<string, string> }) {
  const kinds = kindsIn(part, nodes);
  const arrows = arrowKeys(part, (sources) => liftedMode(sources, modes));
  if (kinds.length < 2 && arrows.length < 2) return null;
  return (
    <ul className="legend" aria-label="Key">
      {kinds.map((k) => (
        <li key={k}>
          <svg width={22} height={14} aria-hidden="true">
            <g className={`node ${k} family-${KIND_FAMILY[k]}`}>
              <rect x={1} y={1} width={20} height={12} rx={k === "actor" || k === "step" ? 6 : 3} />
            </g>
          </svg>
          {KIND_LABEL[k]}
        </li>
      ))}
      {arrows.map((a) => (
        <li key={a.className}>
          <svg width={26} height={14} aria-hidden="true">
            <line className={a.className} x1={1} y1={7} x2={25} y2={7} />
          </svg>
          {a.label}
        </li>
      ))}
    </ul>
  );
}

function markerTitle(kind: ModelNode["kind"] | undefined, marker: "stale" | "unverified"): string {
  if (kind === "test") return marker === "stale" ? "No test files match these paths" : "Not yet checked against the code";
  return marker === "stale" ? "Changed in the code since it was modeled" : "Not yet checked against the code";
}

/** Text on an arrow, beside its longest segment if that runs down, below it if across. */
function placeLabel(full: string, points: { x: number; y: number }[], family: string, given?: { x: number; y: number }) {
  if (given) {
    const text = fit(full, 180, `11px ${family}`);
    return { text, x: given.x + 2, y: given.y, anchor: "start" as const, right: given.x + 2 + measure(text, `11px ${family}`) };
  }
  let best = 0;
  let at = { x: points[0]!.x, y: points[0]!.y };
  let across = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > best) {
      best = length;
      at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      across = a.y === b.y;
    }
  }
  const text = fit(full, 180, `11px ${family}`);
  const w = measure(text, `11px ${family}`);
  const x = across ? at.x : at.x + 6;
  return { text, x, y: across ? at.y + 9 : at.y, anchor: across ? ("middle" as const) : ("start" as const), right: across ? x + w / 2 : x + w };
}

/** A view edge takes a mode only when every model edge behind it shares it. */
function liftedMode(sources: string[], modes: Map<string, string>): string | undefined {
  const found = new Set(sources.map((s) => modes.get(s)));
  return found.size === 1 ? [...found][0] : undefined;
}
