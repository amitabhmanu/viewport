export { startDaemon } from "./server.js";
export type { Daemon, DaemonOptions } from "./server.js";
export { daemonBuild, ensureDaemon, isCurrent, isHealthy, spawnDaemon, lockPath, readLock, stopDaemon, viewerUrl } from "./lock.js";
export type { DaemonLock } from "./lock.js";
export { gradeAnswer, instructions, runClaude } from "./worker.js";
export type { ClaudeOptions, WorkerOptions } from "./worker.js";
