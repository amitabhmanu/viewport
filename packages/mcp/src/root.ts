import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { VIEWPORT_DIR } from "@viewport/core";

/** The repo root: `--root`, else the project Claude Code opened, else the nearest directory holding `.viewport/`. */
export function findRoot(argv: string[], env: NodeJS.ProcessEnv, cwd: string): string {
  const flag = argv.indexOf("--root");
  if (flag !== -1 && argv[flag + 1] !== undefined) return resolve(argv[flag + 1]!);
  if (env.CLAUDE_PROJECT_DIR) return resolve(env.CLAUDE_PROJECT_DIR);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, VIEWPORT_DIR))) return dir;
    if (dirname(dir) === dir) return resolve(cwd);
  }
}
