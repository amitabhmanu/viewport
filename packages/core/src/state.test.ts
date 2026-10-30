import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, openState, stateVersion } from "./state.js";
import { tempDir } from "./test-helpers.js";

describe("state.db", () => {
  it("creates the file, applies all migrations and uses WAL", async () => {
    const path = join(await tempDir(), ".viewport", "local", "state.db");
    const db = openState(path);
    expect(stateVersion(db)).toBe(MIGRATIONS.length);
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toEqual(
      expect.arrayContaining(["events", "flags", "predictions", "quiz_items", "quiz_answers", "familiarity", "cursors"]),
    );
    db.close();
  });

  it("is idempotent when reopened", async () => {
    const path = join(await tempDir(), "state.db");
    openState(path).close();
    const db = openState(path);
    expect(stateVersion(db)).toBe(MIGRATIONS.length);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number };
    expect(rows.n).toBe(MIGRATIONS.length);
    db.close();
  });

  it("lets two connections write", async () => {
    const path = join(await tempDir(), "state.db");
    const a = openState(path);
    const b = openState(path);
    a.prepare("INSERT INTO flags (at, subject, text) VALUES (?, ?, ?)").run("2026-10-30T13:00:00Z", "app.orders", "why not X?");
    b.prepare("INSERT INTO events (at, kind) VALUES (?, ?)").run("2026-10-30T13:00:01Z", "edit");
    const flag = b.prepare("SELECT status FROM flags").get() as { status: string };
    expect(flag.status).toBe("pending");
    a.close();
    b.close();
  });

  it("enforces checks on familiarity scores", () => {
    const db = openState(":memory:");
    expect(() => db.prepare("INSERT INTO familiarity VALUES (?, ?, ?)").run("app", 1.5, "now")).toThrow();
    db.close();
  });
});
