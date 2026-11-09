import * as fs from "fs/promises";
import { accessSync, constants, createReadStream, statSync } from "fs";
import * as readline from "readline";
import * as path from "path";
import { parseBlueprint, nearestBp } from "./bp";

/** `out/soong/module_bp_cc_deps.json` collector (origin=cc_deps).
 *
 *  soong writes this file with `json.MarshalIndent(..., "", "\t")` on every
 *  normal build (independent of `SOONG_GEN_COMPDB`). Because strings cannot
 *  contain raw newlines in that encoding, a module section can be extracted
 *  line-by-line instead of parsing the whole 160 MB+ document. The real tree
 *  has 14,443 modules / 146,773 srcs; a whole-file `JSON.parse` measured 419 ms,
 *  which is affordable but pointless when we only need one module.
 *
 *  Module shape (`ccIdeInfo`): `path[]`, `srcs[]`, nine `ccParameters`
 *  groups, `module_name`. Each `ccParameters` has `header_search_path[]`
 *  (bare, soong already stripped `-I`), `system_search_path[]` (bare),
 *  `flag[]` (verbatim) and `system_root` (bare). */

export interface CcParameters {
  header_search_path?: string[];
  system_search_path?: string[];
  flag?: string[];
  system_root?: string;
}

export interface CcModuleInfo {
  path?: string[];
  srcs?: string[];
  global_common_flags?: CcParameters;
  local_common_flags?: CcParameters;
  global_c_flags?: CcParameters;
  local_c_flags?: CcParameters;
  global_c_only_flags?: CcParameters;
  local_c_only_flags?: CcParameters;
  global_cpp_flags?: CcParameters;
  local_cpp_flags?: CcParameters;
  system_include_flags?: CcParameters;
}

export interface Compilers {
  clang?: string;
  "clang++"?: string;
}

export interface CcDepsLookupResult {
  origin: "cc_deps";
  module: string;
  args: string[];
  compiler: string;
  target: string | null;
}

export interface CcDepsLookupOptions {
  isDir?: (p: string) => boolean;
  isExecutable?: (p: string) => boolean;
}

/** Incremental line-level section scanner.
 *
 *  A section starts at `\t\t"<name>": {` and ends at the first `},` / `}`
 *  whose indentation is not deeper than the module line. Nested braces are
 *  therefore harmless. Multiple candidate modules are collected in one pass,
 *  so a lookup costs one file scan no matter how many candidates the nearest
 *  Android.bp declares. */
export function createSegmentScanner(names: Iterable<string>): {
  feed: (line: string) => void;
  finish: () => Map<string, string>;
} {
  const wanted = new Set(names);
  const out = new Map<string, string>();
  let current: { name: string; indent: number; buf: string[] } | null = null;
  const startRe = /^(\s*)("(?:\\.|[^"\\])*")\s*:\s*\{\s*$/;
  const endRe = /^\s*\},?\s*$/;

  return {
    feed(line: string): void {
      if (current) {
        const lead = /^[ \t]*/.exec(line)![0];
        if (lead.length <= current.indent && endRe.test(line)) {
          current.buf.push(line);
          out.set(current.name, current.buf.join("\n"));
          current = null;
          return;
        }
        current.buf.push(line);
        return;
      }
      const m = startRe.exec(line);
      if (!m) return;
      let name: string;
      try {
        name = JSON.parse(m[2]) as string;
      } catch {
        return;
      }
      if (!wanted.has(name)) return;
      current = { name, indent: m[1].length, buf: [line] };
    },
    finish(): Map<string, string> {
      // A section without its closing line means the file was truncated or
      // soong changed the encoding: drop it rather than hand clangd bad JSON.
      return out;
    },
  };
}

/** Test seam: extract sections from an in-memory document. */
export function extractSegments(text: string, names: Iterable<string>): Map<string, string> {
  const scanner = createSegmentScanner(names);
  for (const line of text.split("\n")) scanner.feed(line);
  return scanner.finish();
}

/** Extract candidate module sections with a streaming read (memory stays O(section)). */
export async function extractSegmentsFromFile(
  jsonPath: string,
  names: Iterable<string>
): Promise<Map<string, string>> {
  const scanner = createSegmentScanner(names);
  const rl = readline.createInterface({ input: createReadStream(jsonPath), crlfDelay: Infinity });
  for await (const line of rl) scanner.feed(line);
  return scanner.finish();
}

/** Parse `"<name>": { ... },` into the inner `ccIdeInfo`. */
export function parseModuleSegment(segment: string, name: string): CcModuleInfo | null {
  try {
    const wrapped = JSON.parse(`{${segment.replace(/,\s*$/, "")}}`) as Record<string, CcModuleInfo>;
    const info = wrapped[name];
    return info && typeof info === "object" ? info : null;
  } catch {
    return null;
  }
}

/** Top-level compilers live in the first few lines, before `"modules"`. */
export function parseTopCompilers(headLines: string[]): Compilers {
  const out: Compilers = {};
  for (const line of headLines) {
    if (line.includes('"modules"')) break;
    const m = /^\s*"(clang(?:\+\+)?)"\s*:\s*"([^"]*)"/.exec(line);
    if (m) out[m[1] as keyof Compilers] = m[2];
  }
  return out;
}

export async function readTopCompilers(jsonPath: string): Promise<Compilers> {
  const lines: string[] = [];
  const rl = readline.createInterface({ input: createReadStream(jsonPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.includes('"modules"')) break;
    lines.push(line);
    if (lines.length >= 8) break;
  }
  rl.close();
  return parseTopCompilers(lines);
}

/** cc_deps carries no arch field, but soong's best variant puts the bionic
 *  `uapi/asm-<arch>` directory into `system_search_path` — that is the device
 *  arch. Without `--target` clangd resolves as host x86_64 and `-march=armv8-a`
 *  fails immediately (measured on a real tree). */
const TARGET_BY_ARCH: Record<string, string> = {
  "asm-arm64": "aarch64-linux-android",
  "asm-arm64v8a": "aarch64-linux-android",
  "asm-arm": "arm-linux-androideabi",
  "asm-armv7": "arm-linux-androideabi",
  "asm-armv7-a-neon": "arm-linux-androideabi",
  "asm-x86": "i686-linux-android",
  "asm-x86_64": "x86_64-linux-android",
  "asm-riscv64": "riscv64-linux-android",
};

export function deriveTarget(groups: Array<CcParameters | undefined>): string | null {
  for (const g of groups) {
    for (const p of g?.system_search_path ?? []) {
      const arch = /uapi\/(asm-[A-Za-z0-9_-]+)/.exec(p)?.[1];
      if (arch && TARGET_BY_ARCH[arch]) return TARGET_BY_ARCH[arch];
    }
  }
  return null;
}

function resolvePath(
  p: string,
  root: string,
  modDir: string | null,
  isDir: (p: string) => boolean
): string {
  if (path.isAbsolute(p)) return p;
  const rootRel = path.join(root, p);
  if (isDir(rootRel)) return rootRel;
  if (modDir) {
    const modRel = path.join(modDir, p);
    if (isDir(modRel)) return modRel;
  }
  return rootRel;
}

/** Inverse of soong's `parseCompilerCCParameters`: bare header dirs become
 *  `-I`, system dirs become `-isystem`, flags are copied verbatim, and the
 *  sysroot is re-attached. */
export function paramsToFlags(
  params: CcParameters | undefined,
  root: string,
  modDir: string | null,
  isDir: (p: string) => boolean
): string[] {
  const out: string[] = [];
  for (const p of params?.header_search_path ?? []) {
    out.push("-I" + resolvePath(p, root, modDir, isDir));
  }
  for (const p of params?.system_search_path ?? []) {
    out.push("-isystem", resolvePath(p, root, modDir, isDir));
  }
  for (const f of params?.flag ?? []) out.push(f);
  const sysroot = params?.system_root;
  if (sysroot) out.push("--sysroot=" + resolvePath(sysroot, root, modDir, isDir));
  return out;
}

/** Drop include/sysroot values whose directory does not exist (partial
 *  checkouts). clang silently skips missing search dirs anyway, so this only
 *  changes readability — it cannot fix a genuinely missing header. */
export function pruneMissingDirs(args: string[], isDir: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-I") && a.length > 2) {
      if (!isDir(a.slice(2))) continue;
    } else if (a === "-isystem") {
      const v = args[i + 1];
      if (!v) continue;
      if (!isDir(v)) {
        i++; // drop the value with its flag
        continue;
      }
    } else if (a.startsWith("--sysroot=") && !isDir(a.slice("--sysroot=".length))) {
      continue;
    }
    out.push(a);
  }
  return out;
}

export function isCFile(file: string): boolean {
  return path.extname(file).toLowerCase() === ".c";
}

/** Build the argument list (without compiler / file) for one module. */
export function buildArgs(
  info: CcModuleInfo,
  root: string,
  modDir: string | null,
  isC: boolean,
  isDir: (p: string) => boolean
): { args: string[]; target: string | null } {
  const groups = isC
    ? [
        info.global_common_flags,
        info.local_common_flags,
        info.global_c_flags,
        info.local_c_flags,
        info.global_c_only_flags,
        info.local_c_only_flags,
        info.system_include_flags,
      ]
    : [
        info.global_common_flags,
        info.local_common_flags,
        info.global_cpp_flags,
        info.local_cpp_flags,
        info.system_include_flags,
      ];
  let args: string[] = [];
  for (const g of groups) args = args.concat(paramsToFlags(g, root, modDir, isDir));
  args = pruneMissingDirs(args, isDir);
  const target = deriveTarget(groups);
  // clangd reads the target triple right after the compiler; `--target` must be
  // first or the host triple wins.
  if (target) args = ["--target=" + target, ...args];
  return { args, target };
}

export function compilerFor(
  top: Compilers,
  isC: boolean,
  root: string,
  isExecutable: (p: string) => boolean
): string {
  const key: "clang" | "clang++" = isC ? "clang" : "clang++";
  const raw = top[key];
  if (raw) {
    const expanded = raw.split("${ANDROID_ROOT}").join(root);
    if (isExecutable(expanded)) return expanded;
  }
  return key;
}

function matchesSrc(info: CcModuleInfo, file: string, root: string, bpDir: string): boolean {
  const abs = path.resolve(file);
  const rel = abs.startsWith(path.resolve(root) + path.sep)
    ? path.relative(path.resolve(root), abs)
    : null;
  const base = path.basename(abs);
  for (const s of info.srcs ?? []) {
    if (s === rel || s === base || path.join(bpDir, s) === abs) return true;
  }
  return false;
}

/** Look up the compile flags of `file` through its nearest Android.bp module
 *  list. Candidates come from the nearest bp (never from a whole-tree scan);
 *  sections are extracted in one streaming pass. */
export async function lookupCcDeps(
  root: string,
  file: string,
  depsPath: string,
  opts: CcDepsLookupOptions = {}
): Promise<CcDepsLookupResult | null> {
  const isDir = opts.isDir ?? ((p: string) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  });
  const isExecutable = opts.isExecutable ?? ((p: string) => {
    try { accessSync(p, constants.X_OK); return true; } catch { return false; }
  });

  const bp = await nearestBp(file, root);
  if (!bp) return null;
  const bpDir = path.dirname(bp);
  const mods = parseBlueprint(await fs.readFile(bp, "utf8"));
  const names: string[] = [];
  for (const m of mods) if (m.name && !names.includes(m.name)) names.push(m.name);
  if (names.length === 0) return null;

  const segments = await extractSegmentsFromFile(depsPath, names);
  const top = await readTopCompilers(depsPath);
  for (const name of names) {
    const seg = segments.get(name);
    if (!seg) continue;
    const info = parseModuleSegment(seg, name);
    if (!info || !matchesSrc(info, file, root, bpDir)) continue;
    const modDir = info.path?.[0] ? path.join(root, info.path[0]) : bpDir;
    const isC = isCFile(file);
    const built = buildArgs(info, root, modDir, isC, isDir);
    return {
      origin: "cc_deps",
      module: name,
      args: built.args,
      compiler: compilerFor(top, isC, root, isExecutable),
      target: built.target,
    };
  }
  return null;
}
