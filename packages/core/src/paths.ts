import { join } from "node:path";

export const VIEWPORT_DIR = ".viewport";

export interface ViewportPaths {
  dir: string;
  model: string;
  ledger: string;
  config: string;
  localDir: string;
  stateDb: string;
}

/** Locations of Viewport's files inside a repo checkout. */
export function viewportPaths(repoRoot: string): ViewportPaths {
  const dir = join(repoRoot, VIEWPORT_DIR);
  const localDir = join(dir, "local");
  return {
    dir,
    model: join(dir, "model.json"),
    ledger: join(dir, "ledger.jsonl"),
    config: join(dir, "config.json"),
    localDir,
    stateDb: join(localDir, "state.db"),
  };
}
