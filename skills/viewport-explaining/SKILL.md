---
name: viewport-explaining
description: How to write Viewport takeaways and quiz questions about parts of a system and the decisions behind them. Use when explaining Viewport model nodes or ledger decisions to the developer who owns the code.
---

# Explaining a system to its owner

The reader is the developer who owns this code but did not write it: a coding agent did. They are sharp and short on time. Your job is to keep their mental model of the system alive, so they can review, debug and steer it without rereading everything.

## Takeaways

Write one takeaway per subject, at three levels. Each is one sentence, under 30 words, in plain words. Say what the part is for or what the decision means, never how it is spelled in code.

- **simple**: what it does for the product, in words a product manager would use. No technology names.
- **medium**: what it does and how it fits with its neighbours: what it calls, who calls it, and whether that is synchronous.
- **complex**: the one thing an engineer should know before changing it: an invariant, a failure mode, a coupling, or a cost.

Good (orders, medium): "Runs the order lifecycle and calls Payments synchronously, so a slow payment provider slows checkout."
Bad: "The orders module contains the OrderService class." (names code, says nothing about behaviour)

For a decision, the takeaway says what was chosen and what it commits the system to: "Notifications queue in memory, so they are lost if the app restarts."

## Questions

Write at most two questions per subject, only where there is something worth thinking about. Each needs an `answer`: what a good answer says, in one or two sentences. The developer never sees it before answering; a grader compares their answer with it.

- **why**: why is it built this way? Ask about a real trade-off, not a fact to recall. "Why does Orders call Payments synchronously rather than queueing the charge?"
- **what-if**: what happens under a change or failure? "What happens to pending notifications if the app restarts?"
- **predict**: for a decision, which option would you pick? Give the real options as `choices`, and the chosen one, word for word, as `answer`.

Now and then, about one question in four, set `stretch` to true on a why or what-if question that assumes the `complex` level's vocabulary and depth: protocols, failure modes, key configuration. A right answer shows the developer is ready to step up, and the viewer poses at most one a day.

Avoid trivia (file names, line counts, exact library versions), questions answered by the subject's own name, and anything the model you were given cannot support. If you are unsure, read the code with Read, Grep or Glob; do not guess.

## Output

Return JSON matching the schema you are given: `takeaways` with `subject`, `simple`, `medium` and `complex`, and `questions` with `subject`, `kind`, `question`, `answer`, for predict `choices`, and optionally `stretch`. Use only the subject ids you were given.
