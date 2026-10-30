/** The model each fixture starts from, matching fixtures/README.md, so every run begins clean. */
export const BASELINES: Record<"py-shop" | "ts-notes", { nodes: unknown[]; edges: unknown[] }> = {
  "py-shop": {
    nodes: [
      { kind: "system", id: "shop", name: "Shop", purpose: "Take and manage orders" },
      { kind: "external", id: "payment-provider", name: "Payment provider", role: "Charges and refunds cards" },
      { kind: "container", id: "app", name: "Shop app", role: "Serves the API and runs order logic", tech: "Python" },
      { kind: "component", id: "app.api", name: "API", role: "HTTP routes", paths: ["src/shop/api/**", "src/shop/__init__.py"] },
      { kind: "component", id: "app.orders", name: "Orders", role: "Order lifecycle", paths: ["src/shop/orders/**"] },
      { kind: "component", id: "app.payments", name: "Payments", role: "Talks to the payment provider", paths: ["src/shop/payments/**"] },
      { kind: "component", id: "app.notifications", name: "Notifications", role: "Queues order events", paths: ["src/shop/notifications/**"] },
      { kind: "component", id: "app.storage", name: "Storage", role: "Stores orders", paths: ["src/shop/storage/**"] },
    ],
    edges: [
      { kind: "contains", from: "shop", to: "app" },
      ...["api", "orders", "payments", "notifications", "storage"].map((c) => ({ kind: "contains", from: "app", to: `app.${c}` })),
      ...[
        ["api", "orders"],
        ["orders", "payments"],
        ["orders", "storage"],
        ["orders", "notifications"],
        ["storage", "orders"],
      ].map(([a, b]) => ({ kind: "depends_on", from: `app.${a}`, to: `app.${b}`, mode: "sync" })),
      { kind: "depends_on", from: "app.payments", to: "payment-provider", mode: "sync", protocol: "HTTPS" },
    ],
  },
  "ts-notes": {
    nodes: [
      { kind: "system", id: "notes", name: "Notes", purpose: "Keep private notes per user" },
      { kind: "container", id: "api", name: "Notes API", role: "Serves notes over HTTP", tech: "TypeScript" },
      { kind: "component", id: "api.server", name: "Server", role: "HTTP routes", paths: ["src/server/**"] },
      { kind: "component", id: "api.auth", name: "Auth", role: "Checks session tokens", paths: ["src/auth/**"] },
      { kind: "component", id: "api.notes", name: "Notes", role: "Creates and lists notes", paths: ["src/notes/**"] },
      { kind: "component", id: "api.storage", name: "Storage", role: "Stores users and notes", paths: ["src/storage/**"] },
    ],
    edges: [
      { kind: "contains", from: "notes", to: "api" },
      ...["server", "auth", "notes", "storage"].map((c) => ({ kind: "contains", from: "api", to: `api.${c}` })),
      ...[
        ["server", "auth"],
        ["server", "notes"],
        ["auth", "storage"],
        ["notes", "storage"],
      ].map(([a, b]) => ({ kind: "depends_on", from: `api.${a}`, to: `api.${b}`, mode: "sync" })),
    ],
  },
};
