import { describe, it, expect } from "vitest";
import { CACHE_VERSION, CacheFile, isCacheValid, filtersHash } from "../src/core/cacheModel";

const filters = { jars: ["a"], paths: ["b"], globs: ["c"] };
const hash = filtersHash(filters);

function cache(over: Partial<CacheFile> = {}): CacheFile {
  return {
    version: CACHE_VERSION,
    filtersHash: hash,
    generatedAt: "2026-01-01T00:00:00.000Z",
    jars: ["/out/x.jar"],
    buildMtimeMs: 1000,
    ...over,
  };
}

describe("cache freshness", () => {
  it("accepts a matching cache", () => {
    expect(isCacheValid(cache(), CACHE_VERSION, hash, 1000)).toBe(true);
  });

  it("rejects version, filter hash, and empty lists", () => {
    expect(isCacheValid(cache({ version: CACHE_VERSION - 1 }), CACHE_VERSION, hash, 1000)).toBe(false);
    expect(isCacheValid(cache(), CACHE_VERSION, "other", 1000)).toBe(false);
    expect(isCacheValid(cache({ jars: [] }), CACHE_VERSION, hash, 1000)).toBe(false);
  });

  it("rejects caches without a build stamp (upgrade path)", () => {
    const old = cache();
    delete old.buildMtimeMs;
    expect(isCacheValid(old, CACHE_VERSION, hash, 1000)).toBe(false);
  });

  it("rejects a rebuild but accepts an unknown current stamp", () => {
    expect(isCacheValid(cache(), CACHE_VERSION, hash, 2000)).toBe(false);
    expect(isCacheValid(cache(), CACHE_VERSION, hash, null)).toBe(true);
  });

  it("rejects a cached stamp when the tree previously had no build.ninja", () => {
    expect(isCacheValid(cache({ buildMtimeMs: null }), CACHE_VERSION, hash, 1000)).toBe(false);
  });

  it("fingerprints are stable per exclusion set and change with it", () => {
    expect(filtersHash(filters)).toBe(hash);
    expect(filtersHash({ ...filters, jars: ["a", "z"] })).not.toBe(hash);
  });
});
