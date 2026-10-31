import { describe, expect, it } from "vitest";
import { shopModelV2 } from "../test-helpers.js";
import { ModelGraph, QueryError } from "./graph.js";
import { changeImpact, failureImpact } from "./impact.js";

const shop = () => new ModelGraph(shopModelV2());

describe("what if a part fails", () => {
  it("takes down sync callers all the way up, then the steps, processes and people", () => {
    const r = failureImpact(shop(), "payment-provider");
    expect(r.effect).toMatchObject({
      "payment-provider": "fails",
      "app.payments": "down",
      "app.orders": "down",
      "app.api": "down",
      "app.storage": "down",
      "ordering.place": "affected",
      ordering: "affected",
      customer: "affected",
    });
    expect(r.effect["app.notifications"]).toBeUndefined();
    expect(r.edges).toContain("depends_on:app.payments->payment-provider");
    expect(r.edges).toContain("implements:app.orders->ordering.place");
    expect(r.edges).toContain("uses:customer->ordering");
  });

  it("only degrades parts behind an async dependency (D-013)", () => {
    const r = failureImpact(shop(), "app.notifications");
    expect(r.effect["app.orders"]).toBe("degraded");
    // A sync caller of a degraded part is degraded, not down.
    expect(r.effect["app.api"]).toBe("degraded");
    expect(Object.values(r.effect).filter((e) => e === "down")).toEqual([]);
  });

  it("takes down a runtime's containers and their components", () => {
    const r = failureImpact(shop(), "server");
    expect(r.effect).toMatchObject({ server: "fails", app: "down", "app.api": "down", "app.orders": "down", customer: "affected" });
    expect(r.edges).toContain("runs_on:app->server");
    expect(r.edges).toContain("uses:customer->app");
  });

  it("refuses kinds that cannot fail", () => {
    expect(() => failureImpact(shop(), "ordering.place")).toThrow(QueryError);
  });
});

describe("what if a requirement changes", () => {
  it("finds the code to touch and the tests to rerun for a rule", () => {
    const r = changeImpact(shop(), "refund-shipped");
    expect(r.effect).toMatchObject({ "refund-shipped": "changed", "ordering.refund": "affected", "app.orders": "touch", "checkout-tests": "retest" });
    expect(r.edges).toEqual(["constrained_by:ordering.refund->refund-shipped", "covers:checkout-tests->ordering.place", "implements:app.orders->ordering.refund"]);
    // Both ends of every arrow are in the result.
    for (const key of r.edges) for (const id of key.slice(key.indexOf(":") + 1).split("->")) expect(r.nodes).toContain(id);
  });

  it("reaches through an assumption to what assumes it", () => {
    const r = changeImpact(shop(), "full-refund");
    expect(r.effect).toMatchObject({ "full-refund": "changed", "refund-shipped": "affected", "app.orders": "touch", "checkout-tests": "retest" });
  });

  it("touches an entity's owner, writers and readers", () => {
    const r = changeImpact(shop(), "order");
    expect(r.effect).toMatchObject({ order: "changed", "app.orders": "touch", "app.storage": "touch", "checkout-tests": "retest" });
  });

  it("refuses kinds that are not requirements", () => {
    expect(() => changeImpact(shop(), "app.api")).toThrow(QueryError);
  });
});
