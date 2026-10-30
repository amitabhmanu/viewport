#!/usr/bin/env node
import { text } from "node:stream/consumers";
import { runCli } from "./run.js";

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  readStdin: () => text(process.stdin),
});
process.exitCode = code;
