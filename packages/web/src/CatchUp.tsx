import type { Decision, Gate, GateSettings, GateSubject, Prediction } from "@viewport/core";
import { api } from "./api.js";
import { PredictPrompt } from "./Predict.js";
import { QuizCard } from "./Quiz.js";

export interface GateStatus {
  enabled: boolean;
  /** Enabled and not turned off for this run by VIEWPORT_NO_GATES. */
  active: boolean;
  settings: GateSettings;
  gate: Gate | null;
  last: Gate | null;
}

const RECENT_MS = 30 * 60 * 1000;

/**
 * The open catch-up gate: Claude is paused until each subject reaches the threshold.
 * Decisions not yet guessed get their prediction card; everything else gets the gate's
 * own question, again after a grade that falls short.
 */
export function CatchUpPanel({ status, ledger, predictions }: { status: GateStatus; ledger: Decision[]; predictions: Prediction[] }) {
  const { gate, last } = status;
  if (gate === null) {
    if (last === null || last.outcome === "skipped" || Date.now() - Date.parse(last.closedAt ?? "") > RECENT_MS) return null;
    return (
      <div className="catch-up done" data-gate={last.id}>
        <p>
          <strong>You're caught up.</strong> {last.outcome === "released" ? (last.note ?? "") : "Claude can carry on: send your next prompt."}
        </p>
      </div>
    );
  }
  const met = gate.subjects.filter((s) => s.met).length;
  return (
    <section className="catch-up" data-gate={gate.id} aria-labelledby="catch-up-title">
      <div className="section-head">
        <h2 id="catch-up-title">Catch up before Claude carries on</h2>
        <button className="link" onClick={() => void api.setGate({ skip: true })}>
          Skip this time
        </button>
      </div>
      <p className="muted">
        Claude reached a milestone and is paused until you show you follow the work so far. {met} of {gate.subjects.length} caught up.
      </p>
      <div className="gate-progress" role="progressbar" aria-valuemin={0} aria-valuemax={gate.subjects.length} aria-valuenow={met}>
        <span style={{ width: `${(100 * met) / Math.max(1, gate.subjects.length)}%` }} />
      </div>
      <ul className="predict-cards">
        {gate.subjects.map((s) => (
          <GateItem key={s.id} s={s} threshold={gate.threshold} decision={ledger.find((d) => d.id === s.id)} predicted={predictions.some((p) => p.decisionId === s.id)} />
        ))}
      </ul>
    </section>
  );
}

function GateItem({ s, threshold, decision, predicted }: { s: GateSubject; threshold: number; decision: Decision | undefined; predicted: boolean }) {
  const head = (named = true) => (
    <p className="muted">
      <span className={`tag${s.met ? " met" : ""}`}>{s.met ? "Caught up" : s.kind === "decision" ? "Decision" : "Component"}</span> {named && s.name}
      <span className="familiarity" title={`Familiarity ${s.familiarity.toFixed(2)} of ${threshold} needed`}>
        <span style={{ width: `${Math.min(100, (100 * s.familiarity) / threshold)}%` }} />
      </span>
    </p>
  );
  if (s.met) return <li className="quiz decision gate-item met">{head()}</li>;
  if (decision !== undefined && !predicted) {
    return (
      <li className="quiz decision gate-item" data-gate-subject={s.id}>
        {head(false)}
        <h2>{decision.title}</h2>
        <PredictPrompt d={decision} />
      </li>
    );
  }
  if (s.grading) {
    return (
      <li className="quiz decision gate-item" data-gate-subject={s.id}>
        {head()}
        <h2>{s.question}</h2>
        <p className="result muted">Claude is checking your answer…</p>
      </li>
    );
  }
  return (
    <li className="gate-item" data-gate-subject={s.id}>
      {s.answered && <p className="muted retry">Not there yet: the feedback is under Your answers. Have another go.</p>}
      {/* A fresh card after each grade, so a short answer can be tried again. */}
      <ul className="predict-cards">
        <QuizCard key={`${s.itemId}:${s.answers}`} item={{ id: s.itemId, subject: s.id, kind: "why", question: s.question, step: 0, dueAt: "" }} subject={s.name} />
      </ul>
    </li>
  );
}

/** The on/off switch, at the foot of Today. */
export function GateSwitch({ status }: { status: GateStatus }) {
  const s = status.settings;
  return (
    <div className="gate-switch">
      <h2>Catch-up gates</h2>
      <p className="muted">
        {status.enabled
          ? `On: Claude pauses after ${s.decisions} new decisions or ${s.components} touched components, until you catch up on the most important of them.`
          : "Off: Claude never waits for you to catch up."}
        {status.enabled && !status.active && " Turned off for this run by VIEWPORT_NO_GATES."}
      </p>
      <button onClick={() => void api.setGate({ enabled: !status.enabled })}>{status.enabled ? "Turn off" : "Turn on"}</button>
    </div>
  );
}
