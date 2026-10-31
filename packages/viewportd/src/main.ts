import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ensureDaemon, isHealthy, readLock, releaseLock, stopDaemon, viewerUrl, writeLock } from "./lock.js";
import { startDaemon } from "./server.js";

const HOUR = 60 * 60 * 1000;
const WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const PLUGIN = new URL("../../../", import.meta.url);
const EXPLAINER = ["agents/viewport-explainer.md", "skills/viewport-explaining/SKILL.md"].map((f) => fileURLToPath(new URL(f, PLUGIN)));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: process.cwd() },
    port: { type: "string" },
    open: { type: "boolean", default: false },
  },
});
const root = resolve(values.root);
const command = positionals[0] ?? "ensure";

if (!existsSync(resolve(root, ".viewport", "config.json"))) {
  console.error(`viewportd: no Viewport workspace at ${root}; run /viewport:init first`);
  process.exit(1);
}

switch (command) {
  case "serve": {
    // A second daemon for the same repo steps aside for the first.
    const existing = await readLock(root);
    if (existing !== undefined && existing.pid !== process.pid && (await isHealthy(existing))) process.exit(0);
    const daemon = await startDaemon(root, {
      ...(values.port !== undefined ? { port: Number(values.port) } : {}),
      webRoot: WEB_ROOT,
      idleMs: 8 * HOUR,
      onIdle: () => void shutdown(),
      // Background jobs run Claude and cost tokens; VIEWPORT_NO_JOBS turns them off.
      ...(process.env.VIEWPORT_NO_JOBS ? {} : { worker: { explainFiles: EXPLAINER } }),
    });
    await writeLock({ pid: process.pid, port: daemon.port, token: daemon.token, root, startedAt: new Date().toISOString() });
    const shutdown = async () => {
      await releaseLock(root);
      await daemon.close();
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
    break;
  }
  case "ensure": {
    const lock = await ensureDaemon(root, fileURLToPath(import.meta.url));
    const url = viewerUrl(lock);
    console.log(url);
    if (values.open) openBrowser(url);
    break;
  }
  case "stop":
    console.log((await stopDaemon(root)) ? "stopped" : "not running");
    break;
  default:
    console.error(`viewportd: unknown command '${command}'; use serve, ensure or stop`);
    process.exit(1);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
