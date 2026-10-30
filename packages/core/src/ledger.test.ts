import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LedgerError, appendDecision, nextDecisionId, readLedger } from "./ledger.js";
import { tempDir } from "./test-helpers.js";

const input = {
  title: "Queue between orders and notifications",
  options: [
    { name: "Direct call", tradeoff: "Simple, but slow requests block orders" },
    { name: "In-process queue", tradeoff: "Decoupled, but lost on restart" },
  ],
  chosen: "In-process queue",
  why: "Notifications must not slow down checkout",
  reversibility: "easy" as const,
  blastRadius: 2,
};

describe("ledger", () => {
  it("reads a missing ledger as empty", async () => {
    expect(await readLedger(join(await tempDir(), "ledger.jsonl"))).toEqual([]);
  });

  it("assigns sequential ids and appends one line per decision", async () => {
    const path = join(await tempDir(), ".viewport", "ledger.jsonl");
    const a = await appendDecision(path, input);
    const b = await appendDecision(path, { ...input, title: "Second" });
    expect([a.id, b.id]).toEqual(["D-001", "D-002"]);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await readLedger(path)).map((d) => d.title)).toEqual([input.title, "Second"]);
  });

  it("rejects duplicate ids and unknown supersedes", async () => {
    const path = join(await tempDir(), "ledger.jsonl");
    await appendDecision(path, input);
    await expect(appendDecision(path, { ...input, id: "D-001" })).rejects.toBeInstanceOf(LedgerError);
    await expect(appendDecision(path, { ...input, supersedes: "D-009" })).rejects.toBeInstanceOf(LedgerError);
    const replacement = await appendDecision(path, { ...input, chosen: "Direct call", supersedes: "D-001" });
    expect(replacement.supersedes).toBe("D-001");
  });

  it("rejects an invalid decision without writing", async () => {
    const path = join(await tempDir(), "ledger.jsonl");
    await expect(appendDecision(path, { ...input, chosen: "Kafka" })).rejects.toThrow();
    expect(await readLedger(path)).toEqual([]);
  });

  it("reports the line number of a corrupt entry", async () => {
    const path = join(await tempDir(), "ledger.jsonl");
    await appendDecision(path, input);
    await appendFile(path, `${JSON.stringify({ id: "D-002" })}\n`);
    await expect(readLedger(path)).rejects.toThrow(/line 2/);
  });

  it("numbers after the highest id, not the count", () => {
    expect(nextDecisionId([])).toBe("D-001");
    const d = { id: "D-041" } as Parameters<typeof nextDecisionId>[0][number];
    expect(nextDecisionId([d])).toBe("D-042");
  });
});
