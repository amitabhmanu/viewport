import type { Change, Level, ModelNode, SplitView } from "@viewport/core";
import { useEffect, useState } from "react";
import { CHANGE_LABEL, KIND_LABEL, subtitle } from "./labels.js";
import { type Layout, layout, syncMarker } from "./layout.js";

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
}

/** One sub-view as an SVG diagram: boxes for elements, dashed boxes for stubs, arrows for dependencies. */
export function Diagram({ part, nodes, modes, level, changed, selected, onSelect, onOpen, onStub, onSelectEdge, selectedEdge }: Props) {
  const [laid, setLaid] = useState<Layout>();
  useEffect(() => {
    let live = true;
    void layout(part).then((l) => live && setLaid(l));
    return () => {
      live = false;
    };
  }, [part]);

  if (laid === undefined) return <div className="diagram-loading">Laying out…</div>;
  return (
    <svg className="diagram" viewBox={`0 0 ${laid.width} ${laid.height}`} width={laid.width} height={laid.height} role="img" aria-label={part.title}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arrowhead" />
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
              className={`edge ${r.kind}${mode ? ` ${mode}` : ""}${fresh ? " fresh" : ""}${lit ? " lit" : ""}`}
              points={points}
              markerEnd="url(#arrow)"
            />
            {onSelectEdge && (
              <polyline
                className="edge-hit"
                points={points}
                role="button"
                tabIndex={0}
                aria-label={`Dependency ${nodes.get(r.from)?.name ?? r.from} to ${nodes.get(r.to)?.name ?? r.to}`}
                onClick={() => onSelectEdge(r.id)}
                onKeyDown={(e) => e.key === "Enter" && onSelectEdge(r.id)}
              />
            )}
          </g>
        );
      })}
      {laid.boxes.map((b) => {
        const node = nodes.get(b.id);
        const name = node?.name ?? b.id;
        const marker = b.stub ? undefined : syncMarker(node);
        const target = part.continuesIn[b.id];
        const change = b.stub ? undefined : changed.get(b.id);
        const cls = ["node", node?.kind ?? "unknown", b.stub ? "stub" : "", selected === b.id ? "selected" : "", marker ?? "", change ? "fresh" : ""].filter(Boolean).join(" ");
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
            <rect width={b.width} height={b.height} rx={node?.kind === "actor" ? b.height / 2 : 8} />
            <text x={12} y={b.stub ? 18 : 24} className="name">
              {clip(name, b.stub ? 20 : 24)}
            </text>
            {b.stub ? (
              <text x={12} y={34} className="sub">
                {target ? `→ continues in part ${target.split("#")[1]}` : "→ elsewhere"}
              </text>
            ) : (
              node && (
                <text x={12} y={46} className="sub">
                  {clip(subtitle(node, level), 30)}
                </text>
              )
            )}
            {change && (
              <text x={b.width - 12} y={b.height - 10} className="badge" textAnchor="end">
                {CHANGE_LABEL[change.change]}
              </text>
            )}
            {marker && (
              <g className="marker" transform={`translate(${b.width - 14},14)`}>
                <circle r={6} />
                <title>{marker === "stale" ? "Changed in the code since it was modeled" : "Not yet checked against the code"}</title>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** A view edge takes a mode only when every model edge behind it shares it. */
function liftedMode(sources: string[], modes: Map<string, string>): string | undefined {
  const found = new Set(sources.map((s) => modes.get(s)));
  return found.size === 1 ? [...found][0] : undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
