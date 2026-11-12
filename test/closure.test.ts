import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/jdtls/moduleRoots";
import { closureJars } from "../src/jdtls/closure";

function fixture() {
  return buildIndex({
    app: {
      path: ["frameworks/base/core/java"],
      jars: ["out/soong/.intermediates/frameworks/base/turbine-combined.jar"],
      dependencies: ["lib", "not-in-index"],
    },
    lib: {
      path: ["frameworks/base/services/core"],
      jars: ["out/soong/.intermediates/frameworks/base/services/turbine-combined.jar"],
      libs: ["ext"],
    },
    ext: {
      path: ["external/x"],
      jars: ["out/soong/.intermediates/external/x/turbine-combined.jar"],
      static_libs: ["cycA"],
    },
    cycA: { path: ["p/c"], jars: [], dependencies: ["cycB"] },
    cycB: { path: ["p/c"], jars: [], dependencies: ["cycA"] },
    "core-oj": {
      path: ["libcore"],
      jars: ["out/soong/.intermediates/libcore/core-oj/javac/core-oj.jar"],
    },
    "core-libart": {
      path: ["libcore"],
      jars: ["out/soong/.intermediates/libcore/core-libart/combined/core-libart.jar"],
    },
  });
}

describe("closureJars", () => {
  it("collects jars transitively through dependencies/libs/static_libs", async () => {
    const r = await closureJars(fixture(), ["frameworks/base/core/java"]);
    expect(r.jars).toEqual([
      "out/soong/.intermediates/external/x/turbine-combined.jar",
      "out/soong/.intermediates/frameworks/base/services/turbine-combined.jar",
      "out/soong/.intermediates/frameworks/base/turbine-combined.jar",
    ]);
    // "not-in-index" is a dangling edge; cycA/cycB are in the index but jar-less
    expect(r.unmapped).toEqual(["not-in-index"]);
    expect(r.visited).toBe(6);
    expect(r.starved).toBe(0);
  });

  it("seeds every module living in the selected dir and dedupes shared jars", async () => {
    const idx = buildIndex({
      a: { path: ["p"], jars: ["out/j/a.jar"], libs: ["b"] },
      b: { path: ["p"], jars: ["out/j/a.jar", "out/j/b.jar"] },
    });
    const r = await closureJars(idx, ["p"]);
    expect(r.jars).toEqual(["out/j/a.jar", "out/j/b.jar"]);
    expect(r.unmapped).toEqual([]);
  });

  it("accepts tree-relative prebuilt paths, rejects absolute ones", async () => {
    const idx = buildIndex({
      a: {
        path: ["p"],
        jars: ["/abs/a.jar", "relative.jar", "../escape.jar", "prebuilts/sdk/current/x.aar", "out/j/a.jar"],
      },
    });
    const r = await closureJars(idx, ["p"]);
    expect(r.jars).toEqual(["out/j/a.jar", "prebuilts/sdk/current/x.aar", "relative.jar"]);
    // absolute + parent-traversal entries are reported as dropped
    expect(r.dropped).toBe(2);
  });

  it("counts modules whose jars are not built yet as starved, not unmapped", async () => {
    const r = await closureJars(fixture(), ["frameworks/base/core/java"], {
      exists: (rel) => rel.endsWith("turbine-combined.jar") && !rel.includes("/x/"),
    });
    // ext had jar candidates but all failed the disk check
    expect(r.starved).toBe(1);
    expect(r.dropped).toBe(1);
    expect(r.unmapped).toEqual(["not-in-index"]);
    expect(r.jars).not.toContain("out/soong/.intermediates/external/x/turbine-combined.jar");
  });

  it("appends the common set and reports missing common modules", async () => {
    const r = await closureJars(fixture(), ["frameworks/base/core/java"], {
      commonModules: ["core-oj", "core-libart", "nope"],
    });
    expect(r.jars).toContain("out/soong/.intermediates/libcore/core-oj/javac/core-oj.jar");
    expect(r.jars).toContain("out/soong/.intermediates/libcore/core-libart/combined/core-libart.jar");
    expect(r.missingCommon).toEqual(["nope"]);
  });

  it("reports common modules with no surviving jar as commonStarved, not starved", async () => {
    const r = await closureJars(fixture(), ["frameworks/base/core/java"], {
      commonModules: ["core-oj", "core-libart"],
      exists: (rel) => !rel.includes("libcore"),
    });
    // index variants not on disk → rescue candidates for the caller
    expect(r.commonStarved).toEqual(["core-oj", "core-libart"]);
    expect(r.missingCommon).toEqual([]);
    expect(r.starved).toBe(0);
    expect(r.jars).not.toContain("out/soong/.intermediates/libcore/core-oj/javac/core-oj.jar");
  });

  it("falls back to a built variant instead of dropping a starved module", async () => {
    const idx = buildIndex({
      app: {
        path: ["p"],
        jars: ["out/soong/.intermediates/p/app/turbine-combined/app.jar"],
        dependencies: ["alt", "gone"],
      },
      alt: { path: ["p/alt"], jars: ["out/soong/.intermediates/p/alt/turbine-combined/alt.jar"] },
      gone: { path: ["p/gone"], jars: ["out/soong/.intermediates/p/gone/turbine-combined/gone.jar"] },
    });
    const rescuedCalls: string[] = [];
    const r = await closureJars(idx, ["p"], {
      exists: () => false,
      rescue: (name) => {
        rescuedCalls.push(name);
        return name === "alt" ? "out/soong/.intermediates/p/alt/android_common/javac/alt.jar" : null;
      },
    });
    expect(rescuedCalls.sort()).toEqual(["alt", "app", "gone"]);
    expect(r.jars).toEqual(["out/soong/.intermediates/p/alt/android_common/javac/alt.jar"]);
    expect(r.rescued).toBe(1);
    // only the module with no built variant is starved, and only its entry is dropped
    expect(r.starved).toBe(2);
    expect(r.dropped).toBe(2);
  });

  it("reports selected dirs missing from the index", async () => {
    const r = await closureJars(fixture(), ["frameworks/base/core/java", "gone"]);
    expect(r.unknownSeeds).toEqual(["gone"]);
  });

  it("terminates on dependency cycles", async () => {
    const r = await closureJars(fixture(), ["frameworks/base/core/java"]);
    expect(r.jars.length).toBeGreaterThan(0);
  });
});
