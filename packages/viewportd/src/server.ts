import { randomBytes, timingSafeEqual } from "node:crypto";
import { type FSWatcher, existsSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import {
  AskQuery,
  ConfigMissingError,
  type Level,
  ModelGraph,
  QueryError,
  type SliceFilter,
  type TraceOptions,
  type ViewName,
  addPin,
  changesSince,
  get,
  listPins,
  logEvent,
  markAllSeen,
  markSeen,
  openState,
  raiseFlag,
  readConfig,
  readLedger,
  readModel,
  removePin,
  slice,
  trace,
  unresolvedFlags,
  verify,
  view,
  viewportPaths,
} from "@viewport/core";
import { ZodError } from "zod";

export interface DaemonOptions {
  /** Port to listen on; 0 picks a free one. */
  port?: number;
  /** Directory with the built viewer. Without one, a placeholder page is served. */
  webRoot?: string;
  /** Shut down after this long with no requests and no open event streams. */
  idleMs?: number;
  onIdle?: () => void;
}

export interface Daemon {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const LEVELS = new Set(["simple", "medium", "complex"]);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The viewer's local server for one repo: the built UI, a JSON API over core
 * queries, and a server-sent event stream that fires when `.viewport/` changes.
 * Bound to 127.0.0.1; every API call needs the random token, and requests naming
 * any other host are refused so that a web page cannot reach it by DNS rebinding.
 */
export async function startDaemon(root: string, options: DaemonOptions = {}): Promise<Daemon> {
  const paths = viewportPaths(root);
  const token = randomBytes(16).toString("hex");
  const clients = new Set<ServerResponse>();
  let lastActivity = Date.now();
  let port = 0;

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const given = url.searchParams.get("token") ?? req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const api = async (req: IncomingMessage, url: URL): Promise<unknown> => {
    const q = url.searchParams;
    const graph = async () => new ModelGraph(await readModel(paths.model));
    const need = (name: string) => {
      const v = q.get(name);
      if (v === null || v === "") throw new HttpError(400, `missing '${name}'`);
      return v;
    };
    switch (`${req.method} ${url.pathname}`) {
      case "GET /api/health":
        return { ok: true, root };
      case "GET /api/model":
        return readModel(paths.model);
      case "GET /api/node":
        return get(await graph(), need("id"));
      case "GET /api/view": {
        const level = q.get("level") ?? "medium";
        if (!LEVELS.has(level)) throw new HttpError(400, `unknown level '${level}'`);
        return view(await graph(), need("name") as ViewName, level as Level);
      }
      case "GET /api/trace":
      case "GET /api/slice": {
        const query = askFrom(url.pathname === "/api/trace" ? "trace" : "slice", q);
        const result = query.q === "trace" ? trace(await graph(), query.from, query as TraceOptions) : slice(await graph(), query as SliceFilter);
        // The viewer re-runs a shown query when the model changes; only the asking is logged.
        if (q.get("quiet") !== "1") withState((db) => logEvent(db, "query", query.q === "trace" ? query.from : null, { ...query, nodes: result.nodes.length }));
        return result;
      }
      case "GET /api/pins":
        return withState((db) => listPins(db));
      case "POST /api/pins": {
        const body = JSON.parse(await readBody(req)) as { title?: unknown; query?: unknown };
        if (typeof body.title !== "string" || body.title.trim() === "") throw new HttpError(400, "a pin needs a title");
        const title = body.title.trim();
        const query = AskQuery.parse(body.query);
        return withState((db) => addPin(db, title, query));
      }
      case "DELETE /api/pins": {
        const id = Number(need("id"));
        withState((db) => removePin(db, id));
        return { ok: true };
      }
      case "GET /api/ledger":
        return readLedger(paths.ledger);
      case "GET /api/verify":
        return verify(root, await readModel(paths.model), await readConfig(paths.config));
      case "GET /api/flags":
        return withState((db) => unresolvedFlags(db));
      case "POST /api/flags": {
        const body = JSON.parse(await readBody(req)) as { subject?: unknown; text?: unknown };
        if (typeof body.subject !== "string" || typeof body.text !== "string" || body.text.trim() === "") {
          throw new HttpError(400, "a flag needs a subject and some text");
        }
        const { subject, text } = body;
        return withState((db) => raiseFlag(db, subject, text.trim()));
      }
      case "GET /api/changes": {
        const [model, ledger] = await Promise.all([readModel(paths.model), readLedger(paths.ledger)]);
        const db = openState(paths.stateDb);
        try {
          return await changesSince(paths.model, db, model, ledger);
        } finally {
          db.close();
        }
      }
      case "POST /api/seen": {
        const body = JSON.parse(await readBody(req)) as { subjects?: unknown; all?: unknown };
        const { revision } = await readModel(paths.model);
        if (body.all === true) {
          withState((db) => markAllSeen(db, revision));
          return { ok: true };
        }
        if (!Array.isArray(body.subjects) || !body.subjects.every((s) => typeof s === "string")) {
          throw new HttpError(400, "send the subjects you opened, or all: true");
        }
        const subjects = body.subjects as string[];
        withState((db) => markSeen(db, subjects, revision));
        return { ok: true };
      }
    }
    throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
  };

  const withState = <T>(fn: (db: ReturnType<typeof openState>) => T): T => {
    const db = openState(paths.stateDb);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const serveStatic = async (res: ServerResponse, pathname: string) => {
    const web = options.webRoot;
    if (web === undefined || !existsSync(join(web, "index.html"))) {
      res.writeHead(200, { "content-type": TYPES[".html"] }).end(PLACEHOLDER);
      return;
    }
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    const file = join(web, rel);
    const inside = file === web || file.startsWith(web.endsWith(sep) ? web : web + sep);
    const target = inside && extname(file) !== "" && existsSync(file) ? file : join(web, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream" }).end(await readFile(target));
  };

  const server = createServer((req, res) => {
    lastActivity = Date.now();
    void (async () => {
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "unexpected host");
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
      if (!authorized(req, url)) throw new HttpError(401, "missing or wrong token");
      if (url.pathname === "/api/events") return openStream(res);
      const body = await api(req, url);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    })().catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : err instanceof QueryError || err instanceof ZodError || err instanceof SyntaxError ? 400 : err instanceof ConfigMissingError ? 404 : 500;
      const message = err instanceof ZodError ? err.issues.map((i) => i.message).join("; ") : err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    });
  });

  const openStream = (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": connected\n\n");
    clients.add(res);
    res.on("close", () => clients.delete(res));
  };

  // Writes are atomic renames, so watch directories rather than files, and batch bursts.
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const changed = (what: string) => {
    pending.add(what);
    timer ??= setTimeout(() => {
      timer = undefined;
      const data = JSON.stringify({ changed: [...pending].sort() });
      pending.clear();
      for (const c of clients) c.write(`event: change\ndata: ${data}\n\n`);
    }, 100);
  };
  const watchers: FSWatcher[] = [];
  const watchDir = (dir: string, classify: (file: string) => string | undefined) => {
    if (!existsSync(dir)) return;
    watchers.push(
      watch(dir, (_event, file) => {
        const what = file ? classify(file.toString()) : undefined;
        if (what !== undefined) changed(what);
      }),
    );
  };
  watchDir(paths.dir, (f) => (f.startsWith("model.json") ? "model" : f.startsWith("ledger.jsonl") ? "ledger" : undefined));
  watchDir(paths.localDir, (f) => (f.startsWith("state.db") ? "state" : undefined));

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
    if (options.idleMs !== undefined && clients.size === 0 && Date.now() - lastActivity > options.idleMs) options.onIdle?.();
  }, 15_000);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: async () => {
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      for (const c of clients) c.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A trace or slice from query parameters; unknown values fail validation with a 400. */
function askFrom(kind: "trace" | "slice", q: URLSearchParams): AskQuery {
  const pick = (...names: string[]) => Object.fromEntries(names.flatMap((n) => (q.get(n) ? [[n, q.get(n)]] : [])));
  if (kind === "trace") return AskQuery.parse({ q: "trace", ...pick("from", "to", "direction") });
  return AskQuery.parse({ q: "slice", ...pick("mode", "sync", "decidedBy"), ...(q.get("externals") === "true" ? { externals: true } : {}) });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Viewport</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#16161a}}code{font-size:.9em}</style></head>
<body><h1>Viewport</h1><p>The daemon is running, but the viewer has not been built yet. The JSON API is available under <code>/api/</code>, for example <code>/api/view?name=overview</code>, with this page's token.</p></body></html>`;
