import { sessionStart } from "./hooks.js";
import { runHook } from "./run.js";

await runHook((root) => sessionStart(root));
