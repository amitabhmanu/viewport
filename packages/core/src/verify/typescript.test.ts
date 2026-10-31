import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Config, type Model } from "../schema.js";
import { tempDir } from "../test-helpers.js";
import { extractTsImports, pnpmWorkspaceGlobs, readTsPaths, readWorkspacePackages, resolveTsImport, stripJsonc } from "./typescript.js";
import { isClean, verify } from "./index.js";

describe("extractTsImports", () => {
  it("finds every kind of module reference", async () => {
    const src = [
      'import a, { b } from "./x.js";',
      'import type { T } from "../t";',
      'export { c } from "@storage/users.js";',
      'export * from "./all";',
      'const m = await import("./dyn.js");',
      'const { s } = require("./slug.cjs") as X;',
      'import "./side";',
      'import fs = require("fs");',
      "const notAModule = load(\"./nope\");",
    ].join("\n");
    expect((await extractTsImports(src)).map((i) => `${i.line}:${i.specifier}`)).toEqual([
      "1:./x.js",
      "2:../t",
      "3:@storage/users.js",
      "4:./all",
      "5:./dyn.js",
      "6:./slug.cjs",
      "7:./side",
      "8:fs",
    ]);
  });

  it("parses TSX", async () => {
    const src = 'import { Button } from "./button";\nexport const App = () => <Button label="x" />;\n';
    expect((await extractTsImports(src, true)).map((i) => i.specifier)).toEqual(["./button"]);
  });
});

describe("resolveTsImport", () => {
  const files = new Set(["src/a/index.ts", "src/a/b.ts", "src/c.tsx", "src/storage/users.ts", "src/lib/util.ts"]);
  const none = { paths: [] };

  it("maps .js specifiers to .ts sources and finds index files", () => {
    expect(resolveTsImport("./b.js", "src/a/index.ts", files, none)).toEqual(["src/a/b.ts"]);
    expect(resolveTsImport("../c", "src/a/b.ts", files, none)).toEqual(["src/c.tsx"]);
    expect(resolveTsImport("./a", "src/c.tsx", files, none)).toEqual(["src/a/index.ts"]);
  });

  it("uses tsconfig paths and baseUrl", () => {
    const tsPaths = { baseUrl: ".", paths: [["@storage/*", ["src/storage/*"]]] as [string, string[]][] };
    expect(resolveTsImport("@storage/users.js", "src/c.tsx", files, tsPaths)).toEqual(["src/storage/users.ts"]);
    expect(resolveTsImport("src/lib/util", "src/c.tsx", files, tsPaths)).toEqual(["src/lib/util.ts"]);
  });

  it("ignores packages and paths outside the repo", () => {
    expect(resolveTsImport("react", "src/c.tsx", files, none)).toEqual([]);
    expect(resolveTsImport("../../../x", "src/c.tsx", files, none)).toEqual([]);
  });
});

describe("workspace packages", () => {
  const files = new Set(["packages/core/src/index.ts", "packages/core/src/query/index.ts", "packages/ui/src/button.tsx", "packages/cli/index.ts"]);
  const none = { paths: [] };

  async function repo(manifests: Record<string, object>, workspace = 'packages:\n  - "packages/*"\n'): Promise<string> {
    const root = await tempDir();
    await writeFile(join(root, "pnpm-workspace.yaml"), workspace);
    for (const [dir, pkg] of Object.entries(manifests)) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "package.json"), JSON.stringify(pkg));
    }
    return root;
  }

  it("reads the packages list of pnpm-workspace.yaml", () => {
    const text = "# workspace\npackages:\n  - 'apps/*'   # apps\n  - \"packages/**\"\n  - '!**/test/**'\n\ncatalog:\n  - not-a-package\n";
    expect(pnpmWorkspaceGlobs(text)).toEqual(["apps/*", "packages/**", "!**/test/**"]);
    expect(pnpmWorkspaceGlobs("")).toEqual([]);
  });

  it("resolves a package's root and subpath exports to its sources, not its build", async () => {
    const root = await repo({
      "packages/core": { name: "@x/core", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./*": "./dist/*/index.js" } },
      "packages/ui": { name: "@x/ui", main: "./lib/index.js" },
      "packages/cli": { name: "x-cli" },
      "packages/broken": {},
    });
    const packages = await readWorkspacePackages(root);
    expect(packages.map((p) => `${p.name}@${p.dir}`)).toEqual(["x-cli@packages/cli", "@x/core@packages/core", "@x/ui@packages/ui"]);
    const from = "packages/cli/index.ts";
    expect(resolveTsImport("@x/core", from, files, none, packages)).toEqual(["packages/core/src/index.ts"]);
    expect(resolveTsImport("@x/core/query", from, files, none, packages)).toEqual(["packages/core/src/query/index.ts"]);
    expect(resolveTsImport("@x/ui/button.js", from, files, none, packages)).toEqual(["packages/ui/src/button.tsx"]);
    expect(resolveTsImport("x-cli", "packages/ui/src/button.tsx", files, none, packages)).toEqual(["packages/cli/index.ts"]);
    expect(resolveTsImport("@x/core-extra", from, files, none, packages)).toEqual([]);
  });

  it("reads npm workspaces and skips negated globs", async () => {
    const root = await repo({ "packages/core": { name: "@x/core" }, "packages/ui": { name: "@x/ui" } }, "");
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*", "!packages/ui"] } }));
    expect((await readWorkspacePackages(root)).map((p) => p.name)).toEqual(["@x/core"]);
  });

  it("finds dependencies between workspace packages in verify", async () => {
    const root = await repo({ "packages/core": { name: "@x/core", exports: "./dist/index.js" }, "packages/cli": { name: "x-cli" } });
    await mkdir(join(root, "packages/core/src"), { recursive: true });
    await writeFile(join(root, "packages/core/src/index.ts"), "export const x = 1;\n");
    await writeFile(join(root, "packages/cli/index.ts"), 'import { x } from "@x/core";\nconsole.log(x);\n');
    const config = Config.parse({ version: 1, sources: ["packages/**/*.ts"], languages: ["typescript"] });
    const base = { source: "agent" as const, sync: "unverified" as const };
    const report = await verify(root, {
      version: 1,
      revision: 0,
      nodes: [
        { ...base, kind: "system", id: "x", name: "X", purpose: "X" },
        { ...base, kind: "container", id: "app", name: "App", role: "App" },
        { ...base, kind: "component", id: "app.core", name: "core", role: "core", paths: ["packages/core/**"] },
        { ...base, kind: "component", id: "app.cli", name: "cli", role: "cli", paths: ["packages/cli/**"] },
      ],
      edges: [
        { ...base, kind: "contains", from: "x", to: "app" },
        { ...base, kind: "contains", from: "app", to: "app.core" },
        { ...base, kind: "contains", from: "app", to: "app.cli" },
      ],
    }, config);
    expect(report.missingDependencies.map((d) => `${d.from}->${d.to}`)).toEqual(["app.cli->app.core"]);
  });
});

describe("tsconfig", () => {
  it("strips comments and trailing commas but not slashes inside strings", () => {
    const text = '{\n  // comment\n  "a": "http://x", /* block */\n  "b": [1, 2,],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: "http://x", b: [1, 2] });
  });

  it("reads baseUrl and paths relative to the tsconfig", async () => {
    const root = fileURLToPath(new URL("../../../../fixtures/ts-notes", import.meta.url));
    expect(await readTsPaths(root, "tsconfig.json")).toEqual({ baseUrl: ".", paths: [["@storage/*", ["src/storage/*"]]] });
    expect(await readTsPaths(root, "missing.json")).toEqual({ paths: [] });
  });
});

describe("verify on ts-notes", () => {
  const base = { source: "agent" as const, sync: "unverified" as const };
  const comps = ["server", "auth", "notes", "storage"];
  const model = (deps: [string, string][]): Model => ({
    version: 1,
    revision: 0,
    nodes: [
      { ...base, kind: "system", id: "notes", name: "Notes", purpose: "Keep notes" },
      { ...base, kind: "container", id: "api", name: "API", role: "Serves notes" },
      ...comps.map((c) => ({ ...base, kind: "component" as const, id: `api.${c}`, name: c, role: c, paths: [`src/${c}/**`] })),
    ],
    edges: [
      { ...base, kind: "contains", from: "notes", to: "api" },
      ...comps.map((c) => ({ ...base, kind: "contains" as const, from: "api", to: `api.${c}` })),
      ...deps.map(([a, b]) => ({ ...base, kind: "depends_on" as const, from: `api.${a}`, to: `api.${b}`, mode: "sync" as const })),
    ],
  });

  it("finds the dependencies the fixture README predicts", async () => {
    const root = await tempDir();
    await cp(fileURLToPath(new URL("../../../../fixtures/ts-notes", import.meta.url)), root, { recursive: true });
    const config = Config.parse({ version: 1, sources: ["src/**/*.ts"], languages: ["typescript"] });

    const empty = await verify(root, model([]), config);
    expect(empty.unclaimed).toEqual([]);
    expect(empty.missingDependencies.map((d) => `${d.from}->${d.to}`)).toEqual([
      "api.auth->api.storage",
      "api.notes->api.storage",
      "api.server->api.auth",
      "api.server->api.notes",
    ]);
    const viaAlias = empty.missingDependencies.find((d) => d.from === "api.auth");
    expect(viaAlias?.evidence).toEqual([{ file: "src/auth/session.ts", line: 2, target: "src/storage/users.ts" }]);

    const full = model([
      ["server", "auth"],
      ["server", "notes"],
      ["auth", "storage"],
      ["notes", "storage"],
    ]);
    expect(isClean(await verify(root, full, config))).toBe(true);
  });
});
