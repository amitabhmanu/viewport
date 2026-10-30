# Viewport

Keeps a developer's mental model alive while a coding agent builds. Viewport is a Claude Code plugin plus a local web viewer: Claude keeps building without waiting, while the plugin maintains a typed model of the system and the viewer turns it into small views, predictions and quizzes.

## Layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/` | Plugin manifest and a local marketplace entry |
| `bin/viewport` | CLI wrapper used by commands, agents and (later) hooks |
| `hooks/`, `agents/`, `skills/`, `commands/` | Plugin parts |
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

The plugin runs the CLI from this checkout, so build it first:

```sh
pnpm install && pnpm build
claude plugin marketplace add ./
claude plugin install viewport@viewport-dev
```

Or, from GitHub:

```
/plugin install viewport --marketplace amitabhmanu/viewport
```

## Using it

In a Python repo, run `/viewport:init` in Claude Code. It creates `.viewport/` (config, model, and a `.gitignore` entry for local state), and the `viewport-modeler` agent builds the first model. `/viewport:status` shows how well the model matches the code.

The CLI also works on its own: `bin/viewport status`, `bin/viewport verify --changed <file>`, `bin/viewport query trace <from> --to <to>`, and `bin/viewport --help` for the rest.
