import { execFileSync } from "node:child_process";
import { cp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Config, type Model } from "../schema.js";
import { completeShopModel, shopModel, tempDir } from "../test-helpers.js";
import { applyReport, coverage, filesByComponent, fingerprintFiles, isClean, listSources, verify } from "./index.js";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/py-shop", import.meta.url));
const config = Config.parse({ version: 1, sources: ["src/**/*.py"], languages: ["python"] });

let root: string;
beforeEach(async () => {
  root = await tempDir();
  await cp(FIXTURE, root, { recursive: true });
});

function pairs(report: Awaited<ReturnType<typeof verify>>): string[] {
  return report.missingDependencies.map((d) => `${d.from}->${d.to}`);
}

describe("verify (full) on py-shop", () => {
  it("finds the unclaimed package file and the dependencies the model misses", async () => {
    const report = await verify(root, shopModel(), config);
    expect(report.scope).toBe("full");
    expect(report.unclaimed).toEqual(["src/shop/__init__.py"]);
    expect(report.doubleClaimed).toEqual([]);
    expect(pairs(report)).toEqual(["app.orders->app.payments", "app.orders->app.storage", "app.storage->app.orders"]);
    expect(report.unsupportedEdges).toEqual([]);
    expect(report.unknownFreshness).toHaveLength(5);
  });

  it("points at the import that proves a dependency", async () => {
    const report = await verify(root, shopModel(), config);
    const dep = report.missingDependencies.find((d) => d.from === "app.storage");
    expect(dep?.evidence).toEqual([{ file: "src/shop/storage/db.py", line: 2, target: "src/shop/orders/models.py" }]);
  });

  it("reports declared edges that no import supports", async () => {
    const model = shopModel();
    model.edges.push({ kind: "depends_on", from: "app.api", to: "app.storage", mode: "sync", source: "agent", sync: "unverified" });
    const report = await verify(root, model, config);
    expect(report.unsupportedEdges).toEqual(["depends_on:app.api->app.storage"]);
  });

  it("is clean once the model matches the code", async () => {
    const report = await verify(root, completeShopModel(), config);
    expect(isClean(report)).toBe(true);
  });

  it("reports files claimed by two components", async () => {
    const model = shopModel();
    const api = model.nodes.find((n) => n.id === "app.api");
    if (api?.kind === "component") api.paths.push("src/shop/orders/models.py");
    const report = await verify(root, model, config);
    expect(report.doubleClaimed).toEqual([{ file: "src/shop/orders/models.py", components: ["app.api", "app.orders"] }]);
  });
});

describe("edge modes", () => {
  it("lets a data edge cover an import but does not require one", async () => {
    const model = completeShopModel();
    for (const e of model.edges) if (e.kind === "depends_on" && e.from === "app.orders" && e.to === "app.storage") e.mode = "data";
    model.edges.push({ kind: "depends_on", from: "app.api", to: "app.storage", mode: "data", source: "agent", sync: "unverified" });
    const report = await verify(root, model, config);
    expect(report.missingDependencies).toEqual([]);
    expect(report.unsupportedEdges).toEqual([]);
  });
});

describe("verify (incremental)", () => {
  it("catches a new unclaimed folder and a new cross-component import", async () => {
    await mkdir(join(root, "src/shop/reports"), { recursive: true });
    await writeFile(join(root, "src/shop/reports/daily.py"), "from shop.orders.service import place_order\n");
    await writeFile(join(root, "src/shop/api/admin.py"), "from shop.storage.db import load\n");
    const report = await verify(root, completeShopModel(), config, {
      changedFiles: ["src/shop/reports/daily.py", "src/shop/api/admin.py"],
    });
    expect(report.scope).toBe("incremental");
    expect(report.files).toBe(2);
    expect(report.unclaimed).toEqual(["src/shop/reports/daily.py"]);
    expect(pairs(report)).toEqual(["app.api->app.storage"]);
  });

  it("ignores changed files outside the configured sources", async () => {
    const report = await verify(root, completeShopModel(), config, { changedFiles: ["README.md"] });
    expect(report.files).toBe(0);
    expect(isClean(report)).toBe(true);
  });

  it("stays within the 300 ms budget once the cache is warm", async () => {
    await verify(root, completeShopModel(), config);
    const report = await verify(root, completeShopModel(), config, { changedFiles: ["src/shop/orders/service.py"] });
    expect(report.durationMs).toBeLessThan(300);
  });
});

describe("freshness", () => {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, encoding: "utf8" }).trim();

  it("marks a component stale when its files change after changedAt", async () => {
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "base");
    const head = git("rev-parse", "HEAD");
    const model = completeShopModel(head);

    expect((await verify(root, model, config)).staleComponents).toEqual([]);

    await writeFile(join(root, "src/shop/payments/gateway.py"), "def charge(c, n):\n    return None\n");
    expect((await verify(root, model, config)).staleComponents).toEqual(["app.payments"]);

    git("commit", "-qam", "change payments");
    expect((await verify(root, model, config)).staleComponents).toEqual(["app.payments"]);
  });
});

describe("fingerprints", () => {
  it("mark a component stale when its files change, without git", async () => {
    const model = completeShopModel();
    const report = await verify(root, model, config);
    expect(report.unknownFreshness).toHaveLength(5);
    await fingerprintAll(model);
    expect((await verify(root, model, config)).staleComponents).toEqual([]);
    await writeFile(join(root, "src/shop/storage/db.py"), "# changed\n");
    const after = await verify(root, model, config);
    expect(after.staleComponents).toEqual(["app.storage"]);
    expect(after.unknownFreshness).toEqual([]);
  });
});

describe("applyReport", () => {
  it("marks flagged components and edges stale and the rest ok", async () => {
    const model = shopModel();
    model.edges.push({ kind: "depends_on", from: "app.api", to: "app.storage", mode: "sync", source: "agent", sync: "unverified" });
    await fingerprintAll(model);
    const report = await verify(root, model, config);
    const next = applyReport(model, report);
    const sync = (id: string) => next.nodes.find((n) => n.id === id)?.sync;
    expect(sync("app.orders")).toBe("stale");
    expect(sync("app.storage")).toBe("stale");
    expect(sync("app.api")).toBe("ok");
    const edge = (from: string, to: string) => next.edges.find((e) => e.kind === "depends_on" && e.from === from && e.to === to)?.sync;
    expect(edge("app.api", "app.storage")).toBe("stale");
    expect(edge("app.api", "app.orders")).toBe("ok");
    expect(edge("app.payments", "payment-provider")).toBe("unverified");
  });
});

/** The py-shop model with the package file claimed and every observed dependency declared. */
/** Fingerprints every component against the current files, as `viewport model write` does. */
async function fingerprintAll(model: Model): Promise<void> {
  const owned = filesByComponent(coverage(await listSources(root, config), model).owner);
  for (const n of model.nodes) if (n.kind === "component") n.fingerprint = await fingerprintFiles(root, owned.get(n.id) ?? []);
}
