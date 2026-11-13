import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// klsSupport only touches vscode for configuration reads/writes and messages;
// the file logic runs against a temp AOSP root.
const extraExcludes: string[] = [];
const configStore: Record<string, unknown> = {};
vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string) => configStore[`${section}.${key}`] ?? (section === "aosp-nav" && key === "kotlin.klsExcludes" ? extraExcludes : undefined),
      inspect: (key: string) => ({ workspaceValue: configStore[`${section}.${key}`] }),
      update: async (key: string, value: unknown) => {
        if (value === undefined) delete configStore[`${section}.${key}`];
        else configStore[`${section}.${key}`] = value;
      },
    }),
  },
  window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn() },
  ConfigurationTarget: { Workspace: 2 },
  l10n: { t: (s: string) => s },
}));

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ensureKlsSupport, probeKlsSupport, clearKlsSupport } from "../src/kotlin/klsSupport";

describe("klsSupport", () => {
  let root: string;
  // stands in for the extension globalStorage dir; lives inside root so the
  // afterEach sweep cleans both
  const ctx = { globalStorageUri: { fsPath: "" } } as never;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-kls-"));
    (ctx as { globalStorageUri: { fsPath: string } }).globalStorageUri.fsPath = path.join(root, "global-storage");
    extraExcludes.length = 0;
    for (const k of Object.keys(configStore)) delete configStore[k];
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes exclusions, the gitignore prune block and an executable kls-classpath", async () => {
    const log: string[] = [];
    await ensureKlsSupport(root, ["/a.jar", "/b.jar"], (m) => log.push(m));
    const excl = await fs.readFile(path.join(root, ".kls", "exclusions.txt"), "utf8");
    // static safe set + .kls (it holds no Kotlin sources)
    expect(excl).toBe(
      "# aosp-nav managed -- ktlsp source exclusions\n" +
        ".kls\n.repo\ndevice\nexternal\nkernel\nout\nprebuilts\ntoolchain\nvendor\n"
    );
    const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    // every top-level dir is pruned from the build-file scan, so ktlsp finds
    // no gradle/maven resolver and uses the kls-classpath script instead
    const giLines = gi.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(giLines).toEqual([
      ".repo", "art", "bionic", "bootable", "build", "cts", "dalvik", "developers",
      "development", "device", "external", "frameworks", "hardware", "kernel",
      "libcore", "libnativehelper", "log", "out", "outputs", "packages", "pdk",
      "platform_testing", "prebuilts", "sdk", "system", "test", "toolchain",
      "tools", "trusty", "vendor",
    ]);
    expect(giLines).not.toContain(".kls");
    const cp = await fs.readFile(path.join(root, ".kls", "kls-classpath"), "utf8");
    expect(cp).toMatch(/^#!\/bin\/sh\n# aosp-nav managed -- ktlsp classpath \(manifest [0-9a-f]+\)\ncat '.*\.txt'\n$/);
    expect((await fs.stat(path.join(root, ".kls", "kls-classpath"))).mode & 0o111).toBe(0o111);
    expect(log.join("\n")).toContain("ktlsp exclusions/pruning files ready");
  });

  it("keeps frameworks/packages sources while pruning them from the build-file scan", async () => {
    for (const d of ["frameworks", "packages", "out"]) {
      await fs.mkdir(path.join(root, d), { recursive: true });
    }
    await fs.symlink(path.join(root, "out"), path.join(root, ".repo")); // symlinks count too
    await ensureKlsSupport(root, [], () => {});
    // the source walk must keep real trees: pruning by name is depth-agnostic,
    // so `packages` here would also drop frameworks/base/packages (SystemUI)
    const src = (await fs.readFile(path.join(root, ".kls", "exclusions.txt"), "utf8"))
      .split("\n").filter((l) => l && !l.startsWith("#"));
    expect(src).toEqual([".kls", ".repo", "device", "external", "kernel", "out", "prebuilts", "toolchain", "vendor"]);
    expect(src).not.toContain("frameworks");
    expect(src).not.toContain("packages");
    // the build-file walk prunes them anyway (live dirs + the static AOSP list)
    const gi = (await fs.readFile(path.join(root, ".gitignore"), "utf8"))
      .split("\n").filter((l) => l && !l.startsWith("#"));
    for (const n of ["frameworks", "packages", "out", ".repo"]) expect(gi).toContain(n);
    expect(gi).not.toContain(".kls"); // the script must stay discoverable
  });

  it("appends klsExcludes to the source walk and dedupes", async () => {
    extraExcludes.push("myextra", "myextra");
    await ensureKlsSupport(root, [], () => {});
    const excl = await fs.readFile(path.join(root, ".kls", "exclusions.txt"), "utf8");
    expect(excl.split("\n").filter((l) => l && !l.startsWith("#"))).toEqual([
      ".kls", ".repo", "device", "external", "kernel", "myextra", "out", "prebuilts", "toolchain", "vendor",
    ]);
    // the build-file scan needs no extra entries: it already prunes every dir
    const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gi).not.toContain("myextra");
  });

  it("preserves user .gitignore content and is idempotent", async () => {
    const log: string[] = [];
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules");
    await ensureKlsSupport(root, [], (m) => log.push(m));
    const first = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(first.startsWith("node_modules\n")).toBe(true);
    await ensureKlsSupport(root, [], (m) => log.push(m));
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(first);
    // the re-run rewrote nothing, so it stays quiet (#11)
    expect(log.filter((m) => m.includes("files ready"))).toHaveLength(1);
  });

  it("replaces the managed block without duplicating the marker", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "user\n");
    await ensureKlsSupport(root, [], () => {});
    await ensureKlsSupport(root, [], () => {});
    const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gi.startsWith("user\n")).toBe(true);
    expect(gi.match(/pruning \(begin\)/g)).toHaveLength(1);
    expect(gi.match(/pruning \(end\)/g)).toHaveLength(1);
  });

  it("preserves user content below the managed block on rewrite", async () => {
    const userBlock =
      "user-before\n" +
      "# aosp-nav managed -- ktlsp classpath pruning (begin)\n" +
      "stale\n" +
      "# aosp-nav managed -- ktlsp classpath pruning (end)\n" +
      "user-after\n";
    await fs.writeFile(path.join(root, ".gitignore"), userBlock);
    await ensureKlsSupport(root, [], () => {});
    const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gi.startsWith("user-before\n")).toBe(true);
    expect(gi.endsWith("user-after\n")).toBe(true);
    expect(gi).not.toContain("stale");
    expect(gi.match(/pruning \(begin\)/g)).toHaveLength(1);
    expect(gi.match(/pruning \(end\)/g)).toHaveLength(1);
  });

  it("migrates the pre-dual-marker EOF block and recovers torn writes", async () => {
    // old format: single marker line, block ran to EOF
    await fs.writeFile(
      path.join(root, ".gitignore"),
      "user\n# aosp-nav managed -- ktlsp classpath pruning\nout\nprebuilts\n"
    );
    await ensureKlsSupport(root, [], () => {});
    let gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gi.startsWith("user\n")).toBe(true);
    expect(gi.endsWith("(end)\n")).toBe(true);
    expect(gi.match(/pruning \(begin\)/g)).toHaveLength(1);
    expect(gi.match(/pruning \(end\)/g)).toHaveLength(1);
    // torn write: begin without end is treated as our block, replaced to EOF
    await fs.writeFile(
      path.join(root, ".gitignore"),
      "user2\n# aosp-nav managed -- ktlsp classpath pruning (begin)\ngarbage"
    );
    await ensureKlsSupport(root, [], () => {});
    gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gi.startsWith("user2\n")).toBe(true);
    expect(gi).not.toContain("garbage");
    expect(gi.match(/pruning \(end\)/g)).toHaveLength(1);
  });

  it("warns about klsExcludes names colliding with frameworks/packages segments", async () => {
    const log: string[] = [];
    extraExcludes.push("tools");
    await ensureKlsSupport(root, [], (m) => log.push(m));
    expect(log.join("\n")).toContain("also occur inside frameworks/packages (tools)");
    const excl = await fs.readFile(path.join(root, ".kls", "exclusions.txt"), "utf8");
    expect(excl).toContain("tools");
  });

  it("changes the kls-classpath manifest when the jar list changes", async () => {
    await ensureKlsSupport(root, ["/a.jar"], () => {});
    const a = await fs.readFile(path.join(root, ".kls", "kls-classpath"), "utf8");
    await ensureKlsSupport(root, ["/a.jar", "/b.jar"], () => {});
    const b = await fs.readFile(path.join(root, ".kls", "kls-classpath"), "utf8");
    expect(a).not.toBe(b);
    await ensureKlsSupport(root, ["/a.jar", "/b.jar"], () => {});
    expect(await fs.readFile(path.join(root, ".kls", "kls-classpath"), "utf8")).toBe(b);
  });

  it("self-heals a drifted mode on the kls-classpath script", async () => {
    await ensureKlsSupport(root, ["/a.jar"], () => {});
    await fs.chmod(path.join(root, ".kls", "kls-classpath"), 0o644);
    await ensureKlsSupport(root, ["/a.jar"], () => {});
    expect((await fs.stat(path.join(root, ".kls", "kls-classpath"))).mode & 0o111).toBe(0o111);
  });

  it("probe reports file states and the default fwcd server", async () => {
    const p0 = await probeKlsSupport(root, ctx);
    expect(p0).toEqual({ exclusions: null, gitignore: false, klsClasspath: false, ls: "fwcd default (deprecated)", version: null });
    await ensureKlsSupport(root, ["/a.jar"], () => {});
    const p1 = await probeKlsSupport(root, ctx);
    expect(p1.exclusions).toBe(9);
    expect(p1.gitignore).toBe(true);
    expect(p1.klsClasspath).toBe(true);
    expect(p1.ls).toBe("fwcd default (deprecated)");
  });

  it("probe distinguishes bundled ktlsp from a custom path", async () => {
    const store = path.join(root, "global-storage", "ktlsp");
    await fs.mkdir(path.join(store, "server", "bin"), { recursive: true });
    const bin = path.join(store, "server", "bin", "kotlin-language-server");
    await fs.writeFile(bin, "#!/bin/sh\n");
    await fs.writeFile(path.join(store, "VERSION"), "v1.4.0-rc1\n");
    configStore["kotlin.languageServer.path"] = bin;
    const p = await probeKlsSupport(root, ctx);
    expect(p.ls).toBe("ktlsp (bundled)");
    expect(p.version).toBe("v1.4.0-rc1");
    configStore["kotlin.languageServer.path"] = "/opt/ktlsp/server/bin/kotlin-language-server";
    expect((await probeKlsSupport(root, ctx)).ls).toBe("custom");
  });

  it("rollback removes managed files and settings, keeps foreign ones", async () => {
    await ensureKlsSupport(root, ["/a.jar"], () => {});
    configStore["kotlin.languageServer.path"] = path.join(root, "global-storage", "ktlsp", "server", "bin", "kotlin-language-server");
    configStore["kotlin.java.home"] = "/usr/lib/jvm/java-21";
    await clearKlsSupport(ctx, [root]);
    await expect(fs.access(path.join(root, ".kls", "exclusions.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".kls", "kls-classpath"))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).not.toContain("# aosp-nav managed");
    expect(configStore["kotlin.languageServer.path"]).toBeUndefined();
    expect(configStore["kotlin.java.home"]).toBeUndefined();
  });

  it("rollback cuts only the managed interval and keeps lines after the block", async () => {
    await ensureKlsSupport(root, ["/a.jar"], () => {});
    await fs.appendFile(path.join(root, ".gitignore"), "user-after\n");
    await clearKlsSupport(ctx, [root]);
    const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    expect(gi).toBe("user-after\n");
  });

  it("rollback never touches a foreign exclusions file or user LS path", async () => {
    await fs.mkdir(path.join(root, ".kls"), { recursive: true });
    await fs.writeFile(path.join(root, ".kls", "exclusions.txt"), "my-own-glob\n");
    await fs.writeFile(path.join(root, ".kls", "kls-classpath"), "#!/bin/sh\necho mine\n");
    configStore["kotlin.languageServer.path"] = "/opt/other/server/bin/kotlin-language-server";
    configStore["kotlin.java.home"] = "/usr/lib/jvm/java-17";
    await clearKlsSupport(ctx, [root]);
    expect(await fs.readFile(path.join(root, ".kls", "exclusions.txt"), "utf8")).toBe("my-own-glob\n");
    expect(await fs.readFile(path.join(root, ".kls", "kls-classpath"), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(configStore["kotlin.languageServer.path"]).toBe("/opt/other/server/bin/kotlin-language-server");
    expect(configStore["kotlin.java.home"]).toBe("/usr/lib/jvm/java-17");
  });
});
