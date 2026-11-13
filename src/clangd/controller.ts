import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { djb2 } from "../infra/hash";
import { getConfig } from "../config";
import { detectAospRoot } from "../androidRoot";
import { Debouncer } from "../infra/debounce";
import { lookupBp, nearestBp } from "./bp";
import { lookupCcDeps, isCFile } from "./ccDeps";
import { buildEntry, ensureCdbFile, ensureEntry, readCdb } from "./cdb";
import {
  planClangdArguments,
  removeOwnArguments,
} from "./clangdArgs";

/** C/C++ support for VS Code.
 *
 *  Origin chain (same spirit as the nvim plugin):
 *    compdb   `out/soong/development/ide/compdb/compile_commands.json` exists
 *             → point clangd at that directory (native, zero entries written).
 *    cc_deps  `out/soong/module_bp_cc_deps.json` exists → extract the module
 *             section for each opened file and upsert one CDB entry.
 *    bp       neither exists → nearest Android.bp + curated include baseline.
 *
 *  Timing / restart policy (measured on a real AOSP tree):
 *  - The managed CDB lives in extension globalStorage, never at the tree root.
 *  - Entries are written incrementally, only for files the user opens. The
 *    146,773 srcs from cc_deps are never pre-written: clangd startup would pay
 *    for a database almost entirely unused.
 *  - clangd reloads its compilation database after a document change, so a new
 *    entry needs no restart. `clangd.arguments` is read only at process start,
 *    so a change to `--compile-commands-dir` needs exactly one restart.
 *  - Therefore `clangd.restart` is debounced and fires only when the effective
 *    argument list really changed. Reopening files or re-writing an identical
 *    entry does not restart the server.
 *
 *  Platform note (documented in README): VS Code has no lspconfig-style hook
 *  to mutate clangd options before launch, so the first C/C++ file of a session
 *  may briefly start with the previous args; the debounced restart fixes it.
 *
 *  Known limitation: cc_deps carries no generated-header directories
 *  (`out/soong/.intermediates` AIDL/protobuf outputs). Files that include
 *  `android/net/INetd.h` style generated headers keep those errors until the
 *  official compdb is generated (`make SOONG_GEN_COMPDB=1 nothing`). We do not
 *  fabricate include paths to hide this. */

type Origin = "compdb" | "cc_deps" | "bp" | "none";

/** The marketplace id is `llvm-vs-code-extensions.vscode-clangd`; keep a single
 *  constant so diagnostics and activation agree. */
const CLANGD_EXTENSION = "llvm-vs-code-extensions.vscode-clangd";
const OWN_ARGS_KEY = "aosp-nav.ownClangdArgs";

const CPP_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx"]);

function isCppFile(file: string): boolean {
  return CPP_EXTS.has(path.extname(file).toLowerCase());
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

interface RootState {
  origin: Origin;
  cdbDir: string | null;
  module: string | null;
  entries: number;
  logged: boolean;
  suggested: boolean;
  /** Per-file flag lookup cache, keyed by file path. Validated against the
   *  mtime of out/soong/module_bp_cc_deps.json so a rebuild invalidates it;
   *  only used on the cc_deps path (the bp fallback stays uncached — it is
   *  rare and its inputs have no single stamp file). */
  fileInfoCache: Map<string, { stamp: number; info: FileInfo | null }>;
}

const states = new Map<string, RootState>();
const chains = new Map<string, Promise<void>>();
let activeRestart: Debouncer | null = null;
let missingClangdNotified = false;

function managedCdbDir(ctx: vscode.ExtensionContext, root: string): string {
  return path.join(ctx.globalStorageUri.fsPath, `cpp-${djb2(root)}`);
}

function ownClangdArgs(ctx: vscode.ExtensionContext): string[] {
  return ctx.workspaceState.get<string[]>(OWN_ARGS_KEY) ?? [];
}

/** Newest AOSP prebuilt clangd under `prebuilts/clang/host/linux-x86/clang-r.../bin`. */
export async function findAospClangd(root: string): Promise<string | null> {
  const base = path.join(root, "prebuilts/clang/host/linux-x86");
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => {
      const ra = Number(/clang-r(\d+)/.exec(a)?.[1] ?? 0);
      const rb = Number(/clang-r(\d+)/.exec(b)?.[1] ?? 0);
      return rb - ra;
    });
  for (const name of dirs) {
    const cand = path.join(base, name, "bin", "clangd");
    if (await isFile(cand)) return cand;
  }
  return null;
}

/** Compiler for the Android.bp fallback tier: prefer the tree's prebuilts,
 *  otherwise a bare name clangd may still resolve from PATH. */
async function resolveFallbackCompiler(root: string, isC: boolean): Promise<string> {
  const clangd = await findAospClangd(root);
  if (clangd) {
    const bin = path.join(path.dirname(clangd), isC ? "clang" : "clang++");
    if (await isFile(bin)) return bin;
  }
  return isC ? "clang" : "clang++";
}

async function detectOrigin(
  ctx: vscode.ExtensionContext,
  root: string,
  file: string
): Promise<{ origin: Origin; cdbDir: string | null }> {
  const compdb = path.join(root, "out/soong/development/ide/compdb/compile_commands.json");
  if (await isFile(compdb)) {
    return { origin: "compdb", cdbDir: path.dirname(compdb) };
  }
  if (await isFile(path.join(root, "out/soong/module_bp_cc_deps.json"))) {
    return { origin: "cc_deps", cdbDir: managedCdbDir(ctx, root) };
  }
  if (await nearestBp(file, root)) {
    return { origin: "bp", cdbDir: managedCdbDir(ctx, root) };
  }
  return { origin: "none", cdbDir: null };
}

interface FileInfo {
  origin: "cc_deps" | "bp";
  module: string | null;
  args: string[];
  compiler: string;
}

/** Flags for one file: cc_deps first, Android.bp only if that misses. */
async function lookupFileInfo(root: string, file: string): Promise<FileInfo | null> {
  const cfg = getConfig();
  const deps = path.join(root, "out/soong/module_bp_cc_deps.json");
  if (await isFile(deps)) {
    const info = await lookupCcDeps(root, file, deps);
    if (info) {
      return {
        origin: "cc_deps",
        module: info.module,
        args: info.args,
        compiler: info.compiler,
      };
    }
  }
  const bp = await lookupBp(root, file, {
    curatedIncludes: cfg.cpp.curatedIncludes,
    headerLibDepth: cfg.cpp.headerLibDepth,
  });
  if (!bp) return null;
  return {
    origin: "bp",
    module: bp.module,
    args: bp.args,
    compiler: await resolveFallbackCompiler(root, isCFile(file)),
  };
}

function logLine(log: (m: string) => void, msg: string): void {
  log(`[aosp-nav] cpp: ${msg}`);
}

async function suggestClangdPath(
  ctx: vscode.ExtensionContext,
  root: string,
  state: RootState,
  log: (m: string) => void
): Promise<void> {
  const cfg = getConfig();
  if (!cfg.cpp.suggestClangdPath || state.suggested) return;
  state.suggested = true;
  // get() would always be truthy (extension default "clangd"); only a
  // user-authored value in some scope counts as "already configured".
  if (clangdPathSetting()) return;
  const candidate = await findAospClangd(root);
  if (!candidate) return;
  const button = vscode.l10n.t("Set clangd.path");
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "[aosp-nav] The clangd extension does not bundle a binary. Use the AOSP prebuilt clangd at {0}?",
      candidate
    ),
    button,
    vscode.l10n.t("Later")
  );
  if (pick !== button) return;
  const jc = vscode.workspace.getConfiguration("clangd");
  await jc.update("path", candidate, vscode.ConfigurationTarget.Global);
  logLine(log, `clangd.path set to ${candidate}`);
  const ext = vscode.extensions.getExtension(CLANGD_EXTENSION);
  if (ext?.isActive) {
    try {
      await vscode.commands.executeCommand("clangd.restart");
    } catch (e) {
      logLine(log, `clangd.restart failed: ${e}`);
    }
  }
}

/** Write `clangd.arguments` only when the effective list changed. Returns
 *  whether a restart was scheduled. */
async function applyClangdArguments(
  ctx: vscode.ExtensionContext,
  cdbDir: string | null,
  log: (m: string) => void
): Promise<boolean> {
  if (!cdbDir) return false;
  const jc = vscode.workspace.getConfiguration("clangd");
  const insp = jc.inspect<string[]>("arguments");
  const current = insp?.workspaceValue ?? insp?.globalValue ?? insp?.defaultValue ?? [];
  const own = ownClangdArgs(ctx);
  const plan = planClangdArguments(current, cdbDir, own);
  if (!plan.injected) {
    logLine(log, "user-configured --compile-commands-dir found; not overriding");
    return false;
  }
  if (!plan.changed) return false;

  await jc.update("arguments", plan.next, vscode.ConfigurationTarget.Workspace);
  const ownNext = own.filter((a) => plan.next.includes(a));
  if (plan.flag && !ownNext.includes(plan.flag)) ownNext.push(plan.flag);
  await ctx.workspaceState.update(OWN_ARGS_KEY, ownNext);
  logLine(
    log,
    `clangd.arguments updated (${plan.next.length} entries); ` +
      `clangd restart will be debounced by ${getConfig().cpp.restartDebounceMs} ms`
  );

  const ext = vscode.extensions.getExtension(CLANGD_EXTENSION);
  if (ext?.isActive) {
    activeRestart?.schedule();
    return true;
  }
  logLine(log, "clangd is not active yet; new arguments apply when it starts");
  return false;
}

/** mtime of out/soong/module_bp_cc_deps.json, or null when the file is absent
 *  (cache is bypassed so the bp fallback stays live). */
async function ccDepsStamp(root: string): Promise<number | null> {
  try {
    return (await fs.stat(path.join(root, "out/soong/module_bp_cc_deps.json"))).mtimeMs;
  } catch {
    return null;
  }
}

async function ensureRoot(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void,
  root: string,
  file: string
): Promise<void> {
  let state = states.get(root);
  if (!state) {
    const o = await detectOrigin(ctx, root, file);
    state = {
      origin: o.origin,
      cdbDir: o.cdbDir,
      module: null,
      entries: 0,
      logged: false,
      suggested: false,
      fileInfoCache: new Map(),
    };
    states.set(root, state);
    if (o.origin !== "none") logLine(log, `${root}: origin=${o.origin} cdb=${o.cdbDir ?? "-"}`);
  }
  if (state.origin === "none") return;

  // compdb is consumed natively by clangd; writing entries would be redundant.
  if (state.origin !== "compdb" && state.cdbDir) {
    try {
      const stamp = await ccDepsStamp(root);
      const cached = stamp !== null ? state.fileInfoCache.get(file) : undefined;
      const info = cached && cached.stamp === stamp ? cached.info : await lookupFileInfo(root, file);
      if (stamp !== null && (!cached || cached.stamp !== stamp)) {
        state.fileInfoCache.set(file, { stamp, info });
      }
      if (info) {
        const entry = buildEntry(root, file, info.args, info.compiler);
        const r = await ensureEntry(path.join(state.cdbDir, "compile_commands.json"), entry);
        state.entries = r.count;
        state.module = info.module;
        if (r.changed) {
          logLine(
            log,
            `entry ${info.origin}${info.module ? ` (${info.module})` : ""}: ` +
              `${info.args.length} flags for ${file} (${r.count} total)`
          );
        }
      } else {
        await ensureCdbFile(path.join(state.cdbDir, "compile_commands.json"));
        if (!state.logged) logLine(log, `no cc_deps/bp flags for ${file}`);
      }
    } catch (e) {
      logLine(log, `entry write failed for ${file}: ${e}`);
    }
  }

  await applyClangdArguments(ctx, state.cdbDir, log);
  if (!state.logged) {
    state.logged = true;
    void suggestClangdPath(ctx, root, state, log);
  }
}

function enqueue(root: string, fn: () => Promise<void>, log: (m: string) => void): Promise<void> {
  const prev = chains.get(root) ?? Promise.resolve();
  const next = prev.then(fn, fn).catch((e) => logLine(log, `failed: ${e}`));
  chains.set(root, next);
  return next;
}

export function registerCppSupport(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void
): vscode.Disposable {
  const restart = new Debouncer(() => getConfig().cpp.restartDebounceMs, async () => {
    const ext = vscode.extensions.getExtension(CLANGD_EXTENSION);
    if (!ext?.isActive) return;
    logLine(log, "clangd.arguments changed → clangd.restart");
    try {
      await vscode.commands.executeCommand("clangd.restart");
    } catch (e) {
      logLine(log, `clangd.restart failed: ${e}`);
    }
  });
  activeRestart = restart;

  const handle = async (uri: vscode.Uri | undefined): Promise<void> => {
    if (!uri || uri.scheme !== "file") return;
    const cfgNow = getConfig();
    if (!cfgNow.enabled || !cfgNow.cpp.enabled) return;
    if (!isCppFile(uri.fsPath)) return;
    if (!vscode.extensions.getExtension(CLANGD_EXTENSION)) {
      if (!missingClangdNotified) {
        missingClangdNotified = true;
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            "[aosp-nav] C/C++ navigation needs the clangd extension ({0}). Install it, then reopen a C/C++ file.",
            CLANGD_EXTENSION
          )
        );
      }
      return;
    }
    const root = cfgNow.androidRoot ?? (await detectAospRoot(uri.fsPath));
    if (!root) return; // not part of an AOSP tree: stay silent
    await enqueue(root, () => ensureRoot(ctx, log, root, uri.fsPath), log);
  };

  const disposables: vscode.Disposable[] = [
    vscode.window.onDidChangeActiveTextEditor((e) => void handle(e?.document.uri)),
    vscode.workspace.onDidOpenTextDocument((d) => {
      const ae = vscode.window.activeTextEditor;
      if (ae && ae.document === d) void handle(d.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("aosp-nav.")) return;
      states.clear();
      const ae = vscode.window.activeTextEditor;
      if (ae) void handle(ae.document.uri);
    }),
  ];

  // session restore: a C/C++ editor may already be open at activation
  const ae = vscode.window.activeTextEditor;
  if (ae) void handle(ae.document.uri);

  return {
    dispose(): void {
      restart.cancel();
      if (activeRestart === restart) activeRestart = null;
      for (const d of disposables) d.dispose();
    },
  };
}

/** Remove only what this extension wrote (AOSP: Reset Plugin Settings). */
export async function resetCppSupport(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void
): Promise<void> {
  activeRestart?.cancel();
  const jc = vscode.workspace.getConfiguration("clangd");
  const insp = jc.inspect<string[]>("arguments");
  const ws = insp?.workspaceValue;
  const own = ownClangdArgs(ctx);
  if (ws) {
    const next = removeOwnArguments(ws, own);
    const global = insp?.globalValue ?? [];
    const sameAsGlobal =
      next.length === global.length && next.every((a, i) => a === global[i]);
    await jc.update(
      "arguments",
      next.length === 0 || sameAsGlobal ? undefined : next,
      vscode.ConfigurationTarget.Workspace
    );
    if (own.length > 0) logLine(log, `removed ${own.length} managed clangd argument(s)`);
  }
  await ctx.workspaceState.update(OWN_ARGS_KEY, undefined);

  for (const [, s] of states) {
    if (s.cdbDir && s.origin !== "compdb" && s.cdbDir.startsWith(ctx.globalStorageUri.fsPath)) {
      await fs.rm(s.cdbDir, { recursive: true, force: true });
    }
  }
  // Also clear managed CDBs left by previous windows/sessions (states is
  // in-memory and may be empty after a reload).
  try {
    const gs = ctx.globalStorageUri.fsPath;
    for (const e of await fs.readdir(gs, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith("cpp-")) {
        await fs.rm(path.join(gs, e.name), { recursive: true, force: true });
      }
    }
  } catch { /* globalStorage may not exist yet */ }
  states.clear();
  if (own.length > 0) {
    const ext = vscode.extensions.getExtension(CLANGD_EXTENSION);
    if (ext?.isActive) {
      try {
        await vscode.commands.executeCommand("clangd.restart");
      } catch { /* ignore */ }
    }
  }
}

export interface CppStatus {
  origin: Origin;
  cdbDir: string | null;
  entries: number;
  module: string | null;
  hasCdbFlag: boolean;
}

/** Read-only status for `AOSP: Show Diagnostics` (no lookups, no scans). */
export async function cppStatus(
  ctx: vscode.ExtensionContext,
  root: string | null
): Promise<CppStatus> {
  const args = vscode.workspace.getConfiguration("clangd").get<string[]>("arguments") ?? [];
  const hasCdbFlag = args.some((a) => a.startsWith("--compile-commands-dir="));
  if (!root) {
    // No usable seed (jdt:// view / focus outside the tree). Report what clangd
    // is actually configured with instead of pretending nothing is set up: a
    // `cpp-<hash>` managed dir means an aosp-nav-generated CDB, otherwise the
    // official compdb directory.
    const cdbArg = args.find((a) => a.startsWith("--compile-commands-dir="));
    const cdbDir = cdbArg ? cdbArg.slice("--compile-commands-dir=".length) : null;
    const managed = cdbDir ? path.basename(cdbDir).startsWith("cpp-") : false;
    const entries = cdbDir ? (await readCdb(path.join(cdbDir, "compile_commands.json"))).length : 0;
    return { origin: cdbDir ? (managed ? "cc_deps" : "compdb") : "none", cdbDir, entries, module: null, hasCdbFlag };
  }
  let s = states.get(root);
  if (!s) {
    let origin: Origin = "none";
    let cdbDir: string | null = null;
    if (await isFile(path.join(root, "out/soong/development/ide/compdb/compile_commands.json"))) {
      origin = "compdb";
      cdbDir = path.join(root, "out/soong/development/ide/compdb");
    } else if (await isFile(path.join(root, "out/soong/module_bp_cc_deps.json"))) {
      origin = "cc_deps";
      cdbDir = managedCdbDir(ctx, root);
    }
    s = { origin, cdbDir, module: null, entries: 0, logged: false, suggested: false, fileInfoCache: new Map() };
  }
  let entries = s.entries;
  if (s.cdbDir && s.origin !== "compdb") {
    entries = (await readCdb(path.join(s.cdbDir, "compile_commands.json"))).length;
  }
  return {
    origin: s.origin,
    cdbDir: s.cdbDir,
    entries,
    module: s.module,
    hasCdbFlag,
  };
}

/** `clangd.path` as written by the user in any settings scope, or null.
 *  The clangd extension declares default "clangd" (look on PATH), so the
 *  effective `get()` value is never empty — it cannot distinguish "unset"
 *  from "configured". */
export function clangdPathSetting(): string | null {
  // this VS Code d.ts has no `machineValue` on the inspection type, but the
  // runtime object may carry one (Machine-level settings.json on remote)
  const insp = vscode.workspace.getConfiguration("clangd").inspect<string>("path") as
    | { workspaceValue?: string; globalValue?: string; machineValue?: string }
    | undefined;
  return insp?.workspaceValue ?? insp?.globalValue ?? insp?.machineValue ?? null;
}

export function missingClangdHint(): string | null {
  if (vscode.extensions.getExtension(CLANGD_EXTENSION)) return null;
  return `install ${CLANGD_EXTENSION} (AOSP prebuilt clangd is under prebuilts/clang/host/linux-x86/)`;
}
