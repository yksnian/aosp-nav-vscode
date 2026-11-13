import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  buildEntry,
  ensureEntry,
  readCdb,
  upsertEntry,
} from "../src/clangd/cdb";

describe("upsertEntry", () => {
  const entry = buildEntry("/aosp", "/aosp/a.cpp", ["-I/aosp/inc"], "clang++");

  it("appends an unseen file", () => {
    const r = upsertEntry([], entry);
    expect(r.changed).toBe(true);
    expect(r.entries).toEqual([entry]);
  });

  it("is a no-op when flags and directory are identical", () => {
    const r = upsertEntry([entry], buildEntry("/aosp", "/aosp/a.cpp", ["-I/aosp/inc"], "clang++"));
    expect(r.changed).toBe(false);
    expect(r.entries).toEqual([entry]);
  });

  it("replaces the whole entry when flags change", () => {
    const next = buildEntry("/aosp", "/aosp/a.cpp", ["-I/aosp/inc", "-DFOO"], "clang++");
    const r = upsertEntry([entry], next);
    expect(r.changed).toBe(true);
    expect(r.entries).toEqual([next]);
  });

  it("replaces in place and preserves the order of other files", () => {
    const b = buildEntry("/aosp", "/aosp/b.cpp", [], "clang++");
    const next = buildEntry("/aosp", "/aosp/a.cpp", ["-DX"], "clang++");
    const r = upsertEntry([entry, b], next);
    expect(r.entries.map((e) => e.file)).toEqual(["/aosp/a.cpp", "/aosp/b.cpp"]);
    expect(r.entries[0].arguments).toEqual(["clang++", "-DX"]);
  });
});

describe("ensureEntry on disk", () => {
  it("creates a readable CDB and second identical write is skipped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-cdb-"));
    const file = path.join(dir, "compile_commands.json");
    try {
      const entry = buildEntry("/aosp", "/aosp/a.cpp", ["-I/aosp/inc"], "clang++");
      const first = await ensureEntry(file, entry);
      expect(first).toEqual({ changed: true, count: 1 });
      expect(await readCdb(file)).toEqual([entry]);

      const second = await ensureEntry(file, entry);
      expect(second).toEqual({ changed: false, count: 1 });

      const changed = await ensureEntry(
        file,
        buildEntry("/aosp", "/aosp/a.cpp", ["-I/aosp/other"], "clang++")
      );
      expect(changed).toEqual({ changed: true, count: 1 });
      expect((await readCdb(file))[0].arguments).toEqual(["clang++", "-I/aosp/other"]);
    } finally {
      await fs.rm(file, { force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
