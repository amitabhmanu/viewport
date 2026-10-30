// Stands in for `claude -p` in tests: answers an explain prompt with a takeaway and a
// question for every "## subject" line, and records its arguments next to itself.
import { appendFileSync } from "node:fs";
import process from "node:process";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args: process.argv.slice(2), job: process.env.VIEWPORT_JOB })}\n`);
if (process.env.FAKE_CLAUDE_FAIL) {
  process.stderr.write("boom");
  process.exit(2);
}
const subjects = [...prompt.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
const output = {
  takeaways: subjects.map((s) => ({ subject: s, simple: `${s} simply`, medium: `${s} in context`, complex: `${s} in depth` })),
  questions: subjects.map((s) => ({ subject: s, kind: "why", question: `Why is ${s} built this way?`, answer: `Because of ${s}.` })),
};
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: output }));
