import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { type JumpItem, jumpItems, opensJump, search } from "./jump.js";
import { useLive, useLoad } from "./live.js";

/** A search box over every part and decision; picking one opens it where it is shown in full. */
export function Jump({ go }: { go: (to: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (!opensJump(e, typing)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <>
      <button className="jump-open" onClick={() => setOpen(true)} title="Jump to any part or decision (Ctrl+K)">
        Jump to… <kbd>Ctrl K</kbd>
      </button>
      {open && (
        <JumpDialog
          onClose={() => setOpen(false)}
          onPick={(href) => {
            setOpen(false);
            go(href);
          }}
        />
      )}
    </>
  );
}

function JumpDialog({ onClose, onPick }: { onClose: () => void; onPick: (href: string) => void }) {
  const live = useLive();
  const model = useLoad(api.model, [live.model]);
  const ledger = useLoad(api.ledger, [live.ledger]);
  const items = useMemo(() => (model.data ? jumpItems(model.data, ledger.data ?? []) : []), [model.data, ledger.data]);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const found = useMemo(() => search(items, query), [items, query]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setAt(0), [query]);
  const pick = (item: JumpItem | undefined) => item && onPick(item.href);
  return (
    <div className="jump-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="jump" role="dialog" aria-modal="true" aria-label="Jump to">
        <input
          ref={input}
          value={query}
          placeholder="Find a part, step, rule or decision"
          aria-label="Find"
          role="combobox"
          aria-expanded="true"
          aria-controls="jump-results"
          aria-activedescendant={found[at] ? `jump-${at}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") setAt((i) => Math.min(i + 1, found.length - 1));
            else if (e.key === "ArrowUp") setAt((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter") pick(found[at]);
            else return;
            e.preventDefault();
          }}
        />
        <ul id="jump-results" role="listbox" aria-label="Results">
          {found.map((item, i) => (
            <li
              key={`${item.kind}:${item.id}`}
              id={`jump-${i}`}
              role="option"
              aria-selected={i === at}
              className={i === at ? "here" : ""}
              onMouseEnter={() => setAt(i)}
              onClick={() => pick(item)}
            >
              <span className="jump-name">{item.name}</span>
              <span className={`kind-chip family-${item.family}`}>{item.kind}</span>
              {item.detail && <span className="jump-detail">{item.detail}</span>}
            </li>
          ))}
          {model.data && found.length === 0 && <li className="muted jump-none">Nothing matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}
