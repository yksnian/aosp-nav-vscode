import { ExclusionConfig } from "./types";
import { djb2 } from "../infra/hash";

// 8: caches now record the build stamp (`buildMtimeMs`) and a jar-existence
// check runs on hit. A 7-era list can point at jars deleted by a rebuild, and
// version 7 has no stamp to compare, so force one rescan on upgrade.
export const CACHE_VERSION = 8;

export interface CacheFile {
  version: number;
  filtersHash: string;
  generatedAt: string;
  jars: string[];
  /** mtime of `out/soong/build.ninja` when the list was produced (null when the
   *  tree has no such file, e.g. make-era checkouts). Absent on 7-era caches. */
  buildMtimeMs?: number | null;
}

/** fingerprint of exclusion config: any change -> cache invalidated */
export function filtersHash(ex: ExclusionConfig): string {
  return djb2(JSON.stringify({ jars: ex.jars, paths: ex.paths, globs: ex.globs }));
}

/** A cached list is valid only when the rules still match AND the tree has not
 *  been rebuilt since. `buildMtimeMs` is the current stamp (null = unknown,
 *  e.g. no `build.ninja`): with an unknown stamp we accept the cache and let
 *  the caller's jar-existence sampling catch deletions.
 *
 *  A cache without `buildMtimeMs` is always treated as stale: sampling cannot
 *  see modules that were ADDED by a build, so the one-time rescan on upgrade is
 *  the only way to pick those up. */
export function isCacheValid(
  c: CacheFile | null | undefined,
  version: number,
  fhash: string,
  buildMtimeMs: number | null
): c is CacheFile {
  if (!c || c.version !== version || c.filtersHash !== fhash || c.jars.length === 0) return false;
  if (c.buildMtimeMs === undefined) return false;
  if (buildMtimeMs !== null && c.buildMtimeMs !== buildMtimeMs) return false;
  return true;
}
