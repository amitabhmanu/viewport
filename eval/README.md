# Evaluation harness

Runs scripted build tasks headless with Claude Code, once with the Viewport plugin and once without, and checks the Phase 2 gate from the implementation plan. It costs tokens, so run it by hand or nightly, never in CI.

```sh
pnpm install && pnpm build
pnpm eval                       # all tasks, sonnet, one run each plus a no-plugin baseline
pnpm eval --tasks py-refunds --model haiku --repeat 2 --parallel 2 --no-baseline
```

Results go to `eval/results/<timestamp>/` (ignored by git): `summary.md`, `scores.json`, each run's Claude Code output, and a copy of each run's `.viewport/`.

## What it measures

| Check | How | Gate |
| --- | --- | --- |
| Findings left at end | Full verification of the final model against the final code | 0 |
| Expected decisions logged | Each task lists the choices it forces (`packages/eval/src/tasks.ts`); a logged decision covers one when all of its patterns match the decision's text | at least 80% |
| Median PostToolUse time | Each edit event records the hook process's run time | under 300 ms |
| Plugin token overhead | All tokens across models, with the plugin against without, summed over runs | under 15% |

Tasks run from a clean model of their fixture (`packages/eval/src/baselines.ts`). Tools allowed: Read, Glob, Grep, Edit, Write, MultiEdit, Task, Agent, Skill and the Viewport MCP tools.

## Reading the numbers

- Token use for the same task varies by up to about 2x between runs, so a single run says little about overhead. Use `--repeat 2` or more for a gate decision.
- The decision patterns are loose on purpose: a decision such as "Store note shares as separate grants in storage" counts for both "how shares are stored" and "where sharing logic lives". Read the ledgers in the results folder before trusting a pass.

## Grader agreement (Phase 4)

```
pnpm build && pnpm eval:grader [--model sonnet] [--parallel 4] [--out FILE]
```

Grades 30 hand-labelled answers (`packages/eval/src/grader-set.ts`: six questions about `fixtures/py-shop`, five answers each) with the real `viewport-grader`, exactly as viewportd runs it, and reports how often its grade matches the label. The gate is 80%. Some answer keys are deliberately incomplete, and a few answers are right only by what the code does, so the set also exercises the second look. About 50 seconds and 50 short sonnet runs at `--parallel 6`.

## Phase 4 gate

```
pnpm build && pnpm eval:gate4 [--task py-shipping] [--model sonnet] [--out DIR]
```

Claude builds a task with the plugin while a simulated reviewer drives the viewer's API, as the developer would. It raises one flag after Claude's first edit and guesses at every new decision. When the build stops, the harness's own daemon runs the explainer. The reviewer then answers every question it wrote: half the written answers paraphrase the answer key and half are guesses. The grader grades them. The gate passes when:

- predictions are recorded
- the flag is answered within 2 edits
- the explainer writes questions
- every answer is graded

The third Phase 4 check, grader agreement, is `pnpm eval:grader`.

Flag latency counts only the edits Claude made after it could see the flag, which it gets from the PostToolUse hook of the first edit to finish after the flag was raised. Edits issued in the same turn as that one were already in flight, so they don't count. The harness pairs edit events with the session's Edit and Write calls, in order, from the `stream-json` transcript. One run takes about two minutes, including the explainer and the grader.
