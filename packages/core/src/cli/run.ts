import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigMissingError, readConfig } from "../config-store.js";
import { readLedger } from "../ledger.js";
import { readModel, serializeModel, writeModel } from "../model-store.js";
import { viewportPaths } from "../paths.js";
import { ModelGraph, QueryError, get, slice, trace, view, type Level, type ViewName } from "../query/index.js";
import { applyReport, isClean, verify } from "../verify/index.js";
import { openState } from "../state.js";
import { engagementStats, formatStats } from "../stats.js";
import { initWorkspace, writeModelFromAgent } from "../workspace.js";
import { formatLedger, formatModelSummary, formatReport, plural } from "./format.js";
import { ZodError } from "zod";

export interface CliIo {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  readStdin: () => Promise<string>;
}

const USAGE = `viewport <command> [options]

Commands:
  init                         Set up .viewport/ (config, empty model, .gitignore entry)
  status                       Model summary, full verification and ledger
  verify [--changed F]...      Verify the model against the code (--apply records sync states)
  model show                   Print the model as canonical JSON
  model write [--from FILE] [--reviewed ID]
                               Validate, stamp, verify and write a model (from FILE or stdin)
  query get <id>
  query trace <from> [--to X] [--upstream]
  query slice [--externals] [--mode M] [--sync S] [--decided-by D]
  query view <name> [--level simple|medium|complex]
                               Views: overview, containers, components:<id>, code-map,
                               processes, process:<id>, rules, data, coverage, deploy
  stats [--days N]             Engagement numbers for the dogfood log (default: last 7 days)

Options:
  --root DIR   Repo root (default: current directory)
  --json       Machine-readable output
`;

/** Runs one CLI invocation and returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      changed: { type: "string", multiple: true },
      apply: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      reviewed: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
      upstream: { type: "boolean", default: false },
      externals: { type: "boolean", default: false },
      mode: { type: "string" },
      sync: { type: "string" },
      "decided-by": { type: "string" },
      days: { type: "string" },
      level: { type: "string", default: "medium" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const root = values.root ?? io.cwd;
  const paths = viewportPaths(root);
  const print = (data: unknown, text: () => string) => io.out(values.json ? JSON.stringify(data, null, 2) : text());
  const [command, sub, arg] = positionals;

  try {
    switch (values.help ? "help" : command) {
      case "init": {
        const result = await initWorkspace(root);
        print(result, () =>
          [
            result.created.length > 0 ? `Created ${result.created.join(", ")}.` : "Already set up.",
            `Languages: ${result.config.languages.join(", ")}. Sources: ${result.config.sources.join(", ")} (${plural(result.files, "file")}).`,
          ].join("\n"),
        );
        return 0;
      }
      case "status": {
        const config = await readConfig(paths.config);
        const model = await readModel(paths.model);
        const report = await verify(root, model, config);
        const ledger = await readLedger(paths.ledger);
        print({ revision: model.revision, report, decisions: ledger.length }, () =>
          [formatModelSummary(model), formatReport(report), formatLedger(ledger)].join("\n"),
        );
        return 0;
      }
      case "verify": {
        const config = await readConfig(paths.config);
        const model = await readModel(paths.model);
        const report = await verify(root, model, config, values.changed ? { changedFiles: values.changed } : {});
        if (values.apply) await writeModel(paths.model, applyReport(model, report));
        print(report, () => formatReport(report));
        return values.check && !isClean(report) ? 1 : 0;
      }
      case "model": {
        if (sub === "show") {
          io.out(serializeModel(await readModel(paths.model)).trimEnd());
          return 0;
        }
        if (sub === "write") {
          const text = values.from !== undefined ? await readFile(resolve(root, values.from), "utf8") : await io.readStdin();
          const incoming = JSON.parse(text) as unknown;
          const result = await writeModelFromAgent(root, incoming, values.reviewed ?? []);
          print({ revision: result.model.revision, stamped: result.stamped, report: result.report }, () =>
            [
              `Wrote model r${result.model.revision}; fingerprinted ${result.stamped.length > 0 ? result.stamped.join(", ") : "nothing"}.`,
              formatReport(result.report),
            ].join("\n"),
          );
          return 0;
        }
        break;
      }
      case "query": {
        const graph = new ModelGraph(await readModel(paths.model));
        const result = runQuery(graph, sub, arg, values);
        io.out(JSON.stringify(result, null, 2));
        return 0;
      }
      case "stats": {
        const days = values.days === undefined ? 7 : Number(values.days);
        if (!Number.isFinite(days) || days <= 0) throw new QueryError("--days needs a positive number");
        const db = openState(paths.stateDb);
        try {
          const stats = engagementStats(db, new Date(), days);
          print(stats, () => formatStats(stats));
        } finally {
          db.close();
        }
        return 0;
      }
      case "help":
      case undefined:
        io.out(USAGE);
        return command === undefined && !values.help ? 2 : 0;
    }
    io.err(`unknown command: ${positionals.join(" ")}\n\n${USAGE}`);
    return 2;
  } catch (err) {
    if (err instanceof ZodError) {
      io.err(`invalid model:\n${err.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
      return 1;
    }
    if (err instanceof ConfigMissingError || err instanceof QueryError || err instanceof SyntaxError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}

function runQuery(graph: ModelGraph, sub: string | undefined, arg: string | undefined, values: Record<string, unknown>): unknown {
  const need = (what: string) => {
    if (arg === undefined) throw new QueryError(`query ${sub} needs ${what}`);
    return arg;
  };
  switch (sub) {
    case "get":
      return get(graph, need("a node id"));
    case "trace":
      return trace(graph, need("a starting node"), {
        ...(typeof values.to === "string" ? { to: values.to } : {}),
        direction: values.upstream ? "upstream" : "downstream",
      });
    case "slice":
      return slice(graph, {
        ...(values.externals ? { externals: true } : {}),
        ...(typeof values.mode === "string" ? { mode: values.mode as "sync" } : {}),
        ...(typeof values.sync === "string" ? { sync: values.sync as "ok" } : {}),
        ...(typeof values["decided-by"] === "string" ? { decidedBy: values["decided-by"] } : {}),
      });
    case "view": {
      const level = values.level as Level;
      if (!["simple", "medium", "complex"].includes(level)) throw new QueryError(`unknown level '${level}'`);
      return view(graph, need("a view name") as ViewName, level);
    }
  }
  throw new QueryError(`unknown query '${sub ?? ""}'; use get, trace, slice or view`);
}
