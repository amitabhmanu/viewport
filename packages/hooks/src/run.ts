import { type HookInput, type HookOutput, findWorkspace } from "./hooks.js";

/**
 * Runs one hook: reads Claude Code's JSON input from stdin, does nothing outside a
 * Viewport workspace, and prints the hook's output. A failure is reported on stderr
 * with exit code 1, which Claude Code treats as non-blocking.
 */
export async function runHook(handler: (root: string, input: HookInput) => Promise<HookOutput>): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    const input = (text === "" ? {} : JSON.parse(text)) as HookInput;
    const root = findWorkspace(input);
    if (root === undefined) return;
    const output = await handler(root, input);
    if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (err) {
    process.stderr.write(`viewport hook: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
