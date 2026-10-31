# Dogfooding Viewport on Viewport (Phase 5)

For two weeks, Amitabh builds the next version of Viewport with Claude Code while Viewport runs on this repo. Open the viewer whenever it's useful, never on a schedule. The goal is to find out whether Viewport helps on real work, and what v2 should be.

## Set up (once, on your machine)

```
git clone https://github.com/amitabhmanu/viewport && cd viewport
pnpm install && pnpm build
claude --plugin-dir .
```

The repo already holds Viewport's model of itself (`.viewport/model.json`), an empty ledger and a config scoped to `packages/`. Inside Claude Code, `/viewport:status` shows the model and `/viewport:open` opens the viewer. Background explainer and grader runs cost tokens. Set `VIEWPORT_NO_JOBS=1` to pause them.

Rebuild with `pnpm build` after pulling changes to the plugin itself. The session keeps using the built hooks and daemon until you restart it.

## The routine

- **Before (day 0):** before you look at the model, write Viewport's main parts and three key decisions from memory in [before-after.md](before-after.md).
- **Daily:** add a few lines to [log.md](log.md): what you opened, what you ignored, what surprised you, and anything that felt like homework.
- **Weekly:** run `bin/viewport stats --days 7` and paste the table into the log. Token overhead is not in `state.db`: run `pnpm eval --no-baseline` once a week if you want it.
- **After (day 14):** write the same list from memory again, compare both with the model, then write [findings.md](findings.md): keep, change, drop, and what v2 should be.

## Tuning knobs

| Knob | Where | Now |
| --- | --- | --- |
| Familiarity half-life | `HALF_LIFE_DAYS` in `packages/core/src/familiarity.ts` | 14 days |
| Quiz cap | `QUIZ_PER_DAY` in `packages/core/src/quiz.ts` | 3 a day |
| Salience weights | `REVERSIBILITY_WEIGHT`, `RECENCY_HALF_LIFE_DAYS` in `packages/core/src/salience.ts` | 3 / 1.5 / 1, 7 days |
| Questions per item | `QUESTIONS_PER_SUBJECT` in `packages/core/src/explain.ts` | 2 |
