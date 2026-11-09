import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { djb2 } from "./infra/hash";
import { loadDefaults, getConfig, effectiveExclusions } from "./config";
import { detectAospRoot } from "./androidRoot";
import { scanSoong } from "./core/scanner";
import { applyDirPriority } from "./core/selector";
import { FilterEngine } from "./core/filters";
import { CACHE_VERSION, filtersHash, isCacheValid, CacheFile } from "./core/cacheModel";
import { scanJars, isDirectory, verifyJars, ScanCancelledError, DEFAULT_WALK_CONCURRENCY } from "./infra/fsScan";
import type { JarVerifyResult } from "./infra/fsScan";
import type { ScanStats, ScanResult } from "./core/types";
import { applyReferencedLibraries, clearOwnWorkspaceLibs } from "./jdtls/settingsChannel";
import { ensureJavaExtension } from "./jdtls/depManager";
import { applyOnce as applyCompat, resetWritten } from "./jdtls/compat";
import { apply as applyHygiene } from "./jdtls/workspaceHygiene";
import { guardWorkspace, cleanAndReload, clearOwnExclusions, getLastReports, getBlockedCount, isCleanPending } from "./jdtls/eclipseGuard";
import { applySourceRoots, clearOwnSourcePaths, ownSourcePaths } from "./jdtls/sourceRoots";
import { resolveSourceRoots } from "./jdtls/sourceRootsPlan";
import { applyKotlinClasspath, probeKotlinChannel, clearKotlinChannel, pruneKotlinRootMap } from "./kotlin/classpathChannel";
import { ensureKotlinExtension } from "./kotlin/depManager";
import {
  registerCppSupport,
  resetCppSupport,
  cppStatus,
  findAospClangd,
  clangdPathSetting,
  missingClangdHint,
} from "./clangd/controller";
import * as status from "./status";
import { invalidateCache } from "./commands/rescan";
import { openOutput, printDiagnostics, DiagLine } from "./commands/diagnostics";

let channel: vscode.OutputChannel;
let defaultsJson: Awaited<ReturnType<typeof loadDefaults>>;
/** What the last injection did, surfaced by `AOSP: Show Diagnostics`.
 *  `verify` records the jar-existence check that gates a cache hit (see
 *  infra/fsScan.verifyJars). */
interface SessionMeta {
  at: string;
  source: "cache" | "scan";
  ms: number;
  dirs?: number;
  stats?: ScanStats;
  verify?: JarVerifyResult;
}

const sessions = new Map<string, { phase: "idle" | "scanning" | "ready" | "failed"; jars: string[]; meta?: SessionMeta }>();
/** Last root that created a session; diagnostics fallback when no editor/file
 *  path yields one (jdt:// decompiled views, focus outside the tree). */
let lastRoot: string | null = null;
/** One promise per root: repeated triggers for the same tree join the running
 *  scan instead of returning early. */
const inflight = new Map<string, Promise<void>>();
const scanQueue: Array<{ root: string; release: () => void }> = [];
/** Scans allowed to run at once. A single global `running` flag used to make a
 *  multi-root window drop the second tree entirely; a small window keeps I/O
 *  bounded while still letting both trees make progress. */
const MAX_CONCURRENT_SCANS = 2;
let activeScans = 0;
/** Roots that already got the one-time "first Eclipse index" notice. */
const firstIndexNotified = new Set<string>();
/** One reload prompt per extension-host session; sourcePaths only change when
 *  the configured list does, and the prompt would otherwise repeat on every
 *  scan. */
let sourceReloadNotified = false;

const SOONG_BASES = ["out/soong/.intermediates", "out/.soong/.intermediates"];
/** Delay before the Eclipse-metadata guard walks the tree. The walk reads every
 *  directory of the tree (325k dirs, ~8 s at concurrency 8 on a real AOSP
 *  checkout); it is deferred so activation and redhat.java's import are not
 *  competing with it. */
const GUARD_DELAY_MS = 3000;

/** mtime of the soong build description: a rebuild rewrites it, so comparing
 *  it against the cached value catches "jars changed since the scan". Trees
 *  without build.ninja (make-era) return null and fall back to sampling. */
async function buildStamp(root: string): Promise<number | null> {
  try {
    const st = await fs.stat(path.join(root, "out/soong/build.ninja"));
    return st.mtimeMs;
  } catch {
    return null;
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("aosp-nav");
  status.initStatus(ctx);
  ctx.subscriptions.push(channel);

  loadDefaults(ctx).then((d) => { defaultsJson = d; });

  // C/C++ (clangd): independent of the Java session state machine. It only
  // acts on files under a detected AOSP root and never pre-writes the full CDB.
  ctx.subscriptions.push(registerCppSupport(ctx, (m) => channel.appendLine(m)));

  // eclipse guard: neutralize stale .project dirs that would suppress
  // jdt.ls' invisible project (and thus referencedLibraries).
  // Deferred past activation so the (expensive) tree walk does not compete
  // with redhat.java's import; a cached report younger than 24 h skips it.
  const guardTimer = setTimeout(
    () => void guardWorkspace(ctx, (m) => channel.appendLine(m)),
    GUARD_DELAY_MS
  );
  ctx.subscriptions.push({ dispose: () => clearTimeout(guardTimer) });
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // folders changed: the cached guard report no longer describes this set
      void guardWorkspace(ctx, (m) => channel.appendLine(m), { force: true });
      // a folder that was removed/renamed leaves a dead branch in the Kotlin
      // dispatch script; prune it (never touches a foreign script)
      if (getConfig().kotlinEnabled) {
        void pruneKotlinRootMap(ctx, (m) => channel.appendLine(m));
      }
    })
  );

  const drainQueue = (): void => {
    while (activeScans < MAX_CONCURRENT_SCANS && scanQueue.length > 0) {
      const job = scanQueue.shift()!;
      activeScans++;
      void scanRoot(job.root)
        .catch((e) => channel.appendLine(`[aosp-nav] error: ${e}`))
        .finally(() => {
          activeScans--;
          inflight.delete(job.root);
          job.release();
          drainQueue();
        });
    }
  };

  const runFor = (root: string): Promise<void> => {
    const existing = inflight.get(root);
    if (existing) return existing;
    let release!: () => void;
    const p = new Promise<void>((r) => { release = r; });
    inflight.set(root, p);
    scanQueue.push({ root, release });
    drainQueue();
    return p;
  };

  const scanRoot = async (root: string): Promise<void> => {
    const s = sessions.get(root) ?? { phase: "idle" as const, jars: [] };
    sessions.set(root, s);
    lastRoot = root;
    if (s.phase === "ready" || s.phase === "scanning") return;
    s.phase = "scanning";
    status.statusScanning(root);

    try {
      const cfg = getConfig();
      if (!defaultsJson) defaultsJson = await loadDefaults(ctx);
      const ex = effectiveExclusions(cfg, defaultsJson);
      const fhash = filtersHash(ex);

      if (!(await ensureJavaExtension())) {
        status.statusFailed(root);
        s.phase = "failed";
        return;
      }
      await applyCompat(ctx, cfg.settingsScope, (m) => channel.appendLine(m));
      await applyHygiene(ctx, (m) => channel.appendLine(m));

      // cache: a valid entry must match the rules AND the build stamp AND its
      // jars must still exist (a rebuild deletes/replaces them). Verifying the
      // list is cheap (2552 jars = ~56 ms at concurrency 8 on a real tree), so
      // hits are checked completely up to FULL_VERIFY_LIMIT instead of sampled.
      const cacheFile = path.join(ctx.globalStorageUri.fsPath, `jars-${djb2(root)}.json`);
      const stamp = await buildStamp(root);
      const startedAt = Date.now();
      let jars: string[] | null = null;
      let fromCache = false;
      let verify: JarVerifyResult | undefined;
      let stats: ScanStats | undefined;
      try {
        const raw = JSON.parse(await fs.readFile(cacheFile, "utf8")) as CacheFile;
        if (isCacheValid(raw, CACHE_VERSION, fhash, stamp)) {
          verify = await verifyJars(raw.jars);
          if (verify.missing === 0) {
            jars = raw.jars;
            fromCache = true;
          } else {
            channel.appendLine(
              `[aosp-nav] ${root}: ${verify.missing}/${verify.checked} cached jar(s) no longer exist, rescanning`
            );
          }
        }
      } catch { /* miss */ }

      if (!jars) {
        const baseOk = await isDirectory(path.join(root, SOONG_BASES[0]))
          || await isDirectory(path.join(root, SOONG_BASES[1]));
        if (!baseOk) {
          // make-era or no build outputs
          status.statusNoOut(root);
          s.phase = "failed";
          return;
        }
        let scan: ScanResult | null;
        try {
          scan = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t("AOSP: scanning build outputs"),
              cancellable: true,
            },
            async (progress, token) => {
              progress.report({ message: vscode.l10n.t("reading {0}", path.basename(root)) });
              return scanSoong(root, defaultsJson, new FilterEngine(ex), (base) =>
                scanJars(base, {
                  concurrency: DEFAULT_WALK_CONCURRENCY,
                  shouldCancel: () => token.isCancellationRequested,
                  onDirs: (n) => progress.report({ message: vscode.l10n.t("{0} directories", n) }),
                })
              );
            }
          );
        } catch (e) {
          if (e instanceof ScanCancelledError) {
            // cancelled: no cache write, and the session stays retryable
            status.statusCancelled(root);
            s.phase = "idle";
            channel.appendLine(`[aosp-nav] ${root}: scan cancelled by user`);
            return;
          }
          throw e;
        }
        if (!scan) {
          status.statusNoOut(root);
          s.phase = "failed";
          return;
        }
        applyDirPriority(scan.jars, defaultsJson);
        jars = scan.jars;
        stats = scan.stats;
        await fs.mkdir(ctx.globalStorageUri.fsPath, { recursive: true });
        // two windows of the same aosp root share globalStorage: write via a
        // unique temp file + rename so concurrent scans never interleave
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({
          version: CACHE_VERSION, filtersHash: fhash,
          generatedAt: new Date().toISOString(), jars,
          buildMtimeMs: stamp,
        } as CacheFile));
        await fs.rename(tmp, cacheFile);
      }

      s.jars = jars;
      s.meta = {
        at: new Date().toISOString(),
        source: fromCache ? "cache" : "scan",
        ms: Date.now() - startedAt,
        stats,
        verify,
      };
      // kotlin channel: same jar list, fed to fwcd kotlin-language-server
      // via its global classpath script (independent of the java write
      // below, so a java settings failure does not kill kotlin nav)
      if (cfg.kotlinEnabled) {
        await applyKotlinClasspath(ctx, root, jars, (m) => channel.appendLine(m));
        void ensureKotlinExtension();
      }
      const res = await applyReferencedLibraries(ctx, cfg.settingsScope, jars, (m) => channel.appendLine(m));
      if (!res.inEffect) {
        // write failed (e.g. settings not writable): keep the session
        // retryable — the next file open tries again instead of dying
        // silently as in 0.1.1
        status.statusFailed(root);
        s.phase = "failed";
        channel.appendLine(`[aosp-nav] ${root}: referencedLibraries not applied, will retry on next open`);
        return;
      }
      if (res.changed) {
        // fresh write: show the one-time Eclipse index, but settle on its own
        // (this branch used to stay on "indexing" forever)
        status.statusIndexing(root, jars.length);
        if (!firstIndexNotified.has(root)) {
          firstIndexNotified.add(root);
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              "[aosp-nav] Injected {0} dependency jars. The first Eclipse indexing takes about 30-60 minutes (one-time); high CPU is normal, do not restart the language server during it. Later opens are instant.",
              jars.length
            ),
            vscode.l10n.t("Got it"));
        }
      } else {
        status.statusReady(root, jars.length, fromCache);
      }
      s.phase = "ready";
      // java.project.sourcePaths: real .java sources ahead of the decompiled
      // jars. jdt.ls reads this during import, so the change only takes effect
      // after a window reload. Never probe java.project.getAll/getClasspaths
      // here or in diagnostics: those block for minutes on a real AOSP tree.
      try {
        const sp = await applySourceRoots(ctx, cfg.javaSourceRoots, (m) => channel.appendLine(m));
        if (sp.changed && !sourceReloadNotified) {
          sourceReloadNotified = true;
          const button = vscode.l10n.t("Reload Window");
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              "[aosp-nav] java.project.sourcePaths updated ({0} entries). Reload the window so jdt.ls picks them up; go-to-definition then lands in .java sources for the listed roots (modules not listed keep jar navigation only).",
              sp.written
            ),
            button
          ).then((pick) => {
            if (pick === button) void vscode.commands.executeCommand("workbench.action.reloadWindow");
          });
        }
      } catch (e) {
        channel.appendLine(`[aosp-nav] sourcePaths: ${e}`);
      }
      const verifyNote = verify
        ? `, verified ${verify.checked} jar(s)${verify.sampled ? " (sampled)" : ""}, ${verify.missing} missing`
        : "";
      channel.appendLine(
        `[aosp-nav] ${root}: ${jars.length} jars (${fromCache ? "cache" : "scan"}${verifyNote}) in ${Date.now() - startedAt} ms`
      );
    } catch (e) {
      status.statusFailed(root);
      s.phase = "failed";
      channel.appendLine(`[aosp-nav] error: ${e}`);
    }
  };

  const onFile = async (uri: vscode.Uri | undefined): Promise<void> => {
    if (!uri || uri.scheme !== "file") return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc && doc.languageId !== "java" && doc.languageId !== "kotlin") return;
    const cfg = getConfig();
    if (!cfg.enabled) return;
    const root = cfg.androidRoot ?? await detectAospRoot(uri.fsPath);
    if (!root) return; // not an AOSP file: stay silent
    await runFor(root);
  };

  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => void onFile(e?.document.uri)),
    vscode.workspace.onDidOpenTextDocument((d) => {
      const ae = vscode.window.activeTextEditor;
      if (ae && ae.document === d) void onFile(d.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aosp-nav.")) {
        // invalidate sessions and re-run immediately so new filters/scope take
        // effect without reopening a file (cache is filters-hash aware)
        const roots = [...sessions.entries()]
          .filter(([, v]) => v.phase !== "scanning")
          .map(([root]) => root);
        for (const root of roots) {
          const s = sessions.get(root);
          if (s) s.phase = "idle";
        }
        if (getConfig().enabled) {
          // one runFor per root; the queue dedupes and orders them instead of
          // a detached serial loop that could overlap a running scan
          void Promise.all(roots.map((root) => runFor(root)));
        }
      }
    }),
    vscode.commands.registerCommand("aosp-nav.rescan", async () => {
      const ae = vscode.window.activeTextEditor;
      if (!ae) { void vscode.window.showWarningMessage(vscode.l10n.t("[aosp-nav] no active file")); return; }
      const root = getConfig().androidRoot ?? await detectAospRoot(ae.document.uri.fsPath);
      if (!root) { void vscode.window.showWarningMessage(vscode.l10n.t("[aosp-nav] not an AOSP file")); return; }
      invalidateCache(ctx.globalStorageUri.fsPath, root);
      sessions.delete(root);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "AOSP: rescanning" },
        async () => {
          await runFor(root);
          // re-run the eclipse guard too: the user may have cleaned stale
          // metadata dirs manually since the last scan
          await guardWorkspace(ctx, (m) => channel.appendLine(m));
        });
    }),
    vscode.commands.registerCommand("aosp-nav.fixEclipseBlockers", async () => {
      // physical dirs keep existing after a successful fix, so this stays
      // runnable whenever any are on disk — it is the escape hatch for "I
      // dismissed the confirmation earlier" / "navigation is still broken".
      const physical = getLastReports().reduce((a, r) => a + r.blockers.length + (r.rootBlocked ? 1 : 0), 0);
      if (physical === 0 && getBlockedCount() === 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t("[aosp-nav] No Eclipse metadata blockers to fix (if the workspace has not been scanned yet, open an AOSP java file first)."));
        return;
      }
      await cleanAndReload(ctx, (m) => channel.appendLine(m));
    }),
    vscode.commands.registerCommand("aosp-nav.resetSettings", async () => {
      await resetWritten(ctx, (m) => channel.appendLine(m));
      await clearOwnWorkspaceLibs(ctx);
      await clearOwnSourcePaths(ctx);
      await clearOwnExclusions(ctx);
      await clearKotlinChannel(ctx);
      await resetCppSupport(ctx, (m) => channel.appendLine(m));
      void vscode.window.showInformationMessage(vscode.l10n.t("[aosp-nav] settings written by the plugin have been rolled back"));
    }),
    vscode.commands.registerCommand("aosp-nav.diagnostics", async () => {
      openOutput(channel);
      const lines: DiagLine[] = [];
      lines.push({ ok: null, label: "extension", detail: `${ctx.extension.packageJSON.version}` });
      const javaExt = vscode.extensions.getExtension("redhat.java");
      lines.push({
        ok: !!javaExt,
        label: "redhat.java",
        detail: javaExt ? `${javaExt.packageJSON.version} (${javaExt.isActive ? "active" : "inactive"})` : "NOT INSTALLED",
      });
      const cfgNow = getConfig();
      // The active editor is not always a usable seed: decompiled sources are
      // `jdt://` (or `jar:`), and focus may sit outside any editor. Fall back
      // to a workspace folder, then to a known session, so the panel reports
      // the tree instead of a misleading "open an AOSP java file first".
      const ae = vscode.window.activeTextEditor;
      let root: string | null = null;
      let rootSource: string | null = null;
      if (ae) {
        if (ae.document.uri.scheme !== "file") {
          rootSource = `active editor is a ${ae.document.uri.scheme}: view, not a file on disk`;
        } else {
          root = cfgNow.androidRoot ?? await detectAospRoot(ae.document.uri.fsPath);
        }
      }
      if (!root) {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          if (folder.uri.scheme !== "file") continue;
          const r = cfgNow.androidRoot ?? await detectAospRoot(folder.uri.fsPath);
          if (r) {
            root = r;
            rootSource = rootSource ? `${rootSource}; root from workspace folder` : "from workspace folder";
            break;
          }
        }
      }
      if (!root) {
        const only = sessions.size === 1 ? [...sessions.keys()][0] : null;
        const fallback = lastRoot && sessions.has(lastRoot) ? lastRoot : only;
        if (fallback) {
          root = fallback;
          rootSource = "from last session";
        }
      }
      lines.push({
        ok: !!root,
        label: "root",
        detail: root
          ? `${root} (${rootSource ?? "from active editor"})`
          : `not detected (${rootSource ?? "no AOSP file open and no AOSP workspace folder"})`,
      });
      const s = root ? sessions.get(root) : undefined;
      lines.push({
        ok: s ? s.phase === "ready" : null,
        label: "state",
        detail: s ? `${s.phase}, jars=${s.jars.length}` : "no session (no java file from this tree opened yet)",
      });
      if (s?.meta) {
        const m = s.meta;
        const verify = m.verify
          ? `, verified ${m.verify.checked}/${s.jars.length} jar(s)${m.verify.sampled ? " (sampled)" : ""}, missing ${m.verify.missing}`
          : "";
        lines.push({
          ok: null,
          label: "last scan",
          detail: m.source === "cache"
            ? `cache hit in ${m.ms} ms${verify}`
            : `fresh scan in ${m.ms} ms` +
              (m.stats
                ? `, scanned ${m.stats.scanned}, excluded ${m.stats.excluded}, selected ${m.stats.selected}, dedup ${m.stats.dedupPreJarjar}`
                : "") +
              verify,
        });
      }
      if (root) {
        // cache freshness: the same stamp/validity the scan path relies on
        const cacheFile = path.join(ctx.globalStorageUri.fsPath, `jars-${djb2(root)}.json`);
        try {
          const raw = JSON.parse(await fs.readFile(cacheFile, "utf8")) as CacheFile;
          lines.push({
            ok: null,
            label: "cache",
            detail: `v${raw.version}, ${raw.jars.length} jars, generated ${raw.generatedAt}, build ${raw.buildMtimeMs ?? "(none)"}`,
          });
        } catch {
          lines.push({ ok: null, label: "cache", detail: "no cache (next open rescans)" });
        }
      }
      const jc = vscode.workspace.getConfiguration("java");
      const rl = jc.get<unknown>("project.referencedLibraries");
      const rlCount = Array.isArray(rl) ? rl.length : (rl as { include?: string[] })?.include?.length ?? 0;
      lines.push({ ok: rlCount > 0, label: "referencedLibraries", detail: `${rlCount} entries` });
      // sourcePaths: config read only. java.project.getAll/getClasspaths are
      // deliberately not called anywhere — they block for minutes here.
      const sp = jc.get<string[]>("project.sourcePaths") ?? [];
      lines.push({
        ok: sp.length > 0 ? true : null,
        label: "sourcePaths",
        detail: `${sp.length} entries (${ownSourcePaths(ctx).length} managed by aosp-nav; reload required after changes)`,
      });
      // A configured source root outside every workspace folder cannot be
      // injected: jdt.ls only takes workspace-relative paths. Say so and give
      // the actionable fix instead of leaving it to a single log line.
      const outOfScope: string[] = [];
      let scopeRoot: string | null = null;
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== "file") continue;
        const folderRoot = cfgNow.androidRoot ?? await detectAospRoot(folder.uri.fsPath);
        if (!folderRoot) continue;
        scopeRoot = folderRoot;
        const r = await resolveSourceRoots(folderRoot, cfgNow.javaSourceRoots, isDirectory);
        for (const p of r.paths) {
          const rel = path.relative(folder.uri.fsPath, p).split(path.sep).join("/");
          if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
            if (!outOfScope.includes(p)) outOfScope.push(p);
          }
        }
      }
      if (outOfScope.length > 0) {
        lines.push({
          ok: false,
          label: "sourcePaths scope",
          detail: `${outOfScope.length} configured root(s) outside the workspace folder, skipped: ${outOfScope.join(", ")}`,
          action: scopeRoot
            ? `open ${scopeRoot} as the workspace folder to get cross-module source navigation (java.project.sourcePaths must be workspace-relative)`
            : "open the AOSP root as the workspace folder to get cross-module source navigation",
        });
      }
      // C/C++ (clangd): read-only status; never resolves files or writes CDB here
      const cppCfg = getConfig().cpp;
      const clangdExt = vscode.extensions.getExtension("llvm-vs-code-extensions.vscode-clangd");
      lines.push({
        ok: cppCfg.enabled ? !!clangdExt : null,
        label: "clangd extension",
        detail: clangdExt
          ? `${clangdExt.packageJSON.version} (${clangdExt.isActive ? "active" : "inactive"})`
          : "NOT INSTALLED" + (missingClangdHint() ? ` — ${missingClangdHint()}` : ""),
      });
      if (cppCfg.enabled) {
        const cs = await cppStatus(ctx, root);
        const cand = root ? await findAospClangd(root) : null;
        lines.push({
          ok: cs.origin === "none" ? null : true,
          label: "cpp origin",
          detail: cs.origin === "compdb"
            ? "compdb (clangd native, no entries written)"
            : cs.origin === "cc_deps"
              ? `cc_deps, ${cs.entries} entr(ies)${cs.module ? `, last module ${cs.module}` : ""}`
              : cs.origin === "bp"
                ? `Android.bp fallback, ${cs.entries} entr(ies)`
                : "none (no compdb / module_bp_cc_deps.json / Android.bp)",
          action: cs.cdbDir ? `cdb: ${cs.cdbDir}` : undefined,
        });
        const clangdPath = clangdPathSetting();
        lines.push({
          ok: clangdPath ? true : null,
          label: "clangd.path",
          detail: clangdPath || `(unset)${cand ? `; AOSP prebuilt: ${cand}` : ""}`,
          action: !clangdPath && cand ? "set 'clangd.path' to the AOSP prebuilt (extension bundles none)" : undefined,
        });
        const ca = vscode.workspace.getConfiguration("clangd").get<string[]>("arguments") ?? [];
        // Check the actual setting: cs.hasCdbFlag reflects the same array, but
        // printing the flag makes a stale/empty diagnostics root obvious.
        const cdbArg = ca.find((a) => a.startsWith("--compile-commands-dir="));
        lines.push({
          ok: cdbArg ? true : null,
          label: "clangd.arguments",
          detail: `${ca.length} entries${cdbArg ? `, ${cdbArg}` : ", no --compile-commands-dir"}`,
        });
        if (cs.origin === "cc_deps") {
          lines.push({
            ok: null,
            label: "cpp generated headers",
            detail: "cc_deps carries no AIDL/protobuf output dirs: android/net/INetd.h-style errors are expected until the official compdb is generated (make SOONG_GEN_COMPDB=1 nothing)",
          });
        }
      }
      // the switches live in the layer aosp-nav.settingsScope selects, so name
      // it — "false" with no layer is not actionable when debugging
      for (const sub of ["import.gradle.enabled", "import.maven.enabled"]) {
        const insp = jc.inspect<unknown>(sub);
        const where =
          insp?.workspaceValue === false ? "workspace" : insp?.globalValue === false ? "global" : "unset";
        lines.push({ ok: jc.get(sub) === false, label: sub, detail: `${String(jc.get(sub))} (${where})` });
      }
      // kotlin channel
      const kEnabled = getConfig().kotlinEnabled;
      const kExt = vscode.extensions.getExtension("fwcd.kotlin");
      lines.push({
        ok: kEnabled ? !!kExt : null,
        label: "kotlin",
        detail: `enabled=${kEnabled}, fwcd.kotlin=${kExt ? `${kExt.packageJSON.version} (${kExt.isActive ? "active" : "inactive"})` : "NOT INSTALLED"}`,
      });
      if (root) {
        const kp = await probeKotlinChannel(root);
        lines.push({
          ok: kp.script === "ours" ? true : kp.script === "family-nvim" ? true : kp.script === "user" ? false : null,
          label: "kotlin classpath script",
          detail: kp.script === "ours"
            ? `ours, ${kp.jars} jars`
            : kp.script === "family-nvim"
              ? "family (aosp-nav.nvim) in place, taken over on next injection"
              : kp.script === "user"
                ? "user-managed, aosp-nav will not take over"
                : "not written",
        });
      }
      const vmargs = vscode.workspace.getConfiguration("java").get<string>("jdt.ls.vmargs") ?? "";
      lines.push({
        ok: vmargs.includes("-Xmx"),
        label: "jdt.ls.vmargs",
        detail: vmargs || "(unset)",
        action: vmargs.includes("-Xmx") ? undefined : "add e.g. java.jdt.ls.vmargs: -Xmx6G ... in user settings",
      });
      // eclipse guard
      const pending = await isCleanPending(ctx);
      const actionNeeded = getBlockedCount();
      for (const r of getLastReports()) {
        const n = r.blockers.length + (r.rootBlocked ? 1 : 0);
        const needsAction = n > 0 && actionNeeded > 0;
        lines.push({
          ok: n === 0 ? true : needsAction ? false : null,
          label: `eclipse guard [${path.basename(r.folder)}]`,
          detail: n === 0
            ? "no stale .project dirs"
            : needsAction
              ? `${n} blocker(s)${r.rootBlocked ? " (workspace root itself has Eclipse metadata)" : ""}, clean+reload pending${pending ? "" : " (not re-armed)"}`
              : `${n} dir(s) already excluded from import (ignored, not blocking)`,
          action: needsAction
            ? "run 'AOSP: Fix Eclipse Metadata Blockers' (one-time clean + reload)"
            : n > 0
              ? "if navigation is still broken, run 'AOSP: Fix Eclipse Metadata Blockers' once"
              : undefined,
        });
      }
      if (getLastReports().length === 0) {
        lines.push({ ok: null, label: "eclipse guard", detail: "not scanned yet (open an AOSP java file first)" });
      }
      const excl = jc.get<string[]>("import.exclusions") ?? [];
      lines.push({ ok: null, label: "import.exclusions", detail: `${excl.length} patterns` });
      printDiagnostics(channel, lines);
    })
  );

  // session restore: an editor may already be open at activation
  if (vscode.window.activeTextEditor) {
    void onFile(vscode.window.activeTextEditor.document.uri);
  }
}

export function deactivate(): void {}
