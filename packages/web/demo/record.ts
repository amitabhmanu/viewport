import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openState, resolveFlag, unresolvedFlags, viewportPaths } from "@viewport/core";
import { startDaemon } from "@viewport/viewportd";
import { type Locator, type Page, chromium } from "playwright";
import { addSearch, seedDemo } from "./seed.js";

// Records a captioned walkthrough of the viewer to a .webm in the given directory.
// Run after `pnpm build`: tsx demo/record.ts <outDir>
const WEB = fileURLToPath(new URL("../dist", import.meta.url));
const outDir = process.argv[2] ?? "demo-out";
const W = 1280;
const H = 800;

const OVERLAY = `
(() => {
  const install = () => {
    if (document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = \`
      #demo-cursor { position: fixed; z-index: 2147483647; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none;
        transform: translate(-3px, -2px); transition: transform 40ms linear; }
      #demo-cursor.down svg { transform: scale(0.85); }
      #demo-ring { position: fixed; z-index: 2147483646; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%;
        border: 3px solid rgba(37, 99, 235, 0.7); pointer-events: none; opacity: 0; }
      #demo-ring.on { animation: demo-ring 450ms ease-out; }
      @keyframes demo-ring { from { opacity: 1; transform: scale(0.4); } to { opacity: 0; transform: scale(1.4); } }
      #demo-caption { position: fixed; z-index: 2147483645; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 1000px;
        background: rgba(17, 24, 39, 0.92); color: #fff; font: 500 21px/1.4 Inter, system-ui, sans-serif; padding: 12px 22px;
        border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.25); text-align: center; transition: opacity 250ms; pointer-events: none; }
      #demo-caption:empty { opacity: 0; }
    \`;
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 18 L6.5 13.5 L9.5 20.5 L12.5 19.2 L9.6 12.4 L16 12.4 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const ring = document.createElement("div");
    ring.id = "demo-ring";
    const caption = document.createElement("div");
    caption.id = "demo-caption";
    document.body.append(cursor, ring, caption);
    const pos = window.__demoPos ?? { x: ${W / 2}, y: ${H / 2} };
    cursor.style.transform = \`translate(\${pos.x - 3}px, \${pos.y - 2}px)\`;
    document.addEventListener("mousemove", (e) => {
      window.__demoPos = { x: e.clientX, y: e.clientY };
      cursor.style.transform = \`translate(\${e.clientX - 3}px, \${e.clientY - 2}px)\`;
    }, true);
    document.addEventListener("mousedown", (e) => {
      cursor.classList.add("down");
      ring.style.left = e.clientX + "px"; ring.style.top = e.clientY + "px";
      ring.classList.remove("on"); void ring.offsetWidth; ring.classList.add("on");
    }, true);
    document.addEventListener("mouseup", () => cursor.classList.remove("down"), true);
    window.__caption = (t) => { caption.textContent = t; };
  };
  if (document.body) install(); else document.addEventListener("DOMContentLoaded", install);
})();
`;

const card = (title: string, sub: string, foot = "") => `<!doctype html><html><body style="margin:0;height:100vh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;background:#faf9f7;font-family:Inter,system-ui,sans-serif;color:#111">
  <div style="font-size:64px;font-weight:700;letter-spacing:-1px">${title}</div>
  <div style="font-size:26px;color:#444;margin-top:18px;max-width:900px;text-align:center;line-height:1.4">${sub}</div>
  <div style="font-size:18px;color:#777;margin-top:36px">${foot}</div></body></html>`;

const root = await seedDemo();
const daemon = await startDaemon(root, { webRoot: WEB });
const base = `http://127.0.0.1:${daemon.port}`;
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: outDir, size: { width: W, height: H } } });
await context.addInitScript(OVERLAY);
const page = await context.newPage();
page.setDefaultTimeout(10000);

const wait = (ms: number) => page.waitForTimeout(ms);
const caption = async (text: string, hold = 0) => {
  await page.evaluate((t) => (window as unknown as { __caption: (t: string) => void }).__caption(t), text);
  if (hold) await wait(hold);
};
const moveTo = async (target: Locator, dx = 0.5, dy = 0.5) => {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width * dx, box.y + box.height * dy, { steps: 22 });
  await wait(250);
};
const click = async (target: Locator, opts: { dbl?: boolean; dx?: number; dy?: number } = {}) => {
  await moveTo(target, opts.dx, opts.dy);
  if (opts.dbl) await page.mouse.dblclick(...(await centre(target, opts)));
  else await page.mouse.click(...(await centre(target, opts)));
  await wait(500);
};
const centre = async (target: Locator, { dx = 0.5, dy = 0.5 } = {}): Promise<[number, number]> => {
  const box = (await target.boundingBox())!;
  return [box.x + box.width * dx, box.y + box.height * dy];
};
const type = async (target: Locator, text: string) => {
  await click(target);
  await page.keyboard.type(text, { delay: 45 });
  await wait(300);
};
const scrollTo = async (target: Locator, offset = 120) => {
  const y = await target.evaluate((el, off) => el.getBoundingClientRect().top + window.scrollY - off, offset);
  await page.evaluate(async (to) => {
    const from = window.scrollY;
    for (let i = 1; i <= 30; i++) {
      window.scrollTo(0, from + ((to - from) * (1 - Math.cos((Math.PI * i) / 30))) / 2);
      await new Promise((r) => setTimeout(r, 25));
    }
  }, y);
  await wait(400);
};
const node = (id: string) => page.locator(`[data-node="${id}"]`).first();
const answerFlags = (answer: string) => {
  const db = openState(viewportPaths(root).stateDb);
  for (const f of unresolvedFlags(db)) resolveFlag(db, f.id, answer);
  db.close();
};

async function scene(p: Page) {
  // Title.
  await p.setContent(card("Viewport", "Keep your mental model of the code<br>while Claude writes it.", "A Claude Code plugin · local viewer"));
  await wait(3500);

  // Today.
  await p.goto(`${base}/?token=${daemon.token}`);
  await p.locator(".tile").first().waitFor();
  await caption("Today: what Claude decided and changed since you last looked.", 3500);
  const predict = p.locator(".predict, [data-decision]").first();
  await scrollTo(predict, 140);
  await caption("Predict before you look: guess Claude's call, then see its reasoning.", 2200);
  await click(p.locator('[data-decision="D-003"]').getByRole("button", { name: /^SQLite/ }));
  await wait(2200);
  const quiz = p.locator(".quiz", { hasText: "Why is notifications async?" });
  await scrollTo(quiz, 140);
  await caption("Short questions, spaced over days, check what you really remember.", 1500);
  await click(quiz.getByRole("radio", { name: "Fairly sure" }));
  await type(quiz.getByLabel("Your answer"), "So a slow email never holds up checkout");
  await click(quiz.getByRole("button", { name: "Answer" }));
  await wait(1500);
  await caption("Claude grades each answer in the background, in plain words.", 1200);
  await scrollTo(p.locator(".answers"), 120);
  await wait(2500);
  await scrollTo(p.locator(".calibration"), 100);
  await caption("And it tracks how sure you felt against how right you were.", 3500);
  await caption("");

  // Map: zoom in.
  await p.evaluate(() => window.scrollTo(0, 0));
  await click(p.getByRole("link", { name: "Map" }));
  await node("shop").waitFor();
  await caption("The Map: a live model of the system that Claude keeps in the repo.", 3000);
  await caption("Double-click to zoom from the system down to its components.", 600);
  await click(node("shop"), { dbl: true });
  await node("app").waitFor();
  await wait(1200);
  await click(node("app"), { dbl: true });
  await node("app.orders").waitFor();
  await wait(1500);
  await caption("Solid arrows are calls; the dashed one is async, through a queue.", 3000);

  await click(node("app.orders"));
  await p.locator(".panel h2").first().waitFor();
  await caption("Click a part: what it does, the decisions behind it, and a takeaway at your level.", 3200);
  await click(p.getByRole("radio", { name: "Simple" }));
  await wait(1500);
  await click(p.getByRole("radio", { name: "Complex" }));
  await wait(2000);

  // Live change.
  await click(p.getByRole("button", { name: /^Fit$/ }));
  await caption("Meanwhile Claude adds a search component. The Map updates within a second.", 1500);
  await addSearch(root);
  await node("app.search").waitFor();
  await wait(1200);
  await moveTo(node("app.search"));
  await wait(2200);

  // Flag on an arrow.
  await caption("Any arrow or decision can carry a question for Claude.", 600);
  const arrow = p.getByRole("button", { name: "Dependency: orders to payments" });
  await moveTo(arrow);
  await arrow.focus();
  await p.keyboard.press("Enter");
  await p.locator(".panel h2", { hasText: "orders → payments" }).waitFor();
  await wait(2000);
  const panel = p.locator(".panel");
  const open = panel.getByRole("button", { name: "Flag a question" });
  if (await open.count()) await click(open);
  await type(panel.getByLabel("Question for Claude"), "Can a charge be retried on timeout?");
  await click(panel.getByRole("button", { name: "Flag", exact: true }));
  await caption("Claude sees the flag and must answer before its next edit.", 1800);
  answerFlags("Yes: payments is idempotent by order id, so a retry never charges twice.");
  await wait(3000);

  // Process flow.
  await caption("Requirements: the business processes, rules and assumptions.", 300);
  await click(p.locator(".phases").getByRole("button", { name: "Requirements" }));
  await wait(1200);
  const ordering = node("ordering");
  if (await ordering.count()) {
    await click(ordering, { dbl: true });
  }
  await node("ordering.place").waitFor();
  await wait(2500);
  await caption("An assumption only you can confirm is marked “To confirm”.", 300);
  await click(node("full-refund"));
  await wait(1500);
  await moveTo(p.getByRole("button", { name: "It holds" }));
  await wait(1500);
  await click(p.getByRole("button", { name: "It holds" }));
  await wait(2000);

  // Ctrl+K.
  await caption("Ctrl+K jumps to any part, from anywhere.", 600);
  await p.keyboard.press("Control+k");
  await wait(500);
  await p.keyboard.type("stor", { delay: 120 });
  await wait(1200);
  await p.keyboard.press("Enter");
  await p.locator(".panel h2", { hasText: /storage/i }).first().waitFor();
  await wait(2000);

  // Ask.
  await caption("Ask: what depends on storage? Pin the answer to come back to it.", 300);
  await click(p.getByRole("link", { name: "What depends on it" }));
  await p.locator(".ask h2").first().waitFor();
  await wait(2500);
  await click(p.getByRole("button", { name: "Pin" }));
  await wait(2500);

  // Ledger.
  await click(p.getByRole("link", { name: "Ledger" }));
  await p.locator(".decision").first().waitFor();
  await caption("The Ledger: every decision Claude made, ranked by how much it touches.", 3200);
  await click(p.getByRole("radio", { name: "One-way" }));
  await caption("Filter to the ones that are hard to undo.", 2500);
  await click(p.getByRole("radio", { name: "All" }));
  await wait(800);
  const d4 = p.locator("#D-004");
  await scrollTo(d4, 120);
  await caption("Even here, you guess first. A wrong guess is the point: now you know why.", 800);
  await click(d4.getByRole("button", { name: /^Every cancel/ }));
  await wait(3500);
  await caption("");

  // End.
  await p.setContent(card("Viewport", "Decisions, flags and spaced questions,<br>so you still know the system Claude built.", "Claude Code plugin · MCP · hooks · local viewer"));
  await wait(4000);
}

try {
  await scene(page);
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  await daemon.close();
  if (video) {
    const path = await video.path();
    await rename(path, join(outDir, "viewport-demo.webm"));
  }
  console.log("files", await readdir(outDir));
}
