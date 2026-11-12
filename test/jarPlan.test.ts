import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { computeInjectedJars } from "../src/jdtls/jarPlan";

const tmps: string[] = [];
async function makeRoot(
  deps: Record<string, unknown> | null,
  jarRels: string[],
  opts: { ninjaNewer?: boolean } = {}
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-jarplan-"));
  tmps.push(root);
  if (deps !== null) {
    const dir = path.join(root, "out", "soong");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "module_bp_java_deps.json"), JSON.stringify(deps));
    for (const rel of jarRels) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), "");
    }
    if (opts.ninjaNewer) {
      const far = new Date(Date.now() + 60_000);
      await fs.writeFile(path.join(dir, "build.ninja"), "");
      await fs.utimes(path.join(dir, "build.ninja"), far, far);
    }
  }
  return root;
}
afterEach(async () => {
  while (tmps.length) {
    const t = tmps.pop()!;
    await fs.rm(t, { recursive: true, force: true });
  }
});

const NOOP = (): void => undefined;
const FULL = ["/full/a.jar", "/full/b.jar"];

describe("computeInjectedJars", () => {
  it("falls back to the full list when the index is missing", async () => {
    const root = await makeRoot(null, []);
    const r = await computeInjectedJars(root, ["frameworks/base/core/java"], FULL, NOOP);
    expect(r.mode).toBe("fallback");
    expect(r.jars).toEqual(FULL);
    expect(r.reason).toContain("module_bp_java_deps.json");
  });

  it("falls back when the index is older than the last build", async () => {
    const root = await makeRoot(
      { app: { path: ["frameworks/base/core/java"], jars: ["out/j/a.jar"] } },
      ["out/j/a.jar"],
      { ninjaNewer: true }
    );
    const r = await computeInjectedJars(root, ["frameworks/base/core/java"], FULL, NOOP);
    expect(r.mode).toBe("fallback");
    expect(r.reason).toContain("older");
  });

  it("falls back when there is no module selection", async () => {
    const root = await makeRoot(
      { app: { path: ["frameworks/base/core/java"], jars: ["out/j/a.jar"] } },
      ["out/j/a.jar"]
    );
    const r = await computeInjectedJars(root, [], FULL, NOOP);
    expect(r.mode).toBe("fallback");
    expect(r.reason).toContain("no module selection");
  });

  it("falls back when the closure yields no existing jar", async () => {
    const root = await makeRoot(
      { app: { path: ["frameworks/base/core/java"], jars: ["out/j/gone.jar"] } },
      []
    );
    const r = await computeInjectedJars(root, ["frameworks/base/core/java"], FULL, NOOP);
    expect(r.mode).toBe("fallback");
    expect(r.reason).toContain("0 existing jars");
  });

  it("returns the closure ∪ common set as absolute paths", async () => {
    const root = await makeRoot(
      {
        app: {
          path: ["frameworks/base/core/java"],
          jars: ["out/j/a.jar"],
          dependencies: ["lib"],
        },
        lib: { path: ["p"], jars: ["out/j/b.jar"] },
        "core-oj": { path: ["libcore"], jars: ["out/j/core-oj.jar"] },
        "core-libart": { path: ["libcore"], jars: ["out/j/core-libart.jar"] },
      },
      ["out/j/a.jar", "out/j/b.jar", "out/j/core-oj.jar", "out/j/core-libart.jar"]
    );
    const logs: string[] = [];
    const r = await computeInjectedJars(root, ["frameworks/base/core/java"], FULL, (m) => logs.push(m));
    expect(r.mode).toBe("closure");
    expect(r.jars).toEqual([
      path.join(root, "out/j/a.jar"),
      path.join(root, "out/j/b.jar"),
      path.join(root, "out/j/core-libart.jar"),
      path.join(root, "out/j/core-oj.jar"),
    ]);
    expect(r.unmapped).toEqual([]);
    expect(r.starved).toBe(0);
    expect(logs.some((l) => l.includes("closure of 1 module"))).toBe(true);
  });

  it("logs dangling module names for later tracing", async () => {
    const root = await makeRoot(
      {
        app: {
          path: ["frameworks/base/core/java"],
          jars: ["out/j/a.jar"],
          dependencies: ["framework-res"],
        },
      },
      ["out/j/a.jar"]
    );
    const logs: string[] = [];
    const r = await computeInjectedJars(root, ["frameworks/base/core/java"], FULL, (m) => logs.push(m));
    expect(r.mode).toBe("closure");
    expect(r.unmapped).toEqual(["framework-res"]);
    expect(logs.some((l) => l.includes("framework-res"))).toBe(true);
  });

  it("rescues common modules whose built jar differs from the index variant", async () => {
    const root = await makeRoot(
      {
        app: { path: ["frameworks/base/core/java"], jars: ["out/j/a.jar"] },
        // index registers a turbine-combined variant that was never built;
        // the real jar is the apex javac one (variant preference: last sorted)
        "core-oj": {
          path: ["libcore"],
          jars: ["out/soong/.intermediates/libcore/core-oj/turbine-combined/core-oj.jar"],
        },
      },
      [
        "out/j/a.jar",
        "out/soong/.intermediates/libcore/core-oj/android_common/javac/core-oj.jar",
        "out/soong/.intermediates/libcore/core-oj/android_common_apex31/javac/core-oj.jar",
      ]
    );
    const logs: string[] = [];
    const r = await computeInjectedJars(root, ["frameworks/base/core/java"], FULL, (m) => logs.push(m));
    expect(r.mode).toBe("closure");
    expect(r.jars).toContain(
      path.join(root, "out/soong/.intermediates/libcore/core-oj/android_common_apex31/javac/core-oj.jar")
    );
    expect(r.rescued).toBe(1);
    expect(logs.some((l) => l.includes("recovered through variant fallback"))).toBe(true);
  });

  it("recovers a non-common starved module from a built variant", async () => {
    const root = await makeRoot(
      {
        app: { path: ["frameworks/base/core/java"], jars: ["out/j/a.jar"], dependencies: ["aidl-lib"] },
        // index registers a turbine jar that was never built; javac exists
        "aidl-lib": {
          path: ["hardware/interfaces/sample"],
          jars: ["out/soong/.intermediates/hardware/interfaces/sample/aidl-lib/turbine-combined/aidl-lib.jar"],
        },
      },
      [
        "out/j/a.jar",
        "out/soong/.intermediates/hardware/interfaces/sample/aidl-lib/android_common/javac/aidl-lib.jar",
      ]
    );
    const logs: string[] = [];
    const r = await computeInjectedJars(root, ["frameworks/base/core/java"], FULL, (m) => logs.push(m));
    expect(r.mode).toBe("closure");
    expect(r.jars).toContain(
      path.join(root, "out/soong/.intermediates/hardware/interfaces/sample/aidl-lib/android_common/javac/aidl-lib.jar")
    );
    expect(r.rescued).toBe(1);
    expect(r.starved).toBe(0);
    expect(r.dropped).toBe(0);
  });

  it("reuses the closure for the same module set while the index is unchanged", async () => {
    const root = await makeRoot(
      {
        app: { path: ["frameworks/base/core/java"], jars: ["out/j/a.jar"] },
        gone: { path: ["p/g"], jars: ["out/j/gone.jar"] },
      },
      ["out/j/a.jar"]
    );
    const logs1: string[] = [];
    const first = await computeInjectedJars(
      root, ["frameworks/base/core/java"], FULL, (m) => logs1.push(m)
    );
    const logs2: string[] = [];
    const second = await computeInjectedJars(
      root, ["frameworks/base/core/java"], FULL, (m) => logs2.push(m)
    );
    expect(second.jars).toEqual(first.jars);
    expect(second.dropped).toBe(first.dropped);
    expect(logs2.some((l) => l.includes("closure cache hit"))).toBe(true);
    expect(logs2.some((l) => l.includes("closure of 1 module"))).toBe(false);
  });

  it("counts unbuilt jar candidates as starved without listing names", async () => {
    const root = await makeRoot(
      {
        app: {
          path: ["frameworks/base/core/java"],
          jars: ["out/j/a.jar"],
          dependencies: ["notbuilt"],
        },
        notbuilt: { path: ["p/nb"], jars: ["out/j/nb.jar"] },
      },
      ["out/j/a.jar"]
    );
    const logs: string[] = [];
    const r = await computeInjectedJars(root, ["frameworks/base/core/java"], FULL, (m) => logs.push(m));
    expect(r.mode).toBe("closure");
    expect(r.starved).toBe(1);
    expect(r.jars).toEqual([path.join(root, "out/j/a.jar")]);
    expect(logs.some((l) => l.includes("not on disk yet"))).toBe(true);
    expect(logs.some((l) => l.includes("notbuilt"))).toBe(false);
  });

  it("auto-selects the modules under a subtree window folder", async () => {
    const root = await makeRoot(
      {
        conn: {
          path: ["packages/modules/Connectivity/framework"],
          srcs: ["packages/modules/Connectivity/framework/src/example/A.java"],
          jars: ["out/j/a.jar"],
          dependencies: ["lib"],
        },
        lib: { path: ["p"], srcs: ["p/src/example/B.java"], jars: ["out/j/b.jar"] },
        wifi: {
          path: ["packages/modules/Wifi/framework"],
          srcs: ["packages/modules/Wifi/framework/src/example/C.java"],
          jars: ["out/j/c.jar"],
        },
      },
      ["out/j/a.jar", "out/j/b.jar", "out/j/c.jar"]
    );
    const logs: string[] = [];
    const r = await computeInjectedJars(
      root,
      [],
      FULL,
      (m) => logs.push(m),
      { folder: path.join(root, "packages/modules/Connectivity") }
    );
    expect(r.mode).toBe("closure");
    expect(r.auto).toBe(1);
    expect(r.jars).toEqual([path.join(root, "out/j/a.jar"), path.join(root, "out/j/b.jar")]);
    expect(logs.some((l) => l.includes("auto-selected 1 module(s)"))).toBe(true);
    expect(logs.some((l) => l.includes("closure (auto 1 module(s) for this folder)"))).toBe(true);
  });

  it("falls back when the subtree folder holds no java module", async () => {
    const root = await makeRoot(
      { app: { path: ["packages/modules/Connectivity/framework"], srcs: ["src"], jars: ["out/j/a.jar"] } },
      ["out/j/a.jar"]
    );
    const r = await computeInjectedJars(
      root,
      [],
      FULL,
      NOOP,
      { folder: path.join(root, "packages/modules/Telephony") }
    );
    expect(r.mode).toBe("fallback");
    expect(r.reason).toContain("no module dirs under the window folder");
  });

  it("keeps the root window on the explicit selection", async () => {
    const root = await makeRoot(
      { app: { path: ["frameworks/base/core/java"], srcs: ["src"], jars: ["out/j/a.jar"] } },
      ["out/j/a.jar"]
    );
    const r = await computeInjectedJars(root, [], FULL, NOOP, { folder: root });
    expect(r.mode).toBe("fallback");
    expect(r.reason).toBe("no module selection");
  });
});
