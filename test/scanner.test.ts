// test/scanner.test.ts (vitest, 纯函数: fake out 树通过内存 listJars 注入)
import { describe, it, expect } from "vitest";
import { scanSoong } from "../src/core/scanner";
import { FilterEngine } from "../src/core/filters";
import { Defaults } from "../src/core/types";

const defaults: Defaults = {
  schemaVersion: 1,
  excludeJars: [], excludePaths: [], excludeGlobs: [],
  ownTags: ["javac", "kotlinc"], repackagedTags: ["repackaged-jarjar", "jarjar"],
  soongTagPriority: ["combined", "turbine-combined", "turbine"],
  dirPriority: [], dirPriorityFallback: 3,
  makeJars: [], makeBlacklist: [],
};
const I = (base: string) => async (b: string) => (b === base ? Object.keys(fixtures).map(k => fixtures[k]) : []);

// T001 own bucket keeps javac+kotlinc both
// T002 fallback only when no own artifact (service-connectivity combined case)
// T003 .impl normalization wins over main-dir combined
// T004 pre-jarjar dropped when base selected; orphan kept
// T005 stubs/-stub/-headers/jrt-fs excluded (module & jar name match)
// T006 variant: android_common preferred over apex; apex-only module kept
// T007 repackaged chain excluded
//   (每个用例用 fixtures 表构造假路径集合, 与 nvim 版 3-jar 冒烟清单同构)
