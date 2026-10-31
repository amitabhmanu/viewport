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
