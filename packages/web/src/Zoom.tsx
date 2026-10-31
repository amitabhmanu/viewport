import { type PointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const ZOOM = { min: 0.25, max: 2, fitMin: 0.6, fitMax: 1.25, step: 1.25 } as const;

/**
 * The scale that shows a whole drawing in a frame: as large as fits, but no larger
 * than `fitMax`, so a small view fills the screen without its text turning huge, and
 * no smaller than `fitMin`, so a big view stays readable and scrolls instead.
 */
export function fitScale(content: { width: number; height: number }, frame: { width: number; height: number }): number {
  if (content.width <= 0 || content.height <= 0 || frame.width <= 0 || frame.height <= 0) return 1;
  const s = Math.max(ZOOM.fitMin, Math.min(frame.width / content.width, frame.height / content.height, ZOOM.fitMax));
  return clampScale(s);
}

export function clampScale(s: number): number {
  return Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(s * 100) / 100));
}

/**
 * A scrollable frame around a drawing that opens fitted to the screen, zooms with
 * the buttons, Ctrl or Cmd with the wheel, or + - 0 keys, and pans by dragging the
 * background. A new `fitKey` (another view or part) fits again.
 */
export function Zoom({ width, height, fitKey, children }: { width: number; height: number; fitKey: string; children: (scale: number) => ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [manual, setManual] = useState<number>();
  const [fitted, setFitted] = useState(1);
  const scale = manual ?? fitted;

  useEffect(() => setManual(undefined), [fitKey]);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setFitted(fitScale({ width, height }, { width: el.clientWidth - 2, height: el.clientHeight - 2 }));
    measure();
    // Refit when the window changes, not the frame: opening the side panel narrows the
    // frame, and refitting then would move the box under the pointer between two clicks.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [width, height, fitKey]);

  /** Zooms about a point in the frame (the pointer, or the middle), keeping that point still. */
  const zoomTo = useCallback(
    (next: number, at?: { x: number; y: number }) => {
      const el = frame.current;
      const s = clampScale(next);
      if (!el || s === scale) return setManual(s);
      const px = at?.x ?? el.clientWidth / 2;
      const py = at?.y ?? el.clientHeight / 2;
      const cx = (el.scrollLeft + px) / scale;
      const cy = (el.scrollTop + py) / scale;
      setManual(s);
      requestAnimationFrame(() => {
        el.scrollLeft = cx * s - px;
        el.scrollTop = cy * s - py;
      });
    },
    [scale],
  );

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      zoomTo(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - box.left, y: e.clientY - box.top });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [scale, zoomTo]);

  // Dragging the background pans; a press on a box or an arrow stays a click.
  const drag = useRef<{ x: number; y: number; left: number; top: number; id: number } | undefined>(undefined);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("[data-node], .edge-hit, button")) return;
    const el = frame.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, id: e.pointerId };
    el.setPointerCapture(e.pointerId);
    el.classList.add("panning");
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    frame.current!.scrollLeft = d.left - (e.clientX - d.x);
    frame.current!.scrollTop = d.top - (e.clientY - d.y);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = undefined;
    frame.current!.classList.remove("panning");
  };

  return (
    <div className="zoom">
      <div className="zoom-tools" role="toolbar" aria-label="Zoom">
        <button aria-label="Zoom out" title="Zoom out (-)" onClick={() => zoomTo(scale / ZOOM.step)} disabled={scale <= ZOOM.min}>
          −
        </button>
        <button className="zoom-level" title="Actual size" onClick={() => zoomTo(1)}>
          {Math.round(scale * 100)}%
        </button>
        <button aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomTo(scale * ZOOM.step)} disabled={scale >= ZOOM.max}>
          +
        </button>
        <button title="Show the whole view (0)" aria-pressed={manual === undefined} onClick={() => setManual(undefined)}>
          Fit
        </button>
      </div>
      <div
        ref={frame}
        className="zoom-frame"
        tabIndex={-1}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={(e) => {
          if ((e.target as Element).closest("[data-node], .edge-hit, input, textarea")) return;
          if (e.key === "+" || e.key === "=") zoomTo(scale * ZOOM.step);
          else if (e.key === "-") zoomTo(scale / ZOOM.step);
          else if (e.key === "0") setManual(undefined);
          else return;
          e.preventDefault();
        }}
      >
        {children(scale)}
      </div>
    </div>
  );
}
