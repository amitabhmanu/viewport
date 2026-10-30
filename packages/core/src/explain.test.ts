import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyExplanation, explainDue, explainPrompt } from "./explain.js";
import { claimJob, enqueueJob, finishJob, openJobs, requeueStale } from "./jobs.js";
import { readModel, writeModel } from "./model-store.js";
import type { Decision } from "./schema.js";
import { openState } from "./state.js";
import { shopModel, tempDir } from "./test-helpers.js";

const decision: Decision = {
  id: "D-001",
  at: "2026-10-30T10:00:00.000Z",
  title: "In-process queue for notifications",
  options: [
    { name: "In-process", tradeoff: "simple" },
    { name: "Broker", tradeoff: "durable" },
  ],
  chosen: "In-process",
  why: "One instance for now",
  reversibility: "easy",
  blastRadius: 2,
  affects: ["app.notifications"],
  assumptions: [],
};

describe("jobs", () => {
  it("runs queued jobs in order and requeues ones a stopped daemon left running", () => {
    const db = openState(":memory:");
    enqueueJob(db, "explain", { subjects: ["a"] });
    enqueueJob(db, "explain", { subjects: ["b"] });
    const first = claimJob(db)!;
    expect(first.payload).toEqual({ subjects: ["a"] });
    finishJob(db, first.id);
    claimJob(db);
    expect(requeueStale(db)).toBe(1);
    const again = claimJob(db)!;
    finishJob(db, again.id, "timed out");
    expect(claimJob(db)).toBeUndefined();
    expect(openJobs(db)).toEqual([]);
  });
});

describe("explainer", () => {
  it("explains what is new or changed once, and stores takeaways and questions from the batch only", async () => {
    const path = join(await tempDir(), ".viewport", "model.json");
    const db = openState(":memory:");
    await writeModel(path, shopModel());
    let model = await readModel(path);
    const due = explainDue(db, model, [decision]);
    expect(due).toContain("app.orders");
    expect(due).toContain("D-001");
    expect(due).not.toContain("d-001");

    const prompt = explainPrompt(model, [decision], ["app.orders", "D-001"]);
    expect(prompt).toContain("## app.orders");
    expect(prompt).toContain("Depends on: Notifications (async)");
    expect(prompt).toContain('"chosen":"In-process"');

    const result = await applyExplanation(path, db, [decision], ["app.orders", "D-001"], {
      takeaways: [
        { subject: "app.orders", simple: "Runs orders.", medium: "Runs the order lifecycle.", complex: "Owns order state transitions." },
        { subject: "D-001", simple: "Queue in memory.", medium: "Notifications queue in process.", complex: "Lost on restart." },
        { subject: "app.api", simple: "x", medium: "x", complex: "x" },
      ],
      questions: [
        { subject: "D-001", kind: "predict", question: "Where do notifications queue?", choices: ["In memory", "A broker"], answer: "In memory" },
        { subject: "D-001", kind: "predict", question: "Bad", choices: ["a", "b"], answer: "c" },
        { subject: "app.orders", kind: "why", question: "Why async to notifications?", answer: "So a slow send does not hold up the order." },
        { subject: "app.api", kind: "why", question: "Out of batch", answer: "x" },
      ],
    });
    expect(result).toEqual({ takeaways: 2, questions: 2 });
    model = await readModel(path);
    expect(model.nodes.find((n) => n.id === "app.orders")?.takeaways?.simple).toBe("Runs orders.");
    expect(model.nodes.find((n) => n.id === "d-001")?.takeaway).toBe("Notifications queue in process.");
    expect(model.nodes.find((n) => n.id === "app.api")?.takeaways).toBeUndefined();

    const next = explainDue(db, model, [decision]);
    expect(next).not.toContain("app.orders");
    expect(next).not.toContain("D-001");
    enqueueJob(db, "explain", { subjects: ["app.api"] });
    expect(explainDue(db, model, [decision])).not.toContain("app.api");
    const changed = { ...model, nodes: model.nodes.map((n) => (n.id === "app.orders" ? { ...n, role: "Orders and refunds" } : n)) };
    expect(explainDue(db, changed, [decision])).toContain("app.orders");
  });
});
