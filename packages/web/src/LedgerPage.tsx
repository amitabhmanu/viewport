import type { Decision } from "@viewport/core";
import { api } from "./api.js";
import { useLive, useLoad } from "./live.js";

export function LedgerPage() {
  const live = useLive();
  const { data, error } = useLoad(api.ledger, [live.ledger]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted page">Loading…</p>;
  const newest = [...data].reverse();
  return (
    <section className="page narrow">
      <h1>Ledger</h1>
      {newest.length === 0 && <p className="muted">No decisions yet. The agent records one whenever it picks between real options.</p>}
      <ol className="ledger">
        {newest.map((d) => (
          <DecisionCard key={d.id} d={d} />
        ))}
      </ol>
    </section>
  );
}

function DecisionCard({ d }: { d: Decision }) {
  return (
    <li className="decision" id={d.id}>
      <div className="decision-head">
        <span className="id">{d.id}</span>
        <h2>{d.title}</h2>
        <span className={`tag ${d.reversibility}`}>{d.reversibility === "one-way" ? "One-way" : "Reversible"}</span>
      </div>
      <p>
        <strong>Chose {d.chosen}.</strong> {d.why}
      </p>
      <p className="muted">
        Touches {d.blastRadius} component{d.blastRadius === 1 ? "" : "s"}
        {d.supersedes ? ` · replaces ${d.supersedes}` : ""} · {new Date(d.at).toLocaleString()}
      </p>
      {d.assumptions.length > 0 && (
        <ul className="assumptions">
          {d.assumptions.map((a) => (
            <li key={a}>Assumed: {a}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
