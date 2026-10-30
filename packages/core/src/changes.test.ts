import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changesSince, diffModels, markAllSeen, markSeen } from "./changes.js";
import { SNAPSHOTS_KEPT, readSnapshot, writeModel } from "./model-store.js";
import type { Decision, Model } from "./schema.js";
import { openState } from "./state.js";
import { shopModel, tempDir } from "./test-helpers.js";

const renamed = (m: Model): Model => ({ ...m, nodes: m.nodes.map((n) => (n.id === "app.orders" ? { ...n, role: "Order lifecycle and refunds" } : n)) });
const withSearch = (m: Model): Model => ({
  ...m,
  nodes: [...m.nodes, { kind: "component", id: "app.search", name: "Search", role: "Finds products", paths: ["src/shop/search/**"], source: "agent", sync: "unverified" }],
  edges: [
    ...m.edges,
    { kind: "contains", from: "app", to: "app.search", source: "agent", sync: "unverified" },
    { kind: "depends_on", from: "app.api", to: "app.search", mode: "sync", source: "agent", sync: "unverified" },
  ],
});
const decision = (id: string, at: string): Decision => ({
  id,
  at,
  title: "Queue refunds",
  options: [
    { name: "Inline", tradeoff: "simple" },
    { name: "Queue", tradeoff: "resilient" },
  ],
  chosen: "Queue",
  why: "Provider is slow",
  reversibility: "easy",
  blastRadius: 2,
  affects: [],
  assumptions: [],
});

describe("diffModels", () => {
  it("reports added, removed and changed nodes and flow edges, ignoring sync bookkeeping", () => {
    const a = shopModel();
    const synced = { ...a, nodes: a.nodes.map((n) => ({ ...n, sync: "ok" as const })) };
    expect(diffModels(a, synced)).toEqual([]);
    const b = withSearch(renamed(a));
    expect(diffModels(a, b).map((c) => `${c.change} ${c.what} ${c.subject}`)).toEqual([
      "changed node app.orders",
      "added node app.search",
      "added edge depends_on:app.api->app.search",
    ]);
    const back = diffModels(b, a);
    expect(back.find((c) => c.subject === "app.search")).toMatchObject({ change: "removed", label: "Search", nodes: [] });
    expect(back.find((c) => c.subject === "depends_on:app.api->app.search")).toMatchObject({ label: "API → Search", nodes: ["app.api"] });
  });
});

describe("changesSince", () => {
  it("starts caught up, then lists changes until each is opened", async () => {
    const path = join(await tempDir(), ".viewport", "model.json");
    const db = openState(":memory:");
    let model = await writeModel(path, shopModel());
    expect(await changesSince(path, db, model, [], "2026-10-30T10:00:00.000Z")).toEqual({ since: 1, revision: 1, changes: [] });

    model = await writeModel(path, withSearch(renamed(model)));
    const ledger = [decision("D-001", "2026-10-30T09:00:00.000Z"), decision("D-002", "2026-10-30T11:00:00+01:00"), decision("D-003", "2026-10-30T12:00:00.000Z")];
    const first = await changesSince(path, db, model, ledger);
    expect(first.since).toBe(1);
    expect(first.changes.map((c) => c.subject)).toEqual(["app.orders", "app.search", "depends_on:app.api->app.search", "D-003"]);

    markSeen(db, ["app.search", "depends_on:app.api->app.search", "D-003"], model.revision);
    expect((await changesSince(path, db, model, ledger)).changes.map((c) => c.subject)).toEqual(["app.orders"]);

    // Opened, then changed again: new again.
    model = await writeModel(path, { ...model, nodes: model.nodes.map((n) => (n.id === "app.search" ? { ...n, role: "Finds and ranks products" } : n)) });
    expect((await changesSince(path, db, model, ledger)).changes.map((c) => c.subject)).toEqual(["app.orders", "app.search"]);

    markSeen(db, ["app.orders", "app.search"], model.revision);
    expect((await changesSince(path, db, model, ledger)).changes).toEqual([]);
    // The cursor caught up, so the next change is measured from here.
    const next = await changesSince(path, db, await writeModel(path, renamed({ ...model, nodes: model.nodes.filter((n) => n.id !== "app.search"), edges: model.edges.filter((e) => e.to !== "app.search") })), ledger);
    expect(next.since).toBe(model.revision);
    expect(next.changes.map((c) => `${c.change} ${c.subject}`)).toEqual(["removed app.search", "removed depends_on:app.api->app.search"]);

    markAllSeen(db, next.revision);
    expect((await changesSince(path, db, await readSnapshot(path, next.revision) as Model, ledger)).changes).toEqual([]);
  });

  it("restarts the cursor when no baseline snapshot survives", async () => {
    const path = join(await tempDir(), ".viewport", "model.json");
    const db = openState(":memory:");
    db.prepare("INSERT INTO cursors (name, revision, at) VALUES ('changes', 3, '2026-10-30T10:00:00.000Z')").run();
    const model = { ...shopModel(), revision: 7 };
    expect(await changesSince(path, db, model, [])).toMatchObject({ since: 7, changes: [] });
    expect(await readSnapshot(path, 7)).toBeDefined();
  });

  it("prunes old snapshots", async () => {
    const path = join(await tempDir(), ".viewport", "model.json");
    await writeModel(path, shopModel());
    const model = await writeModel(path, { ...shopModel(), revision: SNAPSHOTS_KEPT - 1 });
    expect(await readSnapshot(path, 1)).toBeDefined();
    await writeModel(path, model);
    expect(await readSnapshot(path, 1)).toBeUndefined();
    expect(await readSnapshot(path, SNAPSHOTS_KEPT + 1)).toBeDefined();
  });
});
