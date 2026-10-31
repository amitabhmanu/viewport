// The labelled answers the Phase 4 gate checks the grader against: six questions about
// the py-shop fixture, five answers each, labelled by hand. Some keys leave things out,
// and a few answers are right only by what the code does, to exercise the second look.
import type { Decision, Grade } from "@viewport/core";

export interface LabelledQuestion {
  subject: string;
  kind: "why" | "what-if";
  question: string;
  key: string;
  answers: [answer: string, label: Grade][];
}

export const GRADER_LEDGER: Decision[] = [
  {
    id: "D-001",
    at: "2026-10-30T10:00:00.000Z",
    title: "In-process queue for notifications",
    options: [
      { name: "In-process deque", tradeoff: "No infrastructure; lost on restart" },
      { name: "Message broker", tradeoff: "Durable; one more service to run" },
    ],
    chosen: "In-process deque",
    why: "One instance for now, and a missed email is acceptable",
    reversibility: "easy",
    blastRadius: 2,
    affects: ["app.notifications"],
    assumptions: ["A single app instance"],
  },
  {
    id: "D-002",
    at: "2026-10-30T10:05:00.000Z",
    title: "Charge synchronously while placing an order",
    options: [
      { name: "Synchronous call", tradeoff: "Simple; checkout waits on the provider" },
      { name: "Queued charge", tradeoff: "Checkout is fast; orders exist before they are paid" },
    ],
    chosen: "Synchronous call",
    why: "An order is only saved once it is paid, and the customer sees the result at once",
    reversibility: "costly",
    blastRadius: 3,
    affects: ["depends_on:app.orders->app.payments"],
    assumptions: [],
  },
];

export const GRADER_SET: LabelledQuestion[] = [
  {
    subject: "app.orders",
    kind: "why",
    question: "Why does placing an order charge the customer before saving the order?",
    key: "So an order is only stored once payment succeeded: if the charge fails, nothing is saved and no notification goes out.",
    answers: [
      ["so we never save an order that wasn't paid for; if charge throws we bail before save", "correct"],
      ["payment first means a declined card never leaves a half-made order or a confirmation email behind", "correct"],
      ["because the payment provider is faster than the database", "wrong"],
      ["to make sure the money is taken", "partial"],
      ["no idea, the order probably doesn't matter", "wrong"],
    ],
  },
  {
    subject: "D-001",
    kind: "what-if",
    question: "What happens to order notifications that are still queued if the app restarts?",
    key: "They are lost: the queue is an in-memory deque inside the process, so anything not yet sent disappears on restart.",
    answers: [
      ["they're gone, it's just a deque in memory", "correct"],
      ["lost, because the queue lives in process memory and nothing persists it", "correct"],
      ["they get sent once the app comes back up", "wrong"],
      ["some of them might not go out", "partial"],
      ["the queue is in memory", "partial"],
    ],
  },
  {
    subject: "app.orders",
    kind: "what-if",
    question: "What happens if a customer cancels an order that has already shipped?",
    key: "They are refunded for the items, the order is marked cancelled and saved, and an order_cancelled notification is queued.",
    answers: [
      ["refunds them, marks it cancelled, and queues a cancellation notification", "correct"],
      ["they get their money back and the order shows as cancelled", "correct"],
      ["the order is marked cancelled", "partial"],
      ["the cancel is rejected because it already shipped", "wrong"],
      ["nothing happens", "wrong"],
    ],
  },
  {
    subject: "app.orders",
    kind: "what-if",
    question: "What happens to the customer's money when they cancel an order that has not shipped yet?",
    key: "The order is marked cancelled.",
    answers: [
      ["nothing: only shipped orders get a refund, so they were charged and keep being charged. Looks like a bug", "correct"],
      ["they get a full refund", "wrong"],
      ["the order is cancelled but no refund is issued, since refund only runs for shipped orders", "correct"],
      ["the order gets cancelled", "partial"],
      ["it depends on the order's status", "partial"],
    ],
  },
  {
    subject: "app.api",
    kind: "why",
    question: "Why does the API depend only on Orders and not on Payments or Storage directly?",
    key: "So the order lifecycle lives in one place: routes stay thin, and every rule about charging, saving and notifying is in Orders.",
    answers: [
      ["keeps the routes thin; orders owns all the business logic", "correct"],
      ["layering: api calls orders, which coordinates payments, storage and notifications, so a rule change only touches orders", "correct"],
      ["because payments is too slow to call from a route", "wrong"],
      ["separation of concerns", "partial"],
      ["storage has no functions the api could call", "wrong"],
    ],
  },
  {
    subject: "D-002",
    kind: "why",
    question: "Why does Orders call Payments synchronously rather than queueing the charge?",
    key: "Placing an order needs the charge result at once: the order is only saved after payment went through, and the reply to the customer depends on it.",
    answers: [
      ["we need to know the charge worked before we save and confirm the order", "correct"],
      ["the checkout response depends on whether the payment succeeded", "correct"],
      ["a queue would be more reliable", "wrong"],
      ["sync is simpler", "partial"],
      ["it doesn't, payments are handled asynchronously by the notifications queue", "wrong"],
    ],
  },
];
