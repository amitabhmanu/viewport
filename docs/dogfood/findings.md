# Dogfood findings

Written after two weeks. This decides what v2 should be.

## Keep

## Change

## Drop

## Passive versus generative

Do predictions, quizzes and flags help more than just looking at the views? Is that worth a proper trial?

## Gaps found while setting up

- **Workspace imports (fixed):** the TypeScript scanner couldn't follow imports between pnpm workspace packages (`@viewport/core`), because it skips `node_modules`, so a `.viewport/tsconfig.json` aliased each package to its source. The scanner now reads `pnpm-workspace.yaml` (or `workspaces` in package.json) and resolves each package's exports to its source, and the aliases are gone.

## What v2 should be
