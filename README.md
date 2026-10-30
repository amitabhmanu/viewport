# Viewport

Keeps a developer's mental model alive while a coding agent builds. Viewport is a Claude Code plugin plus a local web viewer: Claude keeps building without waiting, while the plugin maintains a typed model of the system and the viewer turns it into small views, predictions and quizzes.

## Layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/` | Plugin manifest and a local marketplace entry |
| `hooks/`, `agents/`, `skills/`, `commands/` | Plugin parts (filled in from Phase 1) |
| `packages/core` | Schema, verification, queries, salience |
| `packages/mcp` | stdio MCP server |
| `packages/viewportd` | Local HTTP + SSE daemon |
| `packages/web` | Viewer UI |
| `fixtures/` | Sample Python and TypeScript apps for tests |

## Development

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm check   # typecheck, lint, test
```

## Install the plugin from this checkout

```sh
claude plugin marketplace add ./
claude plugin install viewport@viewport-dev
```

Or, from GitHub:

```
/plugin install viewport --marketplace amitabhmanu/viewport
```
