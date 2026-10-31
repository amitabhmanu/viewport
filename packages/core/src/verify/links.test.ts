import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Config, type Model } from "../schema.js";
import { shopModelV2, shopTests, tempDir } from "../test-helpers.js";
import { applyReport, isClean, verify } from "./index.js";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/py-shop", import.meta.url));
const config = Config.parse({ version: 1, sources: ["src/**/*.py"], languages: ["python"] });
const meta = { source: "agent" as const, sync: "unverified" as const };

let root: string;
beforeEach(async () => {
  root = await tempDir();
  await cp(FIXTURE, root, { recursive: true });
  await shopTests(root);
});

describe("requirement and data links", () => {
  it("is clean when tests import what implements their steps and owners name their entities", async () => {
    const report = await verify(root, shopModelV2(), config);
    expect(report.unsupportedEdges).toEqual([]);
    expect(report.emptyTests).toEqual([]);
    expect(isClean(report)).toBe(true);
    const applied = applyReport(shopModelV2(), report);
    expect(applied.edges.find((e) => e.kind === "covers")?.sync).toBe("ok");
    expect(applied.edges.find((e) => e.kind === "owns")?.sync).toBe("ok");
    expect(applied.nodes.find((n) => n.id === "checkout-tests")?.sync).toBe("ok");
    // Not checked: no code names behind it, so it stays as the agent wrote it.
    expect(applied.edges.find((e) => e.kind === "runs_on")?.sync).toBe("unverified");
  });

  it("flags covers edges whose tests import nothing that implements what they cover", async () => {
    await writeFile(join(root, "tests/test_checkout.py"), "from shop.payments.gateway import charge\n");
    const report = await verify(root, shopModelV2(), config);
    expect(report.unsupportedEdges).toEqual(["covers:checkout-tests->ordering.place"]);
    expect(applyReport(shopModelV2(), report).edges.find((e) => e.kind === "covers")?.sync).toBe("stale");
  });

  it("follows covers on a process to its steps, and on a rule to what it constrains", async () => {
    const model = shopModelV2();
    model.edges = model.edges.filter((e) => e.kind !== "covers");
    model.edges.push(
      { ...meta, kind: "covers", from: "checkout-tests", to: "ordering" },
      { ...meta, kind: "covers", from: "checkout-tests", to: "refund-shipped" },
    );
    expect((await verify(root, model, config)).unsupportedEdges).toEqual([]);
  });

  it("flags data edges whose component never names the entity", async () => {
    const model: Model = shopModelV2();
    model.edges.push({ ...meta, kind: "reads", from: "app.payments", to: "order" });
    const entity = model.nodes.find((n) => n.id === "order");
    const report = await verify(root, model, config);
    expect(report.unsupportedEdges).toEqual(["reads:app.payments->order"]);
    // An entity with no code names is not checked.
    if (entity?.kind === "entity") entity.code = [];
    expect((await verify(root, model, config)).unsupportedEdges).toEqual([]);
  });

  it("reports test groups that match no files", async () => {
    const model = shopModelV2();
    model.nodes.push({ ...meta, kind: "test", id: "refund-tests", name: "Refund tests", paths: ["tests/test_refund*.py"] });
    const report = await verify(root, model, config);
    expect(report.emptyTests).toEqual(["refund-tests"]);
    expect(isClean(report)).toBe(false);
    expect(applyReport(model, report).nodes.find((n) => n.id === "refund-tests")?.sync).toBe("stale");
  });

  it("checks nothing new on an incremental run", async () => {
    await writeFile(join(root, "tests/test_checkout.py"), "x = 1\n");
    const report = await verify(root, shopModelV2(), config, { changedFiles: ["src/shop/orders/service.py"] });
    expect(report.unsupportedEdges).toEqual([]);
    expect(report.emptyTests).toEqual([]);
  });
});
