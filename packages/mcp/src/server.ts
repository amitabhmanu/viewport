import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ConfigMissingError,
  DecisionOption,
  DependencyMode,
  EngageError,
  LedgerError,
  ModelEditError,
  ModelGraph,
  QueryError,
  Reversibility,
  SyncState,
  type Level,
  type ViewName,
  get,
  mergeIntoModel,
  openState,
  readLedger,
  readModel,
  recordDecision,
  removeFromModel,
  resolveFlag,
  slice,
  trace,
  unresolvedFlags,
  view,
  viewportPaths,
  writeModelFromAgent,
  writeQuizItems,
  type VerificationReport,
  type WriteResult,
  readConfig,
  verify,
} from "@viewport/core";
import { ZodError, z } from "zod";

export const SERVER_NAME = "viewport";

/** Errors the agent can act on: returned as tool errors rather than thrown. */
const EXPECTED = [ConfigMissingError, QueryError, LedgerError, ModelEditError, EngageError];

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function explain(err: unknown): CallToolResult {
  if (err instanceof ZodError) {
    return fail(`invalid input:\n${err.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  }
  if (EXPECTED.some((E) => err instanceof E)) return fail((err as Error).message);
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return fail(`${(err as Error).message}; run /viewport:init first`);
  throw err;
}

const LIST_CAP = 20;

/** Long lists cost the agent tokens; show the first few and a count. */
function cap(items: string[]): string[] {
  return items.length <= LIST_CAP ? items : [...items.slice(0, LIST_CAP), `...and ${items.length - LIST_CAP} more`];
}

/** A short summary of a model write, so the agent sees what verification found without the whole model. */
function summarizeWrite(write: WriteResult) {
  return { revision: write.model.revision, stamped: write.stamped, findings: findings(write.report) };
}

function findings(r: VerificationReport) {
  return {
    unclaimed: cap(r.unclaimed),
    doubleClaimed: r.doubleClaimed,
    missingDependencies: cap(r.missingDependencies.map((d) => `${d.from} -> ${d.to} (${d.evidence[0]?.file ?? "?"})`)),
    unsupportedEdges: r.unsupportedEdges,
    changedSinceModeled: r.staleComponents,
    emptyTests: r.emptyTests,
    notes: r.notes,
  };
}

/**
 * The Viewport MCP server for one repo. Every call reads the files fresh, so edits
 * made by hooks, the CLI or the viewer are always seen. Writes run one at a time.
 */
export function createServer(root: string): McpServer {
  const paths = viewportPaths(root);
  const server = new McpServer({ name: SERVER_NAME, version: "0.0.1" });

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const handle = async (fn: () => Promise<unknown> | unknown): Promise<CallToolResult> => {
    try {
      return ok(await fn());
    } catch (err) {
      return explain(err);
    }
  };
  const graph = async () => new ModelGraph(await readModel(paths.model));

  let db: DatabaseSync | undefined;
  const state = () => (db ??= openState(paths.stateDb));

  const read = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "model_get",
    {
      description: "One node of the system model with its parent, children, incoming and outgoing edges, and the decisions that shaped it.",
      inputSchema: { id: z.string().describe("Node id, for example app.orders") },
      annotations: read,
    },
    ({ id }) => handle(async () => get(await graph(), id)),
  );

  server.registerTool(
    "model_view",
    {
      description:
        "A named view of the model, split into sub-views that fit the element budget for the level (a process view splits into one part per path, main path first). Names: overview, containers, components:<container id>, code-map, processes, process:<process id>, rules, data, coverage, deploy.",
      inputSchema: {
        name: z.string().describe("overview, containers, components:<container id>, code-map, processes, process:<process id>, rules, data, coverage or deploy"),
        level: z.enum(["simple", "medium", "complex"]).default("medium"),
      },
      annotations: read,
    },
    ({ name, level }) => handle(async () => view(await graph(), name as ViewName, level as Level)),
  );

  server.registerTool(
    "model_trace",
    {
      description:
        "Follows uses and depends_on edges from a node. With `to`, returns the shortest path; without, everything reachable. Upstream follows edges backwards (who depends on this).",
      inputSchema: {
        from: z.string(),
        to: z.string().optional(),
        direction: z.enum(["downstream", "upstream"]).default("downstream"),
      },
      annotations: read,
    },
    ({ from, to, direction }) => handle(async () => trace(await graph(), from, { direction, ...(to !== undefined ? { to } : {}) })),
  );

  server.registerTool(
    "model_slice",
    {
      description: "The part of the model matching a concern. Filters combine with AND.",
      inputSchema: {
        externals: z.boolean().optional().describe("Only edges into external systems"),
        mode: DependencyMode.optional(),
        sync: SyncState.optional().describe("ok, stale or unverified"),
        decidedBy: z.string().optional().describe("Decision node id such as d-003: everything it shaped"),
      },
      annotations: read,
    },
    (filter) =>
      handle(async () =>
        slice(await graph(), {
          ...(filter.externals ? { externals: true } : {}),
          ...(filter.mode !== undefined ? { mode: filter.mode } : {}),
          ...(filter.sync !== undefined ? { sync: filter.sync } : {}),
          ...(filter.decidedBy !== undefined ? { decidedBy: filter.decidedBy } : {}),
        }),
      ),
  );

  server.registerTool(
    "ledger_get",
    {
      description: "Decisions from the ledger. With `id`, one decision; with `affects`, decisions that name that node id or edge key; otherwise the most recent ones.",
      inputSchema: {
        id: z.string().optional().describe("Decision id such as D-003"),
        affects: z.string().optional(),
        limit: z.number().int().positive().default(20),
      },
      annotations: read,
    },
    ({ id, affects, limit }) =>
      handle(async () => {
        const ledger = await readLedger(paths.ledger);
        if (id !== undefined) {
          const found = ledger.find((d) => d.id === id.toUpperCase());
          if (found === undefined) throw new QueryError(`no decision ${id}`);
          return found;
        }
        const matching = affects === undefined ? ledger : ledger.filter((d) => d.affects.includes(affects));
        return matching.slice(-limit).reverse();
      }),
  );

  server.registerTool(
    "model_verify",
    {
      description:
        "Checks the whole model against the code without changing anything: files no component owns, overlapping components, imports with no depends_on edge, sync or async edges no import backs, covers edges whose tests import nothing that implements what they cover, owns/reads/writes edges whose component never names the entity, test groups that match no files, and components whose code changed since they were modeled.",
      inputSchema: {},
      annotations: read,
    },
    () =>
      handle(async () => {
        const model = await readModel(paths.model);
        const report = await verify(root, model, await readConfig(paths.config));
        return { revision: model.revision, findings: findings(report) };
      }),
  );

  server.registerTool(
    "flags_pending",
    {
      description: "Questions the developer has flagged on nodes, edges or decisions that you have not answered yet. Answer each with flags_resolve.",
      inputSchema: {},
      annotations: read,
    },
    () => handle(() => unresolvedFlags(state())),
  );

  server.registerTool(
    "model_upsert",
    {
      description:
        "Adds or replaces nodes (by id) and edges (by kind, from and to), then validates the whole model, verifies it against the code and saves it. Returns what verification found. Shapes are in the viewport-modeling skill; a component is {kind:'component', id:'app.x', name, role, paths:[globs]} and a dependency {kind:'depends_on', from, to, mode:'sync'|'async'|'data'}. Processes, steps, rules, assumptions, entities, tests and runtimes are described there too.",
      inputSchema: {
        // Loose here and validated in mergeIntoModel: the full schema would cost every request ~1k tokens.
        nodes: z.array(z.record(z.string(), z.unknown())).default([]),
        edges: z.array(z.record(z.string(), z.unknown())).default([]),
        reviewed: z.array(z.string()).default([]).describe("Component ids re-checked against the code without changes"),
      },
      annotations: { ...write, idempotentHint: true },
    },
    ({ nodes, edges, reviewed }) =>
      handle(() =>
        serial(async () => {
          const merged = mergeIntoModel(await readModel(paths.model), { nodes, edges });
          return summarizeWrite(await writeModelFromAgent(root, merged, reviewed));
        }),
      ),
  );

  server.registerTool(
    "model_remove",
    {
      description:
        "Removes nodes and edges. Edges touching a removed node go with it. A container that still holds components cannot be removed until they are removed or moved.",
      inputSchema: {
        nodes: z.array(z.string()).default([]),
        edges: z.array(z.string()).default([]).describe("Edge keys such as depends_on:app.api->app.orders"),
      },
      annotations: { ...write, destructiveHint: true },
    },
    ({ nodes, edges }) =>
      handle(() =>
        serial(async () => {
          const pruned = removeFromModel(await readModel(paths.model), { nodes, edges });
          return summarizeWrite(await writeModelFromAgent(root, pruned));
        }),
      ),
  );

  server.registerTool(
    "ledger_append",
    {
      description:
        "Logs a decision: the options you weighed, the one you chose and why, and how hard it is to undo. Blast radius is computed from the model, so name what it affects with node ids or edge keys. To change a decision, log a new one with `supersedes`.",
      inputSchema: {
        title: z.string().min(1),
        options: z.array(DecisionOption).min(2),
        chosen: z.string().min(1).describe("Must match one option's name"),
        why: z.string().min(1),
        reversibility: Reversibility,
        affects: z.array(z.string()).default([]).describe("Node ids such as app.orders and edge keys such as depends_on:app.orders->app.payments"),
        assumptions: z.array(z.string()).default([]).describe("Statements you could not confirm"),
        supersedes: z.string().optional().describe("Decision id this one replaces"),
        commit: z.string().optional(),
      },
      annotations: write,
    },
    (input) =>
      handle(() =>
        serial(async () => {
          const { supersedes, commit, ...rest } = input;
          const { decision, touched, write } = await recordDecision(root, {
            ...rest,
            ...(supersedes !== undefined ? { supersedes: supersedes.toUpperCase() } : {}),
            ...(commit !== undefined ? { commit } : {}),
          });
          return { id: decision.id, blastRadius: decision.blastRadius, touched, model: summarizeWrite(write) };
        }),
      ),
  );

  server.registerTool(
    "engage_write",
    {
      description: "Stores quiz questions and prediction options for the developer. `predict` items need at least two choices.",
      inputSchema: {
        items: z
          .array(
            z.object({
              subject: z.string().describe("Node id, edge key or decision id"),
              kind: z.enum(["why", "what-if", "predict"]),
              question: z.string().min(1),
              choices: z.array(z.string().min(1)).optional(),
            }),
          )
          .min(1),
      },
      annotations: write,
    },
    ({ items }) =>
      handle(() =>
        serial(async () => ({
          ids: writeQuizItems(
            state(),
            items.map(({ choices, ...rest }) => ({ ...rest, ...(choices !== undefined ? { choices } : {}) })),
          ),
        })),
      ),
  );

  server.registerTool(
    "flags_resolve",
    {
      description:
        "Answers a developer's flag. Give an explanation, or if the flag changed your plan, log the new decision with ledger_append first and pass its id.",
      inputSchema: {
        id: z.number().int().positive(),
        answer: z.string().min(1),
        decision: z.string().optional().describe("Id of a decision logged because of this flag"),
      },
      annotations: write,
    },
    ({ id, answer, decision }) =>
      handle(() =>
        serial(async () => {
          if (decision !== undefined && !(await readLedger(paths.ledger)).some((d) => d.id === decision.toUpperCase())) {
            throw new LedgerError(`no decision ${decision}`);
          }
          return resolveFlag(state(), id, answer, decision?.toUpperCase());
        }),
      ),
  );

  const close = server.close.bind(server);
  server.close = async () => {
    await close();
    db?.close();
    db = undefined;
  };
  return server;
}
