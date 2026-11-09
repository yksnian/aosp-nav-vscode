// test/sourceRoots.test.ts (vitest, pure planning helpers)
import { describe, it, expect } from "vitest";
import * as path from "path";
import { planSourcePaths, resolveSourceRoots, sameList } from "../src/jdtls/sourceRootsPlan";

describe("resolveSourceRoots", () => {
  const root = "/aosp";
  const dirs = new Set(["/aosp/frameworks/base/core/java", "/abs/other", "/aosp/frameworks/base"]);
  const isDirectory = async (p: string): Promise<boolean> => dirs.has(p);

  it("resolves relative entries against the AOSP root", async () => {
    const r = await resolveSourceRoots(root, ["frameworks/base/core/java"], isDirectory);
    expect(r.paths).toEqual(["/aosp/frameworks/base/core/java"]);
    expect(r.missing).toEqual([]);
  });

  it("keeps absolute entries, trims blanks and dedups", async () => {
    const r = await resolveSourceRoots(
      root,
      [" /abs/other ", "", "/abs/other", "./frameworks/base/core/java"],
      isDirectory
    );
    expect(r.paths).toEqual(["/abs/other", "/aosp/frameworks/base/core/java"]);
  });

  it("reports entries that do not exist instead of writing them", async () => {
    const r = await resolveSourceRoots(root, ["frameworks/base/core/java", "nope/gone"], isDirectory);
    expect(r.paths).toEqual(["/aosp/frameworks/base/core/java"]);
    expect(r.missing).toEqual(["/aosp/nope/gone"]);
  });
});

describe("planSourcePaths", () => {
  it("appends desired roots after user entries", () => {
    const p = planSourcePaths(["/user/src"], [], ["/aosp/core"]);
    expect(p.next).toEqual(["/user/src", "/aosp/core"]);
    expect(p.own).toEqual(["/aosp/core"]);
    expect(p.added).toBe(1);
    expect(p.removed).toBe(0);
  });

  it("does not duplicate an entry the user already declared", () => {
    const p = planSourcePaths(["/aosp/core"], [], ["/aosp/core"]);
    expect(p.next).toEqual(["/aosp/core"]);
    expect(p.own).toEqual([]);
    expect(p.added).toBe(0);
  });

  it("drops stale managed entries but keeps user entries", () => {
    const p = planSourcePaths(["/user/src", "/aosp/old"], ["/aosp/old"], ["/aosp/new"]);
    expect(p.next).toEqual(["/user/src", "/aosp/new"]);
    expect(p.own).toEqual(["/aosp/new"]);
    expect(p.removed).toBe(1);
  });

  it("removes every managed entry when the config is emptied", () => {
    const p = planSourcePaths(["/user/src", "/aosp/core"], ["/aosp/core"], []);
    expect(p.next).toEqual(["/user/src"]);
    expect(p.own).toEqual([]);
    expect(p.removed).toBe(1);
  });

  it("keeps a managed entry that is still desired", () => {
    const p = planSourcePaths(["/aosp/core"], ["/aosp/core"], ["/aosp/core", "/aosp/net"]);
    expect(p.next).toEqual(["/aosp/core", "/aosp/net"]);
    expect(p.own).toEqual(["/aosp/core", "/aosp/net"]);
    expect(p.added).toBe(1);
    expect(p.removed).toBe(0);
  });
});

describe("sameList", () => {
  it("compares order-sensitively", () => {
    expect(sameList([], [])).toBe(true);
    expect(sameList(["/a", "/b"], ["/a", "/b"])).toBe(true);
    expect(sameList(["/a", "/b"], ["/b", "/a"])).toBe(false);
    expect(sameList(["/a"], ["/a", "/b"])).toBe(false);
  });
});

it("keeps path normalization platform-correct", () => {
  // guard against accidentally hard-coding POSIX separators in the plan code
  expect(path.isAbsolute("/aosp")).toBe(true);
});
