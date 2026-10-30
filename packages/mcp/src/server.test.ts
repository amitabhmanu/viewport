import { cp } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initWorkspace, openState, raiseFlag, readLedger, viewportPaths } from "@viewport/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRoot } from "./root.js";
import { createServer } from "./server.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));

const COMPONENTS = ["api", "orders", "payments", "notifications", "storage"];
const SHOP = {
  nodes: [
    { kind: "system", id: "shop", name: "Shop", purpose: "Take orders" },
    { kind: "external", id: "payment-provider", name: "Payment provider", role: "Charges cards" },
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
    { kind: "depends_on", from: "app.payments", to: "payment-provider", mode: "sync" },
  ],
};

let root: string;
let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "viewport-mcp-"));
  await cp(FIXTURE, root, { recursive: true });
  await initWorkspace(root);
  const server = createServer(root);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  close = async () => {
    await client.close();
    await server.close();
  };
});
afterEach(() => close());

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = result.content[0]?.text ?? "";
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

describe("tool list", () => {
  it("exposes the read and write tools with names the API accepts", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "engage_write",
      "flags_pending",
      "flags_resolve",
      "ledger_append",
      "ledger_get",
      "model_get",
      "model_remove",
      "model_slice",
      "model_trace",
      "model_upsert",
      "model_verify",
      "model_view",
    ]);
    for (const t of tools) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(tools.find((t) => t.name === "model_get")?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("model tools", () => {
  it("upserts a model, reports verification, and answers queries over it", async () => {
    const write = await call("model_upsert", SHOP);
    expect(write.isError).toBe(false);
    expect(write.json()).toMatchObject({ revision: 1, findings: { unclaimed: [], missingDependencies: [] } });

    expect((await call("model_get", { id: "app.orders" })).json()).toMatchObject({ parent: "app", node: { sync: "ok" } });
    expect((await call("model_trace", { from: "app.api", to: "payment-provider" })).json()).toEqual({
      nodes: ["app.api", "app.orders", "app.payments", "payment-provider"],
      edges: ["depends_on:app.api->app.orders", "depends_on:app.orders->app.payments", "depends_on:app.payments->payment-provider"],
    });
    expect((await call("model_slice", { externals: true })).json()).toEqual({
      nodes: ["app.payments", "payment-provider"],
      edges: ["depends_on:app.payments->payment-provider"],
    });
    const views = (await call("model_view", { name: "components:app", level: "simple" })).json() as unknown as { elements: string[] }[];
    expect(views.flatMap((v) => v.elements)).toEqual(expect.arrayContaining(COMPONENTS.map((c) => `app.${c}`)));
  });

  it("verifies without writing", async () => {
    const edges = SHOP.edges.filter((e) => !(e.from === "app.orders" && e.to === "app.storage"));
    await call("model_upsert", { ...SHOP, edges });
    const checked = await call("model_verify");
    expect(checked.json()).toMatchObject({ revision: 1, findings: { missingDependencies: [expect.stringMatching(/^app.orders -> app.storage/)] } });
    expect((await call("model_verify")).json()).toMatchObject({ revision: 1 });
  });

  it("reports a missing dependency when the model omits one", async () => {
    const edges = SHOP.edges.filter((e) => !(e.from === "app.orders" && e.to === "app.storage"));
    const write = await call("model_upsert", { ...SHOP, edges });
    expect(write.json()).toMatchObject({ findings: { missingDependencies: [expect.stringMatching(/^app.orders -> app.storage/)] } });
  });

  it("merges a partial upsert into the existing model", async () => {
    await call("model_upsert", SHOP);
    const write = await call("model_upsert", {
      nodes: [{ kind: "component", id: "app.orders", name: "Orders", role: "Order lifecycle", paths: ["src/shop/orders/**"] }],
    });
    expect(write.json()).toMatchObject({ revision: 2, stamped: ["app.orders"] });
    expect((await call("model_get", { id: "app.api" })).isError).toBe(false);
  });

  it("returns schema problems as tool errors and leaves the model alone", async () => {
    await call("model_upsert", SHOP);
    const bad = await call("model_upsert", { edges: [{ kind: "contains", from: "app", to: "nowhere" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/unknown node 'nowhere'/);
    expect((await call("model_get", { id: "app.orders" })).json()).toMatchObject({ node: { id: "app.orders" } });
  });

  it("removes nodes with their edges, and refuses to orphan components", async () => {
    await call("model_upsert", SHOP);
    const refused = await call("model_remove", { nodes: ["app"] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/not inside any container/);

    const removed = await call("model_remove", { edges: ["depends_on:app.payments->payment-provider"], nodes: ["payment-provider"] });
    expect(removed.isError).toBe(false);
    expect((await call("model_get", { id: "payment-provider" })).text).toMatch(/unknown node/);
  });

  it("explains a missing workspace", async () => {
    const empty = await mkdtemp(join(tmpdir(), "viewport-mcp-"));
    const server = createServer(empty);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const other = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), other.connect(b)]);
    const result = (await other.callTool({ name: "model_upsert", arguments: SHOP })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/init/);
    await other.close();
    await server.close();
  });
});

describe("ledger tools", () => {
  const decision = {
    title: "Synchronous call from orders to payments",
    options: [
      { name: "Direct call", tradeoff: "Simple, couples availability" },
      { name: "Queue", tradeoff: "Decoupled, adds a broker" },
    ],
    chosen: "Direct call",
    why: "Checkout needs the charge result before confirming",
    reversibility: "costly",
    affects: ["depends_on:app.orders->app.payments"],
  };

  it("appends with a computed blast radius and reads decisions back", async () => {
    await call("model_upsert", SHOP);
    const appended = await call("ledger_append", decision);
    expect(appended.json()).toMatchObject({ id: "D-001", blastRadius: 4, touched: ["app.api", "app.orders", "app.payments", "app.storage"] });

    expect((await call("ledger_get", { id: "d-001" })).json()).toMatchObject({ title: decision.title });
    expect((await call("ledger_get", { affects: "depends_on:app.orders->app.payments" })).json()).toHaveLength(1);
    expect((await call("model_slice", { decidedBy: "d-001" })).json()).toMatchObject({ edges: ["depends_on:app.orders->app.payments"] });
    expect((await call("model_get", { id: "app.payments" })).json()).toMatchObject({ decisions: ["d-001"] });
  });

  it("rejects a decision that names unknown parts of the model", async () => {
    await call("model_upsert", SHOP);
    const result = await call("ledger_append", { ...decision, affects: ["app.queue"] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/app.queue/);
    expect(await readLedger(viewportPaths(root).ledger)).toEqual([]);
  });

  it("runs concurrent appends one at a time", async () => {
    await call("model_upsert", SHOP);
    const results = await Promise.all([call("ledger_append", decision), call("ledger_append", decision), call("ledger_append", decision)]);
    expect(results.map((r) => r.json().id).sort()).toEqual(["D-001", "D-002", "D-003"]);
  });
});

describe("flag and engage tools", () => {
  it("lists pending flags and resolves one", async () => {
    const db = openState(viewportPaths(root).stateDb);
    const flag = raiseFlag(db, "app.orders", "Why does storage import orders?");
    db.close();

    expect((await call("flags_pending")).json()).toMatchObject([{ id: flag.id, subject: "app.orders" }]);
    const unknownDecision = await call("flags_resolve", { id: flag.id, answer: "See D-004", decision: "D-004" });
    expect(unknownDecision.isError).toBe(true);
    expect((await call("flags_resolve", { id: flag.id, answer: "It is a cycle to break next" })).json()).toMatchObject({ status: "resolved" });
    expect((await call("flags_pending")).json()).toEqual([]);
  });

  it("stores quiz and prediction items", async () => {
    const result = await call("engage_write", {
      items: [
        { subject: "app.orders", kind: "what-if", question: "Payments is down. What does checkout do?" },
        { subject: "D-001", kind: "predict", question: "Sync or queue?", choices: ["Sync", "Queue"] },
      ],
    });
    expect(result.json()).toEqual({ ids: [1, 2] });
    expect((await call("engage_write", { items: [{ subject: "D-001", kind: "predict", question: "?" }] })).isError).toBe(true);
  });
});

describe("findRoot", () => {
  it("prefers --root, then CLAUDE_PROJECT_DIR, then the nearest .viewport directory", () => {
    expect(findRoot(["--root", "/a"], { CLAUDE_PROJECT_DIR: "/b" }, "/c")).toBe("/a");
    expect(findRoot([], { CLAUDE_PROJECT_DIR: "/b" }, "/c")).toBe("/b");
    expect(findRoot([], {}, join(root, "src", "shop"))).toBe(root);
  });
});
