import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type Model,
  VIEWPORT_DIR,
  applyReport,
  coverage,
  listSources,
  openState,
  readConfig,
  readLedger,
  readModel,
  uncommittedFiles,
  unresolvedFlags,
  verify,
  viewportPaths,
  writeModel,
  writeModelFromAgent,
} from "@viewport/core";

/** The fields of Claude Code's hook input that these hooks read. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
  stop_hook_active?: boolean;
  agent_type?: string;
}

/** What a hook prints: Claude Code's JSON output, or nothing. */
export type HookOutput = Record<string, unknown> | undefined;

/** The nearest directory at or above the session's cwd that holds `.viewport/`. */
export function findWorkspace(input: HookInput, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const start = resolve(input.cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd());
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, VIEWPORT_DIR, "config.json"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

function context(event: string, text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function list(items: string[], limit = 5): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
}

/** The rule every session starts with. Kept short: it is paid for in every session's context. */
export const DECISION_RULE =
  "When you choose between real alternatives that shape the system (where a new capability lives, a dependency between components, a data store, a protocol, a library that is hard to swap), log it with the viewport ledger_append tool when you make it (the viewport-decisions skill says how), and keep the model current with model_upsert. Do not stop to ask; keep building.";

export async function sessionStart(root: string): Promise<HookOutput> {
  const paths = viewportPaths(root);
  const model = await readModel(paths.model);
  const ledger = await readLedger(paths.ledger);
  const state = openState(paths.stateDb);
  const flags = unresolvedFlags(state);
  state.close();

  const lines = ["Viewport keeps a model of this system in .viewport/ for the developer, who reads it in the viewer."];
  lines.push(overview(model));
  const stale = model.nodes.filter((n) => n.kind === "component" && n.sync === "stale").map((n) => n.id);
  if (stale.length > 0) lines.push(`Out of sync with the code: ${list(stale)}. Update them with model_upsert when you touch them.`);
  lines.push(`Ledger: ${ledger.length} decision${ledger.length === 1 ? "" : "s"}${ledger.length > 0 ? `, latest ${ledger.at(-1)!.id}` : ""}. Read with ledger_get.`);
  if (flags.length > 0) lines.push(`The developer has ${flags.length} unanswered question${flags.length === 1 ? "" : "s"}: see flags_pending and answer with flags_resolve.`);
  lines.push(DECISION_RULE);
  return context("SessionStart", lines.join("\n"));
}

function overview(model: Model): string {
  const system = model.nodes.find((n) => n.kind === "system");
  if (model.nodes.length === 0) return "The model is empty; run /viewport:init to build it.";
  const containers = model.nodes.filter((n) => n.kind === "container");
  const parts = containers.map((c) => {
    const count = model.edges.filter((e) => e.kind === "contains" && e.from === c.id).length;
    return `${c.id} (${count} component${count === 1 ? "" : "s"})`;
  });
  const head = system && system.kind === "system" ? `${system.name}: ${system.purpose}.` : "System:";
  return `${head} Containers: ${parts.join(", ") || "none"}. Query with model_view, model_get and model_trace.`;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const FLAGS_PER_EDIT = 3;

function repoPath(root: string, file: string): string | undefined {
  const rel = relative(root, isAbsolute(file) ? file : join(root, file));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/**
 * After each edit: record it, check the edited file against the model, and pass on
 * up to three of the developer's flags. Says nothing when there is nothing to act on,
 * so a normal edit costs no context.
 */
export async function postToolUse(root: string, input: HookInput): Promise<HookOutput> {
  if (!EDIT_TOOLS.has(input.tool_name ?? "") || input.tool_input?.file_path === undefined) return undefined;
  const file = repoPath(root, input.tool_input.file_path);
  if (file === undefined || file.startsWith(`${VIEWPORT_DIR}/`)) return undefined;

  const paths = viewportPaths(root);
  const state = openState(paths.stateDb);
  try {
    const notes: string[] = [];
    const config = await readConfig(paths.config);
    const model = await readModel(paths.model);
    if (model.nodes.some((n) => n.kind === "component")) {
      const report = await verify(root, model, config, { changedFiles: [file] });
      if (report.unclaimed.length > 0) {
        notes.push(`${file} belongs to no component in the Viewport model. Add it to a component's paths, or add a component, with model_upsert.`);
      }
    }
    const flags = deliverFlags(state);
    for (const f of flags) notes.push(`The developer flagged ${f.subject} (flag ${f.id}): "${f.text}". Answer with flags_resolve when you reach a good point.`);
    return notes.length > 0 ? context("PostToolUse", notes.join("\n")) : undefined;
  } finally {
    recordEdit(state, file, input);
    state.close();
  }
}

/** Records the edit last, with the time since the process started, so evaluation can track hook cost. */
function recordEdit(state: DatabaseSync, file: string, input: HookInput): void {
  const payload = { session: input.session_id ?? null, tool: input.tool_name, ms: Math.round(performance.now()) };
  state.prepare("INSERT INTO events (at, kind, subject, payload) VALUES (?, 'edit', ?, ?)").run(new Date().toISOString(), file, JSON.stringify(payload));
}

/** Hands pending flags to Claude, oldest first, and marks them delivered so each is passed on once. */
function deliverFlags(state: DatabaseSync) {
  const flags = unresolvedFlags(state)
    .filter((f) => f.status === "pending")
    .slice(0, FLAGS_PER_EDIT);
  const mark = state.prepare("UPDATE flags SET status = 'delivered' WHERE id = ?");
  for (const f of flags) mark.run(f.id);
  return flags;
}

function editedThisSession(state: DatabaseSync, session: string | undefined): Set<string> {
  if (session === undefined) return new Set();
  const rows = state
    .prepare("SELECT DISTINCT subject FROM events WHERE kind = 'edit' AND json_extract(payload, '$.session') = ?")
    .all(session) as { subject: string }[];
  return new Set(rows.map((r) => r.subject));
}

/**
 * Before Claude finishes: if this session's work left the model behind the code,
 * block once and say what to update. Work means files edited through Claude's edit
 * tools plus anything git shows as changed, so shell edits count too. Findings in
 * other files are left for /viewport:status, so an old gap does not hold up every
 * session. A component whose code changed without new files or dependencies is
 * marked reviewed here rather than costing Claude another round trip.
 */
export async function stop(root: string, input: HookInput): Promise<HookOutput> {
  if (input.stop_hook_active) return undefined;
  const paths = viewportPaths(root);
  const state = openState(paths.stateDb);
  const edited = editedThisSession(state, input.session_id);
  state.close();
  for (const f of await uncommittedFiles(root)) if (!f.startsWith(`${VIEWPORT_DIR}/`)) edited.add(f);
  if (edited.size === 0) return undefined;

  const config = await readConfig(paths.config);
  const model = await readModel(paths.model);
  if (!model.nodes.some((n) => n.kind === "component")) return undefined;
  const report = await verify(root, model, config);
  const owner = coverage(await listSources(root, config), model).owner;
  const touched = new Set([...edited].map((f) => owner.get(f)).filter((c): c is string => c !== undefined));

  const unclaimed = report.unclaimed.filter((f) => edited.has(f));
  const missing = report.missingDependencies.filter((d) => d.evidence.some((e) => edited.has(e.file)));
  const unsupported = report.unsupportedEdges.filter((key) => [...touched].some((c) => key.startsWith(`depends_on:${c}->`)));
  if (unclaimed.length === 0 && missing.length === 0 && unsupported.length === 0) {
    const reviewed = report.staleComponents.filter((c) => touched.has(c));
    if (reviewed.length > 0) await writeModelFromAgent(root, model, reviewed);
    return undefined;
  }

  const lines = ["Before you finish, bring the Viewport model up to date with what you just built:"];
  if (unclaimed.length > 0) lines.push(`- Files no component owns: ${list(unclaimed)}. Extend a component's paths or add a component.`);
  if (missing.length > 0) {
    lines.push(`- New dependencies the model lacks: ${list(missing.map((d) => `${d.from} -> ${d.to}`))}. Add depends_on edges with the right mode.`);
  }
  if (unsupported.length > 0) lines.push(`- Dependencies no import backs any more: ${list(unsupported)}. Remove them, or set mode to data if they are real.`);
  lines.push(
    "Use model_upsert (and model_remove for edges that are gone). List components whose code changed but whose role still fits in reviewed. If where a new capability lives, or a new dependency, was a real choice, log it with ledger_append too.",
  );
  return { decision: "block", reason: lines.join("\n") };
}

/** After the modeler finishes: verify the whole model and save its sync states as a new revision. */
export async function subagentStop(root: string, input: HookInput): Promise<HookOutput> {
  if (!(input.agent_type ?? "").endsWith("viewport-modeler")) return undefined;
  const paths = viewportPaths(root);
  const config = await readConfig(paths.config);
  const model = await readModel(paths.model);
  const report = await verify(root, model, config);
  await writeModel(paths.model, applyReport(model, report));
  return undefined;
}
