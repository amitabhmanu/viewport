import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  EXPLAIN_BATCH,
  type Model,
  VIEWPORT_DIR,
  applyReport,
  GATE_GRACE_EDITS,
  type Gate,
  checkMilestone,
  currentGate,
  editsSinceGate,
  gateProgress,
  gatesOff,
  hasOpenGate,
  coverage,
  dailyDigest,
  digestLine,
  enqueueJob,
  jobHealth,
  type JobHealth,
  explainDue,
  familiarityScores,
  listSources,
  logEvent,
  openState,
  readConfig,
  readLedger,
  readModel,
  takeDigestTurn,
  uncommittedFiles,
  unresolvedFlags,
  verify,
  viewportPaths,
  writeModel,
  writeModelFromAgent,
} from "@viewport/core";
import { isCurrent, isHealthy, readLock, spawnDaemon, stopDaemon, viewerUrl } from "@viewport/viewportd";

/** The fields of Claude Code's hook input that these hooks read. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
  stop_hook_active?: boolean;
  agent_type?: string;
  /** UserPromptSubmit: what the developer typed. */
  prompt?: string;
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

/**
 * Starts the repo's viewer daemon in the background if it is not running. Never
 * waits for it, so a session starts at the same speed either way. Off when
 * VIEWPORT_NO_DAEMON is set (tests and evaluation runs).
 */
export async function startViewer(root: string, script: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.VIEWPORT_NO_DAEMON || !existsSync(script)) return;
  const lock = await readLock(root);
  if (lock !== undefined && (await isHealthy(lock))) {
    if (isCurrent(lock, script)) return;
    // Rebuilt since the daemon started: an old daemon can't read a newer model.
    await stopDaemon(root);
  }
  spawnDaemon(root, script);
}

export async function sessionStart(root: string): Promise<HookOutput> {
  const paths = viewportPaths(root);
  const model = await readModel(paths.model);
  const ledger = await readLedger(paths.ledger);
  const state = openState(paths.stateDb);
  const flags = unresolvedFlags(state);
  // For the developer's eyes, not Claude's context, so it costs no tokens (D-016).
  const digest = digestLine(dailyDigest(state, model, ledger, familiarityScores(state)));
  const showDigest = digest !== undefined && takeDigestTurn(state);
  const jobs = jobProblem(jobHealth(state));
  const gateOpen = hasOpenGate(state);
  state.close();

  const lines = ["Viewport keeps a model of this system in .viewport/ for the developer, who reads it in the viewer."];
  lines.push(overview(model));
  const stale = model.nodes.filter((n) => n.kind === "component" && n.sync === "stale").map((n) => n.id);
  if (stale.length > 0) lines.push(`Out of sync with the code: ${list(stale)}. Update them with model_upsert when you touch them.`);
  lines.push(`Ledger: ${ledger.length} decision${ledger.length === 1 ? "" : "s"}${ledger.length > 0 ? `, latest ${ledger.at(-1)!.id}` : ""}. Read with ledger_get.`);
  if (flags.length > 0) lines.push(`The developer has ${flags.length} unanswered question${flags.length === 1 ? "" : "s"}: see flags_pending and answer with flags_resolve.`);
  lines.push(DECISION_RULE);
  // Also for the developer only: Claude can't fix the developer's environment.
  const gate = gateOpen ? "Viewport: a catch-up gate is open. Claude carries on once you catch up in the viewer's Today tab (/viewport:open), or run /viewport:gates skip." : undefined;
  const message = [gate, jobs, showDigest ? digest : undefined].filter((m) => m !== undefined).join("\n");
  return { ...context("SessionStart", lines.join("\n")), ...(message !== "" ? { systemMessage: message } : {}) };
}

/** One line for the developer when background jobs keep failing, or undefined when they work. */
export function jobProblem(health: JobHealth): string | undefined {
  if (health.failedInARow === 0) return undefined;
  const n = health.failedInARow;
  const what = `Viewport: the last ${n} background job${n === 1 ? "" : "s"} failed, so no new explanations or quiz questions are being written.`;
  return [what, health.hint ?? `Last error: ${(health.lastError ?? "unknown").slice(0, 200)}`].join(" ");
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
    for (const f of flags) notes.push(`The developer flagged ${f.subject} (flag ${f.id}): "${f.text}". The developer is waiting: answer it with flags_resolve before your next edit.`);
    if (!gatesOff(config.gates)) {
      const ledger = await readLedger(paths.ledger);
      const gate = checkMilestone(state, model, ledger, config.gates, input.session_id);
      if (gate !== undefined) notes.push(milestoneNote(gate));
    }
    return notes.length > 0 ? context("PostToolUse", notes.join("\n")) : undefined;
  } finally {
    recordEdit(state, file, input);
    state.close();
  }
}

/** Records the edit last, with the time since the process started, so evaluation can track hook cost. */
function recordEdit(state: DatabaseSync, file: string, input: HookInput): void {
  const payload = { session: input.session_id ?? null, tool: input.tool_name, ms: Math.round(performance.now()) };
  logEvent(state, "edit", file, payload);
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
 * Before Claude finishes: if this session's work left the model behind the code, or
 * the developer has flagged something Claude has not answered, block once and say
 * what to do. Work means files edited through Claude's edit tools plus anything git
 * shows as changed, so shell edits count too. Findings in other files are left for
 * /viewport:status, so an old gap does not hold up every session. A component whose
 * code changed without new files or dependencies is marked reviewed here rather than
 * costing Claude another round trip.
 */
export async function stop(root: string, input: HookInput): Promise<HookOutput> {
  if (input.stop_hook_active) return undefined;
  const paths = viewportPaths(root);
  const state = openState(paths.stateDb);
  const edited = editedThisSession(state, input.session_id);
  const flags = flagsToAnswer(state);
  state.close();
  for (const f of await uncommittedFiles(root)) if (!f.startsWith(`${VIEWPORT_DIR}/`)) edited.add(f);

  const lines = await modelGaps(root, edited);
  if (flags.length > 0) {
    lines.push(
      `The developer is waiting on ${flags.length === 1 ? "an answer" : "answers"}: ${flags.map((f) => `flag ${f.id} on ${f.subject}: "${f.text}"`).join("; ")}. Answer each with flags_resolve (log a new decision first if it changes your plan).`,
    );
  }
  if (lines.length > 0) return { decision: "block", reason: lines.join("\n") };
  await queueExplanations(root);
  const gate = await gateAtStop(root, input);
  return gate !== undefined ? { systemMessage: await gateNotice(root, gate) } : undefined;
}

/** At the end of a turn with the model in step: the gate a milestone opens now, or one still open. */
async function gateAtStop(root: string, input: HookInput): Promise<Gate | undefined> {
  const paths = viewportPaths(root);
  const config = await readConfig(paths.config);
  if (gatesOff(config.gates)) return undefined;
  const [model, ledger] = await Promise.all([readModel(paths.model), readLedger(paths.ledger)]);
  const state = openState(paths.stateDb);
  try {
    const open = currentGate(state, model, ledger, config.gates);
    if (open !== undefined && open.closedAt === undefined) return open;
    return checkMilestone(state, model, ledger, config.gates, input.session_id);
  } finally {
    state.close();
  }
}

function subjectList(gate: Gate): string {
  return gate.subjects
    .filter((s) => !s.met)
    .map((s) => `${s.id} (${s.name})`)
    .join("; ");
}

/** What Claude is told when a milestone is reached mid-turn. */
function milestoneNote(gate: Gate): string {
  return [
    `Viewport catch-up gate: this is a milestone, and the developer has switched on gates so they keep up with the work. They will catch up on ${subjectList(gate)} before you carry on.`,
    `Finish only what keeps the code working (at most ${GATE_GRACE_EDITS} more edits), bring the model up to date, then end your turn with a short summary of what you built and why, and tell the developer to catch up in the viewer's Today tab. Do not start new work, and do not edit files through the shell to get round the pause.`,
  ].join(" ");
}

/** What the developer sees when Claude is paused: what to catch up on, where, and how to opt out. */
async function gateNotice(root: string, gate: Gate): Promise<string> {
  const lock = await readLock(root).catch(() => undefined);
  const where = lock !== undefined ? `the viewer's Today tab: ${viewerUrl(lock)}` : "the viewer's Today tab (/viewport:open)";
  return [
    `Viewport: Claude is paused at a milestone until you catch up on the work so far (${gateProgress(gate)}).`,
    `Answer the catch-up questions in ${where}`,
    ...gate.subjects.filter((s) => !s.met).map((s) => `  - ${s.id} ${s.name}${s.grading ? " (grading your answer)" : ""}`),
    "Skip this one with /viewport:gates skip, or switch gates off with /viewport:gates off.",
  ].join("\n");
}

function deny(reason: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/**
 * Before each edit: while a catch-up gate is open, refuse edits to the code, after a
 * few that let Claude finish what it had in hand when the gate opened. Edits to
 * .viewport/ always go through, so Claude can still bring the model up to date.
 */
export async function preToolUse(root: string, input: HookInput): Promise<HookOutput> {
  if (!EDIT_TOOLS.has(input.tool_name ?? "") || input.tool_input?.file_path === undefined) return undefined;
  const file = repoPath(root, input.tool_input.file_path);
  if (file === undefined || file.startsWith(`${VIEWPORT_DIR}/`)) return undefined;
  const paths = viewportPaths(root);
  const state = openState(paths.stateDb);
  try {
    if (!hasOpenGate(state)) return undefined;
    const config = await readConfig(paths.config);
    if (gatesOff(config.gates)) return undefined;
    const [model, ledger] = await Promise.all([readModel(paths.model), readLedger(paths.ledger)]);
    const gate = currentGate(state, model, ledger, config.gates);
    if (gate === undefined || gate.closedAt !== undefined) return undefined;
    if (gate.session === input.session_id && editsSinceGate(state, gate) < GATE_GRACE_EDITS) return undefined;
    return deny(
      `Viewport catch-up gate: the developer is catching up on ${subjectList(gate)} before work continues (${gateProgress(gate)}). Make no more edits. End your turn with a short summary of the work so far and tell the developer to catch up in the viewer's Today tab.`,
    );
  } finally {
    state.close();
  }
}

/**
 * When the developer sends a prompt while a gate is open: hold it until they catch up.
 * Viewport's own commands always go through, so /viewport:gates skip or off is never locked out.
 * Once the gate passes, Claude is told the developer caught up, in one line.
 */
export async function userPromptSubmit(root: string, input: HookInput): Promise<HookOutput> {
  if ((input.prompt ?? "").trimStart().startsWith("/viewport")) return undefined;
  const paths = viewportPaths(root);
  const state = openState(paths.stateDb);
  let gate: Gate | undefined;
  try {
    if (!hasOpenGate(state)) return undefined;
    const config = await readConfig(paths.config);
    if (gatesOff(config.gates)) return undefined;
    const [model, ledger] = await Promise.all([readModel(paths.model), readLedger(paths.ledger)]);
    gate = currentGate(state, model, ledger, config.gates);
  } finally {
    state.close();
  }
  if (gate === undefined) return undefined;
  if (gate.closedAt !== undefined) {
    const what = gate.subjects.map((s) => s.id).join(", ");
    return context("UserPromptSubmit", `The developer caught up on ${what || "the work so far"} at a Viewport gate (${gate.outcome}); carry on.`);
  }
  return { decision: "block", reason: await gateNotice(root, gate) };
}

/**
 * A checkpoint: with the model in step, hand what is new or changed since it was last
 * explained to the explainer, which the viewer's daemon runs in the background.
 */
async function queueExplanations(root: string): Promise<void> {
  const paths = viewportPaths(root);
  const [model, ledger] = await Promise.all([readModel(paths.model), readLedger(paths.ledger)]);
  if (!model.nodes.some((n) => n.kind === "component")) return;
  const state = openState(paths.stateDb);
  try {
    const due = explainDue(state, model, ledger);
    for (let i = 0; i < due.length; i += EXPLAIN_BATCH) enqueueJob(state, "explain", { subjects: due.slice(i, i + EXPLAIN_BATCH) });
  } finally {
    state.close();
  }
}

/**
 * Flags Claude should answer before finishing: ones already passed on during this
 * work and any raised since, oldest first, at most a few. Raised ones count as delivered now.
 */
function flagsToAnswer(state: DatabaseSync) {
  const flags = unresolvedFlags(state).slice(0, FLAGS_PER_EDIT);
  const mark = state.prepare("UPDATE flags SET status = 'delivered' WHERE id = ? AND status = 'pending'");
  for (const f of flags) mark.run(f.id);
  return flags;
}

/** What the session's edits left the model missing, as instructions; empty when it is in step. */
async function modelGaps(root: string, edited: Set<string>): Promise<string[]> {
  if (edited.size === 0) return [];
  const paths = viewportPaths(root);
  const config = await readConfig(paths.config);
  const model = await readModel(paths.model);
  if (!model.nodes.some((n) => n.kind === "component")) return [];
  const report = await verify(root, model, config);
  const owner = coverage(await listSources(root, config), model).owner;
  const touched = new Set([...edited].map((f) => owner.get(f)).filter((c): c is string => c !== undefined));

  const unclaimed = report.unclaimed.filter((f) => edited.has(f));
  const missing = report.missingDependencies.filter((d) => d.evidence.some((e) => edited.has(e.file)));
  const unsupported = report.unsupportedEdges.filter((key) => [...touched].some((c) => key.startsWith(`depends_on:${c}->`)));
  if (unclaimed.length === 0 && missing.length === 0 && unsupported.length === 0) {
    const reviewed = report.staleComponents.filter((c) => touched.has(c));
    if (reviewed.length > 0) await writeModelFromAgent(root, model, reviewed);
    return [];
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
  return lines;
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
