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
import { scanJars, isDirectory } from "./infra/fsScan";
import { applyReferencedLibraries, clearOwnWorkspaceLibs } from "./jdtls/settingsChannel";
import { ensureJavaExtension } from "./jdtls/depManager";
import { applyOnce as applyCompat, resetWritten } from "./jdtls/compat";
import { apply as applyHygiene } from "./jdtls/workspaceHygiene";
import { guardWorkspace, cleanAndReload, clearOwnExclusions, getLastReports, isCleanPending } from "./jdtls/eclipseGuard";
import * as status from "./status";
import { invalidateCache } from "./commands/rescan";
import { openOutput, printDiagnostics, DiagLine } from "./commands/diagnostics";

let channel: vscode.OutputChannel;
let defaultsJson: Awaited<ReturnType<typeof loadDefaults>>;
const sessions = new Map<string, { phase: "idle" | "scanning" | "ready" | "failed"; jars: string[] }>();
let running = false;
let firstIndexNotified = false;

export function activate(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("aosp-nav");
  status.initStatus(ctx);
  ctx.subscriptions.push(channel);

  loadDefaults(ctx).then((d) => { defaultsJson = d; });

  // eclipse guard: neutralize stale .project/.classpath dirs that would
  // suppress jdt.ls' invisible project (and thus referencedLibraries).
  // Runs at activation — before or in parallel with redhat.java's import —
  // and again whenever workspace folders change.
  void guardWorkspace(ctx, (m) => channel.appendLine(m));
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void guardWorkspace(ctx, (m) => channel.appendLine(m));
    })
  );

  const runFor = async (root: string): Promise<void> => {
    const s = sessions.get(root) ?? { phase: "idle" as const, jars: [] };
    sessions.set(root, s);
    if (s.phase === "ready" || s.phase === "scanning") return;
    if (running) return;
    running = true;
    s.phase = "scanning";
    status.statusScanning();

    try {
      const cfg = getConfig();
      if (!defaultsJson) defaultsJson = await loadDefaults(ctx);
      const ex = effectiveExclusions(cfg, defaultsJson);
      const fhash = filtersHash(ex);

      if (!(await ensureJavaExtension())) {
        status.statusFailed();
        s.phase = "failed";
        return;
      }
      await applyCompat(ctx, (m) => channel.appendLine(m));
      await applyHygiene(ctx, (m) => channel.appendLine(m));

      // cache
      const cacheFile = path.join(ctx.globalStorageUri.fsPath, `jars-${djb2(root)}.json`);
      let jars: string[] | null = null;
      let fromCache = false;
      try {
        const raw = JSON.parse(await fs.readFile(cacheFile, "utf8")) as CacheFile;
        if (isCacheValid(raw, CACHE_VERSION, fhash)) {
          jars = raw.jars;
          fromCache = true;
        }
      } catch { /* miss */ }

      if (!jars) {
        const baseOk = await isDirectory(path.join(root, "out/soong/.intermediates"))
          || await isDirectory(path.join(root, "out/.soong/.intermediates"));
        if (!baseOk) {
          // make-era or no build outputs
          status.statusNoOut();
          s.phase = "failed";
          running = false;
          return;
        }
        const scan = await scanSoong(root, defaultsJson, new FilterEngine(ex), scanJars);
        if (!scan) {
          status.statusNoOut();
          s.phase = "failed";
          running = false;
          return;
        }
        applyDirPriority(scan.jars, defaultsJson);
        jars = scan.jars;
        await fs.mkdir(ctx.globalStorageUri.fsPath, { recursive: true });
        // two windows of the same aosp root share globalStorage: write via a
        // unique temp file + rename so concurrent scans never interleave
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({
          version: CACHE_VERSION, filtersHash: fhash,
          generatedAt: new Date().toISOString(), jars,
        } as CacheFile));
        await fs.rename(tmp, cacheFile);
      }

      s.jars = jars;
      const res = await applyReferencedLibraries(ctx, cfg.settingsScope, jars, (m) => channel.appendLine(m));
      if (!res.inEffect) {
        // write failed (e.g. settings not writable): keep the session
        // retryable — the next file open tries again instead of dying
        // silently as in 0.1.1
        status.statusFailed();
        s.phase = "failed";
        channel.appendLine(`[aosp-nav] ${root}: referencedLibraries not applied, will retry on next open`);
        return;
      }
      if (res.changed) {
        status.statusIndexing(jars.length);
        if (!firstIndexNotified) {
          firstIndexNotified = true;
          void vscode.window.showInformationMessage(
            `[aosp-nav] 已注入 ${jars.length} 个依赖 jar。Eclipse 首次索引约需 30-60 分钟(一次性), 期间 CPU 高属正常, 请勿重启语言服务。之后每次打开为秒级。`,
            "了解");
        }
      } else {
        status.statusReady(jars.length, fromCache, root);
      }
      s.phase = "ready";
      channel.appendLine(`[aosp-nav] ${root}: ${jars.length} jars (${fromCache ? "cache" : "scan"})`);
    } catch (e) {
      status.statusFailed();
      s.phase = "failed";
      channel.appendLine(`[aosp-nav] error: ${e}`);
    } finally {
      running = false;
    }
  };

  const onFile = async (uri: vscode.Uri | undefined): Promise<void> => {
    if (!uri || uri.scheme !== "file") return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc && doc.languageId !== "java") return;
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
          void (async () => { for (const root of roots) await runFor(root); })();
        }
      }
    }),
    vscode.commands.registerCommand("aosp-nav.rescan", async () => {
      const ae = vscode.window.activeTextEditor;
      if (!ae) { void vscode.window.showWarningMessage("[aosp-nav] 无活动文件"); return; }
      const root = getConfig().androidRoot ?? await detectAospRoot(ae.document.uri.fsPath);
      if (!root) { void vscode.window.showWarningMessage("[aosp-nav] 非 AOSP 文件"); return; }
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
      const n = getLastReports().reduce((a, r) => a + r.blockers.length + (r.rootBlocked ? 1 : 0), 0);
      if (n === 0) {
        void vscode.window.showInformationMessage(
          "[aosp-nav] 没有需要修复的 Eclipse 元数据阻塞 (尚未扫描时请先打开一个 AOSP java 文件)。");
        return;
      }
      await cleanAndReload(ctx, (m) => channel.appendLine(m));
    }),
    vscode.commands.registerCommand("aosp-nav.resetSettings", async () => {
      await resetWritten(ctx);
      await clearOwnWorkspaceLibs(ctx);
      await clearOwnExclusions(ctx);
      void vscode.window.showInformationMessage("[aosp-nav] 插件写入的 settings 已回滚");
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
      const ae = vscode.window.activeTextEditor;
      const root = ae ? (getConfig().androidRoot ?? await detectAospRoot(ae.document.uri.fsPath)) : null;
      lines.push({ ok: !!root, label: "root", detail: root ?? "not detected (open an AOSP java file first)" });
      const s = root ? sessions.get(root) : undefined;
      lines.push({
        ok: s ? s.phase === "ready" : null,
        label: "state",
        detail: s ? `${s.phase}, jars=${s.jars.length}` : "no session",
      });
      const jc = vscode.workspace.getConfiguration("java");
      const rl = jc.get<unknown>("project.referencedLibraries");
      const rlCount = Array.isArray(rl) ? rl.length : (rl as { include?: string[] })?.include?.length ?? 0;
      lines.push({ ok: rlCount > 0, label: "referencedLibraries", detail: `${rlCount} entries` });
      lines.push({ ok: jc.get("import.gradle.enabled") === false, label: "import.gradle.enabled", detail: String(jc.get("import.gradle.enabled")) });
      lines.push({ ok: jc.get("import.maven.enabled") === false, label: "import.maven.enabled", detail: String(jc.get("import.maven.enabled")) });
      const vmargs = vscode.workspace.getConfiguration("java").get<string>("jdt.ls.vmargs") ?? "";
      lines.push({
        ok: vmargs.includes("-Xmx"),
        label: "jdt.ls.vmargs",
        detail: vmargs || "(unset)",
        action: vmargs.includes("-Xmx") ? undefined : "add e.g. java.jdt.ls.vmargs: -Xmx6G ... in user settings",
      });
      // eclipse guard
      const pending = await isCleanPending(ctx);
      for (const r of getLastReports()) {
        const n = r.blockers.length + (r.rootBlocked ? 1 : 0);
        lines.push({
          ok: n === 0,
          label: `eclipse guard [${path.basename(r.folder)}]`,
          detail: n === 0
            ? "no stale .project/.classpath dirs"
            : `${n} blocker(s)${r.rootBlocked ? " (workspace root itself has Eclipse metadata)" : ""}${pending ? ", clean+reload pending" : ""}`,
          action: n > 0 ? "run 'AOSP: Fix Eclipse Metadata Blockers' (one-time clean + reload)" : undefined,
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
