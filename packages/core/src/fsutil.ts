import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** Write via a temp file and rename, so readers never see a half-written file. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

/** JSON with object keys sorted at every level, two-space indent and a trailing newline. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
