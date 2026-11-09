import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  FULL_VERIFY_LIMIT,
  SAMPLE_PROBES,
  ScanCancelledError,
  scanJars,
  verifyJars,
  walkDirs,
} from "../src/infra/fsScan";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-fsscan-"));
  // a/1.jar, a/b/2.jar, a/b/c/3.jar, a/b/c/readme.txt, skipped/skip.jar
  await fs.mkdir(path.join(root, "a", "b", "c"), { recursive: true });
  await fs.mkdir(path.join(root, "skipped"), { recursive: true });
  await fs.writeFile(path.join(root, "a", "1.jar"), "x");
  await fs.writeFile(path.join(root, "a", "b", "2.jar"), "x");
  await fs.writeFile(path.join(root, "a", "b", "c", "3.jar"), "x");
  await fs.writeFile(path.join(root, "a", "b", "c", "readme.txt"), "x");
  await fs.writeFile(path.join(root, "skipped", "skip.jar"), "x");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("scanJars (bounded-concurrency walk)", () => {
  it("finds jars at every depth", async () => {
    const jars = await scanJars(root);
    expect(jars.map((p) => path.relative(root, p)).sort()).toEqual([
      path.join("a", "1.jar"),
      path.join("a", "b", "2.jar"),
      path.join("a", "b", "c", "3.jar"),
      path.join("skipped", "skip.jar"),
    ]);
  });

  it("honours skipDir and maxDepth", async () => {
    const jars = await scanJars(root, {
      skipDir: (name) => name === "skipped",
      maxDepth: 1,
    });
    expect(jars.map((p) => path.relative(root, p))).toEqual([path.join("a", "1.jar")]);
  });

  it("reports the number of visited directories", async () => {
    const { dirs } = await walkDirs(root);
    // root + a + a/b + a/b/c + skipped
    expect(dirs).toBe(5);
  });

  it("throws ScanCancelledError when asked to cancel", async () => {
    await expect(scanJars(root, { shouldCancel: () => true })).rejects.toBeInstanceOf(
      ScanCancelledError
    );
  });

  it("survives a missing base directory", async () => {
    const jars = await scanJars(path.join(root, "does-not-exist"));
    expect(jars).toEqual([]);
  });
});

describe("verifyJars", () => {
  it("checks every entry up to the full-verify limit", async () => {
    const jars = await scanJars(root);
    const r = await verifyJars(jars);
    expect(r).toEqual({ checked: jars.length, missing: 0, sampled: false });
  });

  it("counts dead paths", async () => {
    const r = await verifyJars([path.join(root, "a", "1.jar"), path.join(root, "gone.jar")]);
    expect(r.missing).toBe(1);
    expect(r.checked).toBe(2);
    expect(r.sampled).toBe(false);
  });

  it("samples instead of stat-ing huge lists", async () => {
    // fake paths only, nothing is created: 4100 > FULL_VERIFY_LIMIT
    const fake = Array.from({ length: FULL_VERIFY_LIMIT + 100 }, (_, i) =>
      path.join(root, `fake-${i}.jar`)
    );
    const r = await verifyJars(fake);
    expect(r.sampled).toBe(true);
    expect(r.checked).toBeLessThanOrEqual(SAMPLE_PROBES + 1);
    expect(r.missing).toBe(r.checked);
  });

  it("returns an empty result for an empty list", async () => {
    expect(await verifyJars([])).toEqual({ checked: 0, missing: 0, sampled: false });
  });
});
