---
name: viewport-modeling
description: Schema and rules for Viewport's system model (.viewport/model.json). Use when creating or editing the model, choosing component boundaries, or reading Viewport verification output.
---

# Viewport system model

The model is a typed graph in `.viewport/model.json`. Views a developer reads are generated from it, and deterministic verification checks it against the code. The full JSON Schema is in `schema.json` next to this file. Never edit `model.json` by hand: write it with `viewport model write`, which validates, fingerprints changed components, verifies and records sync states.

## Nodes

| kind | means | required fields |
| --- | --- | --- |
| `system` | the thing being built (exactly one) | `id`, `name`, `purpose` |
| `actor` | a person or role using it | `id`, `name`, `goal` |
| `external` | a system outside the boundary (payment provider, email API) | `id`, `name`, `role`; optional `protocol` |
| `container` | something that runs or deploys on its own (web app, worker, database) | `id`, `name`, `role`; optional `tech` |
| `component` | a cohesive part inside a container | `id`, `name`, `role`, `paths` (globs); optional `tech` |
| `decision` | mirrors a ledger entry | `id`, `name`, `reversibility`, `blastRadius` |

All nodes may have a one-sentence `takeaway`. Leave `source`, `sync`, `changedAt` and `fingerprint` to the tools.

Ids are lowercase slugs. Prefix component ids with their container: `app.orders`.

## Edges

| kind | from → to | notes |
| --- | --- | --- |
| `contains` | system → container, container → component | every component is in exactly one container |
| `depends_on` | container or component → container, component or external | needs `mode`: `sync` (direct call), `async` (queue, event), `data` (a dependency imports can't show: shared database, HTTP to another container) |
| `uses` | actor → system or container | |
| `decided_by` | node id or edge key → decision | edge key is `kind:from->to`, e.g. `depends_on:app.orders->app.notifications` |

Edges carry no `id`; they are identified by their key.

## Choosing components

- Aim for 3 to 9 components per container. More than that is a sign two levels are mixed: split the container or merge components.
- Follow the code's own seams: top-level packages or folders under the source root usually map one to one.
- Every source file must belong to exactly one component. Shared top-level files (`src/pkg/__init__.py`) go with the component that is the entry point.
- Name components by what they do for the system, not by pattern names.

## Reading verification output

- **unclaimed**: a source file no component's `paths` covers. Extend a component's globs or add a component.
- **double-claimed**: two components' globs overlap. Narrow one.
- **missing dependency** `a -> b (file:line)`: code in `a` imports code in `b`, but there is no `depends_on` edge. Add it with the right mode, or move paths if the boundary is wrong.
- **unsupported edge**: a `sync`/`async` edge between components that no import backs. Remove it, or change its mode to `data` if the dependency is real but not an import.
- **changed since modeled**: the component's files changed after it was last written. Review it; if nothing needs to change, write with `--reviewed <id>`.
