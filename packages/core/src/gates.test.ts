import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { logEvent } from "./asks.js";
import { readConfig, updateGateSettings } from "./config-store.js";
import { recordPrediction } from "./engage.js";
import {
  checkMilestone,
  currentGate,
  editsSinceGate,
  gateCursor,
  gateQuestion,
  gatesOff,
  hasOpenGate,
  isMilestone,
  listGates,
  skipGate,
  workSince,
} from "./gates.js";
import { applyGrade } from "./grade.js";
import { claimJob, enqueueJob, finishJob } from "./jobs.js";
import { answerQuiz } from "./quiz.js";
import { GateSettings, type Decision } from "./schema.js";
import { openState } from "./state.js";
import { completeShopModel, tempDir } from "./test-helpers.js";

const SETTINGS = GateSettings.parse({});
const T0 = new Date("2026-11-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function decision(n: number, minutes: number, affects: string[] = ["app.orders"]): Decision {
  return {
    id: `D-${String(n).padStart(3, "0")}`,
    at: at(minutes).toISOString(),
    title: `Choice ${n}`,
    options: [
      { name: "A", tradeoff: "simple" },
      { name: "B", tradeoff: "flexible" },
    ],
    chosen: "A",
    why: `Because ${n}`,
    reversibility: n === 1 ? "one-way" : "easy",
    blastRadius: 1,
    affects,
    assumptions: [],
  };
}

function setup() {
  const db = openState(":memory:");
  const model = completeShopModel();
  gateCursor(db, T0);
  return { db, model };
}

describe("milestones", () => {
  it("counts decisions since the last gate and components Claude edited", () => {
    const { db, model } = setup();
    logEvent(db, "edit", "src/shop/payments/client.py", {}, at(1).toISOString());
    logEvent(db, "edit", "src/shop/payments/client.py", {}, at(2).toISOString());
    logEvent(db, "edit", "README.md", {}, at(2).toISOString());
    const ledger = [decision(1, -5), decision(2, 3, ["app.storage"])];
    const work = workSince(db, model, ledger, gateCursor(db));
    expect(work.decisions).toEqual(["D-002"]);
    // Storage, from the decision, plus Orders, which depends on it.
    expect(work.components).toEqual(expect.arrayContaining(["app.payments", "app.storage"]));
    expect(isMilestone(work, SETTINGS)).toBe(false);
    expect(isMilestone({ ...work, decisions: ["a", "b", "c"] }, SETTINGS)).toBe(true);
  });

  it("starts counting the first time gates are checked, not from the start of history", () => {
    const db = openState(":memory:");
    expect(gateCursor(db, T0)).toBe(T0.toISOString());
    expect(gateCursor(db, at(60))).toBe(T0.toISOString());
  });

  it("opens no gate below a milestone, and one at it with a question per subject", () => {
    const { db, model } = setup();
    const ledger = [decision(1, 1), decision(2, 2)];
    expect(checkMilestone(db, model, ledger, SETTINGS, "s1", at(3))).toBeUndefined();
    ledger.push(decision(3, 3));
    const gate = checkMilestone(db, model, ledger, SETTINGS, "s1", at(4))!;
    expect(gate.session).toBe("s1");
    expect(gate.subjects.length).toBeLessThanOrEqual(SETTINGS.subjects);
    // The one-way decision is the most salient.
    expect(gate.subjects[0]).toMatchObject({ id: "D-001", kind: "decision", met: false, answered: false, predicted: false });
    expect(gate.subjects.every((s) => s.question.length > 0)).toBe(true);
    expect(hasOpenGate(db)).toBe(true);
    // One gate at a time.
    expect(checkMilestone(db, model, [...ledger, decision(4, 5), decision(5, 5), decision(6, 5)], SETTINGS, "s1", at(6))).toBeUndefined();
  });

  it("writes questions with answer keys from the ledger and the model", () => {
    const model = completeShopModel();
    const d = gateQuestion(model, [decision(1, 0)], "D-001");
    expect(d.question).toContain('"A" over "B"');
    expect(d.answer).toContain("Because 1");
    const c = gateQuestion(model, [], "app.storage");
    expect(c.question).toContain("Storage");
    expect(c.answer).toContain("Stores orders");
    expect(c.answer).toContain("app.orders");
  });
});

describe("passing a gate", () => {
  it("passes once every subject reaches the threshold, through predictions and graded answers", () => {
    const { db, model } = setup();
    const ledger = [decision(1, 1), decision(2, 2), decision(3, 3)];
    const gate = checkMilestone(db, model, ledger, SETTINGS, "s1", at(4))!;
    const decisions = gate.subjects.filter((s) => s.kind === "decision");
    const components = gate.subjects.filter((s) => s.kind === "component");

    for (const s of decisions) recordPrediction(db, ledger.find((d) => d.id === s.id)!, "A", at(5).toISOString());
    let now = currentGate(db, model, ledger, SETTINGS, at(6))!;
    expect(now.closedAt).toBeUndefined();
    expect(now.subjects.filter((s) => s.met).map((s) => s.id).sort()).toEqual(decisions.map((s) => s.id).sort());

    for (const s of components) {
      const { answerId } = answerQuiz(db, s.itemId, "It does the thing", 3, at(7));
      expect(currentGate(db, model, ledger, SETTINGS, at(7))!.subjects.find((x) => x.id === s.id)).toMatchObject({ answered: true, grading: true });
      applyGrade(db, answerId, { grade: "wrong", feedback: "no" });
      applyGrade(db, answerQuiz(db, s.itemId, "Better answer", 4, at(8)).answerId, { grade: "correct", feedback: "yes" });
    }
    now = currentGate(db, model, ledger, SETTINGS, at(9))!;
    expect(now).toMatchObject({ outcome: "passed" });
    expect(hasOpenGate(db)).toBe(false);
    expect(currentGate(db, model, ledger, SETTINGS, at(10))).toBeUndefined();
    expect(listGates(db, model, ledger, SETTINGS)[0]).toMatchObject({ outcome: "passed" });
  });

  it("releases the gate when every answer is in but background jobs keep failing", () => {
    const { db, model } = setup();
    const ledger = [decision(1, 1), decision(2, 2), decision(3, 3)];
    const gate = checkMilestone(db, model, ledger, SETTINGS, "s1", at(4))!;
    for (const s of gate.subjects) answerQuiz(db, s.itemId, "My answer", 3, at(5));
    for (const _ of [1, 2, 3]) {
      enqueueJob(db, "explain", {});
      finishJob(db, claimJob(db)!.id, "claude exited with 1");
    }
    expect(currentGate(db, model, ledger, SETTINGS, at(6))).toMatchObject({ outcome: "released" });
  });

  it("skips a gate, and counts the next milestone from it", () => {
    const { db, model } = setup();
    const ledger = [decision(1, 1), decision(2, 2), decision(3, 3)];
    checkMilestone(db, model, ledger, SETTINGS, "s1", at(4));
    logEvent(db, "edit", "src/shop/orders/service.py", {}, at(5).toISOString());
    expect(editsSinceGate(db, { openedAt: at(4).toISOString() })).toBe(1);
    expect(skipGate(db, at(6))).toBe(true);
    expect(skipGate(db, at(6))).toBe(false);
    expect(checkMilestone(db, model, ledger, SETTINGS, "s1", at(7))).toBeUndefined();
  });
});

describe("gate settings", () => {
  it("are on by default, and off in config or with VIEWPORT_NO_GATES", () => {
    expect(gatesOff(SETTINGS, {})).toBe(false);
    expect(gatesOff({ ...SETTINGS, enabled: false }, {})).toBe(true);
    expect(gatesOff(SETTINGS, { VIEWPORT_NO_GATES: "1" })).toBe(true);
  });

  it("switch in config.json without writing out the defaults", async () => {
    const path = join(await tempDir(), "config.json");
    await writeFile(path, JSON.stringify({ version: 1, sources: ["src/**"], languages: ["python"] }));
    expect((await readConfig(path)).gates.enabled).toBe(true);
    const config = await updateGateSettings(path, { enabled: false });
    expect(config.gates).toMatchObject({ enabled: false, decisions: 3 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, sources: ["src/**"], languages: ["python"], gates: { enabled: false } });
    await expect(updateGateSettings(path, { threshold: 2 })).rejects.toThrow();
  });
});
