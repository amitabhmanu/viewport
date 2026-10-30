---
description: Explain why part of the system is the way it is, from Viewport's decision ledger and model
argument-hint: <component id, edge key, decision id like D-003, or a question>
allowed-tools: Read, Glob, Grep, mcp__plugin_viewport_viewport__model_get, mcp__plugin_viewport_viewport__model_trace, mcp__plugin_viewport_viewport__model_view, mcp__plugin_viewport_viewport__ledger_get
---

The developer asks why: $ARGUMENTS

Answer from Viewport's ledger and model, not from memory of this session.

1. Work out what they mean. A decision id (`D-003`) goes straight to `ledger_get`. A node id or edge key goes to `model_get`, whose `decisions` field lists the decision nodes (`d-003` is ledger entry `D-003`). For a question in words, find the matching nodes with `model_view` (`overview`, then `components:<container>`), then do the same.
2. Read each relevant decision with `ledger_get`. Follow `supersedes` back to earlier entries when it explains how the choice changed.
3. Answer in a few sentences: what was chosen, the alternatives and their trade-offs, why this one, how hard it is to undo, and any assumptions the agent could not confirm. Mention its blast radius only when it is large.
4. If no decision covers it, say plainly that the ledger has no record. Explain what the model and code show about it, and label that as your reading of the code, not a recorded decision.

Do not change any files. If the developer then disagrees with a decision, suggest they flag it in the viewer, or ask you to change it, which logs a new decision that supersedes the old one.
