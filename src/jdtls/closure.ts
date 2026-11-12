import type { JavaModuleIndex } from "./moduleRoots";

/** Dependency-closure jar computation over the soong build index (plan D).
 *
 *  The injected classpath becomes `closure(selected module dirs) ∪ common set`
 *  instead of the full `out/soong/.intermediates` walk. Seeds are every module
 *  living in a selected dir; the BFS follows soong's `dependencies`, `libs` and
 *  `static_libs` edges and collects each reached module's `jars` entries.
 *
 *  Measured on a real tree (2026-11-11, module_bp_java_deps.json):
 *  the user's 11 selected dirs close over 247 jars / 200 MB versus the full
 *  walk's 1276 jars / 834 MB. The closure alone misses `libcore.*`
 *  (java.lang/String/...): the framework is compiled AGAINST the bootclasspath
 *  but does not name it as a soong dependency edge, so `core-oj` and
 *  `core-libart` join the list via `commonModules`.
 *
 *  Jar candidates come from two locations: `out/soong/.intermediates`
 *  (turbine-combined header jars — full signatures, no method bodies) and
 *  `prebuilts/sdk/current/.../m2repository` (androidx .aars — 31 jars in the
 *  measured closure). Only absolute paths (or `..` traversals) are rejected;
 *  everything tree-relative is collected subject to the `exists` disk check.
 *
 *  unmapped/starved/dropped, all bounded in logs:
 *  - `unmapped`: reachable module names missing from the index entirely
 *    (dangling edges — e.g. framework-res). These cannot map to any jar.
 *  - `starved`: modules whose `jars` entries exist in the index but none of
 *    them is on disk (not built yet / stale build). They join automatically
 *    once built and rescanned. Only counted, never listed by name.
 *  - `dropped`: unique jar entries rejected by the path rule or missing on
 *    disk (what the injected list does not contain).
 *  Modules without any `jars` entry (pure genrule/proto/aidl targets) are
 *  expected in a java closure and are ignored.
 *
 *  Deliberately NOT done (thresholds undecided, logged only): dropping stub
 *  jars (~65 MB of signatures duplicated by framework turbines) and size-based
 *  culling of aggregate jars. Dedup is exact-path only; output is sorted so the
 *  list is stable across runs (settingsChannel's sameList short-circuit relies
 *  on that).
 *
 *  This module stays free of the `vscode` import so it can be unit-tested. */

export interface ClosureOptions {
  /** modules whose jars join the list unconditionally (default call sites pass
   *  the libcore pair; see jarPlan.COMMON_MODULES) */
  commonModules?: readonly string[];
  /** disk-existence predicate over AOSP-relative jar paths; a jar failing it
   *  is dropped and its module counts toward `starved` (if it had candidates) */
  exists?: (relJar: string) => boolean | Promise<boolean>;
}

export interface ClosureResult {
  /** AOSP-relative jar paths, deduped, sorted */
  jars: string[];
  /** reachable module names absent from the index (dangling edges) */
  unmapped: string[];
  /** reachable modules with jar candidates but none existing on disk */
  starved: number;
  /** unique jar entries rejected by the path rule or missing on disk */
  dropped: number;
  /** selected dirs with no module in the index (stale/renamed selection) */
  unknownSeeds: string[];
  /** commonModules absent from the index */
  missingCommon: string[];
  /** commonModules present in the index but with no surviving jar — their
   *  index-registered variants are not on disk (e.g. libcore only lists
   *  turbine-combined while the tree built the javac/combined variants); the
   *  caller may rescue them with a direct disk lookup */
  commonStarved: string[];
  /** module names visited by the traversal (informational) */
  visited: number;
}

export async function closureJars(
  index: JavaModuleIndex,
  moduleDirs: readonly string[],
  opts: ClosureOptions = {}
): Promise<ClosureResult> {
  const jars = new Set<string>();
  const unmapped = new Set<string>();
  const unknownSeeds = new Set<string>();
  const missingCommon: string[] = [];
  const commonStarved: string[] = [];
  const visited = new Set<string>();
  let starved = 0;
  const exists = opts.exists;
  // unique paths, not hit count: one missing jar listed by many modules is
  // still one dropped jar
  const dropped = new Set<string>();

  const collect = async (e: { jars: string[] }): Promise<number> => {
    let got = 0;
    for (const rel of e.jars) {
      // tree-relative paths only; subject to the caller's disk check
      if (rel.startsWith("/") || rel.includes("..")) {
        dropped.add(rel);
        continue;
      }
      if (exists && !(await exists(rel))) {
        dropped.add(rel);
        continue;
      }
      jars.add(rel);
      got++;
    }
    return got;
  };

  // BFS from every module living in a selected dir (queue grows in place)
  const queue: string[] = [];
  for (const dir of moduleDirs) {
    const seeds = index.byPath.get(dir);
    if (!seeds) {
      unknownSeeds.add(dir);
      continue;
    }
    for (const s of seeds) if (!visited.has(s)) queue.push(s);
  }
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i];
    if (visited.has(name)) continue; // seeds and back-edges can repeat
    visited.add(name);
    const e = index.byName.get(name);
    if (!e) {
      unmapped.add(name); // dangling edge: referenced, but not in the index
      continue;
    }
    if ((await collect(e)) === 0 && e.jars.length > 0) starved++;
    for (const d of [...e.dependencies, ...e.libs, ...e.staticLibs]) {
      if (!visited.has(d)) queue.push(d);
    }
  }

  // common set: jars join unconditionally, module never counts as a seed
  for (const name of opts.commonModules ?? []) {
    const e = index.byName.get(name);
    if (!e) {
      missingCommon.push(name);
      continue;
    }
    if ((await collect(e)) === 0) commonStarved.push(name);
  }

  return {
    jars: [...jars].sort(),
    unmapped: [...unmapped].sort(),
    starved,
    dropped: dropped.size,
    unknownSeeds: [...unknownSeeds].sort(),
    missingCommon,
    commonStarved,
    visited: visited.size,
  };
}
