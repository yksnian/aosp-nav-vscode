import { describe, it, expect } from "vitest";
import { CACHE_VERSION, CacheFile, isCacheValid, filtersHash } from "../src/core/cacheModel";
import { ExclusionConfig } from "../src/core/types";

const ex: ExclusionConfig = { jars: ["stub"], paths: ["tracing"], globs: [] };
const fhash = filtersHash(ex);

function cache(over: Partial<CacheFile> = {}): CacheFile {
  return {
    version: CACHE_VERSION,
    filtersHash: fhash,
    generatedAt: "2026-01-01T00:00:00.000Z",
    jars: ["/out/a.jar", "/out/b.jar"],
    buildMtimeMs: 1000,
    ...over,
  };
}

describe("isCacheValid", () => {
  it("accepts a cache whose build stamp matches", () => {
    expect(isCacheValid(cache(), CACHE_VERSION, fhash, 1000)).toBe(true);
  });

  it("rejects a cache produced by a different build (rebuild invalidates)", () => {
    expect(isCacheValid(cache(), CACHE_VERSION, fhash, 2000)).toBe(false);
  });

  it("accepts when the current stamp is unknown (no build.ninja)", () => {
    expect(isCacheValid(cache(), CACHE_VERSION, fhash, null)).toBe(true);
  });

  it("rejects a 7-era cache without a build stamp, forcing one rescan", () => {
    const legacy = cache({ buildMtimeMs: undefined });
    expect(isCacheValid(legacy, CACHE_VERSION, fhash, 1000)).toBe(false);
  });

  it("rejects when filters changed", () => {
    expect(isCacheValid(cache(), CACHE_VERSION, "other", 1000)).toBe(false);
  });

  it("rejects empty jar lists and version mismatches", () => {
    expect(isCacheValid(cache({ jars: [] }), CACHE_VERSION, fhash, 1000)).toBe(false);
    expect(isCacheValid(cache(), CACHE_VERSION + 1, fhash, 1000)).toBe(false);
    expect(isCacheValid(null, CACHE_VERSION, fhash, 1000)).toBe(false);
  });
});
