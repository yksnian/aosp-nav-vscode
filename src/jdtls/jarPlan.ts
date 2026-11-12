import * as fs from "fs/promises";
import * as path from "path";
import { autoModulesForFolder, loadJavaModuleIndex, scopedImportExclusions } from "./moduleRoots";
import type { JavaModuleIndex } from "./moduleRoots";
import { closureJars } from "./closure";

/** Plan D jar list for jdt.ls / Kotlin injection: the dependency closure of the
 *  selected module dirs ∪ a small common set (libcore), computed from
 *  out/soong/module_bp_java_deps.json. The full .intermediates walk list stays
 *  untouched (it remains in the cache); whenever the closure cannot be trusted
 *  the full list is returned and the reason is logged — the injected classpath
 *  can never silently go empty.
 *
 *  COMMON_MODULES rationale: soong records the framework's bootclasspath as a
 *  compilation input, not as a `dependencies`/`libs`/`static_libs` edge, so the
 *  BFS never reaches libcore. Without `core-oj`/`core-libart` every
 *  `java.lang.*`/`java.util.*` reference is unresolved. They are looked up by
 *  module name in the index (robust across trees) rather than hardcoded paths.
 *  `framework-annotations-lib` is the third entry: `android.annotation.NonNull`
 *  /`Nullable` are not in libcore (verified: 0 entries under android/annotation
 *  in core-oj/core-libart) and framework.jar is a bootclasspath input, so
 *  windows whose dependency graph does not statically link the annotations
 *  library lose those imports. It is the official 65 KB / 138-entry library,
 *  not the 40-50 MB framework stub. */

export const COMMON_MODULES = ["core-oj", "core-libart", "framework-annotations-lib"];

/** log cap for the unmapped module list (full list stays in the result) */
const UNMAPPED_LOG_LIMIT = 40;

/** Closure results memoized by (root, module set, index mtime, build stamp).
 *  Toggling modules in the picker then reuses the previous traversal instead of
 *  re-reading the 59 MB index. Every reused jar is still stat'ed, so a rebuild
 *  that deleted jars forces a recompute. */
interface ClosureCacheEntry {
  relJars: string[];
  unmapped: string[];
  starved: number;
  rescued: number;
  dropped: number;
  unknownSeeds: string[];
  missingCommon: string[];
  visited: number;
  /** modules auto-selected for a subtree window (null for an explicit pick) */
  auto: number | null;
}

const CLOSURE_CACHE_LIMIT = 6;
const closureCache = new Map<string, ClosureCacheEntry>();

/** jar kinds inside a variant dir, in preference order: full javac output
 *  beats the merged combined jar beats the header-only turbine jar */
const JAR_KINDS = ["javac", "combined", "turbine-combined"];

/** Variant fallback: scan a module's intermediates dir for a built jar.
 *  Used when every jar the build index registers for the module is missing on
 *  disk (typically the index names a turbine-combined header jar while the
 *  tree built the javac/combined variant). Variant dirs are sorted ascending
 *  and the last one wins, so apex variants (android_common_apexNN) beat plain
 *  ones; within a variant, full javac output beats combined beats turbine.
 *  Returns an AOSP-relative path or null. */
async function rescueBuiltJar(root: string, name: string, dir: string): Promise<string | null> {
  const base = `out/soong/.intermediates/${dir}/${name}`;
  let variants: string[];
  try {
    variants = await fs.readdir(path.join(root, base));
  } catch {
    return null;
  }
  variants.sort();
  for (const variant of variants.reverse()) {
    for (const kind of JAR_KINDS) {
      const rel = `${base}/${variant}/${kind}/${name}.jar`;
      try {
        if ((await fs.stat(path.join(root, rel))).isFile()) return rel;
      } catch {
        // try the next kind / variant
      }
    }
  }
  return null;
}

export interface JarPlanResult {
  /** absolute jar paths to inject */
  jars: string[];
  mode: "closure" | "fallback";
  /** why the full list was kept (mode=fallback) */
  reason?: string;
  /** reachable module names missing from the index (cannot map to any jar) */
  unmapped: string[];
  /** modules whose jars are listed in the index but not built yet */
  starved: number;
  /** modules recovered through the variant fallback (index variant missing,
   *  another built variant used) */
  rescued: number;
  /** unique jar entries the closure dropped (missing on disk / off-tree) */
  dropped: number;
  unknownSeeds: string[];
  missingCommon: string[];
  /** modules visited by the closure traversal (informational) */
  visited: number;
  /** modules auto-selected for a subtree window (absent when the selection was
   *  explicit or the plan fell back) */
  auto?: number;
}

/** Options for windows that have no explicit module selection.
 *  A subtree window (folder !== root) uses the same auto module selection as
 *  the java.project.sourcePaths channel, so both channels describe the same
 *  modules instead of one scoping sources and the other injecting every jar. */
export interface JarPlanOptions {
  /** the workspace folder these jars are for (absolute) */
  folder?: string;
  /** java.import.exclusions of the active window, same entries the source-path
   *  channel scopes */
  importExclusions?: readonly string[];
}

function fallback(
  fullJars: readonly string[],
  reason: string,
  log: (m: string) => void
): JarPlanResult {
  log(`[aosp-nav] jarPlan: full-list fallback (${reason}) — ${fullJars.length} jars`);
  return {
    jars: [...fullJars],
    mode: "fallback",
    reason,
    unmapped: [],
    starved: 0,
    rescued: 0,
    dropped: 0,
    unknownSeeds: [],
    missingCommon: [],
    visited: 0,
  };
}

export async function computeInjectedJars(
  root: string,
  selectedModuleDirs: readonly string[],
  fullJars: readonly string[],
  log: (m: string) => void,
  opts: JarPlanOptions = {}
): Promise<JarPlanResult> {
  let seeds = [...new Set(selectedModuleDirs.map((s) => s.trim()).filter(Boolean))];
  /** modules auto-selected for this window folder (null: explicit selection) */
  let auto: number | null = null;
  if (seeds.length === 0 && (!opts.folder || path.resolve(opts.folder) === path.resolve(root))) {
    return fallback(fullJars, "no module selection", log);
  }

  const depsFile = path.join(root, "out", "soong", "module_bp_java_deps.json");

  // stale index: soong rewrites build.ninja and this file on every full build;
  // an index older than build.ninja describes jars that may no longer exist.
  // (Transient while a build runs — self-heals on the next scan.) Checked
  // BEFORE loading the index: a 59 MB parse would be wasted work here.
  const mtime = async (p: string): Promise<number | null> => {
    try {
      return (await fs.stat(p)).mtimeMs;
    } catch {
      return null;
    }
  };
  const [depsM, ninjaM] = await Promise.all([
    mtime(depsFile),
    mtime(path.join(root, "out", "soong", "build.ninja")),
  ]);
  if (depsM !== null && ninjaM !== null && ninjaM > depsM) {
    return fallback(fullJars, "module index is older than the last build", log);
  }

  // Subtree window (Connectivity, NetworkStack, ...) with no explicit
  // selection: derive the module dirs exactly like the source-path channel
  // (autoModulesForFolder + the same scoped import exclusions), so the two
  // channels scope the same modules. Still empty ⇒ full-list fallback.
  let index: JavaModuleIndex | null = null;
  if (seeds.length === 0) {
    index = await loadJavaModuleIndex(root, log);
    if (!index) {
      return fallback(fullJars, "no module selection and the build index is unavailable", log);
    }
    const scopedExcl = scopedImportExclusions(opts.importExclusions ?? [], [opts.folder!]);
    seeds = [...new Set(autoModulesForFolder(index, root, opts.folder!, scopedExcl))];
    if (seeds.length === 0) {
      return fallback(fullJars, "no module selection and no module dirs under the window folder", log);
    }
    auto = seeds.length;
    log(
      `[aosp-nav] jarPlan: no explicit selection — auto-selected ${auto} module(s) under the window folder (same rule as java.project.sourcePaths)`
    );
  }

  // disk check with a memo: the same jar is listed by many modules
  const disk = new Map<string, boolean>();
  const exists = async (rel: string): Promise<boolean> => {
    const hit = disk.get(rel);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      ok = (await fs.stat(path.join(root, rel))).isFile();
    } catch {
      ok = false;
    }
    disk.set(rel, ok);
    return ok;
  };

  // same module set + same index/build ⇒ same closure: reuse it (the jars are
  // still stat'ed, so a rebuild that removed them falls through to a recompute)
  const cacheKey = [root, seeds.slice().sort().join("\u0000"), depsM, ninjaM].join("\u0001");
  const cached = closureCache.get(cacheKey);
  if (cached) {
    let allPresent = true;
    for (const rel of cached.relJars) {
      if (!(await exists(rel))) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) {
      log(`[aosp-nav] jarPlan: closure cache hit for the same module set (${cached.relJars.length} jars, index/build unchanged)`);
      return {
        jars: cached.relJars.map((rel) => path.join(root, rel)),
        mode: "closure",
        unmapped: cached.unmapped,
        starved: cached.starved,
        rescued: cached.rescued,
        dropped: cached.dropped,
        unknownSeeds: cached.unknownSeeds,
        missingCommon: cached.missingCommon,
        visited: cached.visited,
        auto: cached.auto ?? undefined,
      };
    }
    closureCache.delete(cacheKey);
  }

  if (!index) index = await loadJavaModuleIndex(root, log);
  if (!index) return fallback(fullJars, `${depsFile} not found or not valid JSON`, log);

  const r = await closureJars(index, seeds, {
    commonModules: COMMON_MODULES,
    exists,
    // variant fallback for every module whose index variant is not on disk
    rescue: (name, e) => rescueBuiltJar(root, name, e.path),
  });

  if (r.unknownSeeds.length > 0) {
    log(`[aosp-nav] jarPlan: ${r.unknownSeeds.length} selected module dir(s) not in the index: ${r.unknownSeeds.join(", ")}`);
  }
  if (r.missingCommon.length > 0) {
    log(`[aosp-nav] jarPlan: common module(s) not in the index: ${r.missingCommon.join(", ")}`);
  }
  if (r.unmapped.length > 0) {
    const shown = r.unmapped.slice(0, UNMAPPED_LOG_LIMIT);
    log(
      `[aosp-nav] jarPlan: ${r.unmapped.length} reachable module name(s) missing from the build index (dangling edges, no jar can be mapped): ` +
        `${shown.join(", ")}${r.unmapped.length > shown.length ? ` (+${r.unmapped.length - shown.length} more)` : ""}`
    );
  }
  if (r.starved > 0) {
    log(`[aosp-nav] jarPlan: ${r.starved} closure module(s) reference jar(s) not on disk yet and have no built variant (not built) — they join automatically after the next build + rescan`);
  }
  if (r.rescued > 0) {
    log(`[aosp-nav] jarPlan: ${r.rescued} module(s) recovered through variant fallback (index variant missing, a built javac/combined variant used)`);
  }

  // common modules with no surviving index jar: look the built jar up directly
  // in .intermediates (its variant/kind differ from what the index registers)
  const commonRescued: string[] = [];
  for (const name of r.commonStarved) {
    const dir = index.byName.get(name)?.path;
    if (!dir) continue;
    const rel = await rescueBuiltJar(root, name, dir);
    if (rel) {
      log(`[aosp-nav] jarPlan: index variant of common module ${name} is not on disk — using ${rel}`);
      commonRescued.push(rel);
    } else {
      log(`[aosp-nav] jarPlan: common module ${name} has no built jar on disk (not built yet?)`);
    }
  }

  const allRel = [...r.jars, ...commonRescued];
  if (allRel.length === 0) return fallback(fullJars, "closure produced 0 existing jars", log);

  const rescued = r.rescued + commonRescued.length;
  const label =
    auto === null
      ? `closure of ${seeds.length} module dir(s)`
      : `closure (auto ${auto} module(s) for this folder)`;
  log(`[aosp-nav] jarPlan: ${label} = ${allRel.length} jars (${r.visited} modules visited, ${r.dropped} dropped, ${rescued} rescued by variant fallback)`);
  closureCache.set(cacheKey, {
    relJars: allRel,
    unmapped: r.unmapped,
    starved: r.starved,
    rescued,
    dropped: r.dropped,
    unknownSeeds: r.unknownSeeds,
    missingCommon: r.missingCommon,
    visited: r.visited,
    auto,
  });
  if (closureCache.size > CLOSURE_CACHE_LIMIT) {
    closureCache.delete(closureCache.keys().next().value!);
  }
  return {
    jars: allRel.map((rel) => path.join(root, rel)),
    mode: "closure",
    unmapped: r.unmapped,
    starved: r.starved,
    rescued,
    dropped: r.dropped,
    unknownSeeds: r.unknownSeeds,
    missingCommon: r.missingCommon,
    visited: r.visited,
    auto: auto ?? undefined,
  };
}
