import { ExclusionConfig } from "./types";
import { djb2 } from "../infra/hash";

// 7: excludePaths switched from absolute-path matching to the path relative to
// .intermediates/. The rule change narrows what is excluded, so a list cached
// by 6 could be missing jars this version keeps — force one rescan on upgrade.
export const CACHE_VERSION = 7;

export interface CacheFile {
  version: number;
  filtersHash: string;
  generatedAt: string;
  jars: string[];
}

/** fingerprint of exclusion config: any change -> cache invalidated */
export function filtersHash(ex: ExclusionConfig): string {
  return djb2(JSON.stringify({ jars: ex.jars, paths: ex.paths, globs: ex.globs }));
}

export function isCacheValid(
  c: CacheFile | null | undefined,
  version: number,
  fhash: string
): c is CacheFile {
  return !!c && c.version === version && c.filtersHash === fhash && c.jars.length > 0;
}
