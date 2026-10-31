// Stands in for `claude -p` in tests, and records its arguments in FAKE_CLAUDE_LOG.
// An explain prompt gets a takeaway and a question for every "## subject" line. A grade
// prompt's first look calls an answer containing "right" correct and anything else
// partial; a second look calls it correct only if it also contains "in the code".
import { appendFileSync } from "node:fs";
import process from "node:process";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args: process.argv.slice(2), job: process.env.VIEWPORT_JOB })}\n`);
if (process.env.FAKE_CLAUDE_FAIL) {
  process.stderr.write("boom");
  process.exit(2);
}
let output;
if (prompt.startsWith("Grade the developer's answer")) {
  const answer = prompt.split("# Developer's answer\n")[1]?.split("\n# ")[0] ?? "";
  const second = prompt.includes("# Second look");
  const grade = second ? (answer.includes("in the code") ? "correct" : "wrong") : answer.includes("right") ? "correct" : "partial";
  output = { grade, feedback: `${second ? "Second" : "First"} look: ${grade}.` };
} else {
  const subjects = [...prompt.matchAll(/^## (\S+)$/gm)].map((m) => m[1]);
  output = {
    takeaways: subjects.map((s) => ({ subject: s, simple: `${s} simply`, medium: `${s} in context`, complex: `${s} in depth` })),
    questions: subjects.map((s) => ({ subject: s, kind: "why", question: `Why is ${s} built this way?`, answer: `Because of ${s}.` })),
  };
}
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: output }));
