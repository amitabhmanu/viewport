import { useCallback, useEffect, useState } from "react";

export interface Route {
  path: string;
  params: URLSearchParams;
}

const current = (): Route => ({ path: window.location.pathname, params: new URLSearchParams(window.location.search) });

/** Path routing over the history API; every route is served index.html by viewportd. */
export function useRoute(): [Route, (to: string) => void] {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const onPop = () => setRoute(current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string) => {
    if (to === window.location.pathname + window.location.search) return;
    window.history.pushState(null, "", to);
    setRoute(current());
  }, []);
  return [route, go];
}

/** A map URL. Unset fields are left out so the defaults apply. */
export function mapHref(view: string, opts: { level?: string; focus?: string | undefined; part?: number | undefined; edge?: string | undefined } = {}): string {
  const p = new URLSearchParams({ view });
  if (opts.level && opts.level !== "medium") p.set("level", opts.level);
  if (opts.focus) p.set("focus", opts.focus);
  if (opts.edge) p.set("edge", opts.edge);
  if (opts.part !== undefined && opts.part > 1) p.set("part", String(opts.part));
  return `/map?${p.toString()}`;
}
