import { readFile } from "node:fs/promises";
import { parseFile, stableStringify, writeFileAtomic } from "./fsutil.js";
import { Config, type GateSettings } from "./schema.js";

export class ConfigMissingError extends Error {}

export async function readConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigMissingError("no .viewport/config.json here; run `viewport init` first");
    }
    throw err;
  }
  return parseFile(Config, text, path);
}

/**
 * Changes the catch-up gate settings in config.json, keeping everything else as written
 * (defaults the file leaves out stay out). Returns the config as read back.
 */
export async function updateGateSettings(path: string, change: Partial<GateSettings>): Promise<Config> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const gates = { ...((raw.gates as Record<string, unknown> | undefined) ?? {}), ...change };
  const next = { ...raw, gates };
  parseFile(Config, JSON.stringify(next), path);
  await writeFileAtomic(path, stableStringify(next));
  return readConfig(path);
}
