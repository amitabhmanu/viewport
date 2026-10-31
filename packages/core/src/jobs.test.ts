import { describe, expect, it } from "vitest";
import { claimJob, enqueueJob, finishJob, jobErrorHint, jobHealth } from "./jobs.js";
import { openState } from "./state.js";

function run(db: ReturnType<typeof openState>, at: string, error?: string) {
  enqueueJob(db, "explain", { subjects: ["a"] }, at);
  finishJob(db, claimJob(db, at)!.id, error, at);
}

describe("jobHealth", () => {
  it("counts the failures since the last job that worked, and offers a fix it recognizes", () => {
    const db = openState(":memory:");
    expect(jobHealth(db)).toEqual({ failedInARow: 0 });
    run(db, "2026-10-31T05:00:00.000Z", "timed out after 300s");
    run(db, "2026-10-31T05:01:00.000Z");
    expect(jobHealth(db).failedInARow).toBe(0);
    run(db, "2026-10-31T05:02:00.000Z", "claude exited with 1: Credit balance is too low | ⚠ ... ANTHROPIC_API_KEY ...");
    run(db, "2026-10-31T05:03:00.000Z", "claude exited with 1: Credit balance is too low | ⚠ ... ANTHROPIC_API_KEY ...");
    const health = jobHealth(db);
    expect(health).toMatchObject({ failedInARow: 2, lastFailedAt: "2026-10-31T05:03:00.000Z" });
    expect(health.lastError).toContain("Credit balance");
    expect(health.hint).toContain("VIEWPORT_JOBS_USE_LOGIN=1");
  });

  it("counts every finished job when none has worked yet", () => {
    const db = openState(":memory:");
    run(db, "2026-10-31T05:00:00.000Z", "x");
    run(db, "2026-10-31T05:01:00.000Z", "y");
    expect(jobHealth(db)).toEqual({ failedInARow: 2, lastError: "y", lastFailedAt: "2026-10-31T05:01:00.000Z" });
  });
});

describe("jobErrorHint", () => {
  it("recognizes an old daemon reading a newer model, a missing claude, and nothing else", () => {
    expect(jobErrorHint('[{"code":"invalid_value","values":[1],"path":["version"],"message":"Invalid input: expected 1"}]')).toContain("pnpm build");
    expect(jobErrorHint("the model is version 3, but this daemon is older than that and reads up to version 2")).toContain("viewportd stop");
    expect(jobErrorHint("could not run 'claude': install Claude Code's native build")).toContain("VIEWPORT_CLAUDE");
    expect(jobErrorHint("timed out after 300s")).toBeUndefined();
  });
});
