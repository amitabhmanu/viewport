// Grades the labelled answer set with the real grader, the way viewportd runs it, and
// reports agreement against the Phase 4 gate (at least 80%). Costs tokens: run by hand,
// never in CI. Needs `pnpm build` first.
//
//   pnpm eval:grader [--model sonnet] [--parallel 4] [--out FILE]
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Grade, type GradeCase, initWorkspace, readModel, viewportPaths, writeModelFromAgent } from "@viewport/core";
import { gradeAnswer, instructions } from "@viewport/viewportd";
import { BASELINES } from "./baselines.js";
import { GRADER_LEDGER, GRADER_SET } from "./grader-set.js";
import { agreement } from "./score.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const GATE = 0.8;

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "sonnet" },
    parallel: { type: "string", default: "4" },
    out: { type: "string" },
  },
});

const root = await mkdtemp(join(tmpdir(), "viewport-grader-"));
await cp(join(REPO, "fixtures", "py-shop"), root, { recursive: true, filter: (src) => !src.includes("__pycache__") });
await initWorkspace(root);
await writeModelFromAgent(root, BASELINES["py-shop"]);
const model = await readModel(viewportPaths(root).model);
const system = await instructions([join(REPO, "agents", "viewport-grader.md")]);

const cases = GRADER_SET.flatMap((q, qi) =>
  q.answers.map(([answer, label], ai) => ({
    label,
    c: { answerId: qi * 10 + ai, itemId: qi, subject: q.subject, kind: q.kind, question: q.question, expected: q.key, answer, at: new Date().toISOString() } satisfies GradeCase,
  })),
);

interface Outcome {
  question: string;
  answer: string;
  label: Grade;
  grade?: Grade;
  feedback?: string;
  looks?: number;
  error?: string;
  ms: number;
}

const outcomes: Outcome[] = new Array(cases.length);
let next = 0;
const started = Date.now();
await Promise.all(
  Array.from({ length: Number(values.parallel) }, async () => {
    for (let i = next++; i < cases.length; i = next++) {
      const { c, label } = cases[i]!;
      const t0 = Date.now();
      try {
        const r = await gradeAnswer(root, { model: values.model }, model, GRADER_LEDGER, c, system);
        outcomes[i] = { question: c.question, answer: c.answer, label, grade: r.grade, feedback: r.feedback, looks: r.looks, ms: Date.now() - t0 };
      } catch (err) {
        outcomes[i] = { question: c.question, answer: c.answer, label, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
      }
      const o = outcomes[i]!;
      console.error(`${o.grade === label ? "✓" : "✗"} [${label} → ${o.grade ?? "error"}] ${c.answer.slice(0, 70)}`);
    }
  }),
);

const score = agreement(outcomes.map((o) => ({ label: o.label, grade: o.grade })));
const lines = [
  `Grader agreement: ${score.agreed}/${score.total} (${Math.round(score.rate * 100)}%), gate ${Math.round(GATE * 100)}%: ${score.rate >= GATE ? "PASS" : "FAIL"}`,
  `Second looks: ${outcomes.filter((o) => o.looks === 2).length}; errors: ${outcomes.filter((o) => o.error).length}; ${Math.round((Date.now() - started) / 1000)}s`,
  "Label → grade:",
  ...Object.entries(score.confusion).map(([k, n]) => `  ${k}: ${n}`),
  "",
  "Disagreements:",
  ...outcomes.filter((o) => o.grade !== o.label).map((o) => `  [${o.label} → ${o.grade ?? o.error}] ${o.question}\n    "${o.answer}"\n    ${o.feedback ?? ""}`),
];
console.log(lines.join("\n"));
if (values.out) await writeFile(values.out, `${JSON.stringify({ score, outcomes }, null, 2)}\n`);
process.exitCode = score.rate >= GATE ? 0 : 1;
