import { api } from "./api.js";
import { useLive, useLoad } from "./live.js";
import { mapHref } from "./router.js";

export function TodayPage({ go }: { go: (to: string) => void }) {
  const live = useLive();
  const model = useLoad(api.model, [live.model]);
  const ledger = useLoad(api.ledger, [live.ledger]);
  const flags = useLoad(api.flags, [live.state]);
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
