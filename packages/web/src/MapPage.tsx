import type { Change, Level, ModelNode } from "@viewport/core";
import { useMemo, useState } from "react";
import { api } from "./api.js";
import { markSeen, useChanges } from "./changes.js";
import { Diagram } from "./Diagram.js";
import { CHANGE_LABEL, KIND_LABEL, partShowing, partSummary, seenWith, subtitle, trail, viewTitle, zoomTarget } from "./labels.js";
import { useLive, useLoad } from "./live.js";
import { mapHref } from "./router.js";

const LEVELS: Level[] = ["simple", "medium", "complex"];

export function MapPage({ params, go }: { params: URLSearchParams; go: (to: string) => void }) {
  const live = useLive();
  const view = params.get("view") ?? "overview";
  const levelParam = params.get("level");
  const level: Level = LEVELS.includes(levelParam as Level) ? (levelParam as Level) : "medium";
  const focus = params.get("focus") ?? undefined;
  const partParam = params.get("part");

  const model = useLoad(api.model, [live.model]);
  const parts = useLoad(() => api.view(view, level), [view, level, live.model]);

  const nodes = useMemo(() => new Map((model.data?.nodes ?? []).map((n) => [n.id, n])), [model.data]);
  const modes = useMemo(
    () => new Map((model.data?.edges ?? []).filter((e) => e.kind === "depends_on").map((e) => [`${e.kind}:${e.from}->${e.to}`, e.mode ?? ""])),
    [model.data],
  );

  const { changes, bySubject } = useChanges();
  // A container whose components changed shows as changed too, so the reader knows where to look.
  const changed = useMemo(() => {
    const out = new Map(bySubject);
    for (const e of model.data?.edges ?? []) {
      if (e.kind !== "contains" || out.has(e.from)) continue;
      const inner = changes.find((c) => c.nodes.includes(e.to));
      if (inner) out.set(e.from, { ...inner, subject: e.from, change: "changed" } satisfies Change);
    }
    return out;
  }, [bySubject, changes, model.data]);

  const error = model.error ?? parts.error;
  if (error) return <p className="error page">{error}</p>;
  if (!model.data || !parts.data) return <p className="muted page">Loading…</p>;
  if (parts.data.length === 0) return <p className="muted page">Nothing to show in this view yet.</p>;

  // A part in the URL wins; otherwise show the part holding the focused element, so a level switch keeps it in sight.
  const requested = partParam === null ? partShowing(parts.data, focus) : Number(partParam) - 1;
  const index = Math.min(Math.max(Number.isFinite(requested) ? requested : 0, 0), parts.data.length - 1);
  const part = parts.data[index]!;
  const href = (to: { view?: string; level?: Level; focus?: string | undefined; part?: number | undefined }) =>
    mapHref(to.view ?? view, { level: to.level ?? level, focus: "focus" in to ? to.focus : focus, part: "part" in to ? to.part : index + 1 });

  const openStub = async (id: string) => {
    const target = part.continuesIn[id];
    if (target) return go(href({ focus: id, part: Number(target.split("#")[1]) }));
    // Not in this view at all: go to the view that holds it.
    const detail = await api.node(id);
    const owner = detail.parent !== undefined ? nodes.get(detail.parent) : undefined;
    const next = owner ? zoomTarget(owner) : undefined;
    go(next ? href({ view: next, focus: id, part: undefined }) : href({ focus: id }));
  };
  const zoom = (id: string) => {
    const node = nodes.get(id);
    const next = node && zoomTarget(node);
    if (next) go(href({ view: next, focus: undefined, part: undefined }));
  };

  return (
    <section className="map">
      <div className="map-bar">
        <nav className="crumbs" aria-label="Where you are">
          {trail(view).map((name, i, all) =>
            i === all.length - 1 ? (
              <span key={name} aria-current="page">
                {viewTitle(name, nodes)}
              </span>
            ) : (
              <a
                key={name}
                href={href({ view: name, focus: undefined, part: undefined })}
                onClick={(e) => {
                  e.preventDefault();
                  go(href({ view: name, focus: undefined, part: undefined }));
                }}
              >
                {viewTitle(name, nodes)}
              </a>
            ),
          )}
        </nav>
        <div className="levels" role="radiogroup" aria-label="Detail">
          {LEVELS.map((l) => (
            <button key={l} role="radio" aria-checked={l === level} onClick={() => go(href({ level: l, part: undefined }))}>
              {l[0]!.toUpperCase() + l.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="map-body">
        <div className="canvas">
          <p className="narrative">
            {parts.data.length > 1 && <strong>Part {index + 1} of {parts.data.length}. </strong>}
            {partSummary(part, nodes)}
          </p>
          <Diagram
            part={part}
            nodes={nodes}
            modes={modes}
            level={level}
            changed={changed}
            selected={focus}
            onSelect={(id) => {
              markSeen(seenWith(id, changes));
              go(href({ focus: id === focus ? undefined : id }));
            }}
            onOpen={zoom}
            onStub={(id) => void openStub(id)}
          />
          {parts.data.length > 1 && (
            <div className="parts" aria-label="Parts of this view">
              {parts.data.map((p, i) => (
                <button key={p.id} className={i === index ? "here" : ""} aria-current={i === index ? "true" : undefined} onClick={() => go(href({ part: i + 1 }))}>
                  <span className="mini">
                    {p.elements.map((id) => (
                      <i key={id} className={id === focus ? "focus" : ""} />
                    ))}
                  </span>
                  Part {i + 1}
                  {i === index && <span className="you"> · you are here</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {focus !== undefined && nodes.has(focus) && <NodePanel node={nodes.get(focus)!} nodes={nodes} change={bySubject.get(focus)} level={level} onZoom={zoom} onPick={(id) => void openStub(id)} />}
      </div>
    </section>
  );
}

function NodePanel({
  node,
  nodes,
  change,
  level,
  onZoom,
  onPick,
}: {
  node: ModelNode;
  nodes: Map<string, ModelNode>;
  change: Change | undefined;
  level: Level; onZoom: (id: string) => void; onPick: (id: string) => void }) {
  const live = useLive();
  const detail = useLoad(() => api.node(node.id), [node.id, live.model]);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const d = detail.data;
  return (
    <aside className="panel" aria-label={node.name}>
      <p className="kind">{KIND_LABEL[node.kind]}</p>
      <h2>
        {node.name} {change && <span className="tag fresh">{CHANGE_LABEL[change.change]}</span>}
      </h2>
      <p>{subtitle(node, level)}</p>
      {node.kind === "component" && node.sync !== "ok" && (
        <p className="warn">{node.sync === "stale" ? "The code changed since this was modeled." : "Not yet checked against the code."}</p>
      )}
      {zoomTarget(node) && <button onClick={() => onZoom(node.id)}>Look inside</button>}
      {node.kind === "component" && (
        <>
          <h3>Code</h3>
          <ul className="paths">
            {node.paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {d && d.outgoing.length > 0 && <Links title="Depends on" nodes={nodes} ids={d.outgoing.map((e) => e.to)} onPick={onPick} />}
      {d && d.incoming.length > 0 && <Links title="Used by" nodes={nodes} ids={d.incoming.map((e) => e.from)} onPick={onPick} />}
      {d && d.decisions.length > 0 && <Links title="Shaped by" nodes={nodes} ids={d.decisions} onPick={onPick} />}
      <h3>Ask the agent</h3>
      {sent ? (
        <p className="muted">Sent. The agent sees it on its next edit.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() === "") return;
            void api.flag(node.id, text).then(() => {
              setSent(true);
              setText("");
            });
          }}
        >
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={`Why is ${node.name} built this way?`} rows={3} />
          <button type="submit">Flag</button>
        </form>
      )}
    </aside>
  );
}

function Links({ title, nodes, ids, onPick }: { title: string; nodes: Map<string, ModelNode>; ids: string[]; onPick: (id: string) => void }) {
  return (
    <>
      <h3>{title}</h3>
      <ul className="links">
        {[...new Set(ids)].map((id) => (
          <li key={id}>
            <button className="link" onClick={() => onPick(id)}>
              {nodes.get(id)?.name ?? id}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
