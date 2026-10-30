---
description: Show Viewport's system model, how well it matches the code, and the decision ledger
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/viewport":*)
---

Current Viewport status for this repo:

!`"${CLAUDE_PLUGIN_ROOT}/bin/viewport" status`

Summarize this for the developer in a few sentences: how big the model is, whether it matches the code, and the most important findings. If there are unclaimed files, missing dependencies, unsupported edges or stale components, say what they mean in plain words and suggest running the `viewport-modeler` agent to fix them. If the output says to run `viewport init`, suggest `/viewport:init` instead. Do not change any files.
