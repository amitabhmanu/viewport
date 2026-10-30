import { createContext, useContext, useEffect, useState } from "react";
import { ApiError } from "./api.js";

/** Bumped on every change event from the daemon, so pages refetch what they show. */
export const LiveContext = createContext({ model: 0, ledger: 0, state: 0 });

/** Loads `fetcher` and reloads whenever one of `deps` changes. */
export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | undefined } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    fetcher().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(undefined);
      },
      (err: unknown) => live && setError(describe(err)),
    );
    return () => {
      live = false;
    };
  }, deps);
  return { data, error };
}

export const useLive = () => useContext(LiveContext);

function describe(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) return "This link has expired. Run /viewport:open in Claude Code for a fresh one.";
  return err instanceof Error ? err.message : String(err);
}
