import * as fs from "fs/promises";
import { statSync } from "fs";
import * as path from "path";

/** Android.bp fallback collector.
 *
 *  This is the last tier of the C/C++ chain, used only when neither the soong
 *  compdb nor `module_bp_cc_deps.json` exists. It is a heuristic subset of
 *  Blueprint semantics: comments are stripped, `cc_*` module blocks are
 *  balanced, and only depth-1 string-list fields are read. It is NOT a soong
 *  reimplementation.
 *
 *  Limitation vs the nvim plugin: nvim resolves `header_libs` across the whole
 *  tree (it builds a full Android.bp index + grep). Here we only resolve names
 *  defined in the same Android.bp plus a curated include baseline, so a module
 *  whose `cc_defaults`/`header_libs` live in a parent directory is not fully
 *  reconstructed. That is why this tier is documented as best-effort only. */

export interface BpModule {
  type: string;
  name: string | null;
  fields: Record<string, string[]>;
}

const FIELD_SET = new Set([
  "name",
  "srcs",
  "local_include_dirs",
  "export_include_dirs",
  "include_dirs",
  "cflags",
  "cppflags",
  "conlyflags",
  "header_libs",
  "whole_static_libs",
  "static_libs",
  "shared_libs",
]);

/** Remove line and block comments while respecting string literals. */
export function stripComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const c2 = text.slice(i, i + 2);
    if (inString) {
      if (c === '"') inString = false;
      out.push(c);
      i++;
    } else if (c2 === "//") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c2 === "/*") {
      i += 2;
      while (i < text.length && text.slice(i, i + 2) !== "*/") i++;
      i += 2;
    } else {
      if (c === '"') inString = true;
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /[ \t\r\n]/.test(text[i])) i++;
  return i;
}

function matchBalanced(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  let p = start + 1;
  while (p < text.length && depth > 0) {
    const c = text[p];
    if (c === open) depth++;
    else if (c === close) depth--;
    p++;
  }
  return p;
}

/** Parse the `cc_*` module blocks of an Android.bp file. */
export function parseBlueprint(text: string): BpModule[] {
  const src = stripComments(text);
  const mods: BpModule[] = [];
  let j = 0;
  while (j < src.length) {
    j = skipWs(src, j);
    const typMatch = /^[A-Za-z0-9_]+/.exec(src.slice(j));
    const typ = typMatch?.[0];
    if (typ && /^cc[\w]*$/.test(typ)) {
      const k = skipWs(src, j + typ.length);
      if (src[k] === "{") {
        const end = matchBalanced(src, k, "{", "}");
        const body = src.slice(k + 1, end - 1);
        const mod: BpModule = { type: typ, name: null, fields: {} };
        let b = 0;
        while (b < body.length) {
          b = skipWs(body, b);
          const m = /^([A-Za-z0-9_]+)\s*:\s*/.exec(body.slice(b));
          if (!m) {
            b++;
            continue;
          }
          const key = m[1];
          b += m[0].length;
          const ch = body[b];
          if (ch === "{" || ch === "[") {
            const open = ch;
            const close = ch === "{" ? "}" : "]";
            const p = matchBalanced(body, b, open, close);
            const inner = body.slice(b + 1, p - 1);
            if (open === "[" && FIELD_SET.has(key)) {
              mod.fields[key] = [];
              for (const v of inner.matchAll(/"([^"]*)"/g)) mod.fields[key].push(v[1]);
            }
            b = p;
          } else if (ch === '"') {
            const v = /^"([^"]*)"/.exec(body.slice(b));
            if (key === "name" && v) mod.name = v[1];
            b += v ? v[0].length : 1;
          } else {
            b++;
          }
        }
        mods.push(mod);
        j = end;
      } else {
        j += typ.length;
      }
    } else {
      j += typ ? typ.length : 1;
    }
  }
  return mods;
}

/** Walk up from the source file to the nearest Android.bp, never past root. */
export async function nearestBp(file: string, root: string): Promise<string | null> {
  const stop = path.resolve(root);
  let dir = path.dirname(path.resolve(file));
  while (true) {
    const cand = path.join(dir, "Android.bp");
    try {
      const st = await fs.stat(cand);
      if (st.isFile()) return cand;
    } catch { /* keep walking */ }
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Pick the module that lists `file` in `srcs`; otherwise the first module
 *  that looks compilable (has srcs or include dirs). */
export function pickModule(
  mods: BpModule[],
  file: string,
  root: string,
  bpDir: string
): BpModule | null {
  const abs = path.resolve(file);
  const rel = abs.startsWith(path.resolve(root) + path.sep)
    ? path.relative(path.resolve(root), abs)
    : null;
  const base = path.basename(abs);
  let first: BpModule | null = null;
  for (const m of mods) {
    const f = m.fields;
    if (!first && (f.srcs || f.export_include_dirs || f.local_include_dirs)) first = m;
    for (const s of f.srcs ?? []) {
      if (s === rel || s === base || path.join(bpDir, s) === abs) return m;
    }
  }
  return first;
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

/** Resolve `header_libs` names defined in the same Android.bp, up to `depth`. */
function resolveHeaderLibs(
  mods: BpModule[],
  rootNames: string[],
  bpDir: string,
  depth: number,
  isDir: (p: string) => boolean
): string[] {
  const byName = new Map<string, BpModule>();
  for (const m of mods) if (m.name && !byName.has(m.name)) byName.set(m.name, m);
  const out: string[] = [];
  const seen = new Set<string>();
  let queue = rootNames.map((name) => ({ name, d: 0 }));
  while (queue.length > 0) {
    const { name, d } = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const m = byName.get(name);
    if (!m) continue;
    for (const dir of m.fields.export_include_dirs ?? []) {
      const abs = resolvePath(dir, bpDir, bpDir, isDir);
      if (isDir(abs)) out.push(abs);
    }
    if (d < depth) {
      for (const h of m.fields.header_libs ?? []) queue.push({ name: h, d: d + 1 });
    }
  }
  return out;
}

export interface BpLookupResult {
  origin: "bp";
  module: string | null;
  args: string[];
}

export interface BpLookupOptions {
  /** Curated include dirs relative to the AOSP root (fallback baseline). */
  curatedIncludes: string[];
  headerLibDepth: number;
  isDir?: (p: string) => boolean;
}

export async function lookupBp(
  root: string,
  file: string,
  opts: BpLookupOptions
): Promise<BpLookupResult | null> {
  const isDir = opts.isDir ?? ((p: string) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  });
  const bp = await nearestBp(file, root);
  const args: string[] = [];
  let moduleName: string | null = null;

  if (bp) {
    const bpDir = path.dirname(bp);
    const mods = parseBlueprint(await fs.readFile(bp, "utf8"));
    const m = pickModule(mods, file, root, bpDir);
    if (m) {
      moduleName = m.name;
      for (const d of m.fields.local_include_dirs ?? [])
        args.push("-I" + resolvePath(d, root, bpDir, isDir));
      for (const d of m.fields.export_include_dirs ?? [])
        args.push("-I" + resolvePath(d, root, bpDir, isDir));
      for (const d of m.fields.include_dirs ?? [])
        args.push("-I" + resolvePath(d, root, bpDir, isDir));
      for (const k of ["cflags", "cppflags", "conlyflags"]) {
        for (const f of m.fields[k] ?? []) if (f.startsWith("-")) args.push(f);
      }
      for (const d of resolveHeaderLibs(
        mods,
        m.fields.header_libs ?? [],
        bpDir,
        opts.headerLibDepth,
        isDir
      )) {
        args.push("-I" + d);
      }
    }
  }

  for (const d of opts.curatedIncludes) {
    const abs = path.isAbsolute(d) ? d : path.join(root, d);
    if (isDir(abs)) args.push("-I" + abs);
  }

  if (args.length === 0) return null;
  return { origin: "bp", module: moduleName, args };
}
