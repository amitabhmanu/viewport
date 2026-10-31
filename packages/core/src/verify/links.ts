import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { ModelGraph } from "../query/graph.js";
import { type Model, type ModelEdge, edgeKey } from "../schema.js";
import type { ImportResolver } from "./dependencies.js";
import type { FileImports } from "./import-cache.js";

export interface LinkReport {
  /** Keys of `covers`, `owns`, `reads` and `writes` edges the code does not back. */
  unsupported: string[];
  /** Test nodes whose globs match no file. */
  emptyTests: string[];
}

/**
 * True for the requirement and data edges a full verification checks: every `covers`
 * edge, and `owns`, `reads` or `writes` from a component or container to an entity
 * that names itself in the code.
 */
export function isCheckedLink(graph: ModelGraph, e: ModelEdge): boolean {
  if (e.kind === "covers") return true;
  if (e.kind !== "owns" && e.kind !== "reads" && e.kind !== "writes") return false;
  const from = graph.nodes.get(e.from)?.kind;
  const to = graph.nodes.get(e.to);
  return (from === "component" || from === "container") && to?.kind === "entity" && to.code.length > 0;
}

/** Files each test node's globs match, as sorted repo-relative paths. */
export async function testFiles(root: string, model: Model): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const n of model.nodes) {
    if (n.kind !== "test") continue;
    out.set(n.id, (await glob(n.paths, { cwd: root, ignore: ["**/node_modules/**"], onlyFiles: true })).sort());
  }
  return out;
}

/**
 * Checks requirement and data links against the code (D-009). A `covers` edge is
 * backed when one of the test's files imports a component that implements what it
 * covers: the step, the process or any of its steps, or what a rule constrains. A
 * data edge is backed when a file of the component (or of the container's
 * components) names the entity by one of its `code` names, as a whole word.
 */
export async function checkLinks(
  root: string,
  model: Model,
  owner: Map<string, string>,
  tests: Map<string, string[]>,
  testImports: Map<string, FileImports>,
  resolve: ImportResolver,
): Promise<LinkReport> {
  const graph = new ModelGraph(model);
  const unsupported: string[] = [];

  const imported = new Map<string, Set<string>>();
  for (const [test, files] of tests) {
    const comps = new Set<string>();
    for (const file of files) {
      const found = testImports.get(file);
      if (!found) continue;
      for (let i = 0; i < found.imports.length; i++) {
        for (const target of resolve(file, found, i)) {
          const c = owner.get(target);
          if (c) comps.add(c);
        }
      }
    }
    imported.set(test, comps);
  }

  const filesOf = new Map<string, string[]>();
  for (const [file, c] of owner) filesOf.set(c, [...(filesOf.get(c) ?? []), file]);
  const texts = new Map<string, string>();
  const text = async (file: string) => {
    let t = texts.get(file);
    if (t === undefined) {
      t = await readFile(join(root, file), "utf8");
      texts.set(file, t);
    }
    return t;
  };

  for (const e of model.edges) {
    if (!isCheckedLink(graph, e)) continue;
    if (e.kind === "covers") {
      const reached = imported.get(e.from) ?? new Set();
      if (!implementers(graph, e.to).some((c) => reached.has(c))) unsupported.push(edgeKey(e));
      continue;
    }
    const entity = graph.node(e.to);
    const names = entity.kind === "entity" ? entity.code : [];
    const word = new RegExp(`\\b(${names.map(escapeRegExp).join("|")})\\b`);
    const comps = graph.node(e.from).kind === "container" ? graph.children(e.from) : [e.from];
    let found = false;
    for (const file of comps.flatMap((c) => filesOf.get(c) ?? [])) {
      if (word.test(await text(file))) {
        found = true;
        break;
      }
    }
    if (!found) unsupported.push(edgeKey(e));
  }

  const emptyTests = [...tests].filter(([, files]) => files.length === 0).map(([id]) => id);
  return { unsupported: unsupported.sort(), emptyTests: emptyTests.sort() };
}

/** Components that implement a step, a process (or one of its steps), or what a rule constrains. */
function implementers(graph: ModelGraph, id: string): string[] {
  const node = graph.nodes.get(id);
  if (node === undefined) return [];
  const direct = graph.incoming(id, "implements").map((e) => e.from);
  if (node.kind === "process") return [...direct, ...graph.children(id).flatMap((s) => implementers(graph, s))];
  if (node.kind === "rule") {
    return graph.incoming(id, "constrained_by").flatMap((e) => {
      const from = graph.nodes.get(e.from);
      if (from?.kind !== "entity") return implementers(graph, e.from);
      return (["owns", "writes"] as const).flatMap((k) => graph.incoming(e.from, k)).map((x) => x.from);
    });
  }
  return direct;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
