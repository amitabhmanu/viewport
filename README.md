# Viewport

Keeps a developer's mental model alive while a coding agent builds. Viewport is a Claude Code plugin plus a local web viewer: Claude keeps building without waiting, while the plugin maintains a typed model of the system and the viewer turns it into small views, predictions and quizzes.

## Layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/` | Plugin manifest and a local marketplace entry |
| `bin/viewport` | CLI wrapper used by commands and agents |
| `hooks/`, `agents/`, `skills/`, `commands/` | Plugin parts |
| `packages/core` | Schema, verification, queries, salience |
| `packages/mcp` | stdio MCP server |
| `packages/hooks` | Hook sources, bundled into `hooks/dist` by `pnpm build` |
| `packages/eval` | Evaluation harness for the phase gates (see `eval/README.md`) |
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

The plugin runs the CLI, the MCP server and the hooks from this checkout, so build them first:

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

In a Python repo, run `/viewport:init` in Claude Code. It creates `.viewport/` (config, model, and a `.gitignore` entry for local state), and the `viewport-modeler` agent builds the first model. `/viewport:status` shows how well the model matches the code, and `/viewport:why <id>` explains a part of the system from the decision ledger. While building, Claude logs decisions as the `viewport-decisions` skill describes.

The CLI also works on its own: `bin/viewport status`, `bin/viewport verify --changed <file>`, `bin/viewport query trace <from> --to <to>`, and `bin/viewport --help` for the rest.

The plugin also starts the `viewport` MCP server, which gives Claude the model and ledger as tools: `model_get`, `model_view`, `model_trace`, `model_slice`, `ledger_get`, `model_verify` and `flags_pending` to read, and `model_upsert`, `model_remove`, `ledger_append`, `engage_write` and `flags_resolve` to write; `model_verify` checks the model against the code without changing it. Every write is validated against the schema and verified against the code, and `ledger_append` computes a decision's blast radius from the model.

Hooks keep the model in step while Claude works. At session start Claude gets a short overview of the model and the rule for logging decisions. After each edit, Claude hears about it only if the file belongs to no component or the developer has flagged something. Before Claude finishes, the Stop hook blocks once if that session's edits left files unclaimed, added dependencies the model lacks, or changed modeled components. After the `viewport-modeler` agent runs, the model is re-verified and saved as a new revision.
