import type { Change, Decision, Job, Model } from "@viewport/core";
import { api } from "./api.js";
import { markSeen, useChanges } from "./changes.js";
import { CHANGE_LABEL, KIND_LABEL, homeView, seenWith, toPredict } from "./labels.js";
import { useLive, useLoad } from "./live.js";
import { FLAG_STATUS } from "./Flags.js";
import { PredictPrompt } from "./Predict.js";
import { QuizCard } from "./Quiz.js";
import { mapHref } from "./router.js";

export function TodayPage({ go }: { go: (to: string) => void }) {
  const live = useLive();
  const model = useLoad(api.model, [live.model]);
  const ledger = useLoad(api.ledger, [live.ledger]);
  const flags = useLoad(api.allFlags, [live.state]);
  const predictions = useLoad(api.predictions, [live.state]);
  const { changes } = useChanges();
  // The quiz is fetched once per visit: answering must not swap the card for the next one mid-read.
  const quiz = useLoad(api.quiz, []);
  const jobs = useLoad(api.jobs, [live.state, live.model]);
  const error = model.error ?? ledger.error ?? flags.error;
  if (error) return <p className="error">{error}</p>;
  if (!model.data) return <p className="muted page">Loading…</p>;

  const components = model.data.nodes.filter((n) => n.kind === "component");
  const stale = components.filter((n) => n.sync === "stale");
  const unverified = components.filter((n) => n.sync === "unverified");
  const open = (flags.data ?? []).filter((f) => f.status !== "resolved");
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const answered = (flags.data ?? []).filter((f) => f.resolvedAt !== undefined && Date.parse(f.resolvedAt) > weekAgo).reverse();
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
      {(quiz.data ?? []).length > 0 && (
        <>
          <div className="section-head">
            <h2>Check what you know</h2>
          </div>
          <ul className="predict-cards">
            {quiz.data!.map((q) => (
              <QuizCard key={q.id} item={q} subject={model.data!.nodes.find((n) => n.id === q.subject)?.name ?? q.subject} />
            ))}
          </ul>
        </>
      )}
      {ledger.data && predictions.data && <PredictCards queue={toPredict(ledger.data, predictions.data)} go={go} />}
      <ExplainerStatus jobs={jobs.data ?? []} />
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
                <span className="muted">{f.subject}</span> {f.text} <span className="tag">{FLAG_STATUS[f.status]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {answered.length > 0 && (
        <>
          <h2>Claude's answers this week</h2>
          <ul className="flags flag-list">
            {answered.map((f) => (
              <li key={f.id} className="flag resolved">
                <p className="q">
                  <span className="muted">{f.subject}</span> {f.text}
                </p>
                <p className="a">
                  {f.answer}
                  {f.decisionId && (
                    <>
                      {" "}
                      <a
                        href={`/ledger#${f.decisionId}`}
                        onClick={(e) => {
                          e.preventDefault();
                          go(`/ledger#${f.decisionId}`);
                        }}
                      >
                        See {f.decisionId}
                      </a>
                    </>
                  )}
                </p>
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

/** At most three new decisions to guess at, the most salient first. */
function PredictCards({ queue, go }: { queue: Decision[]; go: (to: string) => void }) {
  if (queue.length === 0) return null;
  return (
    <>
      <div className="section-head">
        <h2>Predict before you look</h2>
        {queue.length > 3 && (
          <a
            href="/ledger"
            onClick={(e) => {
              e.preventDefault();
              go("/ledger");
            }}
          >
            {queue.length - 3} more in the Ledger
          </a>
        )}
      </div>
      <ul className="predict-cards">
        {queue.slice(0, 3).map((d) => (
          <li key={d.id} className="decision" data-decision={d.id}>
            <div className="decision-head">
              <span className="id">{d.id}</span>
              <h2>{d.title}</h2>
            </div>
            <PredictPrompt d={d} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** A quiet line while the explainer works in the background. */
function ExplainerStatus({ jobs }: { jobs: Job[] }) {
  const open = jobs.filter((j) => j.kind === "explain" && (j.status === "queued" || j.status === "running"));
  if (open.length === 0) return null;
  const parts = open.reduce((n, j) => n + ((j.payload.subjects as string[] | undefined)?.length ?? 0), 0);
  return (
    <p className="muted explaining">
      Claude is writing explanations and questions for {parts} new or changed item{parts === 1 ? "" : "s"}.
    </p>
  );
}
