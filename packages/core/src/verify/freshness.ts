import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Model } from "../schema.js";

const run = promisify(execFile);

export interface Freshness {
  /** Components whose files changed after the commit in `changedAt`. */
  stale: string[];
  /** Components with no `changedAt`, so freshness cannot be judged. */
  unknown: string[];
  /** Set when git was unavailable; freshness was then skipped. */
  skipped?: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Marks a component stale when git shows commits or uncommitted edits to its files since `changedAt`. */
export async function checkFreshness(root: string, model: Model): Promise<Freshness> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { stale: [], unknown: [], skipped: "not a git work tree" };
  }
  const stale: string[] = [];
  const unknown: string[] = [];
  for (const node of model.nodes) {
    if (node.kind !== "component") continue;
    if (node.changedAt === undefined) {
      unknown.push(node.id);
      continue;
    }
    const pathspecs = node.paths.map((p) => `:(glob)${p}`);
    const [committed, uncommitted] = await Promise.all([
      git(root, ["log", "-1", "--format=%H", `${node.changedAt}..HEAD`, "--", ...pathspecs]).catch(() => "unknown-commit"),
      git(root, ["status", "--porcelain", "--", ...pathspecs]),
    ]);
    if (committed !== "" || uncommitted !== "") stale.push(node.id);
  }
  return { stale: stale.sort(), unknown: unknown.sort() };
}
