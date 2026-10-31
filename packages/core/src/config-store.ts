import { readFile } from "node:fs/promises";
import { parseFile } from "./fsutil.js";
import { Config } from "./schema.js";

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
