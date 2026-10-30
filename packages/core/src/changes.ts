import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "./fsutil.js";
import { readSnapshot, snapshotModel } from "./model-store.js";
import { type Decision, type Model, type ModelEdge, type ModelNode, edgeKey } from "./schema.js";

export interface Change {
  /** A node id, an edge key, or a decision id. */
  subject: string;
  what: "node" | "edge" | "decision";
  change: "added" | "removed" | "changed";
  /** A readable name: the node's name, the edge's ends, or the decision's title. */
  label: string;
  /** For node and edge changes, the nodes a reader should look at to see it. */
  nodes: string[];
}

export interface ChangesSince {
  /** The revision the developer last caught up to. */
  since: number;
  revision: number;
  changes: Change[];
}

/** The cursor that marks how far the developer has caught up. */
const CURSOR = "changes";
const SEEN = "seen:";

/** A node or edge's content without bookkeeping that changes on every verify. */
function content(item: ModelNode | ModelEdge): string {
  const { sync: _s, source: _o, ...rest } = item as Record<string, unknown>;
  delete rest.changedAt;
  delete rest.fingerprint;
  return stableStringify(rest);
}

/** What differs between two revisions, ignoring sync bookkeeping and decision nodes (the ledger covers those). */
export function diffModels(before: Model, after: Model): Change[] {
  const changes: Change[] = [];
  const name = (id: string) => after.nodes.find((n) => n.id === id)?.name ?? before.nodes.find((n) => n.id === id)?.name ?? id;
  const oldNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const newNodes = new Map(after.nodes.map((n) => [n.id, n]));
  for (const [id, n] of newNodes) {
    if (n.kind === "decision") continue;
    const old = oldNodes.get(id);
    if (old === undefined) changes.push({ subject: id, what: "node", change: "added", label: n.name, nodes: [id] });
    else if (content(old) !== content(n)) changes.push({ subject: id, what: "node", change: "changed", label: n.name, nodes: [id] });
  }
  for (const [id, n] of oldNodes) {
    if (n.kind !== "decision" && !newNodes.has(id)) changes.push({ subject: id, what: "node", change: "removed", label: n.name, nodes: [] });
  }

  const flow = (e: ModelEdge) => e.kind === "depends_on" || e.kind === "uses";
  const oldEdges = new Map(before.edges.filter(flow).map((e) => [edgeKey(e), e]));
  const newEdges = new Map(after.edges.filter(flow).map((e) => [edgeKey(e), e]));
  const live = (ids: string[]) => ids.filter((id) => newNodes.has(id));
  for (const [key, e] of newEdges) {
    const old = oldEdges.get(key);
    const label = `${name(e.from)} → ${name(e.to)}`;
    if (old === undefined) changes.push({ subject: key, what: "edge", change: "added", label, nodes: [e.from, e.to] });
    else if (content(old) !== content(e)) changes.push({ subject: key, what: "edge", change: "changed", label, nodes: [e.from, e.to] });
  }
  for (const [key, e] of oldEdges) {
    if (!newEdges.has(key)) changes.push({ subject: key, what: "edge", change: "removed", label: `${name(e.from)} → ${name(e.to)}`, nodes: live([e.from, e.to]) });
  }
  return changes.sort((a, b) => a.subject.localeCompare(b.subject));
}

interface CursorRow {
  name: string;
  revision: number;
  at: string;
}

const cursor = (db: DatabaseSync, name: string) => db.prepare("SELECT * FROM cursors WHERE name = ?").get(name) as CursorRow | undefined;
const setCursor = (db: DatabaseSync, name: string, revision: number, at: string) =>
  db.prepare("INSERT INTO cursors (name, revision, at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET revision = excluded.revision, at = excluded.at").run(name, revision, at);

/**
 * What changed in the model and ledger since the developer last caught up, minus the
 * items they have opened since. The first call starts the cursor at the current
 * revision, so a new viewer starts with nothing to catch up on. When the baseline
 * snapshot is gone (pruned, or the model arrived by git pull), the nearest older one
 * stands in, and with none at all the cursor restarts at the current revision.
 */
export async function changesSince(modelPath: string, db: DatabaseSync, model: Model, ledger: Decision[], now = new Date().toISOString()): Promise<ChangesSince> {
  await snapshotModel(modelPath, model);
  const start = cursor(db, CURSOR);
  if (start === undefined || start.revision > model.revision) {
    setCursor(db, CURSOR, model.revision, now);
    return { since: model.revision, revision: model.revision, changes: [] };
  }
  let base: Model | undefined;
  for (let r = start.revision; r >= Math.max(0, start.revision - 50) && base === undefined; r--) base = await readSnapshot(modelPath, r);
  if (base === undefined) {
    setCursor(db, CURSOR, model.revision, now);
    return { since: model.revision, revision: model.revision, changes: [] };
  }

  const seen = new Map((db.prepare("SELECT * FROM cursors WHERE name LIKE ?").all(`${SEEN}%`) as unknown as CursorRow[]).map((r) => [r.name.slice(SEEN.length), r]));
  const unseen: Change[] = [];
  for (const c of diffModels(base, model)) {
    const opened = seen.get(c.subject);
    if (opened === undefined) {
      unseen.push(c);
      continue;
    }
    // Opened since: still new only if it changed again after that.
    const then = opened.revision === model.revision ? model : await readSnapshot(modelPath, opened.revision);
    if (then === undefined || diffModels(then, model).some((d) => d.subject === c.subject)) unseen.push(c);
  }
  for (const d of ledger) {
    if (Date.parse(d.at) > Date.parse(start.at) && !seen.has(d.id)) unseen.push({ subject: d.id, what: "decision", change: "added", label: d.title, nodes: [] });
  }

  // Everything opened: catch the cursor up and forget the per-item marks.
  if (unseen.length === 0 && (start.revision !== model.revision || seen.size > 0)) {
    db.exec("BEGIN");
    setCursor(db, CURSOR, model.revision, now);
    db.prepare("DELETE FROM cursors WHERE name LIKE ?").run(`${SEEN}%`);
    db.exec("COMMIT");
    return { since: model.revision, revision: model.revision, changes: [] };
  }
  return { since: start.revision, revision: model.revision, changes: unseen };
}

/** Marks items as opened at `revision`; they drop out of the changes until they change again. */
export function markSeen(db: DatabaseSync, subjects: string[], revision: number, now = new Date().toISOString()): void {
  for (const s of subjects) setCursor(db, `${SEEN}${s}`, revision, now);
}

/** Catches the developer up on everything. */
export function markAllSeen(db: DatabaseSync, revision: number, now = new Date().toISOString()): void {
  db.exec("BEGIN");
  setCursor(db, CURSOR, revision, now);
  db.prepare("DELETE FROM cursors WHERE name LIKE ?").run(`${SEEN}%`);
  db.exec("COMMIT");
}
