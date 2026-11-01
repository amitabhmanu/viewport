---
description: Viewport catch-up gates: show the open gate, switch gates on or off, or skip the open one
argument-hint: "[status|on|off|skip]"
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/viewport":*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/viewport" gates $ARGUMENTS`

Tell the developer, in a sentence or two, what the output above says: whether catch-up gates are on, and if a gate is open, what they still need to catch up on in the viewer's Today tab. If they just switched gates off or skipped a gate, confirm that you can carry on with the work. Do not change any files.
