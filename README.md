# Viewport

Keeps a developer's mental model alive while a coding agent builds. Viewport is a Claude Code plugin plus a local web viewer: Claude keeps building without waiting, while the plugin maintains a typed model of the system and the viewer turns it into small views, predictions and quizzes.

## Layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/` | Plugin manifest and a local marketplace entry |
| `bin/viewport` | CLI wrapper used by commands and agents |
| `bin/viewportd` | Viewer daemon wrapper: `ensure` prints the viewer URL, `stop` stops it |
| `hooks/`, `agents/`, `skills/`, `commands/` | Plugin parts |
| `packages/core` | Schema, verification, queries, salience |
| `packages/mcp` | stdio MCP server |
| `packages/hooks` | Hook sources, bundled into `hooks/dist` by `pnpm build` |
| `packages/eval` | Evaluation harness for the phase gates (see `eval/README.md`) |
| `packages/viewportd` | Local HTTP + SSE daemon for the viewer |
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

In a Python repo, run `/viewport:init` in Claude Code. It creates `.viewport/` (config, model, and a `.gitignore` entry for local state), and the `viewport-modeler` agent builds the first model. Besides containers and components, the model (version 2) can hold business processes and their steps, business rules and the assumptions behind them, entities with their owner and sensitivity, test groups and what they cover, and runtimes. Verification checks that tests import the code that implements what they cover, and that an entity's owner names it in its code. The viewer draws these layers from Phase 8 on. `/viewport:status` shows how well the model matches the code, and `/viewport:why <id>` explains a part of the system from the decision ledger. While building, Claude logs decisions as the `viewport-decisions` skill describes.

The CLI also works on its own: `bin/viewport status`, `bin/viewport verify --changed <file>`, `bin/viewport query trace <from> --to <to>`, and `bin/viewport --help` for the rest.

The plugin also starts the `viewport` MCP server, which gives Claude the model and ledger as tools: `model_get`, `model_view`, `model_trace`, `model_slice`, `ledger_get`, `model_verify` and `flags_pending` to read, and `model_upsert`, `model_remove`, `ledger_append`, `engage_write` and `flags_resolve` to write; `model_verify` checks the model against the code without changing it. Every write is validated against the schema and verified against the code, and `ledger_append` computes a decision's blast radius from the model.

Hooks keep the model in step while Claude works. At session start Claude gets a short overview of the model and the rule for logging decisions. After each edit, Claude hears about it only if the file belongs to no component or the developer has flagged something. Before Claude finishes, the Stop hook blocks once if that session's edits left files unclaimed, added dependencies the model lacks, or changed modeled components. After the `viewport-modeler` agent runs, the model is re-verified and saved as a new revision.

The viewer runs from a small local daemon, one per repo, which the SessionStart hook starts in the background. `/viewport:open` prints its URL and opens it. The daemon listens on 127.0.0.1 only, needs the random token in the URL for its API, and pushes a change event whenever `.viewport/` changes. It stops itself after 8 idle hours; `bin/viewportd stop` stops it sooner.

The viewer has four tabs. **Today** counts components, how many changed since they were modeled or were never checked, decisions, and your open questions. **Map** draws the model as diagrams: the overview, then containers, then one container's components. Double-click a box (or Shift+Enter) to look inside it, use the breadcrumb to go back, and switch between Simple, Medium and Complex detail; the selected box stays selected and in view. A view too large for its level is split into parts, with dashed stubs that lead to the part where a box continues. Dashed arrows are async dependencies, an orange dot means the code changed since the box was modeled, and a grey dot means it has not been checked against the code yet. Select a box or an arrow to see what it is and what shaped it, and to flag a one-line question for Claude; decisions in the Ledger take flags too. Claude hears about new flags on its next edit (at most three at a time) and, before it finishes, is asked to answer any it has not, with an explanation or a new decision that replaces the old one. Answers show on the element you asked about and on Today. **Today** also lists what changed in the model and ledger since you last looked; opening an item (or selecting its box on the Map, where changes are outlined in blue) marks it seen, and once everything is seen the starting point moves up. Each model revision is snapshotted in `.viewport/local/revisions/` (the last 200) to make this possible. **Ledger** lists every decision, ranked by blast radius and filterable by reversibility. A decision's choice and reasons stay hidden until you guess which option Claude picked, or skip; the options are shuffled so their order gives nothing away, the first answer stands, and Today offers up to three new decisions to guess at, hard-to-undo and wide-reaching ones first. **Ask** traces how parts connect (a path between two parts, what one depends on, or what depends on it), slices the model by a concern (async, sync or data dependencies, calls to external systems, stale or unchecked parts, what a decision shaped), asks what-if questions (what goes down or degrades if a part fails, following sync, async and data dependencies to the processes and people it reaches; or what code to change and which tests to rerun if a requirement changes), compares two revisions of the model, and sets a decision's options side by side (the choice stays hidden until you guess). The Map's side panel links straight to traces and what-ifs. Answers open as a view you can pin, a pinned question about a part shows as "Pinned here" on the Map wherever that part is, and each answer ends with one question about the part most worth a thought. Every question asked is logged locally as an event for the picture of what you know. Everything updates live as the model and ledger change.

At each checkpoint (when Claude finishes with the model in step), the Stop hook queues the parts and decisions that are new or changed since they were last explained. The daemon runs the `viewport-explainer` agent on them in the background as a headless `claude -p` (read-only tools, structured output, sonnet, five-minute timeout, one job at a time), which writes a takeaway at each detail level and up to two questions per item. Takeaways show on the Map; questions come back on Today on a 1, 3, 7, 21 day ladder, at most three a day, and ask how sure you are before you answer. Predict questions are graded on the spot. A why or what-if answer goes to the `viewport-grader` agent in the same queue: a first look with only the model, the ledger and the answer key, and, when that finds it partial or wrong, a second look that reads the subject's code, whose grade stands. Today then shows the grade, one line of feedback and a good answer, and the grade moves the question along the ladder. `pnpm eval:grader` checks the grader against 30 hand-labelled answers (costs tokens; the Phase 4 gate wants 80% agreement). These runs cost tokens: set `VIEWPORT_NO_JOBS=1` before the daemon starts to turn them off.

Viewport also keeps a rough estimate of what you know. Each part and decision has a familiarity score from 0 to 1 that halves every 14 days without fresh evidence. A right answer or guess raises it a lot, a partial answer a little, a wrong one halves it, having to trace or slice a part lowers it slightly, and opening a change raises it only up to 0.3. Today's change list, its predict cards and the Ledger are ranked by salience: (1 − familiarity) × blast radius × recency × reversibility weight (one-way 3, costly 1.5, easy 1). New-to-you, wide-reaching and hard-to-undo items come first. Once a few answers are graded, Today also compares how sure you said you were with how often you were right.

`pnpm build` builds the viewer into `packages/web/dist`, which the daemon serves. For UI work, `pnpm --filter @viewport/web dev` runs Vite; the viewer's end-to-end test (`packages/web/e2e`) needs Chromium, which `pnpm --filter @viewport/web exec playwright install chromium` installs.

## Dogfooding

Viewport runs on its own repo: `.viewport/` holds its model of itself and a ledger seeded with its main past decisions. [docs/dogfood](docs/dogfood/README.md) has the Phase 5 routine. `bin/viewport stats --days 7` prints the weekly engagement numbers.
