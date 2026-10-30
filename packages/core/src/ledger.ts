import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Decision, type DecisionInput } from "./schema.js";

export class LedgerError extends Error {}

/** Reads every decision in ledger.jsonl, in the order they were appended. */
export async function readLedger(path: string): Promise<Decision[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return text
    .split("\n")
    .map((line, i) => [line.trim(), i + 1] as const)
    .filter(([line]) => line !== "")
    .map(([line, n]) => {
      const parsed = Decision.safeParse(JSON.parse(line));
      if (!parsed.success) throw new LedgerError(`ledger line ${n}: ${parsed.error.message}`);
      return parsed.data;
    });
}

export function nextDecisionId(existing: Decision[]): string {
  const max = existing.reduce((m, d) => Math.max(m, Number(d.id.slice(2))), 0);
  return `D-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Validates and appends one decision. `id` and `at` are filled in when absent.
 * Entries are never rewritten; a change of mind is a new entry with `supersedes`.
 */
export async function appendDecision(
  path: string,
  input: Omit<DecisionInput, "id" | "at"> & Partial<Pick<DecisionInput, "id" | "at">>,
): Promise<Decision> {
  const existing = await readLedger(path);
  const decision = Decision.parse({
    ...input,
    id: input.id ?? nextDecisionId(existing),
    at: input.at ?? new Date().toISOString(),
  });
  if (existing.some((d) => d.id === decision.id)) throw new LedgerError(`decision ${decision.id} already exists`);
  if (decision.supersedes !== undefined && !existing.some((d) => d.id === decision.supersedes)) {
    throw new LedgerError(`decision ${decision.id} supersedes unknown ${decision.supersedes}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(decision)}\n`, "utf8");
  return decision;
}
