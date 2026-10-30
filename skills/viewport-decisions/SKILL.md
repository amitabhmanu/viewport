---
name: viewport-decisions
description: When and how to log a design decision in Viewport's ledger with the ledger_append tool. Use while building in a repo with a .viewport/ folder, whenever you pick between real alternatives that shape the system, or when answering a developer's flag changes your plan.
---

# Logging decisions in Viewport

The developer is not watching you build. They learn what you decided from the ledger, later, in the viewer, where each decision hides its answer until they guess. A decision you do not log is one they never get to think about. Log it when you make it, then keep building: never stop to ask.

## What counts

Log a choice when **both** are true:

1. There were at least two options a competent engineer would seriously consider.
2. Changing your mind later would touch more than the lines you just wrote: other components, stored data, an interface someone calls, or a dependency that is hard to swap.

Typical decisions:

- Where a new capability lives: a new component, or which existing component takes it on (log this even when the answer is "in the existing one")
- Moving responsibility from one component to another
- A new dependency between components, and whether it is a direct call, a queue or shared data
- Where data lives, its shape when it is stored or sent, and who owns it
- A protocol, API shape or error contract other code relies on
- A library or service that would be costly to replace
- Handling a business rule the task did not spell out (that is also an assumption, see below)

Not decisions: names of local variables, formatting, which loop to write, fixing a typo, following a pattern the code already uses everywhere. If the code base already settled it, follow it and do not log it.

Aim for one decision per question: "where shipping lives" and "how shipping sends email" are two entries, not one. Most features raise one to three. Ten for a small change is noise; none for a new component is a gap.

## The record

Call `ledger_append` with:

| field | how to fill it |
| --- | --- |
| `title` | The question, in a few words: "How refunds reach the payment provider" |
| `options` | 2 to 4 real options, each with one line of trade-off. Include the one you rejected that the developer is most likely to have picked |
| `chosen` | The `name` of one option, exactly |
| `why` | One or two sentences tied to this code base, not general truths |
| `reversibility` | `easy` (change in one place), `costly` (several components or a data migration), `one-way` (published API, deleted data, external contract) |
| `affects` | Node ids (`app.refunds`) and edge keys (`depends_on:app.refunds->app.payments`) this choice shapes. Update the model with `model_upsert` **first**, so they exist |
| `assumptions` | Anything you took as true but could not confirm from the code or the task, especially business rules |

Do not set a blast radius: the tool computes it from the model.

## Good and bad entries

Good:

```json
{
  "title": "How refunds reach the payment provider",
  "options": [
    { "name": "Call payments.gateway directly", "tradeoff": "Simple; refunds fail when the provider is down" },
    { "name": "Queue refund requests", "tradeoff": "Survives outages; needs a worker and idempotency keys" }
  ],
  "chosen": "Call payments.gateway directly",
  "why": "Checkout already calls the gateway synchronously and there is no worker process yet; a queue would be the first one.",
  "reversibility": "easy",
  "affects": ["app.refunds", "depends_on:app.refunds->app.payments"],
  "assumptions": ["A refund may be issued only once per order"]
}
```

Bad, and why:

- `"options": [{ "name": "Use a function" }, { "name": "Don't" }]`: a straw man. Name the option a thoughtful developer would argue for.
- `"why": "It is best practice"`: says nothing about this code. Say what in the code or task tipped it.
- `"affects": []` on a choice that added a component: the developer cannot find it from the map, and the blast radius is zero.
- Logging the same choice again after each edit: log it once; log a new entry with `supersedes` only when you change your mind.

## Changing your mind

Never edit a ledger entry. Log a new one with `supersedes: "D-007"` and say in `why` what changed. If a developer's flag (see `flags_pending`) changed your plan, log the new decision first, then answer the flag with `flags_resolve` and pass the new decision's id.
