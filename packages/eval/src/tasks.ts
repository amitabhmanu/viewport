/** A decision a competent agent should log during a task, recognized by patterns over its text. */
export interface ExpectedDecision {
  id: string;
  /** Every pattern must match the decision's title, options, chosen option and reason. */
  match: RegExp[];
}

export interface EvalTask {
  id: string;
  /** Directory under fixtures/. */
  fixture: "py-shop" | "ts-notes";
  prompt: string;
  expected: ExpectedDecision[];
}

/**
 * Scripted build tasks for the Phase 2 gate. Each one adds a feature that forces at
 * least one real structural choice, and the expected list names those choices.
 */
export const TASKS: EvalTask[] = [
  {
    id: "py-refunds",
    fixture: "py-shop",
    prompt:
      "Add refunds: refund_order(order_id) loads the order from storage, refunds it through the payment gateway, and enqueues a 'refunded' notification. Keep it small.",
    expected: [{ id: "where refund logic lives", match: [/refund/i, /component|package|module|orders|own|separate|where/i] }],
  },
  {
    id: "py-shipping",
    fixture: "py-shop",
    prompt:
      "Add order shipping: an order can be marked as shipped, and when it ships the customer gets an email through an external email provider. Write a small HTTP client stub for the provider (no real network calls, no new third-party libraries).",
    expected: [
      { id: "where the email provider client lives", match: [/e-?mail|mail/i, /component|package|module|client|notifications|separate|own|where/i] },
      { id: "how shipping triggers the email", match: [/e-?mail|mail|notif/i, /sync|async|queue|direct|inline|event/i] },
    ],
  },
  {
    id: "ts-sharing",
    fixture: "ts-notes",
    prompt:
      "Add note sharing: the owner of a note can share it with another user by user id, and shared notes appear in that user's note list. Add a share route to the server.",
    expected: [
      { id: "how shares are stored", match: [/shar/i, /stor|table|record|field|persist|map|list|array/i] },
      { id: "where sharing logic lives", match: [/shar/i, /component|module|notes|service|separate|own|where/i] },
    ],
  },
];
