---
description: Set up Viewport in this repo and build the first system model from the code
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/viewport":*), Read, Glob, Grep, Task, Write(.viewport/local/**)
---

Set up Viewport for this repository.

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/viewport" init` and show the developer what it created and which languages and sources it detected. If no Python or TypeScript files were found, stop and say so.
2. Use the `viewport-modeler` agent to build the first model. Tell it the repo root, that this is a fresh model, and the CLI path `${CLAUDE_PLUGIN_ROOT}/bin/viewport`.
3. If the modeler could not write the model and returned its JSON instead, write that JSON to `.viewport/local/model-draft.json` and run `"${CLAUDE_PLUGIN_ROOT}/bin/viewport" model write --from .viewport/local/model-draft.json` yourself. Do not ask first: this is the expected fallback.
4. When the model is written, run `"${CLAUDE_PLUGIN_ROOT}/bin/viewport" status` and give the developer a short summary: the system, its containers and components in one line each with their role, and anything verification still reports.

$ARGUMENTS
