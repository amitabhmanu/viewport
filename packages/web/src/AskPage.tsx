import type { AskQuery, Change, Comparison, Decision, ImpactResult, Model, ModelNode, Subgraph } from "@viewport/core";
import { type ReactElement, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { ASK_KINDS, CHANGEABLE, EFFECT_LABEL, FAILABLE, SLICES, askHref, askSubject, askTitle, askView, followUp, impactLines, parseAsk } from "./ask.js";
import { useChanges } from "./changes.js";
import { Diagram } from "./Diagram.js";
import { CHANGE_LABEL, homeView, shuffledOptions } from "./labels.js";
import { useLive, useLoad } from "./live.js";
import { mapHref } from "./router.js";

type Answer =
  | { kind: "subgraph"; data: Subgraph }
  | { kind: "impact"; data: ImpactResult }
  | { kind: "compare"; data: Comparison }
  | { kind: "options" };

/** Runs a query against the daemon. `quiet` re-runs are not logged as asking. */
async function run(query: AskQuery, quiet: boolean): Promise<Answer> {
  if (query.q === "fails" || query.q === "changes") return { kind: "impact", data: await api.impact(query.q, query.node, quiet) };
  if (query.q === "compare") return { kind: "compare", data: await api.compare(query.from, query.to, quiet) };
  if (query.q === "options") return { kind: "options" };
  return { kind: "subgraph", data: await api.ask(query, quiet) };
}

export function AskPage({ params, go }: { params: URLSearchParams; go: (to: string) => void }) {
  const live = useLive();
  const model = useLoad(api.model, [live.model]);
  const ledger = useLoad(api.ledger, [live.ledger]);
  const predictions = useLoad(api.predictions, [live.state]);
  const scores = useLoad(api.salience, [live.model, live.ledger, live.state]);
  const pins = useLoad(api.pins, [live.state]);
  const query = parseAsk(params);
  const key = query ? askHref(query) : "";

  // Log the asking, not the re-runs: the first fetch of a query is loud, refreshes after model changes are quiet.
  const asked = useRef("");
  const result = useLoad(async () => {
    if (!query) return undefined;
    const quiet = asked.current === key;
    asked.current = key;
    return run(query, quiet);
  }, [key, live.model]);

  const nodes = useMemo(() => new Map((model.data?.nodes ?? []).map((n) => [n.id, n])), [model.data]);
  const modes = useMemo(
    () => new Map((model.data?.edges ?? []).filter((e) => e.kind === "depends_on").map((e) => [`${e.kind}:${e.from}->${e.to}`, e.mode ?? ""])),
    [model.data],
  );
  const { bySubject } = useChanges();

  if (model.error) return <p className="error page">{model.error}</p>;
  if (!model.data) return <p className="muted page">Loading…</p>;
  const m = model.data;
  const title = query ? askTitle(query, nodes) : "";
  const pinned = (pins.data ?? []).find((p) => askHref(p.query) === key);
  const toMap = (id: string) => go(mapHref(homeView(m, id), { focus: id }));
  const draw = (graph: Subgraph, notes?: Map<string, string>, changed = bySubject) => (
    <Diagram
      part={askView(graph, m.edges, title)}
      nodes={nodes}
      modes={modes}
      level="medium"
      changed={changed}
      selected={query && askSubject(query)}
      onSelect={toMap}
      onOpen={toMap}
      onStub={() => undefined}
      {...(notes ? { notes } : {})}
    />
  );
  const answer = result.data;
  const resultNodes = answer?.kind === "subgraph" || answer?.kind === "impact" || answer?.kind === "compare" ? answer.data.nodes : [];
  const next = query && ledger.data && predictions.data ? followUp(resultNodes, askSubject(query), m, ledger.data, predictions.data, scores.data?.salience ?? {}) : undefined;

  return (
    <section className="ask">
      <div className="ask-side">
        <h1>Ask</h1>
        {/* Keyed by the query so the form follows the URL when it changes elsewhere (a Map link, a pin, Back). */}
        <AskForm key={key} model={m} ledger={ledger.data ?? []} query={query} go={go} />
        {(pins.data ?? []).length > 0 && (
          <>
            <h3>Pinned</h3>
            <ul className="pins">
              {pins.data!.map((p) => (
                <li key={p.id} className={askHref(p.query) === key ? "here" : ""}>
                  <a
                    href={askHref(p.query)}
                    onClick={(e) => {
                      e.preventDefault();
                      go(askHref(p.query));
                    }}
                  >
                    {p.title}
                  </a>
                  <button className="link" aria-label={`Unpin ${p.title}`} onClick={() => void api.unpin(p.id)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="canvas">
        {!query && (
          <p className="muted">
            Trace how parts connect, slice the model by a concern, ask what breaks if a part fails or what a changed requirement touches, compare two revisions, or set a
            decision's options side by side. Results open here as a view you can pin; a pinned question about a part also shows on the Map.
          </p>
        )}
        {query && result.error && <p className="error">{result.error}</p>}
        {query && answer && (
          <>
            <div className="section-head">
              <h2>{title}</h2>
              <button onClick={() => void (pinned ? api.unpin(pinned.id) : api.pin(title, query))}>{pinned ? "Unpin" : "Pin"}</button>
            </div>
            {answer.kind === "subgraph" &&
              (answer.data.nodes.length === 0 ? (
                <p className="muted">Nothing in the model matches.</p>
              ) : (
                <>
                  <p className="narrative">
                    {answer.data.nodes.length} part{answer.data.nodes.length === 1 ? "" : "s"}. Select one to see it on the Map.
                  </p>
                  {draw(answer.data)}
                </>
              ))}
            {answer.kind === "impact" && <ImpactAnswer result={answer.data} nodes={nodes} draw={draw} />}
            {answer.kind === "compare" && <CompareAnswer result={answer.data} draw={draw} />}
            {answer.kind === "options" && query.q === "options" && (
              <OptionsAnswer decision={(ledger.data ?? []).find((d) => d.id === query.decision)} guessed={(predictions.data ?? []).some((p) => p.decisionId === query.decision)} draw={draw} />
            )}
            {next && (
              <p className="follow-up">
                {next.text}{" "}
                <a
                  href={next.href}
                  onClick={(e) => {
                    e.preventDefault();
                    go(next.href);
                  }}
                >
                  {next.href.startsWith("/ledger") ? "Guess" : "Ask"}
                </a>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

type Draw = (graph: Subgraph, notes?: Map<string, string>, changed?: Map<string, Change>) => ReactElement;

function ImpactAnswer({ result, nodes, draw }: { result: ImpactResult; nodes: Map<string, ModelNode>; draw: Draw }) {
  const lines = impactLines(result.effect, nodes);
  const notes = new Map(Object.entries(result.effect).map(([id, e]) => [id, EFFECT_LABEL[e]]));
  return (
    <>
      {lines.length === 0 ? (
        <p className="narrative">Nothing else in the model depends on it.</p>
      ) : (
        <ul className="impact">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {draw(result, notes)}
    </>
  );
}

function CompareAnswer({ result, draw }: { result: Comparison; draw: Draw }) {
  if (result.changes.length === 0) return <p className="muted">The two revisions describe the same system.</p>;
  const changed = new Map(result.changes.map((c) => [c.subject, c]));
  return (
    <>
      <ul className="changes">
        {result.changes.map((c) => (
          <li key={c.subject}>
            <span className={`tag ${c.change}`}>{CHANGE_LABEL[c.change]}</span> {c.label} <span className="muted">({c.what === "edge" ? c.subject.slice(0, c.subject.indexOf(":")) : c.what})</span>
          </li>
        ))}
      </ul>
      {result.nodes.length > 0 && draw({ nodes: result.nodes, edges: result.edges }, undefined, changed)}
    </>
  );
}

/**
 * A decision's options side by side, in an order that gives nothing away. Which one
 * was chosen stays hidden until the developer has guessed or skipped in the Ledger,
 * as everywhere else.
 */
function OptionsAnswer({ decision, guessed, draw }: { decision: Decision | undefined; guessed: boolean; draw: Draw }) {
  const shaped = useLoad(async () => (decision ? api.ask({ q: "slice", decidedBy: decision.id.toLowerCase() }, true) : undefined), [decision?.id]);
  if (!decision) return <p className="muted">That decision is not in the ledger.</p>;
  return (
    <>
      <ul className="option-cards">
        {shuffledOptions(decision).map((o) => (
          <li key={o.name} className={guessed && o.name === decision.chosen ? "chosen" : ""}>
            <strong>{o.name}</strong>
            {guessed && o.name === decision.chosen && <span className="tag fresh">Chosen</span>}
            <p>{o.tradeoff}</p>
          </li>
        ))}
      </ul>
      {guessed ? (
        <p>
          <strong>Why:</strong> {decision.why}
        </p>
      ) : (
        <p className="muted">
          Which one was chosen stays hidden until you guess. <a href={`/ledger#${decision.id}`}>Guess in the Ledger</a>
        </p>
      )}
      {decision.assumptions.length > 0 && (
        <>
          <h3>Taken as true</h3>
          <ul className="assumptions">
            {decision.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {shaped.data && shaped.data.nodes.length > 0 && (
        <>
          <h3>What it shaped</h3>
          {draw(shaped.data)}
        </>
      )}
    </>
  );
}

function AskForm({ model, ledger, query, go }: { model: Model; ledger: Decision[]; query: AskQuery | undefined; go: (to: string) => void }) {
  const live = useLive();
  const revisions = useLoad(api.revisions, [live.model]);
  const [kind, setKind] = useState<AskQuery["q"]>(query?.q ?? "trace");
  const [from, setFrom] = useState(query?.q === "trace" ? query.from : "");
  const [to, setTo] = useState(query?.q === "trace" ? (query.to ?? "") : "");
  const [direction, setDirection] = useState(query?.q === "trace" ? (query.direction ?? "downstream") : "downstream");
  const [slice, setSlice] = useState(query?.q === "slice" ? askHref(query) : askHref(SLICES[0]![1]));
  const [node, setNode] = useState(query?.q === "fails" || query?.q === "changes" ? query.node : "");
  const [revFrom, setRevFrom] = useState(query?.q === "compare" ? String(query.from) : "");
  const [revTo, setRevTo] = useState(query?.q === "compare" && query.to !== undefined ? String(query.to) : "");
  const [decision, setDecision] = useState(query?.q === "options" ? query.decision : "");

  const byName = (a: ModelNode, b: ModelNode) => a.name.localeCompare(b.name);
  const parts = model.nodes.filter((n) => n.kind !== "decision").sort(byName);
  const choices = (list: ModelNode[]) =>
    list.map((n) => (
      <option key={n.id} value={n.id}>
        {n.name} ({n.id})
      </option>
    ));
  const decisions = model.nodes.filter((n) => n.kind === "decision");
  const kept = [...(revisions.data?.kept ?? [])].reverse();
  const current = revisions.data?.current;

  const submit = (): string | undefined => {
    switch (kind) {
      case "trace":
        return from ? askHref({ q: "trace", from, ...(to ? { to } : { direction: direction as "upstream" | "downstream" }) }) : undefined;
      case "slice":
        return slice;
      case "fails":
      case "changes":
        return node ? askHref({ q: kind, node }) : undefined;
      case "compare":
        return revFrom ? askHref({ q: "compare", from: Number(revFrom), ...(revTo ? { to: Number(revTo) } : {}) }) : undefined;
      case "options":
        return decision ? askHref({ q: "options", decision }) : undefined;
    }
  };

  return (
    <form
      className="ask-form"
      onSubmit={(e) => {
        e.preventDefault();
        const href = submit();
        if (href) go(href);
      }}
    >
      <label>
        Question
        <select value={kind} onChange={(e) => setKind(e.target.value as AskQuery["q"])}>
          {ASK_KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {kind === "trace" && (
        <>
          <label>
            From
            <select value={from} onChange={(e) => setFrom(e.target.value)} required>
              <option value="">Choose a part…</option>
              {choices(parts)}
            </select>
          </label>
          <label>
            To
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Anywhere</option>
              {choices(parts)}
            </select>
          </label>
          {!to && (
            <label>
              Direction
              <select value={direction} onChange={(e) => setDirection(e.target.value as "upstream" | "downstream")}>
                <option value="downstream">What it depends on</option>
                <option value="upstream">What depends on it</option>
              </select>
            </label>
          )}
        </>
      )}
      {kind === "slice" && (
        <label>
          Show
          <select value={slice} onChange={(e) => setSlice(e.target.value)}>
            {SLICES.map(([label, s]) => (
              <option key={label} value={askHref(s)}>
                {label}
              </option>
            ))}
            {decisions.map((d) => (
              <option key={d.id} value={askHref({ q: "slice", decidedBy: d.id })}>
                Shaped by: {d.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {(kind === "fails" || kind === "changes") && (
        <label>
          {kind === "fails" ? "Part that fails" : "Requirement that changes"}
          <select value={node} onChange={(e) => setNode(e.target.value)} required>
            <option value="">Choose…</option>
            {choices(parts.filter((n) => (kind === "fails" ? FAILABLE : CHANGEABLE).has(n.kind)))}
          </select>
        </label>
      )}
      {kind === "compare" && (
        <>
          <label>
            From revision
            <select value={revFrom} onChange={(e) => setRevFrom(e.target.value)} required>
              <option value="">Choose…</option>
              {kept.filter((r) => r !== current).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            To revision
            <select value={revTo} onChange={(e) => setRevTo(e.target.value)}>
              <option value="">Now{current !== undefined ? ` (${current})` : ""}</option>
              {kept.filter((r) => r !== current).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          {kept.length === 0 && <p className="muted">No earlier revisions are kept on this machine yet.</p>}
        </>
      )}
      {kind === "options" && (
        <label>
          Decision
          <select value={decision} onChange={(e) => setDecision(e.target.value)} required>
            <option value="">Choose…</option>
            {[...ledger].reverse().map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}: {d.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit">Ask</button>
    </form>
  );
}
