import { mkdtemp } from "node:fs/promises";
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
