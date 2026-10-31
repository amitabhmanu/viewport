# Dogfood findings

Written after two weeks. This decides what v2 should be.

## Keep

## Change

## Drop

## Passive versus generative

Do predictions, quizzes and flags help more than just looking at the views? Is that worth a proper trial?

## Gaps found while setting up

- **Workspace imports:** the TypeScript scanner can't follow imports between pnpm workspace packages (`@viewport/core`), because it skips `node_modules`. The workaround is `.viewport/tsconfig.json`, which aliases each package to its source. v2 should read workspace packages on its own.

## What v2 should be
