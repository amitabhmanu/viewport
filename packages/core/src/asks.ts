import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/** A question asked of the model from the viewer: a trace or a slice, as URL-style parameters. */
export const AskQuery = z.discriminatedUnion("q", [
  z.object({
    q: z.literal("trace"),
    from: z.string().min(1),
    to: z.string().min(1).optional(),
    direction: z.enum(["downstream", "upstream"]).optional(),
  }),
  z.object({
    q: z.literal("slice"),
    externals: z.boolean().optional(),
    mode: z.enum(["sync", "async", "data"]).optional(),
    sync: z.enum(["ok", "stale", "unverified"]).optional(),
    decidedBy: z.string().min(1).optional(),
  }),
]);
export type AskQuery = z.infer<typeof AskQuery>;

export interface Pin {
  id: number;
  at: string;
  title: string;
  query: AskQuery;
}

/**
 * Records something the developer did, for the picture of what they know (Phase 4
 * reads these). Payloads are small JSON objects.
 */
export function logEvent(db: DatabaseSync, kind: string, subject: string | null, payload: object = {}, at = new Date().toISOString()): void {
  db.prepare("INSERT INTO events (at, kind, subject, payload) VALUES (?, ?, ?, ?)").run(at, kind, subject, JSON.stringify(payload));
}

/** A query in a fixed key order, so the same question pins once. */
function canonical(query: AskQuery): string {
  const parsed = AskQuery.parse(query);
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))));
}

/** Pins a query as a view to come back to. Pinning the same query again renames it. */
export function addPin(db: DatabaseSync, title: string, query: AskQuery, at = new Date().toISOString()): Pin {
  const row = db
    .prepare("INSERT INTO pins (at, title, query) VALUES (?, ?, ?) ON CONFLICT(query) DO UPDATE SET title = excluded.title RETURNING *")
    .get(at, title, canonical(query)) as { id: number; at: string; title: string; query: string };
  return { ...row, query: JSON.parse(row.query) as AskQuery };
}

export function listPins(db: DatabaseSync): Pin[] {
  const rows = db.prepare("SELECT * FROM pins ORDER BY at, id").all() as { id: number; at: string; title: string; query: string }[];
  return rows.map((r) => ({ ...r, query: JSON.parse(r.query) as AskQuery }));
}

export function removePin(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM pins WHERE id = ?").run(id);
}
