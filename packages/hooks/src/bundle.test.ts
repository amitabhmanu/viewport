import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initWorkspace, writeModelFromAgent } from "@viewport/core";
import { describe, expect, it } from "vitest";

const DIST = fileURLToPath(new URL("../../../hooks/dist/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));

/** Runs a built hook the way Claude Code does: JSON on stdin, JSON (or nothing) on stdout. */
async function runBundle(name: string, input: unknown): Promise<{ stdout: string; stderr: string }> {
  const file = join(DIST, `${name}.mjs`);
  if (!existsSync(file)) throw new Error(`${file} is missing; run pnpm build first`);
  const child = promisify(execFile)("node", ["--disable-warning=ExperimentalWarning", file]);
  child.child.stdin?.end(JSON.stringify(input));
  return child;
}

describe("bundled hooks", () => {
  it("load their grammars from beside the bundle and answer over stdio", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewport-bundle-"));
    await cp(FIXTURE, root, { recursive: true });
    await initWorkspace(root);
    await writeModelFromAgent(root, {
      nodes: [
        { kind: "system", id: "shop", name: "Shop", purpose: "Take orders" },
        { kind: "container", id: "app", name: "App", role: "Runs the shop" },
        { kind: "component", id: "app.core", name: "Core", role: "Everything", paths: ["src/shop/**"] },
      ],
      edges: [
        { kind: "contains", from: "shop", to: "app" },
        { kind: "contains", from: "app", to: "app.core" },
      ],
    });
    await mkdir(join(root, "src", "other"), { recursive: true });
    await writeFile(join(root, "src", "other", "extra.py"), "import shop.orders\n");

    const start = await runBundle("session-start", { cwd: root });
    expect(JSON.parse(start.stdout).hookSpecificOutput.additionalContext).toContain("Containers: app (1 component)");

    const post = await runBundle("post-tool-use", { session_id: "s", cwd: root, tool_name: "Write", tool_input: { file_path: join(root, "src", "other", "extra.py") } });
    expect(post.stderr).toBe("");

    const blocked = await runBundle("stop", { session_id: "s", cwd: root });
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: "block" });

    const outside = await runBundle("stop", { session_id: "s", cwd: tmpdir() });
    expect(outside.stdout).toBe("");
  });
});
