import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DecisionInput,
  type Model,
  answerQuiz,
  appendDecision,
  applyGrade,
  initWorkspace,
  markAllSeen,
  openState,
  raiseFlag,
  readModel,
  recordPrediction,
  resolveFlag,
  startOfDay,
  viewportPaths,
  writeModelFromAgent,
  writeQuizItems,
} from "@viewport/core";
import { shopModelV2, shopTests } from "../../core/src/test-helpers.js";

// Builds a believable demo workspace: the py-shop fixture with the v2 model, a week of
// decisions, answered quiz items and flags, and one change the developer has not seen.
const FIXTURE = fileURLToPath(new URL("../../../fixtures/py-shop", import.meta.url));

const TAKEAWAYS: Record<string, { simple: string; medium: string; complex: string }> = {
  "app.orders": {
    simple: "Takes an order from cart to paid.",
    medium: "Charges the card first, then saves the order and announces it on the queue.",
    complex: "Owns order state; the only writer of Order. Refunds go through the shipped rule.",
  },
  "app.payments": {
    simple: "Charges and refunds cards.",
    medium: "A thin wrapper over the card processor, called synchronously by orders.",
    complex: "Idempotent by order id, so a retried charge never bills twice.",
  },
  "app.notifications": {
    simple: "Tells the buyer what happened.",
    medium: "Reads from a queue, so a slow email never holds up an order.",
    complex: "At-least-once delivery; templates are keyed by order status.",
  },
};

const day = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();

export const DECISIONS: DecisionInput[] = [
  {
    id: "D-001",
    at: ago(6),
    title: "Charge the card before saving the order",
    options: [
      { name: "Charge first", tradeoff: "No unpaid orders, but a failed save needs a refund" },
      { name: "Save first", tradeoff: "Simple retries, but unpaid orders can leak out" },
    ],
    chosen: "Charge first",
    why: "An order must never be confirmed before the money moves; a rare refund is cheaper than shipping unpaid goods.",
    reversibility: "one-way",
    blastRadius: 4,
    affects: ["app.orders", "app.payments", "depends_on:app.orders->app.payments"],
  },
  {
    id: "D-002",
    at: ago(5),
    title: "Send notifications through a queue",
    options: [
      { name: "Queue", tradeoff: "Orders never wait on email, but sends can lag" },
      { name: "Inline", tradeoff: "Simple, but a slow mail server slows checkout" },
    ],
    chosen: "Queue",
    why: "Checkout latency matters more than instant email.",
    reversibility: "easy",
    blastRadius: 2,
    affects: ["app.notifications", "depends_on:app.orders->app.notifications"],
  },
  {
    id: "D-003",
    at: ago(4),
    title: "Keep orders in SQLite",
    options: [
      { name: "SQLite", tradeoff: "Zero ops, one writer at a time" },
      { name: "Postgres", tradeoff: "Scales writes, but needs a server" },
    ],
    chosen: "SQLite",
    why: "One app server and a few orders a minute; moving later is a contained change behind storage.",
    reversibility: "costly",
    blastRadius: 3,
    affects: ["app.storage"],
  },
  {
    id: "D-004",
    at: ago(1),
    title: "Refund only orders that have shipped",
    options: [
      { name: "Shipped only", tradeoff: "Unshipped cancels just void the charge" },
      { name: "Every cancel", tradeoff: "One path, but pays card fees twice" },
    ],
    chosen: "Shipped only",
    why: "Unshipped orders can void the authorisation instead, which costs nothing.",
    reversibility: "costly",
    blastRadius: 2,
    affects: ["ordering.refund", "refund-shipped"],
    assumptions: ["A refund returns the whole amount"],
  },
  {
    id: "D-005",
    at: ago(0.2),
    title: "Keep the API layer thin",
    options: [
      { name: "Thin API", tradeoff: "Logic lives in orders and is tested once" },
      { name: "Fat handlers", tradeoff: "Faster to write, logic spreads" },
    ],
    chosen: "Thin API",
    why: "Handlers only parse and call orders, so there is one place to read the rules.",
    reversibility: "easy",
    blastRadius: 1,
    affects: ["app.api"],
  },
];

function withTakeaways(model: Model, roleOf: Record<string, string> = {}): Model {
  return {
    ...model,
    nodes: model.nodes.map((n) => {
      let out = n;
      if (TAKEAWAYS[n.id]) out = { ...out, takeaways: TAKEAWAYS[n.id] } as typeof n;
      if (roleOf[n.id] && "role" in out) out = { ...out, role: roleOf[n.id]! } as typeof n;
      return out;
    }),
  };
}

export async function seedDemo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "viewport-demo-"));
  await cp(FIXTURE, root, { recursive: true });
  await initWorkspace(root);
  await shopTests(root);
  const paths = viewportPaths(root);
  await writeModelFromAgent(root, withTakeaways(shopModelV2()));
  for (const d of DECISIONS) await appendDecision(paths.ledger, d);

  const db = openState(paths.stateDb);
  // A week of learning: three answered questions, two right, one partly.
  const old = new Date(startOfDay(new Date()).getTime() - 60 * 60 * 1000);
  const items = writeQuizItems(
    db,
    [
      { subject: "app.orders", kind: "why", question: "Why does orders charge before it saves?", answer: "So no order is confirmed before the money moves." },
      { subject: "app.storage", kind: "why", question: "Who may write an Order?", answer: "Only orders, through storage." },
      { subject: "app.notifications", kind: "why", question: "What happens if the mail server is down?", answer: "The queue holds the message; the order still completes." },
    ],
    old,
  );
  applyGrade(db, answerQuiz(db, items[0]!, "So we never ship an unpaid order", 4, old).answerId, { grade: "correct", feedback: "Yes. Charge first means a confirmed order is always paid." });
  applyGrade(db, answerQuiz(db, items[1]!, "Orders and storage both", 5, old).answerId, { grade: "partial", feedback: "Storage writes it, but only when orders asks; orders owns it." });
  applyGrade(db, answerQuiz(db, items[2]!, "It retries from the queue later", 3, old).answerId, { grade: "correct", feedback: "Right: checkout does not wait on email." });
  const d1 = DECISIONS[0]!;
  recordPrediction(db, { id: d1.id, chosen: d1.chosen, options: d1.options }, "Charge first", ago(5));
  // Due today.
  writeQuizItems(
    db,
    [{ subject: "app.notifications", kind: "why", question: "Why is notifications async?", answer: "So a slow send never blocks an order." }],
    new Date(Date.now() - 1.1 * day),
  );
  const flag = raiseFlag(db, "depends_on:app.orders->app.payments", "Why call payments synchronously?", ago(2));
  resolveFlag(db, flag.id, "The order must not be confirmed before the charge succeeds, so orders waits for payments.", undefined, ago(1.9));

  const seen = await readModel(paths.model);
  markAllSeen(db, seen.revision);
  db.close();

  // Since the developer last looked, Claude taught orders to refund.
  await writeModelFromAgent(root, withTakeaways(shopModelV2(), { "app.orders": "Takes, cancels and refunds orders" }));
  return root;
}

/** The live change shown during the recording: Claude adds a search component. */
export async function addSearch(root: string): Promise<void> {
  const model = withTakeaways(shopModelV2(), { "app.orders": "Takes, cancels and refunds orders" });
  model.nodes.push({ kind: "component", id: "app.search", name: "search", role: "Finds products by name", paths: ["src/shop/search/**"], source: "agent", sync: "unverified" } as Model["nodes"][number]);
  model.edges.push(
    { kind: "contains", from: "app", to: "app.search", source: "agent", sync: "unverified" } as Model["edges"][number],
    { kind: "depends_on", from: "app.api", to: "app.search", mode: "sync", source: "agent", sync: "unverified" } as Model["edges"][number],
  );
  await writeModelFromAgent(root, model);
}
