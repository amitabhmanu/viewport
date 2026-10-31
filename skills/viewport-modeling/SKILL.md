---
name: viewport-modeling
description: Schema and rules for Viewport's system model (.viewport/model.json). Use when creating or editing the model, choosing component boundaries, or reading Viewport verification output.
---

# Viewport system model

The model is a typed graph in `.viewport/model.json`. Views a developer reads are generated from it, and deterministic verification checks it against the code. The full JSON Schema is in `schema.json` next to this file. Never edit `model.json` by hand: change it with the `model_upsert` and `model_remove` tools (or `viewport model write` from the command line), which validate, fingerprint changed components, verify and record sync states. `model_verify` reports findings without changing anything.

## Nodes

| kind | means | required fields |
| --- | --- | --- |
| `system` | the thing being built (exactly one) | `id`, `name`, `purpose` |
| `actor` | a person or role using it | `id`, `name`, `goal` |
| `external` | a system outside the boundary (payment provider, email API) | `id`, `name`, `role`; optional `protocol` |
| `container` | something that runs or deploys on its own (web app, worker, database) | `id`, `name`, `role`; optional `tech` |
| `component` | a cohesive part inside a container | `id`, `name`, `role`, `paths` (globs); optional `tech` |
| `decision` | mirrors a ledger entry | `id`, `name`, `reversibility`, `blastRadius` |
| `process` | a business process, end to end: what someone outside the code wants done | `id`, `name`, `goal` |
| `step` | one step of a process | `id`, `name`, `does` |
| `rule` | a business rule the system must keep, in plain words | `id`, `name`, `statement` |
| `assumption` | something taken as true about the business that only the developer can confirm | `id`, `name`, `statement`; `status` is `open` (default), `confirmed` or `rejected` |
| `entity` | a thing the system stores or passes around (order, user, session) | `id`, `name`, `description`; `sensitivity` is `public`, `internal` (default), `pii` or `secret`; `code` lists the class, type or table names it goes by |
| `test` | a group of tests | `id`, `name`, `paths` (globs for the test files) |
| `runtime` | where containers run once deployed | `id`, `name`, `role`; optional `tech` |

All nodes may have a one-sentence `takeaway`. Leave `source`, `sync`, `changedAt` and `fingerprint` to the tools.

Ids are lowercase slugs. Prefix component ids with their container (`app.orders`) and step ids with their process (`ordering.cancel`).

Models are written as `version: 2`. Version 1 models (no processes, rules, assumptions, entities, tests or runtimes) are read as they are and rewritten as version 2 on the next write.

## Edges

| kind | from → to | notes |
| --- | --- | --- |
| `contains` | system → container, container → component, process → step | every component is in exactly one container, every step in exactly one process |
| `depends_on` | container or component → container, component or external | needs `mode`: `sync` (direct call), `async` (queue, event), `data` (a dependency imports can't show: shared database, HTTP to another container) |
| `uses` | actor → system, container or process | |
| `decided_by` | node id or edge key → decision | edge key is `kind:from->to`, e.g. `depends_on:app.orders->app.notifications` |
| `next` | step → step | order within one process; optional `when` names the condition of a branch ("the order had shipped") |
| `implements` | component → process or step | which code carries out the step |
| `constrained_by` | process, step or entity → rule | |
| `assumes` | process, step, rule or entity → assumption | |
| `owns` | container or component → entity | at most one owner per entity: the part that decides its shape |
| `reads`, `writes` | component or external → entity | |
| `covers` | test → process, step or rule | |
| `runs_on` | container → runtime | |

Edges carry no `id`; they are identified by their key.

## Choosing components

- Aim for 3 to 9 components per container. More than that is a sign two levels are mixed: split the container or merge components.
- Follow the code's own seams: top-level packages or folders under the source root usually map one to one.
- Every source file must belong to exactly one component. Shared top-level files (`src/pkg/__init__.py`) go with the component that is the entry point.
- Name components by what they do for the system, not by pattern names.

## Beyond components

Add these layers after the architecture verifies clean, and only where the code, its tests, its docs or the task show them.

- **Processes**: the few things the system does for someone outside it ("Ordering", "Refunds"), each with the 3 to 7 steps a newcomer would name, not one per function. Link steps in order with `next`, and give each step an `implements` edge from the component that does it. A branch is two `next` edges out of one step, each with a `when`.
- **Rules and assumptions**: a rule is a business constraint the code enforces ("a cancelled order is refunded only if it had shipped"). When the code or task implies a rule you could not confirm, add an `open` assumption and an `assumes` edge from the rule. The developer confirms or rejects it.
- **Entities**: the data other parts rely on, not every class. Mark personal data `pii` and credentials or keys `secret`. List the names it has in the code in `code` so verification can check its owner.
- **Tests**: group test files by what they exercise, and add `covers` edges to the steps, processes or rules they check.
- **Runtimes**: only when deployment config or docs show where things run.

## Reading verification output

- **unclaimed**: a source file no component's `paths` covers. Extend a component's globs or add a component.
- **double-claimed**: two components' globs overlap. Narrow one.
- **missing dependency** `a -> b (file:line)`: code in `a` imports code in `b`, but there is no `depends_on` edge. Add it with the right mode, or move paths if the boundary is wrong.
- **unsupported edge**: a `sync`/`async` edge between components that no import backs. Remove it, or change its mode to `data` if the dependency is real but not an import.
- **unsupported `covers` edge**: none of the test's files import a component that implements what the edge covers (the step, the process or one of its steps, or what the rule constrains). Add the missing `implements` edge, point `covers` at what the tests exercise, or remove it.
- **unsupported `owns`, `reads` or `writes` edge**: no file of the component uses any of the entity's `code` names as a word. Fix `code`, move the edge, or remove it. Entities with no `code` names are not checked.
- **empty test group**: a test node's `paths` match no file.
- **changed since modeled**: the component's files changed after it was last written. Review it; if nothing needs to change, pass its id in `model_upsert`'s `reviewed` list (or `--reviewed <id>` on the command line).
