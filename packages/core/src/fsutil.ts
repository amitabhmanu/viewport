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

/** A file under .viewport/ that is not valid JSON or does not match its schema. */
export class InvalidFileError extends Error {}

/** Parses a .viewport/ file, naming the file and each failing field when it is wrong. */
export function parseFile<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, text: string, path: string): T {
  const name = path.split(/[\\/]/).slice(-2).join("/");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new InvalidFileError(`${name} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(top level)"}: ${i.message}`);
  throw new InvalidFileError(`${name} is invalid: ${issues.join("; ")}`);
}
