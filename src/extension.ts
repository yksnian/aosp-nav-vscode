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
import {
  applyReferencedLibraries,
  clearOwnWorkspaceLibs,
  currentAutobuildState,
  ensureAutobuildDisabled,
  clearOwnAutobuild,
} from "./jdtls/settingsChannel";
import { ensureJavaExtension } from "./jdtls/depManager";
import { applyOnce as applyCompat, resetWritten } from "./jdtls/compat";
import { apply as applyHygiene } from "./jdtls/workspaceHygiene";
import { guardWorkspace, cleanAndReload, clearOwnExclusions, getLastReports, getBlockedCount, isCleanPending } from "./jdtls/eclipseGuard";
import {
  applySourceRootsAndPromptReload,
  clearOwnSourcePaths,
  ownSourcePaths,
} from "./jdtls/sourceRoots";
import { resolveSourceRoots } from "./jdtls/sourceRootsPlan";
import {
  maybeOfferModulePicker,
  seedDefaultModuleSelection,
  clearOwnExtraSourceRoots,
  selectJavaSourceRootsByModule,
} from "./jdtls/modulePicker";
import { computeInjectedJars } from "./jdtls/jarPlan";
import { jdtlsWorkspaceDir, probeJdtlsCrash } from "./jdtls/crashSignals";
import type { JdtlsCrashProbe } from "./jdtls/crashSignals";
import { applyKotlinClasspath, probeKotlinChannel, clearKotlinChannel, pruneKotlinRootMap, knownKotlinRoots } from "./kotlin/classpathChannel";
import { ensureKlsSupport, ensureKtlspBootstrap, probeKlsSupport, clearKlsSupport } from "./kotlin/klsSupport";
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
  /** how the injected jar list was produced (plan D: dependency closure of the
   *  selected modules ∪ the common set, or the full-list fallback with its
   *  reason) */
  jarSource?: {
    mode: "closure" | "fallback";
    reason?: string;
    /** module names reached but absent from the build index */
    unmapped: number;
    /** modules whose jars are not built yet */
    starved: number;
    /** modules recovered by the variant fallback */
    rescued: number;
    /** unique jar entries the closure dropped (missing on disk / off-tree) */
    dropped: number;
    /** common-set modules with no built jar on disk (named, so the user knows
     *  what to build) */
    commonStarved: string[];
    /** the common set also carried the test-support modules */
    testSelection: boolean;
    /** duplicate-provider stubs could not be dropped (no framework.jar /
     *  core-all.jar in the list) */
    stubsKept: boolean;
    /** module dirs the injected classpath was derived from */
    modules: string[];
    /** where that set came from: written config, seeded defaults, the window
     *  folder's auto selection, or nothing at all */
    moduleSource: "explicit" | "default" | "auto" | "none";
    /** modules auto-selected for a subtree window (absent when explicit) */
    auto?: number;
  };
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
/** Roots that already got the "referencedLibraries write failed" warning. */
const libWriteWarned = new Set<string>();

/** workspaceState key holding the newest crash-evidence mtime already
 *  reported, so a heap dump / OOM trace prompts once, not on every scan. */
const CRASH_PROMPTED_KEY = "aosp-nav.jdtlsCrashPromptedAt";
/** Last confirmed crash probe of this window (diagnostics reads it). */
let lastCrashProbe: JdtlsCrashProbe | null = null;

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

  loadDefaults(ctx)
    .then((d) => { defaultsJson = d; })
    .catch(() => { /* a scan retries the load on demand (runFor) and reports there */ });

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

  /** Report jdt.ls crash evidence (heap dump / OutOfMemoryError trace) and
   *  prompt once per new evidence. A normal server restart leaves no trace, so
   *  it never reaches the prompt. The extension only NAMES the actionable
   *  settings (java.jdt.ls.vmargs, java.autobuild.enabled) — it never writes
   *  them. */
  const probeCrash = async (): Promise<JdtlsCrashProbe | null> => {
    const storage = ctx.storageUri?.fsPath;
    if (!storage) return null;
    const wsDir = jdtlsWorkspaceDir(storage);
    const p = await probeJdtlsCrash(wsDir);
    lastCrashProbe = p.confirmed ? p : null;
    if (!p.confirmed) return p;
    channel.appendLine(
      `[aosp-nav] jdt.ls crash evidence in ${wsDir}: ${p.evidence}${p.oomSample ? ` — ${p.oomSample}` : ""}`
    );
    const seen = ctx.workspaceState.get<number>(CRASH_PROMPTED_KEY) ?? 0;
    if (p.newestMs > seen) {
      await ctx.workspaceState.update(CRASH_PROMPTED_KEY, p.newestMs);
      const btn = vscode.l10n.t("Show Diagnostics");
      void vscode.window
        .showWarningMessage(
          vscode.l10n.t(
            "[aosp-nav] The Java language server left crash evidence ({0}). Raise java.jdt.ls.vmargs (e.g. -Xmx6G) and consider java.autobuild.enabled=false; aosp-nav does not change these settings.",
            p.evidence
          ),
          btn
        )
        .then((pick) => {
          if (pick === btn) void vscode.commands.executeCommand("aosp-nav.diagnostics");
        });
    }
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

      s.meta = {
        at: new Date().toISOString(),
        source: fromCache ? "cache" : "scan",
        ms: Date.now() - startedAt,
        stats,
        verify,
      };
      // one-time module picker offer BEFORE injecting anything: injecting
      // sourcePaths turns off jdt.ls' per-file source inference, so the choice
      // must exist before the roots are written — and before the jar pass, so
      // a pick made afterwards cannot trigger a second index run via the
      // config-change listener on an already-injected session. Dismissing it
      // is fine: the root-window default is then persisted as a real module
      // selection.
      await maybeOfferModulePicker(ctx, root, (m) => channel.appendLine(m));
      // no implicit "default roots" branch any more: the root-window default
      // modules are written to aosp-nav.java.sourceRootModules, so the picker's
      // checked state and the injected roots always come from the same config.
      // Runs while the session is still "scanning", so the config-change
      // listener skips this root and no duplicate pass is scheduled.
      const seededDefaults = await seedDefaultModuleSelection(root, (m) => channel.appendLine(m));
      // Plan D jar source: the dependency closure of the selected modules ∪ a
      // small common set (libcore), from the soong build index — instead of
      // the full .intermediates walk. The full list stays in the cache and
      // remains the fallback whenever the index is missing/stale or the
      // selection is empty, so the injected classpath can never silently go
      // empty. The selection is re-read here (not from the cfg snapshot
      // above): seedDefaultModuleSelection may have just written it.
      // Subtree windows (Connectivity, NetworkStack, ...) never seed a module
      // selection, so hand jarPlan the window folder: it then derives the same
      // auto module set the source-path channel uses, instead of injecting the
      // full list. A window folder equal to the root keeps the old behaviour.
      const windowFolder = (vscode.workspace.workspaceFolders ?? [])
        .filter((f) => f.uri.scheme === "file")
        .map((f) => f.uri.fsPath)
        .find((p) => {
          const rel = path.relative(path.resolve(root), path.resolve(p));
          return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
        });
      const jInsp = vscode.workspace.getConfiguration("java").inspect<string[]>("import.exclusions");
      const importExclusions = jInsp?.workspaceValue ?? jInsp?.globalValue ?? jInsp?.defaultValue ?? [];
      const plan = await computeInjectedJars(
        root,
        vscode.workspace.getConfiguration("aosp-nav").get<string[]>("java.sourceRootModules") ?? [],
        jars,
        (m) => channel.appendLine(m),
        { folder: windowFolder, importExclusions }
      );
      jars = plan.jars;
      s.jars = jars;
      if (s.meta) {
        s.meta.jarSource = {
          mode: plan.mode,
          reason: plan.reason,
          unmapped: plan.unmapped.length,
          starved: plan.starved,
          rescued: plan.rescued,
          dropped: plan.dropped,
          commonStarved: plan.commonStarved,
          testSelection: plan.testSelection,
          stubsKept: plan.stubsKept,
          auto: plan.auto,
          modules: plan.modules,
          // where the effective module set came from — the config alone is not
          // the answer for a subtree window (auto selection) or a root window
          // whose defaults were seeded on this very run
          moduleSource: plan.auto !== undefined
            ? "auto"
            : plan.modules.length === 0
              ? "none"
              : seededDefaults
                ? "default"
                : "explicit",
        };
      }
      // kotlin channel: same jar list, fed to fwcd kotlin-language-server
      // via its global classpath script (independent of the java write
      // below, so a java settings failure does not kill kotlin nav)
      if (cfg.kotlinEnabled) {
        const kr = await applyKotlinClasspath(ctx, root, jars, (m) => channel.appendLine(m));
        if (!kr.blocked) {
          // ktlsp support files (.kls exclusions + .gitignore prune block)
          // and the pinned-server bootstrap ride on the injection flow
          await ensureKlsSupport(root, jars, (m) => channel.appendLine(m));
          ensureKtlspBootstrap(ctx, (m) => channel.appendLine(m));
        }
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
        // one warning per root: a silent failure here means navigation simply
        // does not work, which is exactly the case the log alone never conveys
        if (!libWriteWarned.has(root)) {
          libWriteWarned.add(root);
          void vscode.window
            .showWarningMessage(
              vscode.l10n.t(
                "[aosp-nav] Could not write java.project.referencedLibraries ({0} jars). Dependency navigation will not work until this is fixed; the next file open retries.",
                jars.length
              ),
              vscode.l10n.t("Show Diagnostics")
            )
            .then((pick) => {
              if (pick) void vscode.commands.executeCommand("aosp-nav.diagnostics");
            });
        }
        return;
      }
      // Large AOSP root: stop Eclipse from rebuilding on every save. Only when
      // the workspace folder itself is the root (never a subtree window), only
      // above the jar threshold, and never over an explicit user value — the
      // policy lives in jdtls/autobuild.ts. A failed write must not stop the
      // injection.
      try {
        const isRootFolder = (vscode.workspace.workspaceFolders ?? []).some(
          (f) => f.uri.scheme === "file" && path.resolve(f.uri.fsPath) === path.resolve(root)
        );
        await ensureAutobuildDisabled(
          ctx,
          { workspaceIsAospRoot: isRootFolder, jars: jars.length },
          (m) => channel.appendLine(m)
        );
      } catch (e) {
        channel.appendLine(`[aosp-nav] autobuild check failed (ignored): ${e}`);
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
      // jars. jdt.ls picks the change up live (import already ran), so no
      // window reload is required; the helper only reminds in the rare case
      // the live sync could not run. Never probe java.project.getAll/getClasspaths
      // here or in diagnostics: those block for minutes on a real AOSP tree.
      // The module selection (and the seed written above) is already in the
      // config by the time this runs.
      await applySourceRootsAndPromptReload(ctx, (m) => channel.appendLine(m));
      // crash observability: runs after the injection so the message is not
      // mixed with jar planning; never fails the session
      try {
        await probeCrash();
      } catch (e) {
        channel.appendLine(`[aosp-nav] crash probe failed: ${e}`);
      }
      const verifyNote = verify
        ? `, cache verified ${verify.checked} jar(s)${verify.sampled ? " (sampled)" : ""}, ${verify.missing} missing`
        : "";
      channel.appendLine(
        `[aosp-nav] ${root}: injecting ${jars.length} jar(s) [${plan.mode}] from the ${fromCache ? "cached" : "scanned"} full list${plan.mode === "closure" ? ` (${plan.dropped} dropped, ${plan.rescued} rescued, ${plan.unmapped.length} dangling)` : ""}${verifyNote} in ${Date.now() - startedAt} ms`
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
      // join a scan that is still running first: runFor() would otherwise
      // return that old promise (stale jars), and sessions.delete would orphan
      // its in-flight session — the summary below would find nothing.
      const running = inflight.get(root);
      if (running) await running;
      sessions.delete(root);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "AOSP: rescanning" },
        async () => {
          await runFor(root);
          // Force a fresh walk: the user may have deleted stale .project dirs
          // manually since the last scan, and an unexpired cached report would
          // write those exclusions straight back. Rescan is the explicit
          // "trust the disk now" path, so it must skip the 24 h cache.
          await guardWorkspace(ctx, (m) => channel.appendLine(m), { force: true });
        });
      // summarize what the rescan actually injected, so a closure fallback or a
      // module set that lost jars is visible without opening the output channel
      const s = sessions.get(root);
      const js = s?.meta?.jarSource;
      if (s && js) {
        const msg = js.mode === "closure"
          ? vscode.l10n.t(
              "[aosp-nav] {0} jars injected (closure: {1} dropped, {2} rescued by variant fallback, {3} dangling, {4} unbuilt)",
              s.jars.length, js.dropped, js.rescued, js.unmapped, js.starved
            )
          : vscode.l10n.t(
              "[aosp-nav] {0} jars injected (full-list fallback: {1})",
              s.jars.length, js.reason ?? "unspecified"
            );
        channel.appendLine(`[aosp-nav] rescan: ${msg}`);
        void vscode.window.showInformationMessage(msg);
      } else {
        channel.appendLine(`[aosp-nav] rescan: no session for ${root}`);
      }
    }),
    vscode.commands.registerCommand("aosp-nav.fixEclipseBlockers", async () => {
      // physical dirs keep existing after a successful fix, so this stays
      // runnable whenever any are on disk — it is the escape hatch for "I
      // dismissed the confirmation earlier" / "navigation is still broken".
      const physical = getLastReports().reduce((a, r) => a + r.blockers.length, 0);
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
      await clearOwnAutobuild(ctx);
      await clearOwnSourcePaths(ctx);
      await clearOwnExclusions(ctx);
      await clearKotlinChannel(ctx);
      await clearKlsSupport(ctx, knownKotlinRoots(ctx));
      await resetCppSupport(ctx, (m) => channel.appendLine(m));
      // module picks are written by the picker into the workspace layer
      await vscode.workspace
        .getConfiguration("aosp-nav")
        .update("java.sourceRootModules", undefined, vscode.ConfigurationTarget.Workspace);
      await clearOwnExtraSourceRoots(ctx);
      void vscode.window.showInformationMessage(vscode.l10n.t("[aosp-nav] settings written by the plugin have been rolled back"));
    }),
    vscode.commands.registerCommand(
      "aosp-nav.selectJavaSourceRoots",
      () => selectJavaSourceRootsByModule(ctx, (m) => channel.appendLine(m))
    ),
    vscode.commands.registerCommand("aosp-nav.diagnostics", async () => {
      openOutput(channel);
      // fresh probe (heap dump / OOM trace); falls back to the last scan result
      let crash: JdtlsCrashProbe | null = lastCrashProbe;
      try {
        crash = await probeCrash();
      } catch { /* keep the cached probe */ }
      const lines: DiagLine[] = [];
      const javaExt = vscode.extensions.getExtension("redhat.java");
      lines.push({
        ok: !!javaExt,
        label: "versions",
        detail: `aosp-nav ${ctx.extension.packageJSON.version}, redhat.java ${
          javaExt ? `${javaExt.packageJSON.version} (${javaExt.isActive ? "active" : "inactive"})` : "NOT INSTALLED"
        }`,
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
      const s = root ? sessions.get(root) : undefined;
      /** the window's folder IS the tree root (the only place plugin-wide
       *  switches such as autobuild / importer flags are allowed to matter) */
      const isRootWindow =
        !!root &&
        (vscode.workspace.workspaceFolders ?? []).some(
          (f) => f.uri.scheme === "file" && path.resolve(f.uri.fsPath) === path.resolve(root!)
        );
      lines.push({
        ok: s ? s.phase === "ready" : !!root,
        label: "root",
        detail: root
          ? `${root} (${rootSource ?? "from active editor"})${s ? ` — ${s.phase}, ${s.jars.length} jars` : ", no session yet"}`
          : `not detected (${rootSource ?? "no AOSP file open and no AOSP workspace folder"})`,
      });
      if (s?.meta) {
        const m = s.meta;
        const verify = m.verify
          ? `, cache verified ${m.verify.checked} jar(s)${m.verify.sampled ? " (sampled)" : ""}, missing ${m.verify.missing}`
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
        if (m.jarSource) {
          // Name the common-set modules that have no jar on disk: the count
          // alone ("N unbuilt") left the user guessing what to build.
          const cs = m.jarSource.commonStarved;
          const shownCs = cs.slice(0, 5);
          const csNote = cs.length
            ? `; common set not built: ${shownCs.join(", ")}${cs.length > shownCs.length ? ` +${cs.length - shownCs.length} more` : ""} (run: m ${shownCs.join(" ")})`
            : "";
          const commonLabel = m.jarSource.testSelection
            ? "common set (libcore + annotations + test support)"
            : "common set (libcore + annotations)";
          const stubNote = m.jarSource.stubsKept
            ? "; conflict stubs kept (no framework.jar/core-all.jar in the list, so android.* has no other provider)"
            : "";
          // only when the two disagree: the written array is a separate fact
          // from the planned closure (a stale write, or someone else writing it)
          const rlNow = vscode.workspace.getConfiguration("java").get<unknown>("project.referencedLibraries");
          const rlNowCount = Array.isArray(rlNow)
            ? rlNow.length
            : (rlNow as { include?: string[] })?.include?.length ?? 0;
          const rlNote =
            m.jarSource.mode === "closure" && rlNowCount !== s.jars.length
              ? `; java.project.referencedLibraries holds ${rlNowCount} entries (not this list — reload or check the write warning)`
              : "";
          lines.push({
            ok: m.jarSource.mode === "closure" ? cs.length === 0 && !m.jarSource.stubsKept && !rlNote : null,
            label: "jar source",
            detail: m.jarSource.mode === "closure"
              ? `closure${m.jarSource.auto ? ` (auto ${m.jarSource.auto} module(s) for this folder)` : " of the selected module dirs"} + ${commonLabel}: ${s.jars.length} jars (${m.jarSource.dropped} dropped, ${m.jarSource.rescued} rescued by variant fallback, ${m.jarSource.unmapped} dangling, ${m.jarSource.starved} unbuilt${csNote})${stubNote}${rlNote}`
              : `full-list fallback (${m.jarSource.reason ?? "unspecified"})${stubNote}`,
          });
        }
      }
      const jc = vscode.workspace.getConfiguration("java");
      // sourcePaths: config read only. java.project.getAll/getClasspaths are
      // deliberately not called anywhere — they block for minutes here.
      const sp = jc.get<string[]>("project.sourcePaths") ?? [];
      lines.push({
        ok: sp.length > 0 ? true : null,
        label: "sourcePaths",
        detail: `${sp.length} entries (${ownSourcePaths(ctx).length} managed by aosp-nav; live-synced to the running session, reload only if the server rejects the change)`,
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
      // module picks: report what was ACTUALLY used, not the raw config. A
      // subtree window writes nothing yet auto-selects its modules, and a root
      // window may have had the defaults seeded on the last scan — both used to
      // read as "none selected" here.
      const js = s?.meta?.jarSource;
      const mods = js?.modules ?? [];
      const injected = s?.jars.length ?? 0;
      const modList = (list: string[]) =>
        list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} +${list.length - 3}`;
      let modDetail: string;
      if (mods.length === 0) {
        modDetail = injected === 0
          ? "none (nothing injected)"
          : "none configured; full jar list injected (see jar source)";
      } else if (js?.moduleSource === "auto") {
        modDetail = `not configured; auto-selected ${mods.length} module(s) for this folder (${modList(mods)})`;
      } else if (js?.moduleSource === "default") {
        modDetail = `not configured; defaults applied (${mods.length} module(s): ${modList(mods)})`;
      } else {
        modDetail = `${mods.length} selected (${modList(mods)})`;
      }
      lines.push({
        ok: mods.length > 0 ? true : injected === 0 ? false : null,
        label: "sourceRootModules",
        detail: js ? modDetail : `${cfgNow.javaSourceRootModules.length} configured (no scan yet)`,
      });
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
          // healthy = clangd actually consumes the CDB. cc_deps entries are
          // inert without --compile-commands-dir, so a managed CDB that is not
          // wired stays neutral (null), never a red row.
          ok: cs.origin === "none" ? null : cs.origin === "compdb" || cs.hasCdbFlag ? true : null,
          label: "cpp origin",
          detail: cs.origin === "compdb"
            ? "compdb (clangd native, no entries written)"
            : cs.origin === "cc_deps"
              ? `cc_deps, ${cs.entries} entr(ies)${cs.module ? `, last module ${cs.module}` : ""}${cs.hasCdbFlag ? "" : " — managed CDB not wired (missing --compile-commands-dir in clangd.arguments)"}`
              : cs.origin === "bp"
                ? `Android.bp fallback, ${cs.entries} entr(ies)`
                : "none (no compdb / module_bp_cc_deps.json / Android.bp)",
          action: cs.cdbDir ? `cdb: ${cs.cdbDir}` : undefined,
        });
        const clangdPath = clangdPathSetting();
        const ca = vscode.workspace.getConfiguration("clangd").get<string[]>("arguments") ?? [];
        // Check the actual setting: cs.hasCdbFlag reflects the same array, but
        // printing the flag makes a stale/empty diagnostics root obvious.
        const cdbArg = ca.find((a) => a.startsWith("--compile-commands-dir="));
        lines.push({
          ok: clangdPath ? true : null,
          label: "clangd",
          detail: `${clangdPath ?? '(not set; falls back to "clangd" on PATH)'}${
            !clangdPath && cand ? ` (AOSP prebuilt: ${cand})` : ""
          }, ${ca.length} args${cdbArg ? `, ${cdbArg}` : ", no --compile-commands-dir"}`,
          action: !clangdPath && cand ? "set 'clangd.path' to the AOSP prebuilt (extension bundles none)" : undefined,
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
      {
        const where = (sub: string) => {
          const insp = jc.inspect<unknown>(sub);
          return insp?.workspaceValue === false ? "workspace" : insp?.globalValue === false ? "global" : "unset";
        };
        const g = jc.get<boolean>("import.gradle.enabled");
        const mvn = jc.get<boolean>("import.maven.enabled");
        // Only the root window is affected: a sub-tree window has no gradle /
        // maven project to import. Hide the untouched defaults there.
        if (isRootWindow || g === false || mvn === false) {
          lines.push({
            ok: g === false && mvn === false,
            label: "java import",
            detail: `gradle=${String(g)} (${where("import.gradle.enabled")}), maven=${String(mvn)} (${where(
              "import.maven.enabled"
            )})`,
          });
        }
      }
      // kotlin channel
      const kEnabled = getConfig().kotlinEnabled;
      const kExt = vscode.extensions.getExtension("fwcd.kotlin");
      const kp = root && kEnabled ? await probeKotlinChannel(root) : null;
      const kls = root && kEnabled ? await probeKlsSupport(root, ctx) : null;
      lines.push({
        ok: kEnabled ? (kExt ? (kp ? kp.script === "ours" || kp.script === "family-nvim" : null) : false) : null,
        label: "kotlin",
        detail: kEnabled
          ? `on, fwcd.kotlin=${kExt ? kExt.packageJSON.version : "NOT INSTALLED"}${
              kp
                ? kp.script === "ours"
                  ? `, classpath script ours (${kp.jars} jars)`
                  : kp.script === "family-nvim"
                    ? ", classpath script family (aosp-nav.nvim), taken over on next injection"
                    : kp.script === "user"
                      ? ", classpath script user-managed (aosp-nav will not take over)"
                      : ", classpath script not written"
                : ""
            }`
          : "off (aosp-nav.kotlin.enabled)",
      });
      lines.push({
        ok: kEnabled && kls ? (kls.ls === "fwcd default (deprecated)" ? false : kls.exclusions !== null && kls.gitignore && kls.klsClasspath) : null,
        label: "kotlin ktlsp",
        detail: kEnabled && kls
          ? `LS=${kls.ls}${kls.version ? ` (${kls.version})` : ""}, exclusions=${kls.exclusions === null ? "missing" : `${kls.exclusions} entries`}, gitignore prune=${kls.gitignore ? "present" : "missing"}, kls-classpath=${kls.klsClasspath ? "present" : "missing"}`
          : "off (aosp-nav.kotlin.enabled)",
      });
      const vmargs = vscode.workspace.getConfiguration("java").get<string>("jdt.ls.vmargs") ?? "";
      lines.push(
        crash && crash.confirmed
          ? {
              ok: false,
              label: "jdt.ls",
              detail: `${crash.evidence}${crash.oomSample ? ` — ${crash.oomSample}` : ""}; vmargs: ${vmargs || "(unset)"}`,
              action: "raise java.jdt.ls.vmargs (e.g. -Xmx6G)",
            }
          : {
              ok: null,
              label: "jdt.ls",
              detail: `vmargs: ${vmargs || "(unset)"}`,
              action: vmargs.includes("-Xmx") ? undefined : "add e.g. java.jdt.ls.vmargs: -Xmx6G in user settings",
            }
      );
      {
        const ab = currentAutobuildState(ctx);
        const origin =
          ab.source === "plugin" ? "set by aosp-nav"
          : ab.source === "user-workspace" ? "your workspace setting"
          : ab.source === "user-workspace-folder" ? "your workspace-folder setting"
          : ab.source === "user-global" ? "your global setting"
          : "default (on)";
        // The default is on and the plugin only ever changes a large AOSP root,
        // so on any other window the default says nothing the user can act on.
        // A false value is always worth one line: it silently stops the Eclipse
        // builder, and on a sub-tree window that is the user's own setting.
        const showRow = ab.value === false;
        if (showRow) {
          lines.push({
            ok: false,
            label: "java.autobuild.enabled",
            detail: `false (${origin}${isRootWindow ? "" : "; JDT will not rebuild on save"})`,
            action: ab.source === "plugin" ? "undo with 'AOSP: Reset Plugin Settings'" : undefined,
          });
        }
      }
      // eclipse guard
      const pending = await isCleanPending(ctx);
      const actionNeeded = getBlockedCount();
      for (const r of getLastReports()) {
        const n = r.blockers.length;
        const needsAction = n > 0 && actionNeeded > 0;
        const rootNote = r.rootBlocked
          ? " (workspace root itself has Eclipse metadata: open the AOSP root or a sub-directory as the workspace folder)"
          : "";
        lines.push({
          ok: n === 0 ? (r.rootBlocked ? null : true) : needsAction ? false : null,
          label: `eclipse guard [${path.basename(r.folder)}]`,
          detail: n === 0
            ? r.rootBlocked
              ? "workspace root contains .project — no whole-window exclusion is written for it; open the AOSP root or a sub-directory instead"
              : "no stale .project dirs"
            : needsAction
              ? `${n} blocker(s)${rootNote}, clean+reload pending${pending ? "" : " (not re-armed)"}`
              : `${n} dir(s) already excluded from import (ignored, not blocking)${rootNote}`,
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
      printDiagnostics(channel, lines);
    })
  );

  // session restore: an editor may already be open at activation
  if (vscode.window.activeTextEditor) {
    void onFile(vscode.window.activeTextEditor.document.uri);
  }
}

export function deactivate(): void {}
