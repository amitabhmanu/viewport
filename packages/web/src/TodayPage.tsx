import type { Change, Decision, Digest, DigestDecision, Job, Model, ViewEdgeKind } from "@viewport/core";
import { type MouseEvent, useState } from "react";
import { api } from "./api.js";
import { markSeen, useChanges } from "./changes.js";
import { Calibration } from "./Calibration.js";
import { CHANGE_LABEL, EDGE_LABEL, KIND_LABEL, bySalience, changesByProcess, homeView, seenWith, toPredict } from "./labels.js";
import { useLive, useLoad } from "./live.js";
import { FLAG_STATUS } from "./Flags.js";
import { PredictPrompt } from "./Predict.js";
import { AnswerList, QuizCard } from "./Quiz.js";
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
  const answers = useLoad(api.answers, [live.state]);
  const scores = useLoad(api.salience, [live.model, live.ledger, live.state]);
  const calibration = useLoad(api.calibration, [live.state]);
  const debt = useLoad(api.debt, [live.model, live.state]);
  const digest = useLoad(api.digest, [live.ledger, live.state, live.model]);
  const error = model.error ?? ledger.error ?? flags.error;
  if (error) return <p className="error">{error}</p>;
  if (!model.data) return <p className="muted page">Loading…</p>;

  const components = model.data.nodes.filter((n) => n.kind === "component");
  const stale = components.filter((n) => n.sync === "stale");
  const unverified = components.filter((n) => n.sync === "unverified");
  const open = (flags.data ?? []).filter((f) => f.status !== "resolved");
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const answered = (flags.data ?? []).filter((f) => f.resolvedAt !== undefined && Date.parse(f.resolvedAt) > weekAgo).reverse();
  const debtHref = mapHref("containers", { overlay: "debt" });
  const tiles: [string, number | string, string][] = [
    ["Components", components.length, mapHref("overview")],
    ["Changed since modeled", stale.length, mapHref("containers")],
    ["Not yet checked", unverified.length, mapHref("containers")],
    ["Decisions", ledger.data?.length ?? 0, "/ledger"],
    ["Open questions", open.length, "/"],
    ...(debt.data && debt.data.items.length > 0 ? ([["Not yet understood", `${debt.data.gap}%`, debtHref]] as [string, string, string][]) : []),
  ];
  const processGroups = changesByProcess(bySalience(changes, scores.data?.salience ?? {}), model.data);
  const processName = (id: string) => model.data!.nodes.find((n) => n.id === id)?.name ?? id;
  const link = (href: string) => (e: MouseEvent) => {
    e.preventDefault();
    go(href);
  };
  return (
    <section className="page narrow">
      <h1>Today</h1>
      <div className="tiles">
        {tiles.map(([label, n, href]) => (
          <a
            key={label}
            className={`tile${n === 0 ? " zero" : ""}`}
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
      {digest.data && <DigestCard digest={digest.data} link={link} />}
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
      <AnswerList answers={answers.data ?? []} subjectName={(id) => model.data!.nodes.find((n) => n.id === id)?.name ?? id} />
      {ledger.data && predictions.data && <PredictCards queue={toPredict(ledger.data, predictions.data, scores.data?.salience)} go={go} />}
      <ExplainerStatus jobs={jobs.data ?? []} />
      <div className="section-head">
        <h2>What changed since you last looked</h2>
        {changes.length > 0 && <button onClick={() => void api.seenAll()}>Mark all as seen</button>}
      </div>
      {changes.length === 0 ? (
        <p className="muted">You are up to date.</p>
      ) : (
        processGroups.map((g) => (
          <div key={g.process ?? ""}>
            {(g.process !== undefined || processGroups.length > 1) && <h3>{g.process !== undefined ? processName(g.process) : "Everything else"}</h3>}
            <ul className="changes">
              {g.changes.map((c) => (
                <ChangeItem key={c.subject} c={c} model={model.data!} changes={changes} go={go} />
              ))}
            </ul>
          </div>
        ))
      )}
      {debt.data && debt.data.items.some((i) => i.band) && (
        <>
          <div className="section-head">
            <h2>Where you know least</h2>
            <a href={debtHref} onClick={link(debtHref)}>
              Show all
            </a>
          </div>
          <ul className="debt-list">
            {debt.data.items
              .filter((i) => i.band)
              .slice(0, 3)
              .map((i) => {
                const href = mapHref(homeView(model.data!, i.id), { focus: i.id });
                return (
                  <li key={i.id}>
                    <a href={href} onClick={link(href)}>
                      {i.name}
                    </a>{" "}
                    <span className="muted">
                      a change here touches {i.reach} part{i.reach === 1 ? "" : "s"}
                    </span>
                  </li>
                );
              })}
          </ul>
        </>
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
      {calibration.data && <Calibration data={calibration.data} />}
    </section>
  );
}

/** The last day in short. One-way decisions stand apart and stay until looked at; Claude never waits for them (D-001). */
function DigestCard({ digest, link }: { digest: Digest; link: (href: string) => (e: MouseEvent) => void }) {
  const total = digest.decisions.length + digest.moreDecisions;
  const rest = [
    ...(digest.quizDue > 0 ? [`${digest.quizDue} question${digest.quizDue === 1 ? "" : "s"} due`] : []),
    ...(digest.answers > 0 ? [`${digest.answers} answer${digest.answers === 1 ? "" : "s"} from Claude`] : []),
  ];
  if (digest.oneWay.length === 0 && total === 0 && rest.length === 0) return null;
  const toDecision = (d: DigestDecision) => (
    <li key={d.id}>
      <a href={`/ledger#${d.id}`} onClick={link(`/ledger#${d.id}`)}>
        {d.title}
      </a>
    </li>
  );
  return (
    <>
      {digest.oneWay.length > 0 && (
        <div className="one-way-nudge" role="status">
          <strong>Hard to undo.</strong> Claude made {digest.oneWay.length === 1 ? "a one-way decision" : `${digest.oneWay.length} one-way decisions`} you have not looked at yet:
          <ul>{digest.oneWay.slice(0, 3).map(toDecision)}</ul>
        </div>
      )}
      {(total > 0 || rest.length > 0) && (
        <div className="digest">
          {total > 0 && (
            <>
              <strong>
                {total} new decision{total === 1 ? "" : "s"} since yesterday
                {digest.moreDecisions > 0 ? `; the ${digest.decisions.length} most worth knowing:` : ":"}
              </strong>
              <ul>{digest.decisions.map(toDecision)}</ul>
            </>
          )}
          {rest.length > 0 && <p className="muted">{rest.join(" · ")}</p>}
        </div>
      )}
    </>
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
      <span className="muted">{c.what === "edge" ? EDGE_LABEL[c.subject.slice(0, c.subject.indexOf(":")) as ViewEdgeKind].noun : c.what === "decision" ? "Decision" : KIND_LABEL[model.nodes.find((n) => n.id === c.subject)?.kind ?? "component"]}</span>{" "}
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

/** New decisions to guess at, the most salient first: one open at a time, two more waiting below it. */
function PredictCards({ queue, go }: { queue: Decision[]; go: (to: string) => void }) {
  const [openId, setOpenId] = useState<string>();
  if (queue.length === 0) return null;
  const current = queue.find((d) => d.id === openId) ?? queue[0]!;
  const waiting = queue.slice(0, 3).filter((d) => d !== current);
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
        <li key={current.id} className="decision" data-decision={current.id}>
          <div className="decision-head">
            <span className="id">{current.id}</span>
            <h2>{current.title}</h2>
          </div>
          <PredictPrompt d={current} />
        </li>
        {waiting.map((d) => (
          <li key={d.id} className="predict-row">
            <button className="link" onClick={() => setOpenId(d.id)}>
              <span className="id">{d.id}</span> {d.title}
            </button>
            <span className="muted"> · guess this next</span>
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
