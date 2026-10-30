import { readFile } from "node:fs/promises";
import { stableStringify, writeFileAtomic } from "./fsutil.js";
import { Model, NodeKind, edgeKey, emptyModel } from "./schema.js";

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
  return Model.parse(JSON.parse(text));
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

/** Validates, bumps the revision and writes atomically. Returns what was written. */
export async function writeModel(path: string, model: Model): Promise<Model> {
  const next = canonicalize(Model.parse({ ...model, revision: model.revision + 1 }));
  await writeFileAtomic(path, stableStringify(next));
  return next;
}
