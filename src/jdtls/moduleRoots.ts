import * as fs from "fs/promises";
import * as path from "path";

/** Module -> source-root mapping over `out/soong/module_bp_java_deps.json`,
 *  the map soong writes on every full build. Reading it replaces Android.bp
 *  parsing entirely: filegroups, globs and generators are already resolved.
 *  Measured on a real tree (2026-11-10): 31726 modules, JSON.parse ~230 ms.
 *  This module stays free of the `vscode` import so it can be unit-tested. */

export interface SoongEntry {
  /** module directory, relative to the AOSP root */
  path: string;
  srcs: string[];
  staticLibs: string[];
  srcJars: string[];
  /** soong's `dependencies` and `libs` arrays (java module edges, used by the
   *  classpath closure; source-root traversal keeps using staticLibs+srcJars) */
  dependencies: string[];
  libs: string[];
  /** intermediates jars (usually turbine-combined), relative to the tree root */
  jars: string[];
}

export interface ModuleRoots {
  /** roots under first-party dirs: injected when the module is picked */
  firstParty: string[];
  /** roots under external/vendor/... dirs: offered as a separate opt-in,
   *  never auto-injected (user decision, 2026-11-10) */
  thirdParty: string[];
}

export interface JavaModuleIndex {
  byName: Map<string, SoongEntry>;
  /** module dir -> module names living there */
  byPath: Map<string, string[]>;
  moduleCount: number;
  /** memoized rootsForPath results */
  rootsByPath: Map<string, ModuleRoots>;
}

/** Top-level dirs whose derived roots count as third-party or generated. */
const THIRD_PARTY_TOP = new Set(["external", "vendor", "device", "prebuilts", "hardware", "kernel", "out"]);

export function isThirdPartyRoot(rel: string): boolean {
  return THIRD_PARTY_TOP.has(rel.split("/")[0]);
}

/** Derive candidate source roots from a module's .java srcs: a root is the
 *  path prefix ending at the LAST segment named java/src/kotlin. Verified on
 *  a real tree: framework-minus-apex srcs -> frameworks/base/core/java etc.
 *  Srcs under out/ are generated files and are skipped. */
export function deriveRootsFromSrcs(srcs: readonly string[]): Set<string> {
  const roots = new Set<string>();
  for (const f of srcs) {
    if (!f.endsWith(".java") || f.startsWith("out/")) continue;
    const segs = f.split("/");
    let idx = -1;
    for (const name of ["java", "src", "kotlin"]) {
      for (let i = segs.length - 2; i >= 0; i--) {
        if (segs[i] === name) {
          if (i > idx) idx = i;
          break;
        }
      }
    }
    if (idx >= 0) roots.add(segs.slice(0, idx + 1).join("/"));
  }
  return roots;
}

/** Build the index from the parsed JSON. Kept separate from the file read so
 *  tests can feed fixtures directly. */
export function buildIndex(parsed: Record<string, Record<string, unknown>>): JavaModuleIndex {
  const byName = new Map<string, SoongEntry>();
  const byPath = new Map<string, string[]>();
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  for (const [name, e] of Object.entries(parsed)) {
    // soong writes `path` as a single-element array
    const p = Array.isArray(e.path) ? (e.path[0] as string) : (e.path as string);
    if (typeof p !== "string" || !p) continue;
    byName.set(name, {
      path: p,
      srcs: strArr(e.srcs),
      staticLibs: strArr(e.static_libs),
      srcJars: strArr(e.srcjars),
      dependencies: strArr(e.dependencies),
      libs: strArr(e.libs),
      jars: strArr(e.jars),
    });
    const names = byPath.get(p);
    if (names) names.push(name);
    else byPath.set(p, [name]);
  }
  return { byName, byPath, moduleCount: byName.size, rootsByPath: new Map() };
}

export async function loadJavaModuleIndex(
  aospRoot: string,
  log: (m: string) => void
): Promise<JavaModuleIndex | null> {
  const file = path.join(aospRoot, "out", "soong", "module_bp_java_deps.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const t0 = Date.now();
  let parsed: Record<string, Record<string, unknown>>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log(`[aosp-nav] module index: ${file} is not valid JSON: ${e}`);
    return null;
  }
  const index = buildIndex(parsed);
  log(`[aosp-nav] module index: ${index.moduleCount} modules from ${file} (${Date.now() - t0} ms)`);
  return index;
}

/** Transitive roots of one module: its own srcs plus every static_lib /
 *  srcjar dependency. Aggregate modules (framework, service-connectivity)
 *  carry their real sources exclusively through this closure — their own
 *  srcs are empty (verified on a real tree). Memoized per module name. */
export function moduleRoots(
  index: JavaModuleIndex,
  name: string,
  memo: Map<string, Set<string>> = new Map()
): Set<string> {
  const hit = memo.get(name);
  if (hit) return hit;
  memo.set(name, new Set()); // cycle guard: overwritten with the real set below
  const e = index.byName.get(name);
  const out = new Set<string>();
  if (e) {
    for (const r of deriveRootsFromSrcs(e.srcs)) out.add(r);
    for (const d of [...e.staticLibs, ...e.srcJars]) {
      for (const r of moduleRoots(index, d, memo)) out.add(r);
    }
  }
  memo.set(name, out);
  return out;
}

/** Roots of a module dir, split first-party vs third-party so the picker can
 *  keep third-party roots opt-in while first-party roots follow the module
 *  selection. One root may be shared by several module dirs (verified:
 *  packages/modules/Wifi/framework/java feeds framework-minus-apex too). */
export function rootsForPath(index: JavaModuleIndex, modulePath: string): ModuleRoots {
  const cached = index.rootsByPath.get(modulePath);
  if (cached) return cached;
  const memo = new Map<string, Set<string>>();
  const firstParty = new Set<string>();
  const thirdParty = new Set<string>();
  for (const n of index.byPath.get(modulePath) ?? []) {
    for (const r of moduleRoots(index, n, memo)) {
      (isThirdPartyRoot(r) ? thirdParty : firstParty).add(r);
    }
  }
  const result: ModuleRoots = {
    firstParty: [...firstParty].sort(),
    thirdParty: [...thirdParty].sort(),
  };
  index.rootsByPath.set(modulePath, result);
  return result;
}

/** Union of first-party roots of the selected module dirs (AOSP-relative,
 *  sorted, deduped). Unknown module dirs are logged, not fatal: the selection
 *  may predate a clean that renamed modules. */
export function selectedFirstPartyRoots(
  index: JavaModuleIndex,
  modules: readonly string[],
  log: (m: string) => void
): string[] {
  const out = new Set<string>();
  for (const m of modules) {
    if (!index.byPath.has(m)) {
      log(`[aosp-nav] sourcePaths: module ${m} not found in the build index (stale selection or renamed module)`);
      continue;
    }
    for (const p of rootsForPath(index, m).firstParty) out.add(p);
  }
  return [...out].sort();
}

/** Split absolute paths into those inside any of the given folders and those
 *  outside. Mirrors the injection rule (collectDesired): a root is injectable
 *  only when it maps to a non-empty workspace-relative path, so roots equal
 *  to a folder or outside every folder count as outside. */
export function splitRootsByFolders(
  paths: readonly string[],
  folders: readonly string[]
): { inside: string[]; outside: string[] } {
  const inside: string[] = [];
  const outside: string[] = [];
  for (const p of paths) {
    const hit = folders.some((f) => {
      const rel = path.relative(f, p);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    (hit ? inside : outside).push(p);
  }
  return { inside, outside };
}

/** Segments that disqualify a module/root from AUTO selection only (user
 *  decisions 2026-11-10): tests, demos, samples and the vendor "commercial"
 *  trees. Substring rules cover perftests/robotests/test-base/testdata while
 *  leaving innocent names like "latest" alone. Manual picks are never
 *  filtered by this. */
export function isAutoExcludedSegment(seg: string): boolean {
  const s = seg.toLowerCase();
  return (
    // test-base/testdata/unit-tests… ; perftests/robotests/integration-tests…
    s.startsWith("test") ||
    s.endsWith("tests") ||
    s.startsWith("demo") ||
    s.endsWith("demo") ||
    s.startsWith("sample") ||
    s === "commercial"
  );
}

/** frameworks/base dirs that are not "main" content (user decision 1=Y,
 *  2026-11-10): independent apps under packages/, command-line tools, build
 *  tooling, the ravenwood host test harness and errorprone processors. */
const ROOT_WINDOW_EXTRA_EXCLUDE = new Set(["packages", "cmds", "tools", "ravenwood", "errorprone"]);

const FB_BASE = "frameworks/base";

/** True when dirAbs sits inside (or equals) one of the exclusion entries.
 *  `java.import.exclusions` mixes absolute dir paths (scanned gradle/maven
 *  project dirs: sdk/testapps, test/suite_harness, external test libs, ...)
 *  with simple double-star globs over segment sequences ("packages/apps",
 *  "vendor"). Both mean "keep jdt.ls from importing this", so the module
 *  picker and the auto selection must not offer these dirs either (user
 *  decision 2026-11-10). Patterns other than absolute paths and
 *  double-star-prefixed globs are ignored — jdt.ls itself never writes
 *  anything else there. */
export function matchesImportExclusion(dirAbs: string, entries: readonly string[]): boolean {
  const segs = dirAbs.split("/");
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    if (e.includes("*")) {
      const m = /^\*\*\/(.+?)(?:\/\*\*)?$/.exec(e);
      if (!m) continue;
      const want = m[1].split("/");
      for (let i = 0; i + want.length <= segs.length; i++) {
        if (want.every((w, j) => segs[i + j] === w)) return true;
      }
    } else if (path.isAbsolute(e)) {
      const rel = path.relative(e, dirAbs);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
    }
  }
  return false;
}

/** Same matching rules as matchesImportExclusion, but reports WHICH entry hit
 *  so callers can tell the sources apart (guard-written vs user-written vs
 *  default glob) without guessing from the path shape. Returns the first
 *  matching entry, or undefined. */
export function findImportExclusion(
  dirAbs: string,
  entries: readonly string[]
): string | undefined {
  const segs = dirAbs.split("/");
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    if (e.includes("*")) {
      const m = /^\*\*\/(.+?)(?:\/\*\*)?$/.exec(e);
      if (!m) continue;
      const want = m[1].split("/");
      for (let i = 0; i + want.length <= segs.length; i++) {
        if (want.every((w, j) => segs[i + j] === w)) return raw;
      }
    } else if (path.isAbsolute(e)) {
      const rel = path.relative(e, dirAbs);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return raw;
    }
  }
  return undefined;
}

/** Drop exclusion entries that cover a window folder itself. The eclipse
 *  guard adds the whole folder when its own metadata was stale (rootBlocked),
 *  which says nothing about which subdirs are noise and would otherwise nuke
 *  the entire auto/picker list. Absolute entries that are an ancestor of (or
 *  equal to) any folder are dropped; globs have no folder relation and pass. */
export function scopedImportExclusions(entries: readonly string[], folders: readonly string[]): string[] {
  return entries.filter((e) => {
    if (!path.isAbsolute(e)) return true;
    return folders.every((f) => {
      const rel = path.relative(e, f);
      return rel.startsWith("..") || path.isAbsolute(rel);
    });
  });
}

/** Default module selection for one workspace folder, applied while
 *  `aosp-nav.java.sourceRootModules` has never been written:
 *  - AOSP-root window: modules under frameworks/base whose in-tree roots are
 *    main content (services/*, core, telephony, media, apex, ... — cmds,
 *    tools, packages apps etc. excluded via ROOT_WINDOW_EXTRA_EXCLUDE);
 *  - subdirectory window: every non-excluded module whose directory sits in
 *    the folder and owns at least one injectable, non-excluded root there
 *    (measured on a real tree: Connectivity -> 21 production roots).
 *  Returns module dirs (AOSP-relative, sorted). */
export function autoModulesForFolder(
  index: JavaModuleIndex,
  aospRoot: string,
  folder: string,
  importExclusions: readonly string[] = []
): string[] {
  const rootWindow = path.relative(aospRoot, folder) === "";
  const out: string[] = [];
  for (const dirRel of index.byPath.keys()) {
    if (
      importExclusions.length > 0 &&
      matchesImportExclusion(path.join(aospRoot, dirRel), importExclusions)
    ) {
      continue;
    }
    if (rootWindow) {
      if (!(dirRel === FB_BASE || dirRel.startsWith(FB_BASE + "/"))) continue;
      if (dirRel.split("/").some((s) => ROOT_WINDOW_EXTRA_EXCLUDE.has(s))) continue;
    } else {
      const rel = path.relative(folder, path.join(aospRoot, dirRel));
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    }
    if (dirRel.split("/").some(isAutoExcludedSegment)) continue;
    const r = rootsForPath(index, dirRel);
    const usable = r.firstParty.some((rel) => {
      if (rel.split("/").some(isAutoExcludedSegment)) return false;
      if (rootWindow && !rel.startsWith(FB_BASE + "/")) return false;
      const abs = path.join(aospRoot, rel);
      const wrel = path.relative(folder, abs);
      return wrel !== "" && !wrel.startsWith("..") && !path.isAbsolute(wrel);
    });
    if (usable) out.push(dirRel);
  }
  return out.sort();
}
