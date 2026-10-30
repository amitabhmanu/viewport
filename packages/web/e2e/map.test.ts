import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWorkspace, writeModelFromAgent } from "@viewport/core";
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
      nodes: [...SHOP.nodes, { kind: "component", id: "app.search", name: "search", role: "Finds products", paths: ["src/shop/search/**"] }],
      edges: [...SHOP.edges, { kind: "contains", from: "app", to: "app.search" }],
    });
    await node("app.search").waitFor({ timeout: 3000 });
    expect(Date.now() - start).toBeLessThan(1500);
  });
});
