// test/eclipseGuard.test.ts (vitest: pure functions + the bounded walk)
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { escapeGlob, patternsFor, scanBlockers, GuardReport } from "../src/jdtls/eclipseGuardScan";

describe("escapeGlob", () => {
  it("keeps plain absolute paths untouched", () => {
    expect(escapeGlob("/home/u/aosp/external/conscrypt")).toBe("/home/u/aosp/external/conscrypt");
  });

  it("escapes glob metacharacters literally", () => {
    expect(escapeGlob("/a/[b]*c?{d}")).toBe("/a/\\[b\\]\\*c\\?\\{d\\}");
  });

  it("escapes backslashes", () => {
    expect(escapeGlob("C:\\x\\y")).toBe("C:\\\\x\\\\y");
  });
});

describe("patternsFor", () => {
  it("maps blockers to escaped absolute patterns", () => {
    const r: GuardReport = { folder: "/r", blockers: ["/r/a", "/r/b"], rootBlocked: false };
    expect(patternsFor(r)).toEqual(["/r/a", "/r/b"]);
  });

  it("includes the folder itself when the workspace root is blocked", () => {
    const r: GuardReport = { folder: "/r", blockers: [], rootBlocked: true };
    expect(patternsFor(r)).toEqual(["/r"]);
  });

  it("dedups blockers pointing at the same dir", () => {
    const r: GuardReport = { folder: "/r", blockers: ["/r/a", "/r/a"], rootBlocked: false };
    expect(patternsFor(r)).toEqual(["/r/a"]);
  });

  it("no patterns when nothing is blocked", () => {
    const r: GuardReport = { folder: "/r", blockers: [], rootBlocked: false };
    expect(patternsFor(r)).toEqual([]);
  });
});

describe("scanBlockers", () => {
  let root = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-guard-"));
    // .project alone is a blocker (no .classpath required)
    await fs.mkdir(path.join(root, "project-only"), { recursive: true });
    await fs.writeFile(path.join(root, "project-only", ".project"), "<project/>");
    // .classpath alone is not an Eclipse project marker
    await fs.mkdir(path.join(root, "classpath-only"), { recursive: true });
    await fs.writeFile(path.join(root, "classpath-only", ".classpath"), "<classpath/>");
    // nested beyond the old depth-5 cap
    const deep = path.join(root, "a", "b", "c", "d", "e", "f", "g", "deep-project");
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, ".project"), "<project/>");
    // build output is never walked
    await fs.mkdir(path.join(root, "out", "skipped"), { recursive: true });
    await fs.writeFile(path.join(root, "out", "skipped", ".project"), "<project/>");
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("treats .project alone as a blocker at any depth and skips out/", async () => {
    const r = await scanBlockers(root);
    expect(r.rootBlocked).toBe(false);
    expect(r.blockers.map((p) => path.relative(root, p)).sort()).toEqual([
      path.join("a", "b", "c", "d", "e", "f", "g", "deep-project"),
      "project-only",
    ]);
  });

  it("flags the workspace root itself when it carries .project", async () => {
    const blocked = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-guard-root-"));
    try {
      await fs.writeFile(path.join(blocked, ".project"), "<project/>");
      const r = await scanBlockers(blocked);
      expect(r.rootBlocked).toBe(true);
      expect(r.blockers).toEqual([]);
    } finally {
      await fs.rm(blocked, { recursive: true, force: true });
    }
  });
});
