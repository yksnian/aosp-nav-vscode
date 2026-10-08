// Rollback safety: resetSettings must remove exactly what the plugin appended.
// The values below are the ones actually found in the author's global
// settings.json (user entries next to the plugin's "**/out/**", "**/.repo/**")
// — the old `update(key, undefined)` took all of them down.
import { describe, it, expect } from "vitest";
import { peelAppended } from "../src/core/peelExcludes";
import { applyDirPriority } from "../src/core/selector";
import { Defaults } from "../src/core/types";
import REAL from "../resources/defaults.json";

const OURS = ["**/out/**", "**/.repo/**"];
const defaults: Defaults = REAL as Defaults;

describe("peelAppended: object keys (files.watcherExclude / search.exclude)", () => {
  it("keeps the user's entries and drops only ours", () => {
    const { value, changed } = peelAppended(
      {
        "**/out/**": true,
        "**/.repo/**": true,
        "**/node_modules": true,
        "**/dist": true,
        "**/.git": true,
      },
      OURS
    );
    expect(changed).toBe(true);
    expect(value).toEqual({ "**/node_modules": true, "**/dist": true, "**/.git": true });
  });

  it("deletes the key only when nothing else was in it", () => {
    expect(peelAppended({ "**/out/**": true, "**/.repo/**": true }, OURS)).toEqual({
      value: undefined,
      changed: true,
    });
  });

  it("is a no-op when our entries are already gone", () => {
    const cur = { "**/node_modules": true };
    expect(peelAppended(cur, OURS)).toEqual({ value: cur, changed: false });
  });
});

describe("peelAppended: array keys (java.import.exclusions)", () => {
  it("keeps user-authored patterns", () => {
    // real value from the author's global settings: redhat defaults the plugin
    // materialized, plus entries the user added themselves
    const { value, changed } = peelAppended(
      [
        "**/node_modules/**",
        "**/.metadata/**",
        "**/archetype-resources/**",
        "**/META-INF/maven/**",
        "**/lenovo/**",
        "**/packages/apps/**",
        "**/out/**",
        "**/.repo/**",
      ],
      OURS
    );
    expect(changed).toBe(true);
    expect(value).toEqual([
      "**/node_modules/**",
      "**/.metadata/**",
      "**/archetype-resources/**",
      "**/META-INF/maven/**",
      "**/lenovo/**",
      "**/packages/apps/**",
    ]);
  });

  it("ignores values that are not a list or object", () => {
    expect(peelAppended(undefined, OURS)).toEqual({ value: undefined, changed: false });
    expect(peelAppended(true, OURS)).toEqual({ value: true, changed: false });
  });
});

describe("directory priority ordering", () => {
  it("ranks a real tree path above external/", () => {
    const jars = [
      "/aosp/out/soong/.intermediates/external/foo/android_common/javac/foo.jar",
      "/aosp/out/soong/.intermediates/frameworks/base/bar/android_common/javac/bar.jar",
    ];
    applyDirPriority(jars, defaults);
    expect(jars).toEqual([
      "/aosp/out/soong/.intermediates/frameworks/base/bar/android_common/javac/bar.jar",
      "/aosp/out/soong/.intermediates/external/foo/android_common/javac/foo.jar",
    ]);
  });

  it("applies the same ordering to Windows paths", () => {
    // both used to collapse to dirPriorityFallback (the POSIX patterns never
    // matched a `\` path) and fell back to alphabetical order, which put the
    // external/ (lower-priority) jar first
    const jars = [
      "X:\\aosp\\out\\soong\\.intermediates\\external\\foo\\android_common\\javac\\foo.jar",
      "X:\\aosp\\out\\soong\\.intermediates\\frameworks\\base\\bar\\android_common\\javac\\bar.jar",
    ];
    applyDirPriority(jars, defaults);
    expect(jars).toEqual([
      "X:\\aosp\\out\\soong\\.intermediates\\frameworks\\base\\bar\\android_common\\javac\\bar.jar",
      "X:\\aosp\\out\\soong\\.intermediates\\external\\foo\\android_common\\javac\\foo.jar",
    ]);
    // and the ranks must actually differ, not just happen to sort that way
    const rank = (j: string): number => {
      const rel = j.split("\\").join("/").replace(/^.*?\.intermediates\//, "");
      for (const [pat, r] of defaults.dirPriority) if (new RegExp(pat).test(rel)) return r;
      return defaults.dirPriorityFallback;
    };
    expect(rank(jars[0])).toBeLessThan(rank(jars[1]));
  });
});
