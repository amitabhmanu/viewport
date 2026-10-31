import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseFile, stableStringify, writeFileAtomic } from "./fsutil.js";
import { MODEL_VERSION, Model, NodeKind, edgeKey, emptyModel } from "./schema.js";

const KIND_ORDER = NodeKind.options;

/** Reads and validates model.json. A missing file is an empty model. */
export async function readModel(path: string): Promise<Model> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyModel();
    throw err;
  }
  return parseFile(Model, text, path);
}

/** Puts nodes and edges in a fixed order so that git diffs show only real changes. */
export function canonicalize(model: Model): Model {
  const nodes = [...model.nodes].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id),
  );
  const edges = [...model.edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  return { ...model, nodes, edges };
}

export function serializeModel(model: Model): string {
  return stableStringify(canonicalize(Model.parse(model)));
}

/** Validates, bumps the revision and writes atomically, keeping a local snapshot. Returns what was written. */
export async function writeModel(path: string, model: Model): Promise<Model> {
  const next = canonicalize(Model.parse({ ...model, version: MODEL_VERSION, revision: model.revision + 1 }));
  await writeFileAtomic(path, stableStringify(next));
  await snapshotModel(path, next);
  return next;
}

/** How many past revisions to keep in `.viewport/local/revisions/`. */
export const SNAPSHOTS_KEPT = 200;

/** Where the snapshot of a revision lives, beside the model at `modelPath`. */
export function snapshotPath(modelPath: string, revision: number): string {
  return join(dirname(modelPath), "local", "revisions", `${revision}.json`);
}

/**
 * Keeps a copy of each revision so the viewer can show what changed since someone
 * last looked. Best effort: a failed snapshot never fails the write.
 */
export async function snapshotModel(modelPath: string, model: Model): Promise<void> {
  try {
    await writeFileAtomic(snapshotPath(modelPath, model.revision), stableStringify(model));
    await rm(snapshotPath(modelPath, model.revision - SNAPSHOTS_KEPT), { force: true });
  } catch {
    // Local history is a convenience; the committed model is the record.
  }
}

/** A past revision, if its snapshot was kept. */
export async function readSnapshot(modelPath: string, revision: number): Promise<Model | undefined> {
  try {
    return Model.parse(JSON.parse(await readFile(snapshotPath(modelPath, revision), "utf8")));
  } catch {
    return undefined;
  }
}
