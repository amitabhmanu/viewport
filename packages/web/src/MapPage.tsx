import type { Change, Level, Model, ModelEdge, ModelNode, ViewEdge, ViewEdgeKind } from "@viewport/core";
import { type MouseEvent, useMemo } from "react";
import { api } from "./api.js";
import { askHref } from "./ask.js";
import { markSeen, useChanges } from "./changes.js";
import { Diagram } from "./Diagram.js";
import { FlagBox, useFlags } from "./Flags.js";
import { CHANGE_LABEL, EDGE_LABEL, KIND_LABEL, PHASES, boxNotes, partShowing, partSummary, phaseOf, phaseStart, seenWith, subtitle, takeaway, trail, viewTitle, zoomTarget } from "./labels.js";
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
  const edgeParam = params.get("edge") ?? undefined;

  const model = useLoad(api.model, [live.model]);
  const parts = useLoad(() => api.view(view, level), [view, level, live.model]);

  const nodes = useMemo(() => new Map((model.data?.nodes ?? []).map((n) => [n.id, n])), [model.data]);
  const modes = useMemo(
    () => new Map((model.data?.edges ?? []).filter((e) => e.kind === "depends_on").map((e) => [`${e.kind}:${e.from}->${e.to}`, e.mode ?? ""])),
    [model.data],
  );

  const notes = useMemo(() => (model.data ? boxNotes(model.data) : new Map<string, string>()), [model.data]);

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

  if (model.error) return <p className="error page">{model.error}</p>;
  if (!model.data) return <p className="muted page">Loading…</p>;
  const phases = <PhaseBar view={view} model={model.data} go={(v) => go(mapHref(v, { level }))} />;
  if (parts.error) {
    return (
      <section className="map">
        {phases}
        <p className="muted page">{emptyPhase(parts.error)}</p>
      </section>
    );
  }
  if (!parts.data) return <p className="muted page">Loading…</p>;
  if (parts.data.length === 0) return <p className="muted page">Nothing to show in this view yet.</p>;

  // A part in the URL wins; otherwise show the part holding the focused element, so a level switch keeps it in sight.
  const requested = partParam === null ? partShowing(parts.data, focus) : Number(partParam) - 1;
  const index = Math.min(Math.max(Number.isFinite(requested) ? requested : 0, 0), parts.data.length - 1);
  const part = parts.data[index]!;
  // Any navigation drops a selected arrow unless it says otherwise; arrows belong to one view.
  const href = (to: { view?: string; level?: Level; focus?: string | undefined; part?: number | undefined; edge?: string | undefined }) =>
    mapHref(to.view ?? view, { level: to.level ?? level, focus: "focus" in to ? to.focus : focus, part: "part" in to ? to.part : index + 1, edge: to.edge });
  const viewEdge = edgeParam === undefined ? undefined : part.edges.find((e) => `${e.kind}:${e.from}->${e.to}` === edgeParam);

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
      {phases}
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
            {parts.data.length > 1 && <strong>{partLabel(view, part.title)} {index + 1} of {parts.data.length}. </strong>}
            {takeaway(nodes.get(viewSubject(view)), level) ?? partSummary(part, nodes)}
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
            onSelectEdge={(key) => go(href({ focus: undefined, edge: key === edgeParam ? undefined : key }))}
            selectedEdge={edgeParam}
            notes={notes}
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
        {viewEdge && model.data && <EdgePanel edge={viewEdge} model={model.data} nodes={nodes} modes={modes} onPick={(id) => go(href({ focus: id }))} />}
        {viewEdge === undefined && focus !== undefined && nodes.has(focus) && <NodePanel node={nodes.get(focus)!} nodes={nodes} change={bySubject.get(focus)} level={level} onZoom={zoom} onPick={(id) => void openStub(id)} onGo={go} />}
      </div>
    </section>
  );
}

/** The node a view looks inside, whose takeaway heads the view. */
function viewSubject(view: string): string {
  if (view.startsWith("components:")) return view.slice("components:".length);
  if (view.startsWith("process:")) return view.slice("process:".length);
  return "";
}

/** "Part", or for a process split by scenario, the path the part follows ("When the order had shipped, part"). */
function partLabel(view: string, title: string): string {
  if (!view.startsWith("process:")) return "Part";
  return `${title.slice(title.indexOf(": ") + 2)}, part`;
}

/** A phase view's "nothing here" error, said as what to model next. */
function emptyPhase(error: string): string {
  const missing = /has no (.+) yet/.exec(error)?.[1];
  return missing ? `The model has no ${missing} yet. Ask Claude to add them, or run the viewport-modeler agent; the viewport-modeling skill says how.` : error;
}

/** The phases of the build, each opening its default view. A phase with nothing modeled is shown but disabled. */
function PhaseBar({ view, model, go }: { view: string; model: Model; go: (view: string) => void }) {
  const here = phaseOf(view);
  const kinds = new Set(model.nodes.map((n) => n.kind));
  return (
    <nav className="phases" aria-label="Phases">
      {PHASES.map((p) => {
        const ready = p.needs.some((k) => kinds.has(k));
        return (
          <button key={p.label} aria-current={p === here ? "page" : undefined} disabled={!ready} title={ready ? undefined : "Not modeled yet"} onClick={() => go(phaseStart(p, model))}>
            {p.label}
          </button>
        );
      })}
      {here?.more.map((m) => (
        <button key={m.view} className="more" aria-current={m.view === view ? "page" : undefined} onClick={() => go(m.view)}>
          {m.label}
        </button>
      ))}
    </nav>
  );
}

function NodePanel({
  node,
  nodes,
  change,
  level,
  onZoom,
  onPick,
  onGo,
}: {
  node: ModelNode;
  nodes: Map<string, ModelNode>;
  change: Change | undefined;
  level: Level;
  onZoom: (id: string) => void;
  onPick: (id: string) => void;
  onGo: (to: string) => void;
}) {
  const live = useLive();
  const detail = useLoad(() => api.node(node.id), [node.id, live.model]);
  const flags = useFlags();
  const follow = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    onGo(e.currentTarget.getAttribute("href")!);
  };
  const d = detail.data;
  return (
    <aside className="panel" aria-label={node.name}>
      <p className="kind">{KIND_LABEL[node.kind]}</p>
      <h2>
        {node.name} {change && <span className="tag fresh">{CHANGE_LABEL[change.change]}</span>}
      </h2>
      <p>{subtitle(node, level)}</p>
      {takeaway(node, level) && <p className="takeaway">{takeaway(node, level)}</p>}
      {node.kind === "component" && node.sync !== "ok" && (
        <p className="warn">{node.sync === "stale" ? "The code changed since this was modeled." : "Not yet checked against the code."}</p>
      )}
      <div className="actions">
        {zoomTarget(node) && <button onClick={() => onZoom(node.id)}>Look inside</button>}
        {(node.kind === "container" || node.kind === "component" || node.kind === "external") && (
          <>
            <a className="button" href={askHref({ q: "trace", from: node.id, direction: "upstream" })} onClick={follow}>
              What depends on it
            </a>
            <a className="button" href={askHref({ q: "trace", from: node.id, direction: "downstream" })} onClick={follow}>
              What it depends on
            </a>
          </>
        )}
      </div>
      {node.kind === "entity" && <p className={node.sensitivity === "pii" || node.sensitivity === "secret" ? "warn" : "muted"}>{SENSITIVITY[node.sensitivity]}</p>}
      {node.kind === "assumption" && <p className={node.status === "open" ? "warn" : "muted"}>{ASSUMPTION[node.status]}</p>}
      {node.kind === "test" && node.sync === "stale" && <p className="warn">No test files match these paths.</p>}
      {(node.kind === "component" || node.kind === "test") && (
        <>
          <h3>{node.kind === "test" ? "Test files" : "Code"}</h3>
          <ul className="paths">
            {node.paths.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {d?.parent !== undefined && nodes.get(d.parent)?.kind === "process" && <Links title="Part of" nodes={nodes} ids={[d.parent]} onPick={onPick} />}
      {d && groupLinks(d.outgoing, "out").map(([title, ids]) => <Links key={`out:${title}`} title={title} nodes={nodes} ids={ids} onPick={onPick} />)}
      {d && groupLinks(d.incoming, "in").map(([title, ids]) => <Links key={`in:${title}`} title={title} nodes={nodes} ids={ids} onPick={onPick} />)}
      {d && d.decisions.length > 0 && <Links title="Shaped by" nodes={nodes} ids={d.decisions} onPick={onPick} />}
      <h3>Questions for Claude</h3>
      <FlagBox subject={node.id} flags={flags.get(node.id) ?? []} placeholder={flagPrompt(node)} />
    </aside>
  );
}

const SENSITIVITY: Record<"public" | "internal" | "pii" | "secret", string> = {
  public: "Public data.",
  internal: "Internal data, not personal or secret.",
  pii: "Personal data: who can read it matters.",
  secret: "Secret: credentials or keys.",
};

const ASSUMPTION: Record<"open" | "confirmed" | "rejected", string> = {
  open: "Not confirmed yet. Only you can say whether this is true: flag it below.",
  confirmed: "Confirmed.",
  rejected: "Rejected: the code may still rely on it.",
};

/** A model node's edges, grouped under their arrow names ("Done by", "Tested by"), in the order of EDGE_LABEL. */
function groupLinks(edges: ModelEdge[], side: "out" | "in"): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const kind of Object.keys(EDGE_LABEL) as ViewEdgeKind[]) {
    const ids = edges.filter((e) => e.kind === kind).map((e) => (side === "out" ? e.to : e.from));
    if (ids.length === 0) continue;
    const title = EDGE_LABEL[kind][side];
    groups.set(title, [...(groups.get(title) ?? []), ...ids]);
  }
  return [...groups];
}

function flagPrompt(node: ModelNode): string {
  if (node.kind === "assumption") return "Is this true? Say what you know.";
  if (node.kind === "rule") return `Is this the rule you want?`;
  if (node.kind === "step" || node.kind === "process") return `Is this how ${node.name} should go?`;
  return `Why is ${node.name} built this way?`;
}

/**
 * An arrow on the Map: what it connects and how, the decisions behind it, and
 * questions about it. A lifted arrow stands for several dependencies between parts
 * inside the two boxes; questions on it go to the arrow as drawn.
 */
function EdgePanel({
  edge,
  model,
  nodes,
  modes,
  onPick,
}: {
  edge: ViewEdge;
  model: Model;
  nodes: Map<string, ModelNode>;
  modes: Map<string, string>;
  onPick: (id: string) => void;
}) {
  const flags = useFlags();
  const name = (id: string) => nodes.get(id)?.name ?? id;
  const subject = edge.sources.length === 1 ? edge.sources[0]! : `${edge.kind}:${edge.from}->${edge.to}`;
  const single = edge.sources.length === 1 ? model.edges.find((e) => `${e.kind}:${e.from}->${e.to}` === subject) : undefined;
  const decisions = model.edges.filter((e) => e.kind === "decided_by" && edge.sources.includes(e.from)).map((e) => e.to);
  return (
    <aside className="panel" aria-label={EDGE_LABEL[edge.kind].noun}>
      <p className="kind">{EDGE_LABEL[edge.kind].noun}</p>
      <h2>
        {name(edge.from)} → {name(edge.to)}
      </h2>
      {edge.label && <p>When {edge.label}.</p>}
      {single?.mode && (
        <p>
          {single.mode === "async" ? "Asynchronous" : single.mode === "data" ? "Through shared data" : "Synchronous call"}
          {single.protocol ? ` over ${single.protocol}` : ""}
        </p>
      )}
      {edge.sources.length > 1 && (
        <>
          <h3>Stands for</h3>
          <ul className="links">
            {edge.sources.map((key) => {
              const [from, to] = key.slice(key.indexOf(":") + 1).split("->") as [string, string];
              return (
                <li key={key}>
                  {name(from)} → {name(to)} {modes.get(key) && <span className="muted">({modes.get(key)})</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {decisions.length > 0 && <Links title="Shaped by" nodes={nodes} ids={decisions} onPick={onPick} />}
      <h3>Questions for Claude</h3>
      <FlagBox
        subject={subject}
        flags={flags.get(subject) ?? []}
        placeholder={edge.kind === "depends_on" ? `Why does ${name(edge.from)} depend on ${name(edge.to)}?` : `Why ${EDGE_LABEL[edge.kind].out.toLowerCase()} ${name(edge.to)}?`}
      />
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
