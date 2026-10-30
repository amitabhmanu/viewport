import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appendDecision, initWorkspace, openState, viewportPaths, writeModelFromAgent } from "@viewport/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHealthy, readLock, stopDaemon } from "./lock.js";
import { type Daemon, startDaemon } from "./server.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));
const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const COMPONENTS = ["api", "orders", "payments", "notifications", "storage"];
const SHOP = {
  nodes: [
    { kind: "system", id: "shop", name: "Shop", purpose: "Take orders" },
    { kind: "container", id: "app", name: "App", role: "Runs the shop" },
    ...COMPONENTS.map((c) => ({
      kind: "component",
      id: `app.${c}`,
      name: c,
      role: c,
      paths: c === "api" ? ["src/shop/api/**", "src/shop/__init__.py"] : [`src/shop/${c}/**`],
    })),
  ],
  edges: [
    { kind: "contains", from: "shop", to: "app" },
    ...COMPONENTS.map((c) => ({ kind: "contains", from: "app", to: `app.${c}` })),
    ...[
      ["api", "orders"],
      ["orders", "payments"],
      ["orders", "storage"],
      ["orders", "notifications"],
      ["storage", "orders"],
    ].map(([a, b]) => ({ kind: "depends_on", from: `app.${a}`, to: `app.${b}`, mode: "sync" })),
  ],
};

let root: string;
let daemon: Daemon;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "viewportd-"));
  await cp(FIXTURE, root, { recursive: true });
  await initWorkspace(root);
  await writeModelFromAgent(root, SHOP);
  daemon = await startDaemon(root);
});
afterEach(() => daemon.close());

const api = (path: string, init: RequestInit = {}, token = daemon.token) =>
  fetch(`http://127.0.0.1:${daemon.port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });

describe("API", () => {
  it("answers queries over the model", async () => {
    expect(await (await api("/api/model")).json()).toMatchObject({ revision: 1 });
    expect(await (await api("/api/node?id=app.orders")).json()).toMatchObject({ parent: "app" });
    expect(await (await api("/api/trace?from=app.api&to=app.payments")).json()).toMatchObject({ nodes: ["app.api", "app.orders", "app.payments"] });
    const views = (await (await api("/api/view?name=components:app&level=simple")).json()) as { elements: string[] }[];
    expect(views.flatMap((v) => v.elements)).toHaveLength(5);
    expect(await (await api("/api/ledger")).json()).toEqual([]);
    expect(await (await api("/api/verify")).json()).toMatchObject({ unclaimed: [], missingDependencies: [] });
  });

  it("explains bad requests", async () => {
    const res = await api("/api/node?id=nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown node 'nope'" });
    expect((await api("/api/view?name=overview&level=huge")).status).toBe(400);
    expect((await api("/api/nothing")).status).toBe(404);
  });

  it("lists what changed since the viewer last looked, until each item is opened", async () => {
    expect(await (await api("/api/changes")).json()).toMatchObject({ since: 1, changes: [] });
    await writeModelFromAgent(root, { ...SHOP, edges: SHOP.edges.filter((e) => !(e.from === "app.storage" && e.to === "app.orders")) });
    const changes = (await (await api("/api/changes")).json()) as { changes: { subject: string; change: string }[] };
    expect(changes.changes).toEqual([expect.objectContaining({ subject: "depends_on:app.storage->app.orders", change: "removed" })]);
    await api("/api/seen", { method: "POST", body: JSON.stringify({ subjects: ["depends_on:app.storage->app.orders"] }) });
    expect(await (await api("/api/changes")).json()).toMatchObject({ since: 2, changes: [] });
    expect((await api("/api/seen", { method: "POST", body: JSON.stringify({ subjects: "x" }) })).status).toBe(400);
    expect(await (await api("/api/seen", { method: "POST", body: JSON.stringify({ all: true }) })).json()).toEqual({ ok: true });
  });

  it("logs each query and keeps pinned views", async () => {
    await api("/api/trace?from=app.api&direction=downstream");
    await api("/api/slice?mode=sync");
    expect((await api("/api/slice?mode=nope")).status).toBe(400);
    const pin = (await (await api("/api/pins", { method: "POST", body: JSON.stringify({ title: "API path", query: { q: "trace", from: "app.api" } }) })).json()) as { id: number };
    expect(await (await api("/api/pins")).json()).toEqual([expect.objectContaining({ title: "API path", query: { q: "trace", from: "app.api" } })]);
    expect((await api("/api/pins", { method: "POST", body: JSON.stringify({ title: "", query: {} }) })).status).toBe(400);
    await api(`/api/pins?id=${pin.id}`, { method: "DELETE" });
    expect(await (await api("/api/pins")).json()).toEqual([]);
    const db = openState(viewportPaths(root).stateDb);
    const events = db.prepare("SELECT subject, payload FROM events WHERE kind = 'query' ORDER BY id").all() as { subject: string | null; payload: string }[];
    db.close();
    expect(events.map((e) => [e.subject, JSON.parse(e.payload)])).toEqual([
      ["app.api", { q: "trace", from: "app.api", direction: "downstream", nodes: 5 }],
      [null, { q: "slice", mode: "sync", nodes: 5 }],
    ]);
  });

  it("records a guess at a decision before it is revealed", async () => {
    await appendDecision(viewportPaths(root).ledger, {
      id: "D-001",
      at: new Date().toISOString(),
      title: "Queue notifications",
      options: [
        { name: "Inline", tradeoff: "simple" },
        { name: "Queue", tradeoff: "resilient" },
      ],
      chosen: "Queue",
      why: "Slow provider",
      reversibility: "easy",
      blastRadius: 2,
    });
    const post = (body: object) => api("/api/predictions", { method: "POST", body: JSON.stringify(body) });
    expect(await (await post({ decisionId: "D-001", guess: "Queue" })).json()).toMatchObject({ guess: "Queue", correct: true });
    expect((await post({ decisionId: "D-009" })).status).toBe(400);
    expect((await post({ decisionId: "D-001", guess: 3 })).status).toBe(400);
    expect(await (await api("/api/predictions")).json()).toEqual([expect.objectContaining({ decisionId: "D-001", correct: true })]);
  });

  it("stores flags raised from the viewer", async () => {
    const res = await api("/api/flags", { method: "POST", body: JSON.stringify({ subject: "app.orders", text: " why sync? " }) });
    expect(await res.json()).toMatchObject({ subject: "app.orders", text: "why sync?", status: "pending" });
    expect(await (await api("/api/flags")).json()).toHaveLength(1);
    expect(await (await api("/api/flags?all=1")).json()).toHaveLength(1);
    expect((await api("/api/flags", { method: "POST", body: JSON.stringify({ subject: "x" }) })).status).toBe(400);
  });
});

describe("access", () => {
  it("needs the token for the API but not for the page", async () => {
    expect((await api("/api/model", {}, "wrong")).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${daemon.port}/api/model?token=${daemon.token}`)).status).toBe(200);
    const page = await fetch(`http://127.0.0.1:${daemon.port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Viewport");
  });

  it("refuses requests that name another host", async () => {
    const res = await new Promise<number>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port: daemon.port, path: "/", headers: { host: "evil.example" } }, (r) => resolve(r.statusCode ?? 0));
        req.on("error", reject);
        req.end();
      }, reject);
    });
    expect(res).toBe(403);
  });

  it("serves the built viewer when there is one, with routes falling back to index.html", async () => {
    const web = await mkdtemp(join(tmpdir(), "viewport-web-"));
    await mkdir(join(web, "assets"));
    await writeFile(join(web, "index.html"), "<p>app</p>");
    await writeFile(join(web, "assets", "app.js"), "console.log(1)");
    const withWeb = await startDaemon(root, { webRoot: web });
    const get = (p: string) => fetch(`http://127.0.0.1:${withWeb.port}${p}`);
    expect(await (await get("/assets/app.js")).text()).toBe("console.log(1)");
    expect(await (await get("/map/app")).text()).toBe("<p>app</p>");
    expect(await (await get("/../../etc/passwd")).text()).toBe("<p>app</p>");
    await withWeb.close();
  });
});

describe("events", () => {
  it("streams a change event when the model is written", async () => {
    const controller = new AbortController();
    const res = await api("/api/events", { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const seen = (async () => {
      while (!text.includes("event: change")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await writeModelFromAgent(root, SHOP, ["app.orders"]);
    await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error(`no event; got ${text}`)), 3000))]);
    expect(text).toMatch(/data: \{"changed":\[[^\]]*"model"/);
    controller.abort();
  });
});

describe("daemon process", () => {
  it("starts once per repo, is reused, and stops", async () => {
    const run = (cmd: string) => promisify(execFile)("node", ["--disable-warning=ExperimentalWarning", MAIN, cmd, "--root", root]);
    const first = (await run("ensure")).stdout.trim();
    const second = (await run("ensure")).stdout.trim();
    expect(first).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}$/);
    expect(second).toBe(first);
    const lock = await readLock(root);
    expect(lock !== undefined && (await isHealthy(lock))).toBe(true);
    expect(await stopDaemon(root)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(await readLock(root)).toBeUndefined();
  });
});
