import { describe, it, expect, vi } from "vitest";

// classpathChannel imports vscode for the runtime apply path; the script
// builder itself is pure. A minimal mock lets the test load the module.
vi.mock("vscode", () => ({}));

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildScript, shQuote } from "../src/kotlin/classpathChannel";

describe("kotlin dispatch script quoting", () => {
  it("single-quotes paths and escapes embedded single quotes", () => {
    expect(shQuote("/tmp/plain")).toBe("'/tmp/plain'");
    expect(shQuote("/tmp/a b")).toBe("'/tmp/a b'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote("$HOME/*[x]")).toBe("'$HOME/*[x]'");
  });

  it("generates a valid POSIX script for hostile root paths", () => {
    const root = "/tmp/aosp tree/it's $HOME/*[x]";
    const script = buildScript({
      [root]: { hash: "h", matchPaths: [root, root + "/sub folder"] },
    });
    expect(script).toContain('if [ "$PWD" = ');
    expect(script).not.toContain('case "$PWD" in');
    expect(script).toContain("exit 0");

    const file = path.join(os.tmpdir(), `aosp-nav-script-${process.pid}.sh`);
    try {
      fs.writeFileSync(file, script);
      const r = spawnSync("sh", ["-n", file], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("carries a manifest line that changes with any root digest", () => {
    // ktlsp caches resolver results per script content hash; the manifest
    // line must therefore change whenever any jar list changes
    const a = buildScript({ "/r": { hash: "h1", matchPaths: ["/r"], digest: "d1" } });
    const b = buildScript({ "/r": { hash: "h1", matchPaths: ["/r"], digest: "d2" } });
    expect(a).toMatch(/# manifest h1:d1\n/);
    expect(b).toMatch(/# manifest h1:d2\n/);
    expect(a).not.toBe(b);
    // entries without a digest (legacy state) contribute a stable placeholder
    const c = buildScript({ "/r": { hash: "h1", matchPaths: ["/r"] } });
    expect(c).toMatch(/# manifest h1:0\n/);
  });
});
