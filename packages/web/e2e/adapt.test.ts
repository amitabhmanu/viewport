import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerQuiz, appendDecision, applyGrade, initWorkspace, openState, viewportPaths, writeModelFromAgent, writeQuizItems } from "@viewport/core";
import { type Daemon, startDaemon } from "@viewport/viewportd";
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 10 in the built viewer (pnpm build first): levels, suggestions, debt, digest and changes by process.
const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));
const WEB = fileURLToPath(new URL("../dist", import.meta.url));
const COMPONENTS = ["api", "orders", "payments", "notifications", "storage"];
const SHOP = {
  nodes: [
    { kind: "system", id: "shop", name: "Shop", purpose: "Take orders" },
    { kind: "actor", id: "buyer", name: "Buyer", goal: "Buy things" },
    { kind: "container", id: "app", name: "App", role: "Runs the shop", tech: "Python" },
    ...COMPONENTS.map((c) => ({ kind: "component", id: `app.${c}`, name: c, role: `Handles ${c}`, paths: c === "api" ? ["src/shop/api/**", "src/shop/__init__.py"] : [`src/shop/${c}/**`] })),
    { kind: "process", id: "ordering", name: "Ordering", goal: "Buy things" },
    { kind: "step", id: "ordering.place", name: "Place order", does: "Save it" },
  ],
  edges: [
    { kind: "contains", from: "shop", to: "app" },
    { kind: "uses", from: "buyer", to: "shop" },
    ...COMPONENTS.map((c) => ({ kind: "contains", from: "app", to: `app.${c}` })),
    ...[
      ["api", "orders"],
      ["orders", "payments"],
      ["orders", "storage"],
      ["orders", "notifications"],
    ].map(([a, b]) => ({ kind: "depends_on", from: `app.${a}`, to: `app.${b}`, mode: "sync" })),
    { kind: "contains", from: "ordering", to: "ordering.place" },
    { kind: "implements", from: "app.orders", to: "ordering.place" },
  ],
};
const VIEW = "/map?view=components:app";

let root: string;
let daemon: Daemon;
let browser: Browser;
let page: Page;
const open = (path: string) => page.goto(`http://127.0.0.1:${daemon.port}${path}`);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "viewport-adapt-"));
  await cp(FIXTURE, root, { recursive: true });
  await initWorkspace(root);
  await writeModelFromAgent(root, { nodes: SHOP.nodes.filter((n) => n.kind !== "process" && n.kind !== "step"), edges: SHOP.edges.filter((e) => e.kind !== "implements" && e.from !== "ordering") });
  await appendDecision(join(root, ".viewport", "ledger.jsonl"), {
    title: "Pick a database",
    options: [
      { name: "Postgres", tradeoff: "Heavy" },
      { name: "SQLite", tradeoff: "Local" },
    ],
    chosen: "Postgres",
    why: "Several writers",
    reversibility: "one-way",
    blastRadius: 3,
  });
  daemon = await startDaemon(root, { webRoot: WEB });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await open(`/?token=${daemon.token}`);
});
afterAll(async () => {
  await browser?.close();
  await daemon?.close();
});

describe("adapting to the developer", () => {
  it("nudges about a one-way decision until it is looked at, without blocking anything", async () => {
    await page.locator(".one-way-nudge", { hasText: "Pick a database" }).waitFor();
    await page.locator(".digest", { hasText: "1 new decision since yesterday" }).waitFor();
    expect(await page.getByRole("link", { name: "Ledger" }).locator(".nav-count").textContent()).toBe("1");
    await page.getByRole("link", { name: "Ledger" }).click();
    await page.locator("#D-001").getByRole("button", { name: "Skip and reveal" }).click();
    await page.locator("#D-001 .result").waitFor();
    await page.getByRole("link", { name: "Today" }).click();
    await page.locator(".digest").waitFor();
    await expect.poll(() => page.locator(".one-way-nudge").count()).toBe(0);
    expect(await page.locator(".nav-count").count()).toBe(0);
  });

  it("groups changes by process and shows where the developer knows least", async () => {
    await writeModelFromAgent(root, { nodes: SHOP.nodes.map((n) => (n.id === "app.storage" ? { ...n, role: "Keeps orders on disk" } : n)), edges: SHOP.edges });
    await page.locator("h3", { hasText: "Ordering" }).waitFor();
    await page.locator("h3", { hasText: "Everything else" }).waitFor();
    expect(await page.locator(".tile", { hasText: "Not yet understood" }).textContent()).toContain("100%");
    expect(await page.locator(".debt-list li").first().textContent()).toContain("a change here touches 2 parts");
    await page.locator(".tile", { hasText: "Not yet understood" }).click();
    await expect.poll(() => page.url()).toContain("overlay=debt");
    await expect.poll(() => page.locator(".node.debt-high").count()).toBeGreaterThan(0);
  });

  it("shades the Map on request and carries it from view to view", async () => {
    await open(VIEW);
    await page.locator('[data-node="app.orders"]').waitFor();
    expect(await page.locator(".node.debt-high").count()).toBe(0);
    await page.getByRole("button", { name: "What I know least" }).click();
    await expect.poll(() => page.locator('[data-node="app.orders"]').getAttribute("class")).toContain("debt-high");
    expect(await page.locator('[data-node="app.orders"]').textContent()).toContain("Least known");
    await page.getByRole("button", { name: "What I know least" }).click();
    await expect.poll(() => page.locator(".node.debt-high").count()).toBe(0);
  });

  it("remembers a level per view, and a level in a link does not overwrite it", async () => {
    await open(VIEW);
    await page.getByRole("radio", { name: "Simple" }).click();
    await expect.poll(() => page.url()).toContain("level=simple");
    await open(VIEW);
    await expect.poll(() => page.getByRole("radio", { name: "Simple" }).getAttribute("aria-checked")).toBe("true");
    await open("/map?view=containers");
    await expect.poll(() => page.getByRole("radio", { name: "Medium" }).getAttribute("aria-checked")).toBe("true");
    await open(`${VIEW}&level=complex`);
    await expect.poll(() => page.getByRole("radio", { name: "Complex" }).getAttribute("aria-checked")).toBe("true");
    await open(VIEW);
    await expect.poll(() => page.getByRole("radio", { name: "Simple" }).getAttribute("aria-checked")).toBe("true");
    // Back to Medium has no level in its link, and must stick all the same.
    await page.getByRole("radio", { name: "Medium" }).click();
    await expect.poll(() => page.getByRole("radio", { name: "Medium" }).getAttribute("aria-checked")).toBe("true");
    await expect.poll(async () => (await page.evaluate(async (t) => (await fetch("/api/levels?view=components:app", { headers: { authorization: `Bearer ${t}` } })).json(), daemon.token)).level).toBe("medium");
  });

  it("suggests a level from quiz results, and only moves when asked", async () => {
    const db = openState(viewportPaths(root).stateDb);
    for (const i of [1, 2, 3]) {
      const [id] = writeQuizItems(db, [{ subject: "app.orders", kind: "why", question: `Q${i}`, answer: "a" }]);
      const { answerId } = answerQuiz(db, id!, "my answer", 3);
      applyGrade(db, answerId, { grade: "correct", feedback: "Yes" });
    }
    db.close();
    await open(VIEW);
    const prompt = page.locator(".suggestion");
    await prompt.getByText("You got 3 of 3 questions about this right. Try Complex here?").waitFor();
    expect(await page.getByRole("radio", { name: "Medium" }).getAttribute("aria-checked")).toBe("true");
    await prompt.getByRole("button", { name: "Not now" }).click();
    await expect.poll(() => prompt.count()).toBe(0);
    expect(await page.getByRole("radio", { name: "Medium" }).getAttribute("aria-checked")).toBe("true");
    await open(VIEW);
    await page.locator('[data-node="app.orders"]').waitFor();
    expect(await prompt.count()).toBe(0);
  });
});
