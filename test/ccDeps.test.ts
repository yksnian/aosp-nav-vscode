import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  buildArgs,
  compilerFor,
  createSegmentScanner,
  deriveTarget,
  extractSegments,
  lookupCcDeps,
  parseModuleSegment,
  parseTopCompilers,
  pruneMissingDirs,
} from "../src/clangd/ccDeps";

const DOC = `{
\t"clang": "\${ANDROID_ROOT}/prebuilts/clang/host/linux-x86/clang-r584948b/bin/clang",
\t"clang++": "\${ANDROID_ROOT}/prebuilts/clang/host/linux-x86/clang-r584948b/bin/clang++",
\t"modules": {
\t\t"libnetd_server": {
\t\t\t"path": [
\t\t\t\t"system/netd/server"
\t\t\t],
\t\t\t"srcs": [
\t\t\t\t"BandwidthController.cpp",
\t\t\t\t"NetdClient.cpp"
\t\t\t],
\t\t\t"module_name": "libnetd_server",
\t\t\t"global_common_flags": {
\t\t\t\t"header_search_path": [
\t\t\t\t\t"system/libbase/include"
\t\t\t\t],
\t\t\t\t"system_search_path": [
\t\t\t\t\t"bionic/libc/kernel/uapi/asm-arm64"
\t\t\t\t],
\t\t\t\t"flag": [
\t\t\t\t\t"-march=armv8-a"
\t\t\t\t],
\t\t\t\t"system_root": "out/soong/ndk/sysroot"
\t\t\t},
\t\t\t"global_cpp_flags": {
\t\t\t\t"header_search_path": [
\t\t\t\t\t"system/libbase/include",
\t\t\t\t\t"dead/include"
\t\t\t\t],
\t\t\t\t"flag": [
\t\t\t\t\t"-DNETD=1"
\t\t\t\t]
\t\t\t},
\t\t\t"system_include_flags": {
\t\t\t\t"system_search_path": [
\t\t\t\t\t"bionic/libc/include"
\t\t\t\t]
\t\t\t},
\t\t\t"relative_file_path": {
\t\t\t\t"foo": "bar"
\t\t\t}
\t\t},
\t\t"libnetd_server_defaults": {
\t\t\t"srcs": [
\t\t\t\t"BandwidthController.cpp"
\t\t\t]
\t\t},
\t\t"other": {
\t\t\t"srcs": []
\t\t}
\t}
}
`;

describe("segment scanner", () => {
  it("extracts exactly the named module, including nested objects", () => {
    const segs = extractSegments(DOC, ["libnetd_server"]);
    expect(segs.size).toBe(1);
    const info = parseModuleSegment(segs.get("libnetd_server")!, "libnetd_server");
    expect(info?.srcs).toEqual(["BandwidthController.cpp", "NetdClient.cpp"]);
    expect(info?.path).toEqual(["system/netd/server"]);
    expect(info?.global_common_flags?.header_search_path).toEqual(["system/libbase/include"]);
  });

  it("does not match a module name by prefix", () => {
    const segs = extractSegments(DOC, ["libnetd_server"]);
    expect(segs.has("libnetd_server_defaults")).toBe(false);
  });

  it("collects several candidates in one pass", () => {
    const segs = extractSegments(DOC, ["libnetd_server", "other"]);
    expect([...segs.keys()]).toEqual(["libnetd_server", "other"]);
  });

  it("returns nothing for a compact (non-indented) document", () => {
    const segs = extractSegments('{"modules":{"m":{"srcs":["a.cpp"]}}}', ["m"]);
    expect(segs.size).toBe(0);
  });

  it("drops a truncated section instead of returning invalid JSON", () => {
    const scanner = createSegmentScanner(["m"]);
    scanner.feed('\t\t"m": {');
    scanner.feed('\t\t\t"srcs": [');
    const out = scanner.finish();
    expect(out.size).toBe(0);
  });
});

describe("top compilers", () => {
  it("reads clang and clang++ before modules", () => {
    const top = parseTopCompilers(DOC.split("\n").slice(0, 4));
    expect(top.clang).toContain("${ANDROID_ROOT}/prebuilts/clang");
    expect(top["clang++"]).toContain("clang++");
  });

  it("expands ANDROID_ROOT and accepts an executable", () => {
    const top = { "clang++": "${ANDROID_ROOT}/prebuilts/clang/bin/clang++" };
    const got = compilerFor(top, false, "/aosp", (p) => p === "/aosp/prebuilts/clang/bin/clang++");
    expect(got).toBe("/aosp/prebuilts/clang/bin/clang++");
  });

  it("falls back to a bare name when the binary is missing", () => {
    expect(compilerFor({ clang: "/gone/clang" }, true, "/aosp", () => false)).toBe("clang");
  });
});

describe("target derivation", () => {
  it("maps bionic uapi asm dirs to android triples", () => {
    expect(deriveTarget([{ system_search_path: ["bionic/libc/kernel/uapi/asm-arm64"] }]))
      .toBe("aarch64-linux-android");
    expect(deriveTarget([{ system_search_path: ["x/uapi/asm-x86_64"] }]))
      .toBe("x86_64-linux-android");
  });

  it("returns null when no arch directory is present", () => {
    expect(deriveTarget([{ system_search_path: ["bionic/libc/include"] }])).toBeNull();
  });
});

describe("lookupCcDeps end-to-end", () => {
  it("streams the section, matches srcs, and expands the compiler", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aosp-nav-ccdeps-"));
    try {
      const srcDir = path.join(root, "system/netd/server");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(
        path.join(srcDir, "Android.bp"),
        'cc_library_shared { name: "libnetd_server", srcs: ["BandwidthController.cpp"] }'
      );
      const file = path.join(srcDir, "BandwidthController.cpp");
      await fs.writeFile(file, "int main(){}");
      const deps = path.join(root, "deps.json");
      await fs.writeFile(deps, DOC);

      const live = new Set([
        path.join(root, "system/libbase/include"),
        path.join(root, "bionic/libc/include"),
        path.join(root, "bionic/libc/kernel/uapi/asm-arm64"),
        path.join(root, "out/soong/ndk/sysroot"),
      ]);
      const r = await lookupCcDeps(root, file, deps, {
        isDir: (p) => live.has(p),
        isExecutable: () => true,
      });
      expect(r?.module).toBe("libnetd_server");
      expect(r?.target).toBe("aarch64-linux-android");
      expect(r?.compiler).toBe(root + "/prebuilts/clang/host/linux-x86/clang-r584948b/bin/clang++");
      expect(r?.args[0]).toBe("--target=aarch64-linux-android");
      expect(r?.args).toContain("-I" + path.join(root, "system/libbase/include"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("flag assembly", () => {
  const dirs = new Set([
    "/aosp/system/libbase/include",
    "/aosp/bionic/libc/include",
    "/aosp/bionic/libc/kernel/uapi/asm-arm64",
    "/aosp/out/soong/ndk/sysroot",
  ]);
  const isDir = (p: string): boolean => dirs.has(p);

  it("prunes dead include and sysroot paths, keeping the -isystem pair intact", () => {
    const args = [
      "-I/aosp/live",
      "-I/aosp/dead",
      "-isystem", "/aosp/dead",
      "-isystem", "/aosp/live/isystem",
      "--sysroot=/aosp/dead",
      "--sysroot=/aosp/live/sysroot",
      "-DFOO",
    ];
    const live = new Set(["/aosp/live", "/aosp/live/isystem", "/aosp/live/sysroot"]);
    expect(pruneMissingDirs(args, (p) => live.has(p))).toEqual([
      "-I/aosp/live",
      "-isystem", "/aosp/live/isystem",
      "--sysroot=/aosp/live/sysroot",
      "-DFOO",
    ]);
  });

  it("puts --target first and resolves header/system/sysroot paths", () => {
    const segs = extractSegments(DOC, ["libnetd_server"]);
    const info = parseModuleSegment(segs.get("libnetd_server")!, "libnetd_server")!;
    const { args, target } = buildArgs(info, "/aosp", "/aosp/system/netd/server", false, isDir);

    expect(target).toBe("aarch64-linux-android");
    expect(args[0]).toBe("--target=aarch64-linux-android");
    expect(args).toContain("-I/aosp/system/libbase/include");
    expect(args).toContain("-isystem");
    expect(args).toContain("/aosp/bionic/libc/include");
    expect(args).toContain("/aosp/bionic/libc/kernel/uapi/asm-arm64");
    expect(args).toContain("--sysroot=/aosp/out/soong/ndk/sysroot");
    expect(args).toContain("-march=armv8-a");
    expect(args).toContain("-DNETD=1");
    expect(args).not.toContain("dead/include");
    expect(args).not.toContain("-I/aosp/dead/include");
  });
});
