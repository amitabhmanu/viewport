---
description: Open the Viewport viewer for this repo in the browser
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/viewportd":*)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/viewportd" ensure --open`

Give the developer the viewer URL above as a link, and say it was opened in their browser if one is available. The URL carries a private token: it works only on this machine. If the output is an error saying there is no workspace, suggest `/viewport:init`. Do not change any files.
