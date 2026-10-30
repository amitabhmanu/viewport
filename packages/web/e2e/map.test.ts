import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendDecision, initWorkspace, openState, viewportPaths, writeModelFromAgent } from "@viewport/core";
import { type Daemon, startDaemon } from "@viewport/viewportd";
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Drives the built viewer (pnpm build first) against a daemon serving the py-shop fixture.
const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));
const WEB = fileURLToPath(new URL("../dist", import.meta.url));
const COMPONENTS = ["api", "orders", "payments", "notifications", "storage"];
const SHOP = {
  nodes: [
    { kind: "system", id: "shop", name: "Shop", purpose: "Take orders" },
    { kind: "actor", id: "buyer", name: "Buyer", goal: "Buy things" },
    { kind: "container", id: "app", name: "App", role: "Runs the shop", tech: "Python" },
    ...COMPONENTS.map((c) => ({
      kind: "component",
      id: `app.${c}`,
      name: c,
      role: `Handles ${c}`,
      paths: c === "api" ? ["src/shop/api/**", "src/shop/__init__.py"] : [`src/shop/${c}/**`],
    })),
  ],
  edges: [
    { kind: "contains", from: "shop", to: "app" },
    { kind: "uses", from: "buyer", to: "shop" },
    ...COMPONENTS.map((c) => ({ kind: "contains", from: "app", to: `app.${c}` })),
    ...[
      ["api", "orders", "sync"],
      ["orders", "payments", "sync"],
      ["orders", "storage", "sync"],
      ["orders", "notifications", "async"],
    ].map(([a, b, mode]) => ({ kind: "depends_on", from: `app.${a}`, to: `app.${b}`, mode })),
  ],
};

const SEARCH = { kind: "component", id: "app.search", name: "search", role: "Finds products", paths: ["src/shop/search/**"] };

let root: string;
let daemon: Daemon;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "viewport-web-"));
  await cp(FIXTURE, root, { recursive: true });
  await initWorkspace(root);
  await writeModelFromAgent(root, SHOP);
  daemon = await startDaemon(root, { webRoot: WEB });
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
  await daemon?.close();
});

const node = (id: string) => page.locator(`[data-node="${id}"]`);

describe("viewer", () => {
  it("opens on Today and keeps the token out of the address bar", async () => {
    await page.goto(`http://127.0.0.1:${daemon.port}/?token=${daemon.token}`);
    await expect.poll(() => page.locator(".tile").first().textContent()).toContain("5");
    expect(page.url()).not.toContain("token");
  });

  it("zooms from the overview to a container's components", async () => {
    await page.getByRole("link", { name: "Map" }).click();
    await node("shop").waitFor();
    expect(await node("buyer").count()).toBe(1);
    await node("shop").dblclick();
    await node("app").waitFor();
    await node("app").dblclick();
    await node("app.orders").waitFor();
    expect(await page.locator(".crumbs").textContent()).toBe("OverviewContainersApp");
    expect(await page.locator('[data-edge="depends_on:app.orders->app.notifications"]').getAttribute("class")).toContain("async");
  });

  it("keeps the selection across a level switch", async () => {
    await node("app.orders").click();
    await page.locator(".panel h2").getByText("orders").waitFor();
    await page.getByRole("radio", { name: "Simple" }).click();
    await expect.poll(() => page.url()).toContain("level=simple");
    expect(await node("app.orders").getAttribute("class")).toContain("selected");
  });

  it("shows a model change within a second", async () => {
    await page.getByRole("radio", { name: "Complex" }).click();
    await expect.poll(() => page.url()).toContain("level=complex");
    await node("app.orders").waitFor();
    const start = Date.now();
    await writeModelFromAgent(root, {
      nodes: [...SHOP.nodes, SEARCH],
      edges: [...SHOP.edges, { kind: "contains", from: "app", to: "app.search" }],
    });
    await node("app.search").waitFor({ timeout: 3000 });
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("lists what changed since the last look and clears an item once opened", async () => {
    await page.getByRole("link", { name: "Today" }).click();
    const item = page.locator(".changes li", { hasText: "search" });
    await item.waitFor();
    expect(await item.textContent()).toContain("New");
    await item.getByRole("link").click();
    await node("app.search").waitFor();
    expect(page.url()).toContain("focus=app.search");
    await page.getByRole("link", { name: "Today" }).click();
    await page.getByText("You are up to date.").waitFor();
  });

  it("highlights a change on the Map until it is opened", async () => {
    await writeModelFromAgent(root, {
      nodes: [...SHOP.nodes.map((n) => (n.id === "app.orders" ? { ...n, role: "Takes and refunds orders" } : n)), SEARCH],
      edges: [...SHOP.edges, { kind: "contains", from: "app", to: "app.search" }],
    });
    await page.goto(`http://127.0.0.1:${daemon.port}/map?view=components:app&level=complex`);
    await expect.poll(() => node("app.orders").getAttribute("class")).toContain("fresh");
    await node("app.orders").click();
    await expect.poll(() => node("app.orders").getAttribute("class")).not.toContain("fresh");
  });

  it("ranks the ledger by blast radius and filters by reversibility", async () => {
    const decision = (id: string, title: string, blastRadius: number, reversibility: "easy" | "one-way") => ({
      id,
      at: new Date().toISOString(),
      title,
      options: [
        { name: "A", tradeoff: "a" },
        { name: "B", tradeoff: "b" },
      ],
      chosen: "A",
      why: "because",
      reversibility,
      blastRadius,
    });
    await appendDecision(join(root, ".viewport", "ledger.jsonl"), decision("D-001", "Small call", 1, "easy"));
    await appendDecision(join(root, ".viewport", "ledger.jsonl"), decision("D-002", "Big call", 4, "one-way"));
    await page.getByRole("link", { name: "Ledger" }).click();
    await expect.poll(() => page.locator(".decision h2").allTextContents()).toEqual(["Big call", "Small call"]);
    await expect.poll(() => page.locator(".decision.fresh").count()).toBe(2);
    await page.getByRole("radio", { name: "Easy" }).click();
    await expect.poll(() => page.locator(".decision h2").allTextContents()).toEqual(["Small call"]);
    await page.locator("#D-001 .decision-head").click();
    await page.getByRole("radio", { name: "All" }).click();
    await expect.poll(() => page.locator(".decision.fresh h2").allTextContents()).toEqual(["Big call"]);
  });

  it("asks what depends on a part, pins the answer and logs the question", async () => {
    await page.goto(`http://127.0.0.1:${daemon.port}/map?view=components:app&focus=app.storage`);
    await page.getByRole("link", { name: "What depends on it" }).click();
    await page.locator(".ask h2", { hasText: "What depends on storage" }).waitFor();
    await node("app.api").waitFor();
    expect(await page.locator(".ask [data-node]").count()).toBe(3);
    await page.getByRole("button", { name: "Pin" }).click();
    await page.locator(".pins li", { hasText: "What depends on storage" }).waitFor();

    await page.getByRole("radio", { name: "Slice" }).click();
    await page.getByLabel("Show").selectOption({ label: "Async dependencies" });
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.locator(".ask h2", { hasText: "Async dependencies" }).waitFor();
    await node("app.notifications").waitFor();

    await page.locator(".pins a", { hasText: "What depends on storage" }).click();
    await node("app.api").waitFor();
    expect(page.url()).toContain("direction=upstream");
    await node("app.orders").click();
    await expect.poll(() => page.url()).toContain("/map?view=components%3Aapp&focus=app.orders");

    const db = openState(viewportPaths(root).stateDb);
    const asked = db.prepare("SELECT payload FROM events WHERE kind = 'query'").all() as { payload: string }[];
    db.close();
    expect(asked.map((e) => JSON.parse(e.payload).q)).toEqual(["trace", "slice", "trace"]);
  });

  it("asks for a guess before revealing a decision, from Today and the Ledger", async () => {
    await page.getByRole("link", { name: "Today" }).click();
    const card = page.locator('[data-decision="D-002"]');
    await card.waitFor();
    expect(await page.locator("body").textContent()).not.toContain("because");
    await card.getByRole("button", { name: /^B/ }).click();
    await page.locator('[data-decision="D-002"]').waitFor({ state: "detached" });
    await page.getByRole("link", { name: "Ledger" }).click();
    await page.locator("#D-002 .result.wrong").getByText("You picked B; Claude chose A.").waitFor();
    await page.locator("#D-001").getByRole("button", { name: "Skip and reveal" }).click();
    await page.locator("#D-001 .result").getByText("You skipped this one.").waitFor();
    expect(await page.locator("#D-001").textContent()).toContain("Chose A.");
  });
});
