import type { GradedAnswer, QuizItem, QuizResult } from "@viewport/core";
import { useState } from "react";
import { api } from "./api.js";

const SURE = ["Guessing", "Unsure", "Fairly sure", "Sure", "Certain"];

/** One question: say how sure you are first, then answer. Predict items are graded on the spot. */
export function QuizCard({ item, subject }: { item: QuizItem; subject: string }) {
  const [confidence, setConfidence] = useState<number>();
  const [text, setText] = useState("");
  const [result, setResult] = useState<QuizResult>();
  const [answer, setAnswer] = useState("");
  const submit = (value: string) => {
    if (confidence === undefined || value.trim() === "") return;
    setAnswer(value);
    void api.answer(item.id, value, confidence).then(setResult);
  };

  return (
    <li className="quiz decision" data-quiz={item.id}>
      <p className="muted">
        {item.kind === "what-if" ? "What if" : item.kind === "predict" ? "Predict" : "Why"} · {subject}
      </p>
      <h2>{item.question}</h2>
      {result ? (
        <QuizOutcome result={result} answer={answer} />
      ) : (
        <>
          <div className="confidence" role="radiogroup" aria-label="How sure are you?">
            <span className="muted">How sure are you?</span>
            {SURE.map((label, i) => (
              <button key={label} type="button" role="radio" aria-checked={confidence === i + 1} onClick={() => setConfidence(i + 1)}>
                {label}
              </button>
            ))}
          </div>
          {item.choices ? (
            <ul className="choices">
              {item.choices.map((c) => (
                <li key={c}>
                  <button disabled={confidence === undefined} onClick={() => submit(c)}>
                    <strong>{c}</strong>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <form
              className="answer-form"
              onSubmit={(e) => {
                e.preventDefault();
                submit(text);
              }}
            >
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Your answer, in a sentence or two" aria-label="Your answer" />
              <button type="submit" disabled={confidence === undefined || text.trim() === ""}>
                Answer
              </button>
            </form>
          )}
        </>
      )}
    </li>
  );
}

function QuizOutcome({ result, answer }: { result: QuizResult; answer: string }) {
  const days = Math.round((Date.parse(result.nextDue) - Date.now()) / (24 * 60 * 60 * 1000));
  const back = days > 365 ? "You won't see this one again." : `It comes back in ${days} day${days === 1 ? "" : "s"}.`;
  if (result.grade === "correct") return <p className="result right">Right. {back}</p>;
  if (result.grade === "wrong") {
    return (
      <p className="result wrong">
        You said {answer}; the answer is {result.expected}. {back}
      </p>
    );
  }
  return <p className="result muted">Saved. Claude is checking it; the result shows under Your answers.</p>;
}

const GRADE_LABEL = { correct: "Right", partial: "Partly right", wrong: "Not quite" } as const;

/** Written answers from the last week: checking, then the grade, Claude's feedback and a good answer. */
export function AnswerList({ answers, subjectName }: { answers: GradedAnswer[]; subjectName: (id: string) => string }) {
  if (answers.length === 0) return null;
  return (
    <>
      <h2>Your answers</h2>
      <ul className="flags flag-list answers">
        {answers.map((a) => (
          <li key={a.answerId} className={`answer ${a.grade ?? "pending"}`} data-answer={a.answerId}>
            <p className="q">
              <span className="muted">{subjectName(a.subject)}</span> {a.question}
            </p>
            <p className="yours">
              <span className="muted">You said:</span> {a.answer}
            </p>
            {a.grade ? (
              <>
                <p className="a">
                  <span className={`tag grade ${a.grade}`}>{GRADE_LABEL[a.grade]}</span> {a.feedback}
                </p>
                {a.grade !== "correct" && a.expected && (
                  <p className="expected">
                    <span className="muted">A good answer:</span> {a.expected}
                  </p>
                )}
              </>
            ) : (
              <p className="muted">Claude is checking this answer…</p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
