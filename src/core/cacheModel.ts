import { ExclusionConfig } from "./types";
import { djb2 } from "../infra/hash";

export const CACHE_VERSION = 6;

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
