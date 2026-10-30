import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ELEMENT_BUDGET, type SplitView, initWorkspace, writeModelFromAgent } from "@viewport/core";
import { type Daemon, startDaemon } from "@viewport/viewportd";
import { type Browser, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The Phase 3 gate: a scripted build shows on the Map within a second of each model
// change, and a 30-component model renders every view within the element budget at medium.
const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));
const WEB = fileURLToPath(new URL("../dist", import.meta.url));
const CONTAINERS = ["web", "core", "jobs"];

/** `count` components spread over three containers, each depending on the one before it in its container and on one across. */
function model(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `${CONTAINERS[i % 3]}.c${String(i).padStart(2, "0")}`);
  return {
    nodes: [
      { kind: "system", id: "sys", name: "System", purpose: "Gate fixture" },
      ...CONTAINERS.map((c) => ({ kind: "container", id: c, name: c, role: `The ${c} container` })),
      ...ids.map((id) => ({ kind: "component", id, name: id.split(".")[1], role: `Does ${id}`, paths: [`src/${id.replace(".", "/")}/**`] })),
    ],
    edges: [
      ...CONTAINERS.map((c) => ({ kind: "contains", from: "sys", to: c })),
      ...ids.map((id) => ({ kind: "contains", from: id.split(".")[0], to: id })),
      ...ids.slice(3).map((id, i) => ({ kind: "depends_on", from: id, to: ids[i]!, mode: i % 4 === 0 ? "async" : "sync" })),
      ...ids.slice(1).filter((_, i) => i % 5 === 0).map((id, i) => ({ kind: "depends_on", from: id, to: ids[i * 5]!, mode: "sync" })),
    ].filter((e, i, all) => e.from !== e.to && all.findIndex((x) => x.kind === e.kind && x.from === e.from && x.to === e.to) === i),
  };
}

let root: string;
let daemon: Daemon;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "viewport-gate-"));
  await cp(FIXTURE, root, { recursive: true });
  await initWorkspace(root);
  await writeModelFromAgent(root, model(6));
  daemon = await startDaemon(root, { webRoot: WEB });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`http://127.0.0.1:${daemon.port}/map?view=containers&level=complex&token=${daemon.token}`);
  await page.locator('[data-node="web"]').waitFor();
});
afterAll(async () => {
  await browser?.close();
  await daemon?.close();
});

describe("Phase 3 gate", () => {
  it("shows each step of a scripted build on the Map within a second", async () => {
    await page.goto(`http://127.0.0.1:${daemon.port}/map?view=components:web&level=complex`);
    const timings: number[] = [];
    for (let n = 9; n <= 30; n += 3) {
      const start = Date.now();
      await writeModelFromAgent(root, model(n));
      const newest = `web.c${String(n - 3).padStart(2, "0")}`;
      await page.locator(`[data-node="${newest}"]`).waitFor({ timeout: 5000 });
      timings.push(Date.now() - start);
    }
    expect(Math.max(...timings)).toBeLessThan(1000);
  });

  it("renders every view of a 30-component model within the element budget at medium", async () => {
    const views = ["overview", "containers", ...CONTAINERS.map((c) => `components:${c}`)];
    for (const name of views) {
      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/view?name=${name}&level=medium`, { headers: { authorization: `Bearer ${daemon.token}` } });
      const parts = (await res.json()) as SplitView[];
      for (const part of parts) {
        expect(part.elements.length).toBeLessThanOrEqual(ELEMENT_BUDGET.medium);
        const start = Date.now();
        await page.goto(`http://127.0.0.1:${daemon.port}/map?view=${encodeURIComponent(name)}&part=${part.part}`);
        await page.locator(`[data-node="${part.elements[0]}"]`).waitFor();
        const drawn = await page.locator("[data-node]:not(.stub)").count();
        expect(drawn).toBe(part.elements.length);
        expect(Date.now() - start).toBeLessThan(2000);
      }
    }
  });
});
