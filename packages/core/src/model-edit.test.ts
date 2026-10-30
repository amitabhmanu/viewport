import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { readLedger } from "./ledger.js";
import { ModelEditError, blastRadius, mergeIntoModel, recordDecision, removeFromModel } from "./model-edit.js";
import { readModel } from "./model-store.js";
import { viewportPaths } from "./paths.js";
import { Model } from "./schema.js";
import { shopModel, tempDir } from "./test-helpers.js";
import { initWorkspace, writeModelFromAgent } from "./workspace.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));

describe("mergeIntoModel", () => {
  it("replaces nodes by id and edges by key, and adds new ones", () => {
    const merged = mergeIntoModel(shopModel(), {
      nodes: [{ kind: "component", id: "app.orders", name: "Orders", role: "Takes orders", paths: ["src/shop/orders/**"] }],
      edges: [
        { kind: "depends_on", from: "app.orders", to: "app.notifications", mode: "sync" },
        { kind: "depends_on", from: "app.orders", to: "app.storage", mode: "data" },
      ],
    });
    expect(Model.parse(merged).nodes.find((n) => n.id === "app.orders")).toMatchObject({ role: "Takes orders" });
    const deps = merged.edges.filter((e) => e.kind === "depends_on" && e.from === "app.orders");
    expect(deps.map((e) => [e.to, e.mode])).toEqual([
      ["app.notifications", "sync"],
      ["app.storage", "data"],
    ]);
  });

  it("rejects a malformed item", () => {
    expect(() => mergeIntoModel(shopModel(), { edges: [{ kind: "depends_on", from: "a", to: "b" }] })).toThrow(/mode/);
  });
});

describe("removeFromModel", () => {
  it("drops edges touching removed nodes and decided_by links from removed edges", () => {
    const pruned = removeFromModel(shopModel(), { nodes: ["app.notifications"] });
    expect(pruned.edges.some((e) => e.from === "app.notifications" || e.to === "app.notifications")).toBe(false);
    expect(pruned.edges.some((e) => e.kind === "decided_by")).toBe(false);
    expect(() => Model.parse(pruned)).not.toThrow();
  });

  it("names what it cannot find", () => {
    expect(() => removeFromModel(shopModel(), { nodes: ["nope"], edges: ["uses:a->b"] })).toThrow(ModelEditError);
  });

  it("leaves children in place, so removing their container fails validation", () => {
    expect(() => Model.parse(removeFromModel(shopModel(), { nodes: ["app"] }))).toThrow(/not inside any container/);
  });
});

describe("blastRadius", () => {
  it("counts named components and their direct dependents", () => {
    expect(blastRadius(shopModel(), ["app.notifications"])).toEqual(["app.notifications", "app.orders"]);
  });

  it("resolves edges, containers and externals to components", () => {
    const model = shopModel();
    expect(blastRadius(model, ["depends_on:app.api->app.orders"])).toEqual(["app.api", "app.orders"]);
    expect(blastRadius(model, ["app"])).toHaveLength(5);
    expect(blastRadius(model, ["payment-provider"])).toEqual(["app.payments"]);
    expect(blastRadius(model, ["customer", "d-001"])).toEqual([]);
  });
});

describe("recordDecision", () => {
  let root: string;
  beforeEach(async () => {
    root = await tempDir();
    await cp(FIXTURE, root, { recursive: true });
    await initWorkspace(root);
    const { nodes, edges } = removeFromModel(shopModel(), { nodes: ["d-001"] });
    await writeModelFromAgent(root, { nodes, edges });
  });

  const queue = {
    title: "Queue between orders and notifications",
    options: [
      { name: "In-process queue", tradeoff: "Simple, lost on restart" },
      { name: "Redis stream", tradeoff: "Durable, one more service" },
    ],
    chosen: "In-process queue",
    why: "No durability requirement yet",
    reversibility: "easy" as const,
    affects: ["depends_on:app.orders->app.notifications"],
  };

  it("appends to the ledger with a computed blast radius and links the decision into the model", async () => {
    const { decision, touched } = await recordDecision(root, queue);
    expect(decision.id).toBe("D-001");
    expect(touched).toEqual(["app.api", "app.notifications", "app.orders"]);
    expect(decision.blastRadius).toBe(3);

    const model = await readModel(viewportPaths(root).model);
    expect(model.nodes.find((n) => n.id === "d-001")).toMatchObject({ kind: "decision", blastRadius: 3 });
    expect(model.edges).toContainEqual(expect.objectContaining({ kind: "decided_by", from: queue.affects[0], to: "d-001" }));
  });

  it("writes nothing when affects names something unknown", async () => {
    await expect(recordDecision(root, { ...queue, affects: ["app.queue"] })).rejects.toThrow(/app.queue/);
    expect(await readLedger(viewportPaths(root).ledger)).toEqual([]);
  });

  it("writes nothing when chosen is not an option", async () => {
    const before = await readFile(viewportPaths(root).model, "utf8");
    await expect(recordDecision(root, { ...queue, chosen: "SQS" })).rejects.toThrow(/chosen/);
    expect(await readLedger(viewportPaths(root).ledger)).toEqual([]);
    expect(await readFile(join(root, ".viewport/model.json"), "utf8")).toBe(before);
  });

  it("checks supersedes against the ledger", async () => {
    await expect(recordDecision(root, { ...queue, supersedes: "D-009" })).rejects.toThrow(/D-009/);
    await recordDecision(root, queue);
    const { decision } = await recordDecision(root, { ...queue, chosen: "Redis stream", supersedes: "D-001" });
    expect(decision).toMatchObject({ id: "D-002", supersedes: "D-001" });
  });
});
