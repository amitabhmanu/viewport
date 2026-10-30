import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWorkspace, openState, raiseFlag, readModel, recordDecision, resolveFlag, unresolvedFlags, viewportPaths, writeModelFromAgent } from "@viewport/core";
import { beforeEach, describe, expect, it } from "vitest";
import { DECISION_RULE, type HookInput, findWorkspace, postToolUse, sessionStart, stop, subagentStop } from "./hooks.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));
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
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "viewport-hooks-"));
  await cp(FIXTURE, root, { recursive: true });
  await initWorkspace(root);
  await writeModelFromAgent(root, SHOP);
});

const edit = (file: string, session = "s1"): HookInput => ({
  session_id: session,
  cwd: root,
  tool_name: "Edit",
  tool_input: { file_path: join(root, file) },
});

async function addFile(rel: string, text: string) {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), text);
}

function context(output: Record<string, unknown> | undefined): string {
  return ((output?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? "");
}

describe("findWorkspace", () => {
  it("finds .viewport above the session cwd, and nothing outside a workspace", async () => {
    expect(findWorkspace({ cwd: join(root, "src", "shop") }, {})).toBe(root);
    expect(findWorkspace({ cwd: await mkdtemp(join(tmpdir(), "viewport-none-")) }, {})).toBeUndefined();
  });
});

describe("sessionStart", () => {
  it("gives a short overview, the ledger size, open flags and the decision rule", async () => {
    await recordDecision(root, {
      title: "Sync payments",
      options: [
        { name: "Sync", tradeoff: "Simple" },
        { name: "Queue", tradeoff: "Decoupled" },
      ],
      chosen: "Sync",
      why: "Needs the result",
      reversibility: "costly",
      affects: ["depends_on:app.orders->app.payments"],
    });
    const db = openState(viewportPaths(root).stateDb);
    raiseFlag(db, "app.orders", "why sync?");
    db.close();

    const text = context(await sessionStart(root));
    expect(text).toContain("Shop: Take orders. Containers: app (5 components)");
    expect(text).toContain("Ledger: 1 decision, latest D-001");
    expect(text).toContain("1 unanswered question");
    expect(text).toContain(DECISION_RULE);
    expect(text.split("\n").length).toBeLessThanOrEqual(6);
  });
});

describe("postToolUse", () => {
  it("stays silent on an edit inside a modeled component", async () => {
    expect(await postToolUse(root, edit("src/shop/orders/service.py"))).toBeUndefined();
  });

  it("points out a new file no component owns", async () => {
    await addFile("src/shop/refunds/core.py", "x = 1\n");
    expect(context(await postToolUse(root, edit("src/shop/refunds/core.py")))).toMatch(/refunds\/core.py belongs to no component/);
  });

  it("ignores other tools, files outside the repo and Viewport's own files", async () => {
    expect(await postToolUse(root, { ...edit("x"), tool_name: "Read" })).toBeUndefined();
    expect(await postToolUse(root, { ...edit("x"), tool_input: { file_path: "/etc/hosts" } })).toBeUndefined();
    expect(await postToolUse(root, edit(".viewport/model.json"))).toBeUndefined();
  });

  it("passes on at most three pending flags per edit, each once", async () => {
    const db = openState(viewportPaths(root).stateDb);
    for (let i = 1; i <= 4; i++) raiseFlag(db, "app.orders", `question ${i}`, `2026-10-30T10:0${i}:00.000Z`);
    db.close();

    const first = context(await postToolUse(root, edit("src/shop/orders/service.py")));
    expect(first.match(/The developer flagged/g)).toHaveLength(3);
    expect(first).toContain("question 1");
    const second = context(await postToolUse(root, edit("src/shop/orders/service.py")));
    expect(second.match(/The developer flagged/g)).toHaveLength(1);
    expect(second).toContain("question 4");
    expect(await postToolUse(root, edit("src/shop/orders/service.py"))).toBeUndefined();
  });
});

describe("stop", () => {
  it("asks Claude to answer open flags before finishing, even without edits", async () => {
    const db = openState(viewportPaths(root).stateDb);
    const flag = raiseFlag(db, "app.orders", "why is this sync?");
    db.close();
    const out = await stop(root, { session_id: "s1", cwd: root });
    expect(out).toMatchObject({ decision: "block" });
    expect((out as { reason: string }).reason).toContain(`flag ${flag.id} on app.orders: "why is this sync?"`);
    expect(await stop(root, { session_id: "s1", cwd: root, stop_hook_active: true })).toBeUndefined();
    const after = openState(viewportPaths(root).stateDb);
    expect(unresolvedFlags(after)[0]?.status).toBe("delivered");
    resolveFlag(after, flag.id, "It needs the stock count before replying.");
    after.close();
    expect(await stop(root, { session_id: "s1", cwd: root })).toBeUndefined();
  });

  it("lets Claude finish when the session edited nothing", async () => {
    await addFile("src/shop/refunds/core.py", "x = 1\n");
    expect(await stop(root, { session_id: "s1", cwd: root })).toBeUndefined();
  });

  it("blocks once when this session's edits left the model behind", async () => {
    await addFile("src/shop/refunds/core.py", "x = 1\n");
    await addFile("src/shop/payments/extra.py", "from shop.notifications.queue import enqueue\n");
    await postToolUse(root, edit("src/shop/refunds/core.py"));
    await postToolUse(root, edit("src/shop/payments/extra.py"));

    const out = await stop(root, { session_id: "s1", cwd: root });
    expect(out?.decision).toBe("block");
    const reason = out?.reason as string;
    expect(reason).toContain("Files no component owns: src/shop/refunds/core.py");
    expect(reason).toContain("New dependencies the model lacks: app.payments -> app.notifications");
    expect(await stop(root, { session_id: "s1", cwd: root, stop_hook_active: true })).toBeUndefined();
  });

  it("marks a changed component reviewed instead of blocking when nothing structural changed", async () => {
    await addFile("src/shop/orders/extra.py", "from shop.storage.db import save\n");
    await postToolUse(root, edit("src/shop/orders/extra.py"));
    const before = await readModel(viewportPaths(root).model);
    expect(await stop(root, { session_id: "s1", cwd: root })).toBeUndefined();
    const after = await readModel(viewportPaths(root).model);
    expect(after.revision).toBe(before.revision + 1);
    const fingerprint = (m: typeof after) => m.nodes.find((n) => n.id === "app.orders" && n.kind === "component");
    expect(fingerprint(after)).not.toEqual(fingerprint(before));
  });

  it("counts files changed outside Claude's edit tools, as git sees them", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
    await addFile("src/shop/refunds/core.py", "x = 1\n");
    const out = await stop(root, { session_id: "s1", cwd: root });
    expect(out?.reason).toContain("Files no component owns: src/shop/refunds/core.py");
  });

  it("ignores gaps in files another session edited", async () => {
    await addFile("src/shop/refunds/core.py", "x = 1\n");
    await postToolUse(root, edit("src/shop/refunds/core.py", "other"));
    await postToolUse(root, edit("src/shop/orders/service.py", "s1"));
    expect(await stop(root, { session_id: "s1", cwd: root })).toBeUndefined();
  });
});

describe("subagentStop", () => {
  it("re-verifies and bumps the revision after the modeler, and only the modeler", async () => {
    const before = (await readModel(viewportPaths(root).model)).revision;
    await subagentStop(root, { agent_type: "general-purpose" });
    expect((await readModel(viewportPaths(root).model)).revision).toBe(before);

    await addFile("src/shop/orders/extra.py", "y = 2\n");
    await subagentStop(root, { agent_type: "viewport:viewport-modeler" });
    const after = await readModel(viewportPaths(root).model);
    expect(after.revision).toBe(before + 1);
    expect(after.nodes.find((n) => n.id === "app.orders")?.sync).toBe("stale");
  });
});
