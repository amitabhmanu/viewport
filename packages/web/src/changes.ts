import type { Change } from "@viewport/core";
import { useMemo } from "react";
import { api } from "./api.js";
import { useLive, useLoad } from "./live.js";

/** What changed since the reader last looked, refreshed on every change event. */
export function useChanges() {
  const live = useLive();
  const { data } = useLoad(api.changes, [live.model, live.ledger, live.state]);
  return useMemo(() => {
    const changes: Change[] = data?.changes ?? [];
    return { changes, bySubject: new Map(changes.map((c) => [c.subject, c])), since: data?.since, revision: data?.revision };
  }, [data]);
}

/** Marks items opened. The daemon's state event then refreshes every page. */
export function markSeen(subjects: string[]): void {
  if (subjects.length > 0) void api.seen(subjects).catch(() => undefined);
}
