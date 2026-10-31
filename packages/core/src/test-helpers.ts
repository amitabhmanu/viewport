import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "./schema.js";

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "viewport-test-"));
}

/** The model the py-shop fixture should end up with (see fixtures/README.md). */
export function shopModel(): Model {
  const component = (id: string, name: string, role: string) => ({
    kind: "component" as const,
    id,
    name,
    role,
    paths: [`src/shop/${id.split(".")[1]}/**`],
    source: "agent" as const,
    sync: "unverified" as const,
  });
  return {
    version: 1,
    revision: 0,
    nodes: [
      { kind: "system", id: "shop", name: "Shop", purpose: "Take and manage orders", source: "agent", sync: "unverified" },
      { kind: "actor", id: "customer", name: "Customer", goal: "Buy things", source: "agent", sync: "unverified" },
      { kind: "external", id: "payment-provider", name: "Payment provider", role: "Charges and refunds cards", source: "agent", sync: "unverified" },
      { kind: "container", id: "app", name: "Shop app", role: "Serves the API and runs order logic", tech: "Python", source: "agent", sync: "unverified" },
      component("app.api", "API", "HTTP routes"),
      component("app.orders", "Orders", "Order lifecycle"),
      component("app.payments", "Payments", "Talks to the payment provider"),
      component("app.notifications", "Notifications", "Queues order events"),
      component("app.storage", "Storage", "Stores orders"),
      { kind: "decision", id: "d-001", name: "In-process queue for notifications", reversibility: "easy", blastRadius: 2, source: "agent", sync: "unverified" },
    ],
    edges: [
      { kind: "contains", from: "shop", to: "app", source: "agent", sync: "unverified" },
      ...["api", "orders", "payments", "notifications", "storage"].map((c) => ({
        kind: "contains" as const,
        from: "app",
        to: `app.${c}`,
        source: "agent" as const,
        sync: "unverified" as const,
      })),
      { kind: "uses", from: "customer", to: "app", source: "agent", sync: "unverified" },
      { kind: "depends_on", from: "app.api", to: "app.orders", mode: "sync", source: "agent", sync: "unverified" },
      { kind: "depends_on", from: "app.orders", to: "app.notifications", mode: "async", source: "agent", sync: "unverified" },
      { kind: "depends_on", from: "app.payments", to: "payment-provider", mode: "sync", protocol: "HTTPS", source: "agent", sync: "unverified" },
      { kind: "decided_by", from: "depends_on:app.orders->app.notifications", to: "d-001", source: "agent", sync: "unverified" },
    ],
  };
}

/** The py-shop model with every dependency the code has, so full verification is clean. */
export function completeShopModel(changedAt?: string): Model {
  const model = shopModel();
  const api = model.nodes.find((n) => n.id === "app.api");
  if (api?.kind === "component") api.paths.push("src/shop/__init__.py");
  for (const [from, to] of [
    ["app.orders", "app.payments"],
    ["app.orders", "app.storage"],
    ["app.storage", "app.orders"],
  ] as const) {
    model.edges.push({ kind: "depends_on", from, to, mode: "sync", source: "agent", sync: "unverified" });
  }
  if (changedAt) for (const n of model.nodes) if (n.kind === "component") n.changedAt = changedAt;
  return model;
}

/**
 * The complete py-shop model with v2 layers: an ordering process with a branch on
 * cancel, a refund rule and its assumption, the order entity, tests for checkout and
 * a runtime. The tests live in `tests/`, which `shopTests` writes.
 */
export function shopModelV2(): Model {
  const model = completeShopModel();
  const meta = { source: "agent" as const, sync: "unverified" as const };
  model.version = 2;
  model.nodes.push(
    { ...meta, kind: "process", id: "ordering", name: "Ordering", goal: "A customer buys items and may cancel" },
    { ...meta, kind: "step", id: "ordering.place", name: "Place order", does: "Charge the card, save the order, announce it" },
    { ...meta, kind: "step", id: "ordering.cancel", name: "Cancel order", does: "Mark the order cancelled" },
    { ...meta, kind: "step", id: "ordering.refund", name: "Refund", does: "Refund a shipped order" },
    { ...meta, kind: "rule", id: "refund-shipped", name: "Refund shipped orders", statement: "A cancelled order is refunded only if it had shipped" },
    { ...meta, kind: "assumption", id: "full-refund", name: "Full refund", statement: "A refund returns the whole amount", status: "open" },
    { ...meta, kind: "entity", id: "order", name: "Order", description: "What a customer bought", sensitivity: "pii", code: ["Order"] },
    { ...meta, kind: "test", id: "checkout-tests", name: "Checkout tests", paths: ["tests/test_checkout.py"] },
    { ...meta, kind: "runtime", id: "server", name: "App server", role: "Runs the shop app", tech: "Python on a VM" },
  );
  model.edges.push(
    { ...meta, kind: "uses", from: "customer", to: "ordering" },
    ...["ordering.place", "ordering.cancel", "ordering.refund"].map((to) => ({ ...meta, kind: "contains" as const, from: "ordering", to })),
    { ...meta, kind: "next", from: "ordering.cancel", to: "ordering.refund", when: "the order had shipped" },
    ...["ordering.place", "ordering.cancel", "ordering.refund"].map((to) => ({ ...meta, kind: "implements" as const, from: "app.orders", to })),
    { ...meta, kind: "constrained_by", from: "ordering.refund", to: "refund-shipped" },
    { ...meta, kind: "assumes", from: "refund-shipped", to: "full-refund" },
    { ...meta, kind: "owns", from: "app.orders", to: "order" },
    { ...meta, kind: "writes", from: "app.storage", to: "order" },
    { ...meta, kind: "covers", from: "checkout-tests", to: "ordering.place" },
    { ...meta, kind: "runs_on", from: "app", to: "server" },
  );
  return model;
}

/** Writes the py-shop tests that `shopModelV2` points at into a copy of the fixture. */
export async function shopTests(root: string): Promise<void> {
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "tests/test_checkout.py"), "from shop.orders.service import place_order\n\n\ndef test_place():\n    assert place_order\n");
}
