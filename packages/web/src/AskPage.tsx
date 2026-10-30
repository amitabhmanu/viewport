import type { AskQuery, ModelNode } from "@viewport/core";
import { useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { SLICES, askHref, askTitle, askView, parseAsk } from "./ask.js";
import { useChanges } from "./changes.js";
import { Diagram } from "./Diagram.js";
import { homeView } from "./labels.js";
import { useLive, useLoad } from "./live.js";
import { mapHref } from "./router.js";

export function AskPage({ params, go }: { params: URLSearchParams; go: (to: string) => void }) {
  const live = useLive();
  const model = useLoad(api.model, [live.model]);
  const pins = useLoad(api.pins, [live.state]);
  const query = parseAsk(params);
  const key = query ? askHref(query) : "";

  // Log the asking, not the re-runs: the first fetch of a query is loud, refreshes after model changes are quiet.
  const asked = useRef("");
  const result = useLoad(async () => {
    if (!query) return undefined;
    const quiet = asked.current === key;
    asked.current = key;
    return api.ask(query, quiet);
  }, [key, live.model]);

  const nodes = useMemo(() => new Map((model.data?.nodes ?? []).map((n) => [n.id, n])), [model.data]);
  const modes = useMemo(
    () => new Map((model.data?.edges ?? []).filter((e) => e.kind === "depends_on").map((e) => [`${e.kind}:${e.from}->${e.to}`, e.mode ?? ""])),
    [model.data],
  );
  const { bySubject } = useChanges();

  if (model.error) return <p className="error page">{model.error}</p>;
  if (!model.data) return <p className="muted page">Loading…</p>;
  const title = query ? askTitle(query, nodes) : "";
  const pinned = (pins.data ?? []).find((p) => askHref(p.query) === key);

  return (
    <section className="ask">
      <div className="ask-side">
        <h1>Ask</h1>
        {/* Keyed by the query so the form follows the URL when it changes elsewhere (a Map link, a pin, Back). */}
        <AskForm key={key} nodes={model.data.nodes} query={query} go={go} />
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
        {!query && <p className="muted">Trace how parts connect, or slice the model by a concern. Results open here as a view you can pin.</p>}
        {query && result.error && <p className="error">{result.error}</p>}
        {query && result.data && (
          <>
            <div className="section-head">
              <h2>{title}</h2>
              <button onClick={() => void (pinned ? api.unpin(pinned.id) : api.pin(title, query))}>{pinned ? "Unpin" : "Pin"}</button>
            </div>
            {result.data.nodes.length === 0 ? (
              <p className="muted">Nothing in the model matches.</p>
            ) : (
              <>
                <p className="narrative">
                  {result.data.nodes.length} part{result.data.nodes.length === 1 ? "" : "s"}. Select one to see it on the Map.
                </p>
                <Diagram
                  part={askView(result.data, model.data.edges, title)}
                  nodes={nodes}
                  modes={modes}
                  level="medium"
                  changed={bySubject}
                  selected={query.q === "trace" ? query.from : undefined}
                  onSelect={(id) => go(mapHref(homeView(model.data!, id), { focus: id }))}
                  onOpen={(id) => go(mapHref(homeView(model.data!, id), { focus: id }))}
                  onStub={() => undefined}
                />
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function AskForm({ nodes, query, go }: { nodes: ModelNode[]; query: AskQuery | undefined; go: (to: string) => void }) {
  const [kind, setKind] = useState<"trace" | "slice">(query?.q ?? "trace");
  const [from, setFrom] = useState(query?.q === "trace" ? query.from : "");
  const [to, setTo] = useState(query?.q === "trace" ? (query.to ?? "") : "");
  const [direction, setDirection] = useState(query?.q === "trace" ? (query.direction ?? "downstream") : "downstream");
  const [slice, setSlice] = useState(query?.q === "slice" ? askHref(query) : askHref(SLICES[0]![1]));

  const parts = nodes.filter((n) => n.kind !== "decision").sort((a, b) => a.name.localeCompare(b.name));
  const decisions = nodes.filter((n) => n.kind === "decision");
  const options = (
    <>
      {parts.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name} ({n.id})
        </option>
      ))}
    </>
  );
  return (
    <form
      className="ask-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (kind === "slice") return go(slice);
        if (!from) return;
        go(askHref({ q: "trace", from, ...(to ? { to } : { direction: direction as "upstream" | "downstream" }) }));
      }}
    >
      <div className="levels" role="radiogroup" aria-label="Kind of question">
        <button type="button" role="radio" aria-checked={kind === "trace"} onClick={() => setKind("trace")}>
          Trace
        </button>
        <button type="button" role="radio" aria-checked={kind === "slice"} onClick={() => setKind("slice")}>
          Slice
        </button>
      </div>
      {kind === "trace" ? (
        <>
          <label>
            From
            <select value={from} onChange={(e) => setFrom(e.target.value)} required>
              <option value="">Choose a part…</option>
              {options}
            </select>
          </label>
          <label>
            To
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Anywhere</option>
              {options}
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
      ) : (
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
      <button type="submit">Ask</button>
    </form>
  );
}
