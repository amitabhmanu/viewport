import type { Decision, Prediction } from "@viewport/core";
import { api } from "./api.js";
import { markSeen } from "./changes.js";
import { shuffledOptions } from "./labels.js";

/** Guess first, then see what was chosen and why. Answering also marks the decision seen. */
export function PredictPrompt({ d }: { d: Decision }) {
  const answer = (guess?: string) => {
    markSeen([d.id]);
    void api.predict(d.id, guess);
  };
  return (
    <div className="predict">
      <p className="ask-line">Which would you have chosen?</p>
      <ul className="choices">
        {shuffledOptions(d).map((o) => (
          <li key={o.name}>
            <button onClick={() => answer(o.name)}>
              <strong>{o.name}</strong>
              <span className="muted">{o.tradeoff}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="link" onClick={() => answer()}>
        Skip and reveal
      </button>
    </div>
  );
}

/** How the guess went, shown once the choice is revealed. */
export function PredictionResult({ p, chosen }: { p: Prediction; chosen: string }) {
  if (p.skipped) return <p className="result muted">You skipped this one.</p>;
  return p.correct ? (
    <p className="result right">You also picked {chosen}.</p>
  ) : (
    <p className="result wrong">
      You picked {p.guess}; Claude chose {chosen}.
    </p>
  );
}
