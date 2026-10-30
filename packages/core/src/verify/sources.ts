import picomatch from "picomatch";
import { glob } from "tinyglobby";
import type { Config, Model } from "../schema.js";

/** Source files the config says components must claim, as sorted repo-relative POSIX paths. */
export async function listSources(root: string, config: Config): Promise<string[]> {
  const files = await glob(config.sources, { cwd: root, ignore: config.ignore, onlyFiles: true });
  return files.sort();
}

export interface Coverage {
  /** File to the one component that claims it. Files claimed twice are left out. */
  owner: Map<string, string>;
  unclaimed: string[];
  doubleClaimed: { file: string; components: string[] }[];
}

export function coverage(files: string[], model: Model): Coverage {
  const matchers = model.nodes.flatMap((n) => (n.kind === "component" ? [{ id: n.id, match: picomatch(n.paths) }] : []));
  const owner = new Map<string, string>();
  const unclaimed: string[] = [];
  const doubleClaimed: Coverage["doubleClaimed"] = [];
  for (const file of files) {
    const claims = matchers.filter((m) => m.match(file)).map((m) => m.id);
    if (claims.length === 0) unclaimed.push(file);
    else if (claims.length > 1) doubleClaimed.push({ file, components: claims });
    else owner.set(file, claims[0]!);
  }
  return { owner, unclaimed, doubleClaimed };
}
