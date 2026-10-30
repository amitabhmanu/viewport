import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Model } from "../schema.js";

const run = promisify(execFile);

export interface Freshness {
  /** Components whose files changed since they were last modeled. */
  stale: string[];
  /** Components with neither a fingerprint nor `changedAt`, so freshness cannot be judged. */
  unknown: string[];
  /** Set when git was unavailable; freshness was then skipped. */
  skipped?: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Hash of a component's files (paths and contents, in path order). */
export async function fingerprintFiles(root: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file).update("\0").update(await readFile(join(root, file))).update("\0");
  }
  return `sha256:${hash.digest("hex").slice(0, 32)}`;
}

/** Repo-relative files owned by each component, from a coverage owner map. */
export function filesByComponent(owner: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, id] of owner) out.set(id, [...(out.get(id) ?? []), file]);
  return out;
}

/**
 * A component is stale when its files no longer match the fingerprint taken when it
 * was last modeled. Components without a fingerprint fall back to git: stale when
 * commits or uncommitted edits touch its paths after `changedAt`.
 */
export async function checkFreshness(root: string, model: Model, owner: Map<string, string>): Promise<Freshness> {
  const files = filesByComponent(owner);
  const stale: string[] = [];
  const unknown: string[] = [];
  const needGit: Extract<Model["nodes"][number], { kind: "component" }>[] = [];
  for (const node of model.nodes) {
    if (node.kind !== "component") continue;
    if (node.fingerprint !== undefined) {
      if ((await fingerprintFiles(root, files.get(node.id) ?? [])) !== node.fingerprint) stale.push(node.id);
    } else if (node.changedAt !== undefined) needGit.push(node);
    else unknown.push(node.id);
  }
  let skipped: string | undefined;
  if (needGit.length > 0) {
    try {
      await git(root, ["rev-parse", "--is-inside-work-tree"]);
      for (const node of needGit) {
        const pathspecs = node.paths.map((p) => `:(glob)${p}`);
        const [committed, uncommitted] = await Promise.all([
          git(root, ["log", "-1", "--format=%H", `${node.changedAt}..HEAD`, "--", ...pathspecs]).catch(() => "unknown-commit"),
          git(root, ["status", "--porcelain", "--", ...pathspecs]),
        ]);
        if (committed !== "" || uncommitted !== "") stale.push(node.id);
      }
    } catch {
      skipped = "not a git work tree";
      unknown.push(...needGit.map((n) => n.id));
    }
  }
  return { stale: stale.sort(), unknown: unknown.sort(), ...(skipped ? { skipped } : {}) };
}

/** Current HEAD commit, or undefined outside a git work tree. */
/**
 * Files that differ from HEAD, untracked ones included, as repo-relative paths. Catches
 * edits made by any means, such as shell commands. Empty outside a git repo.
 */
export async function uncommittedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const entries = stdout.split("\0").filter((e) => e !== "");
    const files: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      files.push(entry.slice(3));
      // A rename is followed by its old path, which no longer exists.
      if (entry[0] === "R" || entry[0] === "C") i++;
    }
    return files;
  } catch {
    return [];
  }
}

export async function headCommit(root: string): Promise<string | undefined> {
  try {
    return await git(root, ["rev-parse", "HEAD"]);
  } catch {
    return undefined;
  }
}
