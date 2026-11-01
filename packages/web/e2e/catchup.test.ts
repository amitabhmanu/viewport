import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GateSettings, appendDecision, applyGrade, checkMilestone, gateCursor, initWorkspace, openState, readLedger, readModel, viewportPaths, writeModelFromAgent } from "@viewport/core";
import { type Daemon, startDaemon } from "@viewport/viewportd";
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Catch-up gates in the built viewer (pnpm build first): the panel, catching up, and the switch.
const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));
const WEB = fileURLToPath(new URL("../dist", import.meta.url));
const COMPONENTS = ["api", "orders", "payments", "notifications", "storage"];
const SHOP = {
  nodes: [
    { kind: "system", id: "shop", name: "Shop", purpose: "Take orders" },
    { kind: "container", id: "app", name: "App", role: "Runs the shop", tech: "Python" },
    ...COMPONENTS.map((c) => ({ kind: "component", id: `app.${c}`, name: c, role: `Handles ${c}`, paths: c === "api" ? ["src/shop/api/**", "src/shop/__init__.py"] : [`src/shop/${c}/**`] })),
  ],
  edges: [
    { kind: "contains", from: "shop", to: "app" },
    ...COMPONENTS.map((c) => ({ kind: "contains", from: "app", to: `app.${c}` })),
    ...[
      ["api", "orders"],
      ["orders", "payments"],
      ["orders", "storage"],
      ["orders", "notifications"],
    ].map(([a, b]) => ({ kind: "depends_on", from: `app.${a}`, to: `app.${b}`, mode: "sync" })),
  ],
};

let root: string;
let daemon: Daemon;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "viewport-catchup-"));
  await cp(FIXTURE, root, { recursive: true });
  await initWorkspace(root);
  await writeModelFromAgent(root, SHOP);
  const paths = viewportPaths(root);
  const db = openState(paths.stateDb);
  gateCursor(db, new Date(Date.now() - 60_000));
  for (const [title, chosen, other] of [
    ["Pick a database", "Postgres", "SQLite"],
    ["How payments are called", "Synchronously", "Through a queue"],
    ["Where orders are validated", "In the service", "In the API"],
  ] as const) {
    await appendDecision(paths.ledger, {
      title,
      options: [
        { name: chosen, tradeoff: "Chosen" },
        { name: other, tradeoff: "Not chosen" },
      ],
      chosen,
      why: `Because ${chosen}`,
      reversibility: "easy",
      blastRadius: 1,
      affects: ["app.storage"],
    });
  }
  // Three decisions and the two components they shape (storage, and orders, which depends on it); four make the gate.
  const settings = GateSettings.parse({});
  expect(checkMilestone(db, await readModel(paths.model), await readLedger(paths.ledger), settings, "s1")).toBeDefined();
  db.close();
  daemon = await startDaemon(root, { webRoot: WEB });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(`http://127.0.0.1:${daemon.port}/?token=${daemon.token}`);
});
afterAll(async () => {
  await browser?.close();
  await daemon?.close();
});

describe("catch-up gates", () => {
  it("shows the open gate first, and passes it as the developer catches up", async () => {
    const panel = page.locator(".catch-up");
    await panel.getByText("Catch up before Claude carries on").waitFor();
    await panel.getByText(/0 of \d caught up/).waitFor();
    expect(await panel.locator("[data-gate-subject]").count()).toBe(4);

    // A prediction card for an unguessed decision, otherwise the gate's question. The first guess is wrong,
    // so that decision comes back as a question to answer.
    let wrongOnce = false;
    for (let round = 0; round < 8 && (await panel.locator("[data-gate-subject]").count()) > 0; round++) {
      const item = panel.locator("[data-gate-subject]").first();
      const subject = (await item.getAttribute("data-gate-subject"))!;
      if ((await item.locator(".predict").count()) > 0) {
        const d = (await readLedger(viewportPaths(root).ledger)).find((x) => x.id === subject)!;
        const guess = wrongOnce ? d.chosen : d.options.find((o) => o.name !== d.chosen)!.name;
        await item.getByRole("button", { name: new RegExp(guess) }).click();
        if (!wrongOnce) {
          wrongOnce = true;
          await panel.locator(`[data-gate-subject="${subject}"] textarea`).waitFor();
          continue;
        }
      } else {
        await item.getByRole("radio", { name: "Sure", exact: true }).click();
        await item.getByLabel("Your answer").fill("It keeps orders, and everything that saves one depends on it");
        await item.getByRole("button", { name: "Answer" }).click();
        await panel.getByText("Claude is checking your answer").waitFor();
        const db = openState(viewportPaths(root).stateDb);
        const { id } = db.prepare("SELECT MAX(id) AS id FROM quiz_answers").get() as { id: number };
        applyGrade(db, id, { grade: "correct", feedback: "Yes" });
        db.close();
      }
      await expect.poll(() => panel.locator(`[data-gate-subject="${subject}"]`).count()).toBe(0);
    }
    expect(wrongOnce).toBe(true);
    await page.getByText("You're caught up.").waitFor();
  });

  it("switches gates off and on from Today", async () => {
    const config = () => readFile(viewportPaths(root).config, "utf8").then((t) => JSON.parse(t) as { gates: { enabled: boolean } });
    await page.locator(".gate-switch").getByRole("button", { name: "Turn off" }).click();
    await page.locator(".gate-switch").getByRole("button", { name: "Turn on" }).waitFor();
    expect((await config()).gates.enabled).toBe(false);
    await page.locator(".gate-switch").getByRole("button", { name: "Turn on" }).click();
    await page.locator(".gate-switch").getByRole("button", { name: "Turn off" }).waitFor();
    expect((await config()).gates.enabled).toBe(true);
  });
});
