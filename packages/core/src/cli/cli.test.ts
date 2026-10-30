import { cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../test-helpers.js";
import { runCli } from "./run.js";

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/py-shop", import.meta.url));

const SHOP = {
  nodes: [
    { kind: "system", id: "shop", name: "Shop", purpose: "Take orders" },
    { kind: "container", id: "app", name: "App", role: "Runs the shop" },
    ...["api", "orders", "payments", "notifications", "storage"].map((c) => ({
      kind: "component",
      id: `app.${c}`,
      name: c,
      role: c,
      paths: c === "api" ? ["src/shop/api/**", "src/shop/__init__.py"] : [`src/shop/${c}/**`],
    })),
  ],
  edges: [
    { kind: "contains", from: "shop", to: "app" },
    ...["api", "orders", "payments", "notifications", "storage"].map((c) => ({ kind: "contains", from: "app", to: `app.${c}` })),
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
  root = await tempDir();
  await cp(FIXTURE, root, { recursive: true });
});

async function cli(args: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    cwd: root,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => stdin,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("viewport CLI", () => {
  it("init detects Python sources and is idempotent", async () => {
    const first = await cli(["init"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Languages: python. Sources: src/**/*.py (12 files)");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(".viewport/local/");
    const second = await cli(["init"]);
    expect(second.out).toContain("Already set up.");
    expect((await readFile(join(root, ".gitignore"), "utf8")).match(/\.viewport\/local\//g)).toHaveLength(1);
  });

  it("init detects TypeScript sources", async () => {
    const ts = await tempDir();
    await cp(fileURLToPath(new URL("../../../../fixtures/ts-notes", import.meta.url)), ts, { recursive: true });
    const out: string[] = [];
    const code = await runCli(["init", "--root", ts], { cwd: root, out: (s) => out.push(s), err: () => {}, readStdin: async () => "" });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Languages: typescript. Sources: src/**/*.{ts,tsx} (5 files)");
  });

  it("asks for init before anything else", async () => {
    const r = await cli(["status"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("run `viewport init` first");
  });

  it("model write validates, fingerprints, verifies and writes", async () => {
    await cli(["init"]);
    const r = await cli(["model", "write", "--json"], JSON.stringify(SHOP));
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out) as { revision: number; stamped: string[]; report: { unclaimed: string[] } };
    expect(result.revision).toBe(1);
    expect(result.stamped).toHaveLength(5);
    expect(result.report.unclaimed).toEqual([]);

    const model = JSON.parse((await cli(["model", "show"])).out) as { nodes: { id: string; sync: string; fingerprint?: string }[] };
    const orders = model.nodes.find((n) => n.id === "app.orders");
    expect(orders?.sync).toBe("ok");
    expect(orders?.fingerprint).toMatch(/^sha256:/);
  });

  it("model write keeps fingerprints of unchanged components and retakes reviewed ones", async () => {
    await cli(["init"]);
    await cli(["model", "write"], JSON.stringify(SHOP));
    await writeFile(join(root, "src/shop/storage/db.py"), "from shop.orders.models import Order\n");
    expect((await cli(["status"])).out).toContain("changed since modeled: app.storage");

    const again = JSON.parse((await cli(["model", "write", "--json"], JSON.stringify(SHOP))).out) as { stamped: string[] };
    expect(again.stamped).toEqual([]);
    const reviewed = JSON.parse((await cli(["model", "write", "--json", "--reviewed", "app.storage"], JSON.stringify(SHOP))).out) as {
      stamped: string[];
      report: { staleComponents: string[] };
    };
    expect(reviewed.stamped).toEqual(["app.storage"]);
    expect(reviewed.report.staleComponents).toEqual([]);
  });

  it("model write reads a draft file with --from", async () => {
    await cli(["init"]);
    await mkdir(join(root, ".viewport/local"), { recursive: true });
    await writeFile(join(root, ".viewport/local/model-draft.json"), JSON.stringify(SHOP));
    const r = await cli(["model", "write", "--from", ".viewport/local/model-draft.json", "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { revision: number }).revision).toBe(1);
  });

  it("model write rejects an invalid model with readable errors and changes nothing", async () => {
    await cli(["init"]);
    const before = await readFile(join(root, ".viewport/model.json"), "utf8");
    const bad = { ...SHOP, edges: [...SHOP.edges, { kind: "depends_on", from: "app.api", to: "app.nowhere", mode: "sync" }] };
    const r = await cli(["model", "write"], JSON.stringify(bad));
    expect(r.code).toBe(1);
    expect(r.err).toContain("points to unknown node 'app.nowhere'");
    expect(await readFile(join(root, ".viewport/model.json"), "utf8")).toBe(before);
  });

  it("verify --changed reports drift in the changed files, and --check sets the exit code", async () => {
    await cli(["init"]);
    await cli(["model", "write"], JSON.stringify(SHOP));
    await mkdir(join(root, "src/shop/reports"));
    await writeFile(join(root, "src/shop/reports/daily.py"), "from shop.orders.service import place_order\n");
    const r = await cli(["verify", "--changed", "src/shop/reports/daily.py", "--check"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unclaimed: src/shop/reports/daily.py");
    expect((await cli(["verify", "--changed", "src/shop/api/routes.py", "--check"])).code).toBe(0);
  });

  it("answers queries as JSON", async () => {
    await cli(["init"]);
    await cli(["model", "write"], JSON.stringify(SHOP));
    const trace = JSON.parse((await cli(["query", "trace", "app.api", "--to", "app.notifications"])).out) as { nodes: string[] };
    expect(trace.nodes).toEqual(["app.api", "app.orders", "app.notifications"]);
    const views = JSON.parse((await cli(["query", "view", "components:app", "--level", "simple"])).out) as unknown[];
    expect(views).toHaveLength(1);
    const bad = await cli(["query", "get", "missing"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("unknown node 'missing'");
  });

  it("prints usage for unknown commands", async () => {
    const r = await cli(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Commands:");
  });
});
