// test/scanner.test.ts (vitest, 纯函数: 假 out 树通过内存 listJars 注入)
//
// Fixture shapes are copied from a real tree (/home/.../aosp/out/soong for
// android-15): the .impl sibling dirs, the httpengine / httpengine-pre-jarjar
// pair, the android_common_apex31 variants and the repackaged-jarjar jars all
// exist there. Every expectation here was checked against that tree's shapes
// before being written down.
//
// T001 own bucket keeps javac+kotlinc both
// T002 fallback only when no own artifact (service-connectivity combined case)
// T003 .impl normalization wins over main-dir combined
// T004 pre-jarjar dropped when base selected; orphan kept
// T005 stubs/-stub/-headers/jrt-fs excluded (module & jar name match)
// T006 variant: android_common preferred over apex; apex-only module kept
// T007 repackaged chain excluded
import { describe, it, expect } from "vitest";
import * as path from "path";
import { scanSoong } from "../src/core/scanner";
import { FilterEngine } from "../src/core/filters";
import { Defaults } from "../src/core/types";
import REAL from "../resources/defaults.json";

const ROOT = "/aosp";
const BASE = path.join(ROOT, "out/soong/.intermediates");

/** The shipped rules, so T005 exercises resources/defaults.json itself. */
const defaults: Defaults = REAL as Defaults;
const noExclusions = new FilterEngine({ jars: [], paths: [], globs: [] });
const shippedExclusions = new FilterEngine({
  jars: defaults.excludeJars,
  paths: defaults.excludePaths,
  globs: defaults.excludeGlobs,
});

const abs = (rel: string): string => path.join(BASE, rel);
/** jar list as .intermediates-relative paths: what the assertions talk about. */
const rels = (jars: string[]): string[] =>
  jars.map((j) => path.relative(BASE, j).split(path.sep).join("/")).sort();

/** Run scanSoong over a fake tree given as .intermediates-relative paths. */
async function scan(
  relPaths: string[],
  opts: { filters?: FilterEngine; listJars?: (base: string) => Promise<string[]> } = {}
) {
  const filters = opts.filters ?? noExclusions;
  const listJars =
    opts.listJars ?? (async (base: string) => (base === BASE ? relPaths.map(abs) : []));
  const res = await scanSoong(ROOT, defaults, filters, listJars);
  if (!res) throw new Error("scanSoong returned null");
  return { stats: res.stats, jars: rels(res.jars) };
}

describe("T001 own bucket", () => {
  it("keeps javac and kotlinc for the same module", () => {
    return scan([
      "frameworks/base/foo/android_common/javac/foo.jar",
      "frameworks/base/foo/android_common/kotlinc/foo.jar",
    ]).then(({ stats, jars }) => {
      expect(jars).toEqual([
        "frameworks/base/foo/android_common/javac/foo.jar",
        "frameworks/base/foo/android_common/kotlinc/foo.jar",
      ]);
      expect(stats.selected).toBe(2);
    });
  });
});

describe("T002 fallback bucket", () => {
  it("yields to an own artifact of the same module", async () => {
    // bar has both javac (own) and combined (fallback) -> only javac survives;
    // service-connectivity only ever produces combined -> kept
    const { jars } = await scan([
      "frameworks/base/bar/android_common/javac/bar.jar",
      "frameworks/base/bar/android_common/combined/bar.jar",
      "services/core/java/com/android/server/service/connectivity/android_common/combined/service-connectivity.jar",
    ]);
    expect(jars).toEqual([
      "frameworks/base/bar/android_common/javac/bar.jar",
      "services/core/java/com/android/server/service/connectivity/android_common/combined/service-connectivity.jar",
    ]);
  });
});

describe("T003 .impl normalization", () => {
  it("collapses <name>.impl onto <name> and prefers the real compile", async () => {
    // without the normalization both would be kept as separate modules and the
    // same classes would sit on the classpath twice
    const { jars, stats } = await scan([
      "external/conscrypt/framework-conscrypt-nsc/android_common/combined/framework-conscrypt-nsc.jar",
      "external/conscrypt/framework-conscrypt-nsc.impl/android_common/javac/framework-conscrypt-nsc.jar",
    ]);
    expect(jars).toEqual([
      "external/conscrypt/framework-conscrypt-nsc.impl/android_common/javac/framework-conscrypt-nsc.jar",
    ]);
    expect(stats.selected).toBe(1);
  });
});

describe("T004 pre-jarjar", () => {
  it("drops <name>-pre-jarjar when <name> is selected, keeps the orphan", async () => {
    const { jars, stats } = await scan([
      "external/cronet/android/httpengine/android_common/combined/httpengine.jar",
      "external/cronet/android/httpengine-pre-jarjar/android_common/combined/httpengine-pre-jarjar.jar",
      "external/foo/orphan-pre-jarjar/android_common/combined/orphan-pre-jarjar.jar",
    ]);
    expect(jars).toEqual([
      "external/cronet/android/httpengine/android_common/combined/httpengine.jar",
      "external/foo/orphan-pre-jarjar/android_common/combined/orphan-pre-jarjar.jar",
    ]);
    expect(stats.dedupPreJarjar).toBe(1);
  });
});

describe("T005 exclusion rules", () => {
  it("excludes stub / -headers / jrt-fs jars from the shipped defaults", async () => {
    const { jars, stats } = await scan(
      [
        "frameworks/base/baz/android_common/javac/stubs.jar", // jar name rule: "stubs"
        "frameworks/base/foo-headers/android_common/javac/foo-headers.jar", // "-headers"
        "libcore/jrt-fs/android_common/javac/jrt-fs.jar", // "^jrt-fs\.jar$"
        "frameworks/base/foo.stubs.system/android_common/javac/foo.jar", // module name rule
        "frameworks/base/keep/android_common/javac/keep.jar",
      ],
      { filters: shippedExclusions }
    );
    expect(jars).toEqual(["frameworks/base/keep/android_common/javac/keep.jar"]);
    expect(stats.excluded).toBe(4);
  });

  it("matches the module name even when the jar file name does not", async () => {
    // soong usually names the jar after the module, so this branch would
    // otherwise never be covered
    const { jars } = await scan(
      ["frameworks/base/sig.stubs.system/android_common/javac/sig.jar"],
      { filters: shippedExclusions }
    );
    expect(jars).toEqual([]);
  });
});

describe("T006 variants", () => {
  it("prefers android_common over android_common_apex and keeps apex-only modules", async () => {
    const { jars } = await scan([
      "external/cronet/android/httpengine/android_common/combined/httpengine.jar",
      "external/cronet/android/httpengine/android_common_apex31/combined/httpengine.jar",
      "libcore/core-oj/android_common_apex31/javac/core-oj.jar",
    ]);
    expect(jars).toEqual([
      "external/cronet/android/httpengine/android_common/combined/httpengine.jar",
      "libcore/core-oj/android_common_apex31/javac/core-oj.jar",
    ]);
  });
});

describe("T007 repackaged jars", () => {
  it("excludes repackaged-jarjar and jarjar in the type chain", async () => {
    const { jars, stats } = await scan([
      "packages/services/Telephony/TeleService/android_common/repackaged-jarjar/javac/TeleService.jar",
      "packages/services/Other/android_common/jarjar/javac/Other.jar",
      "packages/services/Keep/android_common/javac/Keep.jar",
    ]);
    expect(jars).toEqual(["packages/services/Keep/android_common/javac/Keep.jar"]);
    expect(stats.excluded).toBe(2);
  });
});

describe("base detection", () => {
  it("ignores a jar with no variant component", async () => {
    const { stats, jars } = await scan(["stray.jar"]);
    expect(jars).toEqual([]);
    expect(stats.excluded).toBe(1);
  });

  it("falls through to out/.soong/.intermediates when the soong dir is empty", async () => {
    const alt = path.join(ROOT, "out/.soong/.intermediates");
    const res = await scan([], {
      listJars: async (base) => (base === alt ? [path.join(alt, "x/y/android_common/javac/y.jar")] : []),
    });
    expect(res.stats.selected).toBe(1);
  });

  it("returns null when neither base has jars (no build outputs)", async () => {
    expect(await scanSoong(ROOT, defaults, noExclusions, async () => [])).toBeNull();
  });
});
