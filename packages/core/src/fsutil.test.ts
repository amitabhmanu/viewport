import { mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "./fsutil.js";

const failure = (code: string) => Object.assign(new Error(code), { code });

describe("writeFileAtomic", () => {
  it("tries the rename again while the target is held open, as on Windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "viewport-fsutil-"));
    let tries = 0;
    await writeFileAtomic(join(dir, "f.json"), "hello", async (from, to) => {
      if (++tries < 3) throw failure("EPERM");
      await rename(from, to);
    });
    expect(tries).toBe(3);
    expect(await readFile(join(dir, "f.json"), "utf8")).toBe("hello");
    expect(await readdir(dir)).toEqual(["f.json"]);
  });

  it("gives up at once on any other error, and leaves no temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "viewport-fsutil-"));
    let tries = 0;
    const move = async () => {
      tries++;
      throw failure("ENOSPC");
    };
    await expect(writeFileAtomic(join(dir, "f.json"), "hello", move)).rejects.toThrow("ENOSPC");
    expect(tries).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("gives up in the end if the target stays held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "viewport-fsutil-"));
    let tries = 0;
    const move = async () => {
      tries++;
      throw failure("EBUSY");
    };
    await expect(writeFileAtomic(join(dir, "f.json"), "hello", move)).rejects.toThrow("EBUSY");
    expect(tries).toBe(8);
    expect(await readdir(dir)).toEqual([]);
  });
});
