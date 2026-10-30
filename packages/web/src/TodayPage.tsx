import type { Change, Model } from "@viewport/core";
import { api } from "./api.js";
import { markSeen, useChanges } from "./changes.js";
import { CHANGE_LABEL, KIND_LABEL, homeView, seenWith } from "./labels.js";
import { useLive, useLoad } from "./live.js";
import { mapHref } from "./router.js";

export function TodayPage({ go }: { go: (to: string) => void }) {
  const live = useLive();
  const model = useLoad(api.model, [live.model]);
  const ledger = useLoad(api.ledger, [live.ledger]);
  const flags = useLoad(api.flags, [live.state]);
  const { changes } = useChanges();
  const error = model.error ?? ledger.error ?? flags.error;
  if (error) return <p className="error">{error}</p>;
  if (!model.data) return <p className="muted page">Loading…</p>;

  const components = model.data.nodes.filter((n) => n.kind === "component");
  const stale = components.filter((n) => n.sync === "stale");
  const unverified = components.filter((n) => n.sync === "unverified");
  const open = (flags.data ?? []).filter((f) => f.status !== "resolved");
  const tiles: [string, number, string][] = [
    ["Components", components.length, mapHref("overview")],
    ["Changed since modeled", stale.length, mapHref("containers")],
    ["Not yet checked", unverified.length, mapHref("containers")],
    ["Decisions", ledger.data?.length ?? 0, "/ledger"],
    ["Open questions", open.length, "/"],
  ];
  return (
    <section className="page narrow">
      <h1>Today</h1>
      <div className="tiles">
        {tiles.map(([label, n, href]) => (
          <a
            key={label}
            className="tile"
            href={href}
            onClick={(e) => {
              e.preventDefault();
              go(href);
            }}
          >
            <span className="n">{n}</span>
            <span className="label">{label}</span>
          </a>
        ))}
      </div>
      <div className="section-head">
        <h2>What changed since you last looked</h2>
        {changes.length > 0 && <button onClick={() => void api.seenAll()}>Mark all as seen</button>}
      </div>
      {changes.length === 0 ? (
        <p className="muted">You are up to date.</p>
      ) : (
        <ul className="changes">
          {changes.map((c) => (
            <ChangeItem key={c.subject} c={c} model={model.data!} changes={changes} go={go} />
          ))}
        </ul>
      )}
      {open.length > 0 && (
        <>
          <h2>Your open questions</h2>
          <ul className="flags">
            {open.map((f) => (
              <li key={f.id}>
                <span className="muted">{f.subject}</span> {f.text} <span className="tag">{f.status === "pending" ? "Waiting for the agent" : "Seen by the agent"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** One change. Opening it shows it in place and marks it seen; a removed item can only be dismissed. */
function ChangeItem({ c, model, changes, go }: { c: Change; model: Model; changes: Change[]; go: (to: string) => void }) {
  const focus = c.what === "node" ? c.subject : c.nodes[0];
  const href = c.what === "decision" ? `/ledger#${c.subject}` : focus !== undefined && c.change !== "removed" ? mapHref(homeView(model, focus), { focus }) : undefined;
  const subjects = c.what === "node" && c.change !== "removed" ? seenWith(c.subject, changes) : [c.subject];
  return (
    <li>
      <span className={`tag ${c.change}`}>{CHANGE_LABEL[c.change]}</span>{" "}
      <span className="muted">{c.what === "edge" ? "Dependency" : c.what === "decision" ? "Decision" : KIND_LABEL[model.nodes.find((n) => n.id === c.subject)?.kind ?? "component"]}</span>{" "}
      {href ? (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            markSeen(subjects);
            go(href);
          }}
        >
          {c.label}
        </a>
      ) : (
        <>
          {c.label}{" "}
          <button className="link" onClick={() => markSeen(subjects)}>
            Dismiss
          </button>
        </>
      )}
    </li>
  );
}
