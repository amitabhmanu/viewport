import type { Decision, Flag, Prediction } from "@viewport/core";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { markSeen, useChanges } from "./changes.js";
import { rank } from "./labels.js";
import { useLive, useLoad } from "./live.js";
import { FlagBox, useFlags } from "./Flags.js";
import { PredictPrompt, PredictionResult } from "./Predict.js";

const FILTERS = [
  ["all", "All"],
  ["one-way", "One-way"],
  ["costly", "Costly"],
  ["easy", "Easy"],
] as const;
type Filter = (typeof FILTERS)[number][0];

/** At or above this familiarity, a decision is marked as one the developer knows. */
const FAMILIAR = 0.6;

const REVERSIBILITY: Record<Decision["reversibility"], string> = { "one-way": "One-way", costly: "Costly to undo", easy: "Easy to undo" };

export function LedgerPage() {
  const live = useLive();
  const { data, error } = useLoad(api.ledger, [live.ledger]);
  const predictions = useLoad(api.predictions, [live.state]);
  const scores = useLoad(api.salience, [live.model, live.ledger, live.state]);
  const flags = useFlags();
  const { bySubject } = useChanges();
  const [filter, setFilter] = useState<Filter>("all");
  const scrolled = useRef(false);

  // Arriving from a link to one decision: bring it into view once.
  useEffect(() => {
    const target = window.location.hash.slice(1);
    if (scrolled.current || !data || !target) return;
    scrolled.current = true;
    document.getElementById(target)?.scrollIntoView({ block: "center" });
  }, [data]);

  if (error) return <p className="error page">{error}</p>;
  if (!data || !predictions.data) return <p className="muted page">Loading…</p>;
  const guessed = new Map(predictions.data.map((p) => [p.decisionId, p]));
  const replaced = new Set(data.flatMap((d) => (d.supersedes ? [d.supersedes] : [])));
  const shown = rank(data, scores.data?.salience).filter((d) => filter === "all" || d.reversibility === filter);

  return (
    <section className="page narrow">
      <div className="section-head">
        <h1>Ledger</h1>
        <div className="levels" role="radiogroup" aria-label="Reversibility">
          {FILTERS.map(([value, label]) => (
            <button key={value} role="radio" aria-checked={filter === value} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted">Most worth your attention first: decisions that are new to you, reach many components and are hard to undo.</p>
      {data.length === 0 && <p className="muted">No decisions yet. The agent records one whenever it picks between real options.</p>}
      {data.length > 0 && shown.length === 0 && <p className="muted">No decisions match this filter.</p>}
      <ol className="ledger">
        {shown.map((d) => (
          <DecisionCard key={d.id} d={d} familiar={(scores.data?.familiarity[d.id] ?? 0) >= FAMILIAR} isNew={bySubject.has(d.id)} replaced={replaced.has(d.id)} prediction={guessed.get(d.id)} flags={flags.get(d.id) ?? []} />
        ))}
      </ol>
    </section>
  );
}

/**
 * Every field is shown once the developer has guessed or skipped; until then the
 * choice and the reasons stay hidden. Clicking a new decision marks it seen.
 */
function DecisionCard({
  d,
  familiar,
  isNew,
  replaced,
  prediction,
  flags,
}: {
  d: Decision;
  familiar: boolean;
  isNew: boolean;
  replaced: boolean;
  prediction: Prediction | undefined;
  flags: Flag[];
}) {
  return (
    <li className={`decision${isNew ? " fresh" : ""}${replaced ? " replaced" : ""}`} id={d.id} onClick={() => isNew && markSeen([d.id])}>
      <div className="decision-head">
        <span className="id">{d.id}</span>
        <h2>{d.title}</h2>
        {isNew && <span className="tag fresh">New</span>}
        {replaced && <span className="tag">Replaced</span>}
        {familiar && (
          <span className="tag familiar" title="You have shown you know this one; it ranks lower">
            Familiar
          </span>
        )}
        <span className={`tag ${d.reversibility}`}>{REVERSIBILITY[d.reversibility]}</span>
        <span className="radius" title="Components this decision touches">
          {d.blastRadius}
        </span>
      </div>
      {prediction === undefined && !replaced ? (
        <PredictPrompt d={d} />
      ) : (
        <>
          {prediction && <PredictionResult p={prediction} chosen={d.chosen} />}
          <p>
            <strong>Chose {d.chosen}.</strong> {d.why}
          </p>
          <DecisionBody d={d} />
          <FlagBox subject={d.id} flags={flags} placeholder={`Why ${d.chosen}?`} collapsed={flags.length === 0} />
        </>
      )}
    </li>
  );
}

function DecisionBody({ d }: { d: Decision }) {
  return (
    <div className="decision-body">
      <h3>Options</h3>
      <ul className="options">
        {d.options.map((o) => (
          <li key={o.name} className={o.name === d.chosen ? "chosen" : ""}>
            <strong>{o.name}</strong>: {o.tradeoff}
          </li>
        ))}
      </ul>
      {d.affects.length > 0 && (
        <>
          <h3>Affects</h3>
          <p>
            {d.affects.map((a) => (
              <code key={a}>{a} </code>
            ))}
          </p>
        </>
      )}
      {d.assumptions.length > 0 && (
        <>
          <h3>Assumptions not yet confirmed</h3>
          <ul className="assumptions">
            {d.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
      <p className="muted">
        {new Date(d.at).toLocaleString()}
        {d.commit ? ` · ${d.commit.slice(0, 8)}` : ""}
        {d.supersedes ? ` · replaces ${d.supersedes}` : ""}
      </p>
    </div>
  );
}
