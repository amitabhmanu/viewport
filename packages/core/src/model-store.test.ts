import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readModel, serializeModel, writeModel } from "./model-store.js";
import { shopModel, tempDir } from "./test-helpers.js";

describe("model store", () => {
  it("reads a missing file as an empty model", async () => {
    const m = await readModel(join(await tempDir(), "model.json"));
    expect(m).toEqual({ version: 1, revision: 0, nodes: [], edges: [] });
  });

  it("round-trips and bumps the revision", async () => {
    const path = join(await tempDir(), ".viewport", "model.json");
    const written = await writeModel(path, shopModel());
    expect(written.revision).toBe(1);
    const read = await readModel(path);
    expect(read).toEqual(written);
    expect((await writeModel(path, read)).revision).toBe(2);
  });

  it("serializes the same model identically regardless of input order", () => {
    const a = shopModel();
    const b = shopModel();
    b.nodes.reverse();
    b.edges.reverse();
    b.nodes = b.nodes.map((n) => Object.fromEntries(Object.entries(n).reverse()) as typeof n);
    expect(serializeModel(b)).toBe(serializeModel(a));
  });

  it("orders nodes by kind, then id", async () => {
    const text = serializeModel(shopModel());
    const ids = (JSON.parse(text) as { nodes: { id: string }[] }).nodes.map((n) => n.id);
    expect(ids).toEqual([
      "shop",
      "customer",
      "payment-provider",
      "app",
      "app.api",
      "app.notifications",
      "app.orders",
      "app.payments",
      "app.storage",
      "d-001",
    ]);
  });

  it("refuses to write an invalid model and leaves the old file and no temp files", async () => {
    const dir = await tempDir();
    const path = join(dir, "model.json");
    await writeModel(path, shopModel());
    const before = await readFile(path, "utf8");
    const bad = shopModel();
    bad.edges.push({ kind: "uses", from: "customer", to: "nowhere", source: "agent", sync: "unverified" });
    await expect(writeModel(path, bad)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await readdir(dir)).sort()).toEqual(["local", "model.json"]);
  });
});
