import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify, writeFileAtomic } from "../fsutil.js";
import { extractPythonImports, type RawImport } from "./python.js";
import { extractTsImports, type TsImport } from "./typescript.js";

/** Imports found in one file, tagged by the language that was parsed. */
export type FileImports = { lang: "python"; imports: RawImport[] } | { lang: "typescript"; imports: TsImport[] };

interface CacheEntry {
  mtimeMs: number;
  size: number;
  found: FileImports;
}

interface CacheFile {
  version: 2;
  files: Record<string, CacheEntry>;
}

const TS_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

async function extract(file: string, source: string): Promise<FileImports | undefined> {
  if (file.endsWith(".py")) return { lang: "python", imports: await extractPythonImports(source) };
  if (TS_EXTENSIONS.test(file) && !file.endsWith(".d.ts")) {
    return { lang: "typescript", imports: await extractTsImports(source, /\.(tsx|jsx)$/.test(file)) };
  }
  return undefined;
}

/**
 * Parses imports for each file, reusing cached results for files whose size and
 * mtime have not changed. The cache lives in local state and is never committed.
 */
export async function scanImports(root: string, files: string[], cachePath: string): Promise<Map<string, FileImports>> {
  const cache = await loadCache(cachePath);
  const result = new Map<string, FileImports>();
  let dirty = false;
  for (const file of files) {
    const abs = join(root, file);
    const info = await stat(abs);
    const hit = cache.files[file];
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
      result.set(file, hit.found);
      continue;
    }
    const found = await extract(file, await readFile(abs, "utf8"));
    if (!found) continue;
    cache.files[file] = { mtimeMs: info.mtimeMs, size: info.size, found };
    result.set(file, found);
    dirty = true;
  }
  if (dirty) await writeFileAtomic(cachePath, stableStringify(cache));
  return result;
}

async function loadCache(path: string): Promise<CacheFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CacheFile;
    if (parsed.version === 2 && typeof parsed.files === "object") return parsed;
  } catch {
    // Missing or unreadable cache: start fresh.
  }
  return { version: 2, files: {} };
}
