import { describe, it, expect } from "vitest";

// moduleRoots.ts is deliberately vscode-free so these run unmocked.
import {
  autoModulesForFolder,
  buildIndex,
  deriveRootsFromSrcs,
  isAutoExcludedSegment,
  isThirdPartyRoot,
  loadJavaModuleIndex,
  matchesImportExclusion,
  moduleRoots,
  rootsForPath,
  scopedImportExclusions,
  selectedFirstPartyRoots,
  splitRootsByFolders,
} from "../src/jdtls/moduleRoots";

function index(entries: Record<string, Record<string, unknown>>) {
  return buildIndex(entries);
}

describe("deriveRootsFromSrcs", () => {
  it("uses the last java/src/kotlin segment as the root boundary", () => {
    expect(deriveRootsFromSrcs(["frameworks/base/core/java/com/android/internal/util/ArrayUtils.java"]))
      .toEqual(new Set(["frameworks/base/core/java"]));
    // src/main/java: the LAST matching segment wins
    expect(deriveRootsFromSrcs(["a/src/main/java/com/x/Y.java"])).toEqual(new Set(["a/src/main/java"]));
    expect(deriveRootsFromSrcs(["x/kotlin/com/Y.java"])).toEqual(new Set(["x/kotlin"]));
  });

  it("keeps the deepest match across segment names", () => {
    // 'src' at index 1 and 'java' at index 3 -> java wins
    expect(deriveRootsFromSrcs(["p/src/java/com/A.java"])).toEqual(new Set(["p/src/java"]));
    expect(deriveRootsFromSrcs(["p/java/src/com/A.java"])).toEqual(new Set(["p/java/src"]));
  });

  it("skips generated sources under out/ and non-java files", () => {
    expect(deriveRootsFromSrcs(["out/soong/.intermediates/x/gen/java/com/A.java"])).toEqual(new Set());
    expect(deriveRootsFromSrcs(["external/guava/guava/src/com/X.java.class"])).toEqual(new Set());
    expect(deriveRootsFromSrcs([])).toEqual(new Set());
  });

  it("skips files without a java/src/kotlin segment", () => {
    expect(deriveRootsFromSrcs(["vendor/foo/Bar.java"])).toEqual(new Set());
  });
});

describe("isThirdPartyRoot", () => {
  it("classifies by top-level directory", () => {
    expect(isThirdPartyRoot("external/guava/guava/src")).toBe(true);
    expect(isThirdPartyRoot("vendor/foo/java")).toBe(true);
    expect(isThirdPartyRoot("out/x/java")).toBe(true);
    expect(isThirdPartyRoot("frameworks/base/core/java")).toBe(false);
    expect(isThirdPartyRoot("packages/modules/Connectivity/service/src")).toBe(false);
  });
});

describe("moduleRoots (transitive closure)", () => {
  const idx = index({
    lib: { path: "p/lib", srcs: ["p/lib/java/com/L.java"] },
    "ext-lib": { path: "external/guava", srcs: ["external/guava/guava/src/com/X.java"] },
    // aggregate module: real sources come only through static_libs
    agg: { path: "p/agg", srcs: [], static_libs: ["lib", "ext-lib"] },
    diamond: { path: "p/agg", srcs: ["p/agg/java/com/D.java"], static_libs: ["lib", "agg"] },
    cycleA: { path: "p/c", srcs: ["p/c/java/com/A.java"], static_libs: ["cycleB"] },
    cycleB: { path: "p/c", srcs: [], static_libs: ["cycleA"] },
  });

  it("collects own srcs plus static_lib dependencies", () => {
    expect(moduleRoots(idx, "agg")).toEqual(new Set(["p/lib/java", "external/guava/guava/src"]));
  });

  it("handles diamond dependencies without duplication", () => {
    expect(moduleRoots(idx, "diamond")).toEqual(new Set(["p/agg/java", "p/lib/java", "external/guava/guava/src"]));
  });

  it("does not hang on dependency cycles", () => {
    expect(moduleRoots(idx, "cycleA")).toEqual(new Set(["p/c/java"]));
  });

  it("returns an empty set for unknown modules", () => {
    expect(moduleRoots(idx, "nope")).toEqual(new Set());
  });
});

describe("rootsForPath", () => {
  it("groups modules by directory and splits first-party vs third-party", () => {
    const idx = index({
      a: { path: "p/mod", srcs: ["p/mod/java/com/A.java"] },
      b: { path: "p/mod", srcs: [], static_libs: ["ext"] },
      ext: { path: "external/guava", srcs: ["external/guava/guava/src/com/X.java"] },
      empty: { path: "p/nothing", srcs: [] },
    });
    expect(rootsForPath(idx, "p/mod")).toEqual({
      firstParty: ["p/mod/java"],
      thirdParty: ["external/guava/guava/src"],
    });
    expect(rootsForPath(idx, "p/nothing")).toEqual({ firstParty: [], thirdParty: [] });
  });
});

describe("selectedFirstPartyRoots", () => {
  const idx = index({
    conn: { path: "packages/modules/Connectivity/service", srcs: ["packages/modules/Connectivity/service/src/com/A.java"] },
    ext: { path: "packages/modules/Connectivity/staticlibs", srcs: ["external/guava/guava/src/com/X.java"] },
  });

  it("unions first-party roots of selected modules only", () => {
    const log: string[] = [];
    expect(
      selectedFirstPartyRoots(
        idx,
        ["packages/modules/Connectivity/service", "packages/modules/Connectivity/staticlibs"],
        (m) => log.push(m)
      )
    ).toEqual(["packages/modules/Connectivity/service/src"]);
  });

  it("logs unknown modules instead of failing", () => {
    const log: string[] = [];
    expect(
      selectedFirstPartyRoots(idx, ["packages/modules/Connectivity/service", "gone"], (m) => log.push(m))
    ).toEqual(["packages/modules/Connectivity/service/src"]);
    expect(log.some((m) => m.includes("gone"))).toBe(true);
  });
});

describe("splitRootsByFolders", () => {
  const folders = ["/aosp/packages/modules/Connectivity"];

  it("keeps roots under the folder and drops the rest", () => {
    const { inside, outside } = splitRootsByFolders(
      [
        "/aosp/packages/modules/Connectivity/service/src",
        "/aosp/packages/modules/Connectivity/framework/src",
        "/aosp/frameworks/base/core/java",
      ],
      folders
    );
    expect(inside).toEqual([
      "/aosp/packages/modules/Connectivity/service/src",
      "/aosp/packages/modules/Connectivity/framework/src",
    ]);
    expect(outside).toEqual(["/aosp/frameworks/base/core/java"]);
  });

  it("treats a root equal to the folder as outside (empty rel path is not injectable)", () => {
    const { inside, outside } = splitRootsByFolders(["/aosp/packages/modules/Connectivity"], folders);
    expect(inside).toEqual([]);
    expect(outside).toEqual(["/aosp/packages/modules/Connectivity"]);
  });

  it("accepts a root inside any of several folders", () => {
    const { inside } = splitRootsByFolders(["/b/tree/src"], ["/a/x", "/b/tree"]);
    expect(inside).toEqual(["/b/tree/src"]);
  });

  it("passes everything through when no folders are given", () => {
    const { inside, outside } = splitRootsByFolders(["/a/src"], []);
    expect(inside).toEqual([]);
    expect(outside).toEqual(["/a/src"]);
  });
});

describe("isAutoExcludedSegment", () => {
  it("catches test/demo/sample/commercial variants without false positives", () => {
    expect(isAutoExcludedSegment("tests")).toBe(true);
    expect(isAutoExcludedSegment("perftests")).toBe(true);
    expect(isAutoExcludedSegment("robotests")).toBe(true);
    expect(isAutoExcludedSegment("test-base")).toBe(true);
    expect(isAutoExcludedSegment("testdata")).toBe(true);
    expect(isAutoExcludedSegment("integration-tests")).toBe(true);
    expect(isAutoExcludedSegment("demoapp")).toBe(true);
    expect(isAutoExcludedSegment("samples")).toBe(true);
    expect(isAutoExcludedSegment("commercial")).toBe(true);
    expect(isAutoExcludedSegment("latest")).toBe(false);
    expect(isAutoExcludedSegment("contest")).toBe(false);
    expect(isAutoExcludedSegment("service")).toBe(false);
  });
});

describe("autoModulesForFolder", () => {
  const idx = index({
    // main content under frameworks/base
    "framework-minus-apex": { path: "frameworks/base", srcs: ["frameworks/base/core/java/com/A.java", "frameworks/base/services/core/java/com/B.java"] },
    "telephony": { path: "frameworks/base", srcs: ["frameworks/base/telephony/java/com/T.java"] },
    "some-app": { path: "frameworks/base/packages/EasterEgg", srcs: ["frameworks/base/packages/EasterEgg/src/com/E.java"] },
    "fwb-tools": { path: "frameworks/base/tools/aapt2", srcs: ["frameworks/base/tools/aapt2/java/com/A2.java"] },
    "fwb-tests": { path: "frameworks/base/apct-tests/perftests", srcs: ["frameworks/base/apct-tests/perftests/core/src/P.java"] },
    // a different tree area: not frameworks/base
    "conn": { path: "packages/modules/Connectivity/service", srcs: ["packages/modules/Connectivity/service/src/com/C.java"] },
    "conn-test": { path: "packages/modules/Connectivity/tests/unit", srcs: ["packages/modules/Connectivity/tests/unit/src/CT.java"] },
    "conn-demo": { path: "packages/modules/Connectivity/thread/demoapp", srcs: ["packages/modules/Connectivity/thread/demoapp/java/D.java"] },
    "ext": { path: "external/guava", srcs: ["external/guava/guava/src/com/X.java"] },
  });
  const aosp = "/aosp";

  it("AOSP-root window: frameworks/base main modules only", () => {
    const mods = autoModulesForFolder(idx, aosp, aosp);
    // both main-content modules share the module dir "frameworks/base"
    expect(mods).toEqual(["frameworks/base"]);
  });

  it("subdirectory window: production modules under the folder", () => {
    const mods = autoModulesForFolder(idx, aosp, aosp + "/packages/modules/Connectivity");
    expect(mods).toEqual(["packages/modules/Connectivity/service"]);
  });

  it("unknown folder: nothing auto-selected", () => {
    expect(autoModulesForFolder(idx, aosp, "/somewhere/else")).toEqual([]);
  });

  it("includes a module declared exactly at the window folder", () => {
    // services/core: the compiled module's path IS the window folder, while the
    // only source-only module below it produces no jars. Skipping the equal dir
    // used to leave the closure with the source-only module alone.
    const idx2 = index({
      "services.core.unboosted": {
        path: "frameworks/base/services/core",
        srcs: ["frameworks/base/services/core/java/com/android/server/pm/P.java"],
        jars: ["out/j/services.jar"],
        dependencies: ["lib"],
      },
      "framework-pm-service-sources": {
        path: "frameworks/base/services/core/java/com/android/server/pm",
        srcs: ["frameworks/base/services/core/java/com/android/server/pm/Q.java"],
      },
      lib: {
        path: "frameworks/libs/x",
        srcs: ["frameworks/libs/x/java/L.java"],
        jars: ["out/j/lib.jar"],
      },
    });
    const mods = autoModulesForFolder(idx2, aosp, aosp + "/frameworks/base/services/core");
    expect(mods).toContain("frameworks/base/services/core");
    expect(mods).toContain("frameworks/base/services/core/java/com/android/server/pm");
  });
});

describe("matchesImportExclusion", () => {
  const entries = [
    "**/node_modules/**",
    "**/vendor/**",
    "**/packages/apps/**",
    "/aosp/test/suite_harness/common/host-side/util",
    "/aosp/sdk/testapps/userLibTest",
  ];

  it("prefix-matches absolute dir entries (inside or equal)", () => {
    expect(matchesImportExclusion("/aosp/test/suite_harness/common/host-side/util/sub/X.java", entries)).toBe(true);
    expect(matchesImportExclusion("/aosp/sdk/testapps/userLibTest", entries)).toBe(true);
    expect(matchesImportExclusion("/aosp/sdk/testapps/other", entries)).toBe(false);
    expect(matchesImportExclusion("/aosp/frameworks/base/core/java", entries)).toBe(false);
  });

  it("matches simple **/seg/** globs by segment sequence", () => {
    expect(matchesImportExclusion("/aosp/vendor/sample/frameworks/base/core/java", entries)).toBe(true);
    expect(matchesImportExclusion("/aosp/packages/apps/Calculator/src", entries)).toBe(true);
    // packages/modules must not match packages/apps
    expect(matchesImportExclusion("/aosp/packages/modules/Connectivity/service/src", entries)).toBe(false);
  });

  it("ignores unknown pattern shapes", () => {
    expect(matchesImportExclusion("/aosp/x/src", ["*.md", ""])).toBe(false);
  });

  it("autoModulesForFolder skips dirs under import exclusions", () => {
    const idx = index({
      app: { path: "frameworks/base/startop/apps/ColorChanging", srcs: ["frameworks/base/startop/apps/ColorChanging/src/C.java"] },
      core: { path: "frameworks/base", srcs: ["frameworks/base/core/java/A.java"] },
    });
    const excl = ["/aosp/frameworks/base/startop/apps/ColorChanging"];
    expect(autoModulesForFolder(idx, "/aosp", "/aosp", excl)).toEqual(["frameworks/base"]);
    expect(autoModulesForFolder(idx, "/aosp", "/aosp", [])).toEqual(["frameworks/base", "frameworks/base/startop/apps/ColorChanging"]);
  });
});

describe("scopedImportExclusions", () => {
  const folders = ["/aosp/packages/modules/Connectivity"];

  it("drops absolute entries covering a window folder (guard rootBlocked leftovers)", () => {
    const out = scopedImportExclusions(
      ["**/vendor/**", "/aosp/packages/modules/Connectivity", "/aosp/test/suite_harness/common/host-side/util"],
      folders
    );
    expect(out).toEqual(["**/vendor/**", "/aosp/test/suite_harness/common/host-side/util"]);
  });

  it("keeps everything when no folder is covered", () => {
    const out = scopedImportExclusions(["**/vendor/**", "/aosp/test/suite_harness"], folders);
    expect(out).toEqual(["**/vendor/**", "/aosp/test/suite_harness"]);
  });
});

describe("buildIndex", () => {
  it("accepts soong's single-element path arrays and skips pathless entries", () => {
    const idx = buildIndex({
      good: { path: ["p/good"], srcs: ["p/good/java/A.java"] },
      bad: { srcs: ["x.java"] },
    });
    expect(idx.moduleCount).toBe(1);
    expect([...idx.byPath.keys()]).toEqual(["p/good"]);
  });
});

describe("loadJavaModuleIndex", () => {
  it("returns null when the build index does not exist", async () => {
    expect(await loadJavaModuleIndex("/nonexistent-aosp-root", () => {})).toBeNull();
  });
});
