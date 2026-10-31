import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { viewportPaths, writeFileAtomic } from "@viewport/core";

/** Where a running daemon advertises itself: one per repo, in local state. */
export interface DaemonLock {
  pid: number;
  port: number;
  token: string;
  root: string;
  startedAt: string;
}

export function lockPath(root: string): string {
  return join(viewportPaths(root).localDir, "viewportd.json");
}

export function viewerUrl(lock: DaemonLock): string {
  return `http://127.0.0.1:${lock.port}/?token=${lock.token}`;
}

export async function readLock(root: string): Promise<DaemonLock | undefined> {
  try {
    return JSON.parse(await readFile(lockPath(root), "utf8")) as DaemonLock;
  } catch {
    return undefined;
  }
}

export async function writeLock(lock: DaemonLock): Promise<void> {
  await writeFileAtomic(lockPath(lock.root), `${JSON.stringify(lock, null, 2)}\n`);
}

/** Removes the lock only if it still belongs to this process. */
export async function releaseLock(root: string, pid = process.pid): Promise<void> {
  const lock = await readLock(root);
  if (lock?.pid === pid) await rm(lockPath(root), { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when the lock names a live process that answers the health check with its token. */
export async function isHealthy(lock: DaemonLock): Promise<boolean> {
  if (!alive(lock.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/health`, {
      headers: { authorization: `Bearer ${lock.token}` },
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Returns the repo's running daemon, starting one in the background when there is
 * none or the old one is gone. `script` is the daemon's entry point (dist/main.js).
 */
export async function ensureDaemon(root: string, script: string, waitMs = 5000): Promise<DaemonLock> {
  const existing = await readLock(root);
  if (existing !== undefined && (await isHealthy(existing))) return existing;
  spawnDaemon(root, script);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const lock = await readLock(root);
    if (lock !== undefined && lock.pid !== existing?.pid && (await isHealthy(lock))) return lock;
  }
  throw new Error(`viewportd did not start within ${waitMs} ms`);
}

/** Starts a daemon in the background without waiting for it. It exits by itself if one is already running. */
export function spawnDaemon(root: string, script: string): void {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, "serve", "--root", root], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

/** Stops the repo's daemon, if one is running. */
export async function stopDaemon(root: string): Promise<boolean> {
  const lock = await readLock(root);
  if (lock === undefined || !alive(lock.pid)) {
    await rm(lockPath(root), { force: true });
    return false;
  }
  process.kill(lock.pid, "SIGTERM");
  return true;
}
