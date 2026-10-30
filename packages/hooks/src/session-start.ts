import { fileURLToPath } from "node:url";
import { sessionStart, startViewer } from "./hooks.js";
import { runHook } from "./run.js";

// The bundle lives in hooks/dist; the daemon's entry point is built into packages/viewportd/dist.
const DAEMON = fileURLToPath(new URL("../../packages/viewportd/dist/main.js", import.meta.url));

await runHook(async (root) => {
  await startViewer(root, DAEMON);
  return sessionStart(root);
});
