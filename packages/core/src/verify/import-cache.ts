import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify, writeFileAtomic } from "../fsutil.js";
import { extractPythonImports, type RawImport } from "./python.js";

interface CacheEntry {
  mtimeMs: number;
  size: number;
  imports: RawImport[];
}

interface CacheFile {
  version: 1;
  files: Record<string, CacheEntry>;
}

/**
 * Parses imports for each file, reusing cached results for files whose size and
 * mtime have not changed. The cache lives in local state and is never committed.
 */
export async function scanImports(root: string, files: string[], cachePath: string): Promise<Map<string, RawImport[]>> {
  const cache = await loadCache(cachePath);
  const result = new Map<string, RawImport[]>();
  let dirty = false;
  for (const file of files) {
    if (!file.endsWith(".py")) continue;
    const abs = join(root, file);
    const info = await stat(abs);
    const hit = cache.files[file];
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
      result.set(file, hit.imports);
      continue;
    }
    const imports = await extractPythonImports(await readFile(abs, "utf8"));
    cache.files[file] = { mtimeMs: info.mtimeMs, size: info.size, imports };
    result.set(file, imports);
    dirty = true;
  }
  if (dirty) await writeFileAtomic(cachePath, stableStringify(cache));
  return result;
}

async function loadCache(path: string): Promise<CacheFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CacheFile;
    if (parsed.version === 1 && typeof parsed.files === "object") return parsed;
  } catch {
    // Missing or unreadable cache: start fresh.
  }
  return { version: 1, files: {} };
}
