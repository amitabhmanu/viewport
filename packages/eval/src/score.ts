import type { Decision, Grade, VerificationReport } from "@viewport/core";
import type { ExpectedDecision } from "./tasks.js";

/** Phase 2 gate thresholds, from the implementation plan. */
export const GATE = {
  decisionRecall: 0.8,
  medianHookMs: 300,
  tokenOverhead: 0.15,
} as const;

export interface DecisionMatch {
  expected: string;
  /** Id of the logged decision that covered it, if any. */
  matchedBy?: string;
}

function decisionText(d: Decision): string {
  return [d.title, d.chosen, d.why, ...d.options.map((o) => `${o.name} ${o.tradeoff}`)].join("\n");
}

/**
 * Finds a logged decision covering each expected one. A single entry may cover two
 * expected decisions when it records both choices ("client in notifications, sent on
 * dispatch"); each expected decision still needs all of its own patterns to match.
 */
export function matchDecisions(expected: ExpectedDecision[], ledger: Decision[]): DecisionMatch[] {
  return expected.map((e) => {
    const hit = ledger.find((d) => e.match.every((re) => re.test(decisionText(d))));
    return hit === undefined ? { expected: e.id } : { expected: e.id, matchedBy: hit.id };
  });
}

/** Everything verification still reports at the end of a run; the gate wants none. */
export function leftoverFindings(report: VerificationReport): string[] {
  return [
    ...report.unclaimed.map((f) => `unclaimed ${f}`),
    ...report.doubleClaimed.map((d) => `double-claimed ${d.file}`),
    ...report.missingDependencies.map((d) => `missing ${d.from} -> ${d.to}`),
    ...report.unsupportedEdges.map((e) => `unsupported ${e}`),
    ...report.staleComponents.map((c) => `changed since modeled ${c}`),
  ];
}

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** All tokens a headless run used across every model, subagents included. */
export function totalTokens(result: { modelUsage?: Record<string, ModelUsage> }): number {
  return Object.values(result.modelUsage ?? {}).reduce(
    (sum, u) => sum + (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
    0,
  );
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface RunScore {
  task: string;
  ok: boolean;
  error?: string;
  decisions: DecisionMatch[];
  logged: number;
  leftover: string[];
  hookMs: number[];
  tokens: number;
  costUsd: number;
  baselineTokens?: number;
  baselineCostUsd?: number;
}

export interface GateResult {
  pass: boolean;
  checks: { name: string; value: string; target: string; pass: boolean }[];
}

/** The Phase 2 gate over a set of runs. Token overhead is skipped when no baseline ran. */
export function gate(runs: RunScore[]): GateResult {
  const expected = runs.flatMap((r) => r.decisions);
  const recall = expected.length === 0 ? 1 : expected.filter((d) => d.matchedBy !== undefined).length / expected.length;
  const hookMedian = median(runs.flatMap((r) => r.hookMs));
  const withBaseline = runs.filter((r) => r.baselineTokens !== undefined);
  const plugin = withBaseline.reduce((s, r) => s + r.tokens, 0);
  const base = withBaseline.reduce((s, r) => s + (r.baselineTokens ?? 0), 0);
  const overhead = base > 0 ? plugin / base - 1 : undefined;

  const checks = [
    { name: "runs finished", value: `${runs.filter((r) => r.ok).length}/${runs.length}`, target: "all", pass: runs.every((r) => r.ok) },
    {
      name: "findings left at end",
      value: String(runs.reduce((s, r) => s + r.leftover.length, 0)),
      target: "0",
      pass: runs.every((r) => r.leftover.length === 0),
    },
    {
      name: "expected decisions logged",
      value: `${Math.round(recall * 100)}%`,
      target: `>= ${GATE.decisionRecall * 100}%`,
      pass: recall >= GATE.decisionRecall,
    },
    {
      name: "median PostToolUse time",
      value: hookMedian === undefined ? "no edits" : `${Math.round(hookMedian)} ms`,
      target: `< ${GATE.medianHookMs} ms`,
      pass: hookMedian !== undefined && hookMedian < GATE.medianHookMs,
    },
  ];
  if (overhead !== undefined) {
    checks.push({
      name: "plugin token overhead",
      value: `${Math.round(overhead * 100)}%`,
      target: `< ${GATE.tokenOverhead * 100}%`,
      pass: overhead < GATE.tokenOverhead,
    });
  }
  return { pass: checks.every((c) => c.pass), checks };
}

export function formatSummary(runs: RunScore[], result: GateResult): string {
  const lines = ["# Viewport Phase 2 evaluation", "", `Gate: **${result.pass ? "pass" : "fail"}**`, "", "| Check | Value | Target | |", "| --- | --- | --- | --- |"];
  for (const c of result.checks) lines.push(`| ${c.name} | ${c.value} | ${c.target} | ${c.pass ? "pass" : "FAIL"} |`);
  lines.push("", "| Task | Decisions logged | Expected matched | Findings left | Edits | Tokens (plugin / baseline) | Cost USD (plugin / baseline) |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    const matched = r.decisions.map((d) => `${d.expected}: ${d.matchedBy ?? "missed"}`).join("; ");
    const tokens = `${r.tokens}${r.baselineTokens !== undefined ? ` / ${r.baselineTokens}` : ""}`;
    const cost = `${r.costUsd.toFixed(3)}${r.baselineCostUsd !== undefined ? ` / ${r.baselineCostUsd.toFixed(3)}` : ""}`;
    lines.push(`| ${r.task}${r.ok ? "" : ` (error: ${r.error ?? "?"})`} | ${r.logged} | ${matched} | ${r.leftover.join(", ") || "none"} | ${r.hookMs.length} | ${tokens} | ${cost} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** How often the grader's grade matches the hand label, and a count of each label → grade pair. */
export function agreement(results: { label: Grade; grade?: Grade | undefined }[]): { agreed: number; total: number; rate: number; confusion: Record<string, number> } {
  const confusion: Record<string, number> = {};
  for (const r of results) {
    const key = `${r.label} → ${r.grade ?? "error"}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  const agreed = results.filter((r) => r.grade === r.label).length;
  return { agreed, total: results.length, rate: results.length === 0 ? 0 : agreed / results.length, confusion };
}

/**
 * Claude's edits between seeing a flag and answering it. The PostToolUse hook of the
 * first edit to finish after the flag was raised hands it over; edits already issued
 * in the same turn could not have seen it. So count edit calls in Claude's later turns
 * up to its flags_resolve call. Edit events and the session's edit calls pair up in order.
 */
export function editsBeforeAnswer(transcript: string, editEvents: number[], flagEvent: number): number | undefined {
  const EDITS = new Set(["Edit", "Write", "MultiEdit"]);
  const calls: { message: string; name: string }[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    const m = JSON.parse(line) as { type?: string; parent_tool_use_id?: string | null; message?: { id?: string; content?: { type: string; name?: string }[] } };
    if (m.type !== "assistant" || m.parent_tool_use_id) continue;
    for (const c of m.message?.content ?? []) if (c.type === "tool_use" && c.name) calls.push({ message: m.message?.id ?? "", name: c.name });
  }
  const edits = calls.filter((c) => EDITS.has(c.name));
  const delivering = editEvents.findIndex((id) => id > flagEvent);
  const resolve = calls.findIndex((c) => c.name.endsWith("flags_resolve"));
  if (resolve === -1) return undefined;
  if (delivering === -1) return 0;
  const seenIn = edits[delivering]?.message;
  const after = calls.findIndex((c, i) => i > calls.indexOf(edits[delivering]!) && c.message !== seenIn);
  if (after === -1 || after > resolve) return 0;
  return calls.slice(after, resolve).filter((c) => EDITS.has(c.name)).length;
}
