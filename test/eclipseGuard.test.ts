// test/eclipseGuard.test.ts (vitest, pure functions from eclipseGuardScan)
import { describe, it, expect } from "vitest";
import { escapeGlob, patternsFor, GuardReport } from "../src/jdtls/eclipseGuardScan";

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
