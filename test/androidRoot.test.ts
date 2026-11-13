import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAospRoot } from "../src/androidRoot";

const tmps: string[] = [];
afterEach(async () => {
  while (tmps.length) {
    const t = tmps.pop()!;
    await fs.rm(t, { recursive: true, force: true });
  }
});

async function makeTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-root-"));
  tmps.push(root);
  return root;
}

describe("detectAospRoot", () => {
  it("finds the tree root by probe markers from a deep seed", async () => {
    const root = await makeTree();
    await fs.mkdir(path.join(root, "out/soong/.intermediates"), { recursive: true });
    const deep = path.join(root, "frameworks/base/core/java");
    await fs.mkdir(deep, { recursive: true });
    expect(await detectAospRoot(path.join(deep, "A.java"))).toBe(root);
  });

  it("does not cache negative results, so a tree built after opening is detected", async () => {
    const root = await makeTree();
    const sub = path.join(root, "frameworks/base");
    await fs.mkdir(sub, { recursive: true });
    expect(await detectAospRoot(path.join(sub, "A.java"))).toBeNull();
    await fs.mkdir(path.join(root, "out/soong/.intermediates"), { recursive: true });
    expect(await detectAospRoot(path.join(sub, "A.java"))).toBe(root);
  });

  it("prefers out/soong/.intermediates over the make-era marker", async () => {
    const root = await makeTree();
    await fs.mkdir(path.join(root, "out/target/common/obj/JAVA_LIBRARIES"), { recursive: true });
    expect(await detectAospRoot(path.join(root, "x.java"))).toBe(root);
  });
});
