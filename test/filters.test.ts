// test/filters.test.ts (vitest, pure FilterEngine)
// Regression guard for the path base used by excludePaths: keywords are matched
// against the path relative to .intermediates/, never the absolute one.
import { describe, it, expect } from "vitest";
import { FilterEngine } from "../src/core/filters";
import { ScanEntry } from "../src/core/types";

const entry = (absPath: string, relPath: string, moduleName: string): ScanEntry => ({
  absPath, relPath, moduleName, variant: "android_common", type: "javac",
});

const EX = { jars: [], paths: ["development/", "linux_glibc_common"], globs: [] };

describe("FilterEngine excludePaths", () => {
  it("excludes by keyword inside the tree", () => {
    const f = new FilterEngine(EX);
    expect(f.hit(entry(
      "/aosp/out/soong/.intermediates/development/tools/x/android_common/javac/x.jar",
      "development/tools/x/android_common/javac/x.jar",
      "x"
    ))).toBe(true);
  });

  it("does not exclude everything when the checkout path contains a keyword", () => {
    // the default keyword "development/" inside the AOSP checkout prefix used
    // to match every jar once the plugin was passed the absolute path
    const f = new FilterEngine(EX);
    expect(f.hit(entry(
      "/home/u/development/aosp13/out/soong/.intermediates/frameworks/base/x/android_common/javac/x.jar",
      "frameworks/base/x/android_common/javac/x.jar",
      "x"
    ))).toBe(false);
  });

  it("keeps a real module under a keyword-matching directory excluded", () => {
    const f = new FilterEngine(EX);
    expect(f.hit(entry(
      "/home/u/development/aosp13/out/soong/.intermediates/development/tools/x/android_common/javac/x.jar",
      "development/tools/x/android_common/javac/x.jar",
      "x"
    ))).toBe(true);
  });
});

describe("FilterEngine excludeJars / excludeGlobs", () => {
  it("matches the jar name and the module name", () => {
    const f = new FilterEngine({ jars: ["^stubs\\.jar$", "stubs"], paths: [], globs: [] });
    expect(f.hit(entry("/a/android_common/javac/stubs.jar", "a/android_common/javac/stubs.jar", "a"))).toBe(true);
    expect(f.hit(entry(
      "/a/android_common/javac/sig.jar",
      "a/android_common/javac/sig.jar",
      "android.non-updatable.stubs.system"
    ))).toBe(true);
  });

  it("anchors excludeGlobs on the path relative to .intermediates", () => {
    const f = new FilterEngine({ jars: [], paths: [], globs: ["^external/cronet/"] });
    expect(f.hit(entry("/r/out/soong/.intermediates/external/cronet/x/android_common/javac/x.jar",
      "external/cronet/x/android_common/javac/x.jar", "x"))).toBe(true);
    expect(f.hit(entry("/r/out/soong/.intermediates/frameworks/base/external/cronet/x/android_common/javac/x.jar",
      "frameworks/base/external/cronet/x/android_common/javac/x.jar", "x"))).toBe(false);
  });

  it("skips an invalid regex instead of throwing", () => {
    const f = new FilterEngine({ jars: ["("], paths: [], globs: [] });
    expect(f.hit(entry("/a/b.jar", "b.jar", "b"))).toBe(false);
  });
});
