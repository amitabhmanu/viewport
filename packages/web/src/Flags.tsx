import type { Flag } from "@viewport/core";
import { useMemo, useState } from "react";
import { api } from "./api.js";
import { useLive, useLoad } from "./live.js";

/** Every flag, grouped by what it was raised on, refreshed as Claude answers. */
export function useFlags(): Map<string, Flag[]> {
  const live = useLive();
  const { data } = useLoad(api.allFlags, [live.state]);
  return useMemo(() => {
    const by = new Map<string, Flag[]>();
    for (const f of data ?? []) by.set(f.subject, [...(by.get(f.subject) ?? []), f]);
    return by;
  }, [data]);
}

export const FLAG_STATUS: Record<Flag["status"], string> = { pending: "Waiting for Claude", delivered: "Claude has it", resolved: "Answered" };

/** The questions raised on one element with Claude's answers, and a one-line box to ask another. */
export function FlagBox({ subject, flags, placeholder, collapsed = false }: { subject: string; flags: Flag[]; placeholder: string; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  const [text, setText] = useState("");
  return (
    <div className="flagbox">
      {flags.length > 0 && (
        <ul className="flag-list">
          {flags.map((f) => (
            <FlagItem key={f.id} f={f} />
          ))}
        </ul>
      )}
      {open ? (
        <form
          className="flag-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() === "") return;
            void api.flag(subject, text.trim()).then(() => setText(""));
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="Question for Claude" maxLength={300} />
          <button type="submit">Flag</button>
        </form>
      ) : (
        <button className="link" onClick={() => setOpen(true)}>
          Flag a question
        </button>
      )}
    </div>
  );
}

export function FlagItem({ f }: { f: Flag }) {
  return (
    <li className={`flag ${f.status}`}>
      <p className="q">
        {f.text} <span className="tag">{FLAG_STATUS[f.status]}</span>
      </p>
      {f.answer && (
        <p className="a">
          {f.answer}
          {f.decisionId && (
            <>
              {" "}
              <a href={`/ledger#${f.decisionId}`}>See {f.decisionId}</a>
            </>
          )}
        </p>
      )}
    </li>
  );
}
