import * as path from "path";
import { Defaults, ScanEntry, ScanResult } from "./types";
import { FilterEngine } from "./filters";

const SOONG_BASES = ["out/soong/.intermediates", "out/.soong/.intermediates"];
// variant dirs: android_common (rank 0) or android_common_apex{,N}... (rank 1)
const APEX_VARIANT_PREFIX = "android_common_apex";

function variantRank(v: string, fallbackPrefix: string): number | null {
  if (v === "android_common") return 0;
  if (v.startsWith(fallbackPrefix)) return 1;
  return null;
}

export async function scanSoong(
  aospRoot: string,
  defaults: Defaults,
  filters: FilterEngine,
  listJars: (base: string) => Promise<string[]>
): Promise<ScanResult | null> {
  // pick the first existing soong base
  let baseDir: string | null = null;
  for (const sub of SOONG_BASES) {
    const cand = path.join(aospRoot, sub);
    const jars = await listJars(cand).catch(() => [] as string[]);
    // listJars returns [] for missing dirs too; distinguish via existence of any jar
    // (a missing dir simply yields an empty list; try next base)
    if (jars.length > 0) {
      baseDir = cand;
      // use this jar list
      return scanBase(baseDir, jars, defaults, filters);
    }
  }
  return null;
}

async function scanBase(
  baseDir: string,
  allPaths: string[],
  defaults: Defaults,
  filters: FilterEngine
): Promise<ScanResult> {
  const typeRank = new Map(defaults.soongTagPriority.map((t, i) => [t, i + 1]));
  const unknownRank = defaults.soongTagPriority.length + 1;

  // own: module -> (tag -> best)     fb: module -> best
  const own = new Map<string, Map<string, { rank: number; entry: ScanEntry }>>();
  const fb = new Map<string, { rank: number; entry: ScanEntry }>();
  let excluded = 0;

  for (const absPath of allPaths) {
    const relPath = path.relative(baseDir, absPath).split(path.sep).join("/");
    const comps = relPath.split("/");

    // rightmost variant component
    let vi = -1;
    for (let i = comps.length - 2; i >= 0; i--) {
      if (variantRank(comps[i], APEX_VARIANT_PREFIX) !== null) {
        vi = i;
        break;
      }
    }
    if (vi < 1) { excluded++; continue; }

    // type chain between variant and jar: reject repackaged links
    const chain = comps.slice(vi + 1, comps.length - 1);
    let repackaged = false;
    for (const c of chain) {
      if (defaults.repackagedTags.includes(c)) { repackaged = true; break; }
    }
    if (repackaged) { excluded++; continue; }
    const typ = vi < comps.length - 2 ? comps[vi + 1] : "";

    // module name: strip .impl suffix (java_sdk_library real compile lives in <name>.impl)
    const moduleName = comps[vi - 1].replace(/\.impl$/, "");

    const entry: ScanEntry = { absPath, relPath, moduleName, variant: comps[vi], type: typ };
    if (filters.hit(entry)) { excluded++; continue; }

    const rank = variantRank(comps[vi], APEX_VARIANT_PREFIX)! * 100
      + (typeRank.get(typ) ?? unknownRank);

    if (defaults.ownTags.includes(typ)) {
      // own bucket: best variant per (module, tag); javac+kotlinc both kept
      let per = own.get(moduleName);
      if (!per) { per = new Map(); own.set(moduleName, per); }
      const b = per.get(typ);
      if (!b || rank < b.rank) per.set(typ, { rank, entry });
    } else {
      // fallback bucket: one per module (combined/turbine/unknown compete)
      const b = fb.get(moduleName);
      if (!b || rank < b.rank) fb.set(moduleName, { rank, entry });
    }
  }

  // assemble: own bucket fully kept; fallback only for modules without own artifacts
  const selected = new Map<string, ScanEntry>();
  const jars: string[] = [];
  for (const [mod, per] of own) {
    for (const { entry } of per.values()) {
      selected.set(mod, entry);
      jars.push(entry.absPath);
    }
  }
  for (const [mod, { entry }] of fb) {
    if (!own.has(mod)) {
      selected.set(mod, entry);
      jars.push(entry.absPath);
    }
  }

  // pre-jarjar cross-module dedup: drop when base module has its own artifact
  let dedupPreJarjar = 0;
  for (const [mod, entry] of [...selected.entries()]) {
    const m = /^(.+)-pre-jarjar$/.exec(mod);
    if (m && selected.has(m[1])) {
      const idx = jars.indexOf(entry.absPath);
      if (idx >= 0) {
        jars.splice(idx, 1);
        selected.delete(mod);
        dedupPreJarjar++;
      }
    }
  }

  return {
    jars,
    stats: { scanned: allPaths.length, excluded, selected: jars.length, dedupPreJarjar },
  };
}
