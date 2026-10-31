import type { Decision, Model } from "@viewport/core";
import { describe, expect, it } from "vitest";
import { jumpItems, opensJump, search } from "./jump.js";

const meta = { source: "agent", sync: "ok" } as const;
const model = {
  version: 2,
  revision: 1,
  nodes: [
    { ...meta, kind: "container", id: "app", name: "Shop app", role: "Runs the shop" },
    { ...meta, kind: "component", id: "app.payments", name: "Payments", role: "Talks to the card provider", paths: ["src/pay/**"] },
    { ...meta, kind: "process", id: "ordering", name: "Ordering", goal: "Buy things" },
    { ...meta, kind: "step", id: "ordering.pay", name: "Pay for order", does: "Charge the card" },
    { ...meta, kind: "decision", id: "d-001", name: "Hidden", reversibility: "easy", blastRadius: 1 },
  ],
  edges: [
    { ...meta, kind: "contains", from: "app", to: "app.payments" },
    { ...meta, kind: "contains", from: "ordering", to: "ordering.pay" },
  ],
} as unknown as Model;
const ledger = [{ id: "D-001", title: "Card payments through Stripe", why: "It handles refunds" }] as Decision[];

describe("jump", () => {
  const items = jumpItems(model, ledger);

  it("reaches each part where it is shown in full, and decisions in the ledger", () => {
    expect(items.find((i) => i.id === "app.payments")?.href).toBe("/map?view=components%3Aapp&focus=app.payments");
    expect(items.find((i) => i.id === "ordering.pay")?.href).toBe("/map?view=process%3Aordering&focus=ordering.pay");
    expect(items.find((i) => i.id === "D-001")?.href).toBe("/ledger#D-001");
    expect(items.some((i) => i.id === "d-001")).toBe(false);
  });

  it("ranks a name that starts with the query first, then a word in it, then descriptions", () => {
    expect(search(items, "pay").map((i) => i.id)).toEqual(["app.payments", "ordering.pay", "D-001"]);
    expect(search(items, "card").map((i) => i.id)).toEqual(["D-001", "app.payments", "ordering.pay"]);
    expect(search(items, "pay order").map((i) => i.id)).toEqual(["ordering.pay"]);
    expect(search(items, "zzz")).toEqual([]);
    expect(search(items, "")).toHaveLength(items.length);
  });

  it("opens on Ctrl+K or Cmd+K anywhere, and on / outside a text field", () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect(opensJump(k("k", { ctrlKey: true }), true)).toBe(true);
    expect(opensJump(k("K", { metaKey: true }), false)).toBe(true);
    expect(opensJump(k("/"), false)).toBe(true);
    expect(opensJump(k("/"), true)).toBe(false);
    expect(opensJump(k("k"), false)).toBe(false);
  });
});
