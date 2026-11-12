import * as path from "path";
import * as vscode from "vscode";
import { detectAospRoot } from "../androidRoot";
import { getConfig } from "../config";
import { isDirectory } from "../infra/fsScan";
import { djb2 } from "../infra/hash";
import { planSourcePaths, resolveSourceRoots, sameList } from "./sourceRootsPlan";
import { autoModulesForFolder, loadJavaModuleIndex, scopedImportExclusions, selectedFirstPartyRoots } from "./moduleRoots";

/** `java.project.sourcePaths` injection for AOSP workspaces.
 *
 *  Why: with the invisible project, go-to-definition for types that live in
 *  another module lands in the decompiled `jdt://` view of the injected jar.
 *  Explicitly declaring source roots puts the real `.java` files ahead of the
 *  library entries, so the same jump lands in editable sources (verified on a
 *  real tree: `ArrayUtils.` inside Settings resolves to
 *  `frameworks/base/core/java/com/android/internal/util/ArrayUtils.java`).
 *
 *  Coverage is deliberately partial (v1): the configured list plus user
 *  entries. An AOSP-root window with no written module selection gets the two
 *  default modules persisted first (seedDefaultModuleSelection in
 *  modulePicker.ts), so picker state and injection share one config.
 *  Injecting sourcePaths turns
 *  off jdt.ls' per-file source inference, so modules NOT listed lose *source*
 *  navigation — jar navigation still works. Never write the whole tree: a real
 *  AOSP checkout has 210k packaged files and an 8.4k source-root union.
 *
 *  Timing: sourcePaths are read by jdt.ls when the invisible project is
 *  CREATED. A project that already exists (any workspace indexed by an older
 *  plugin version) keeps its old entries and its old link folders: a runtime
 *  preference change alone adds classpath entries WITHOUT the underlying
 *  resource infos, and the model dead-ends in "does not exist" — which is why
 *  reloads never fixed stale workspaces. applySourceRoots therefore also
 *  syncs the RUNNING session through the raw jdt.ls commands
 *  java.project.listSourcePaths / addToSourcePath / removeFromSourcePath,
 *  forwarded by redhat.java's `java.execute.workspaceCommand` (it awaits a
 *  pending client start and returns the server's raw response; undefined when
 *  no client is initialized). Readiness is redhat.java's exported
 *  `serverReady()` promise, resolved by jdt.ls' `ServiceReady` notification —
 *  never a fixed retry count. The `*.command` wrappers are UI commands: they
 *  return nothing (listSourcePaths opens a Quick Pick) and add/remove pop one
 *  information message per root.
 *  java.project.getAll / getClasspaths remain forbidden from activation or
 *  diagnostics: on a real AOSP tree those hang for minutes.
 *
 *  Scope: always the workspace layer. Absolute AOSP paths must not leak into
 *  the user's global `java.project.sourcePaths` (they would be evaluated in
 *  every other Java project). */

const OWN_KEY = "aosp-nav.ownSourcePaths";

export interface SourceRootsApplyResult {
  changed: boolean;
  failed: boolean;
  written: number;
  added: number;
  removed: number;
  /** configured entries that do not exist on disk (logged, skipped) */
  missing: string[];
  /** this apply's desired roots, absolute (for the runtime sync) */
  desiredAbs: string[];
  /** roots this extension wrote in the PREVIOUS workspace list, resolved
   *  absolute — the only subset the runtime sync may remove (hand-written
   *  user entries are never touched) */
  previousAbs: string[];
  /** configured roots skipped because they fall outside their window */
  skippedOutside: number;
  /** the soong build index was needed but missing */
  noIndex: boolean;
}

export function ownSourcePaths(ctx: vscode.ExtensionContext): string[] {
  return ctx.workspaceState.get<string[]>(OWN_KEY) ?? [];
}

/** Collect the configured roots of every AOSP workspace folder. Multi-root
 *  windows get the union: the workspace layer is shared by the whole window.
 *  `explicitModules` is the user-picked `aosp-nav.java.sourceRootModules`
 *  (null = never written: fall back to per-folder auto selection). Derived
 *  first-party roots from the soong build index join the hand-written roots;
 *  entries outside the folder are still skipped by the rel-path check below. */
async function collectDesired(
  configured: string[],
  cfgRoot: string | null,
  explicitModules: readonly string[] | null,
  importExclusions: readonly string[],
  oldEntries: readonly string[],
  log: (m: string) => void
): Promise<{
  paths: string[];
  absPaths: string[];
  previousAbs: string[];
  missing: string[];
  skippedOutside: number;
  noIndex: boolean;
}> {
  const paths: string[] = [];
  const absPaths: string[] = [];
  const previousAbs: string[] = [];
  const missing: string[] = [];
  let skippedOutside = 0;
  let noIndex = false;
  // loaded once per apply; undefined = not attempted yet, null = no build index
  let index: Awaited<ReturnType<typeof loadJavaModuleIndex>> | undefined;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const root = cfgRoot ?? (await detectAospRoot(folder.uri.fsPath));
    if (!root) continue; // not part of an AOSP tree: leave its settings alone
    for (const e of oldEntries) {
      const abs = path.isAbsolute(e) ? path.normalize(e) : path.resolve(root, e);
      if (!previousAbs.includes(abs)) previousAbs.push(abs);
    }
    let entries = configured;
    let modules: readonly string[] | null = explicitModules;
    if (modules === null) {
      // The module picker runs BEFORE injection and its root-window default is
      // PERSISTED by seedDefaultModuleSelection(), so by the time we get here a
      // root window either has that selection or the user cleared it. No
      // implicit special case here: one config drives picker and injection.
      if (path.relative(path.resolve(folder.uri.fsPath), path.resolve(root)) === "") {
        modules = [];
      } else {
        if (index === undefined) index = await loadJavaModuleIndex(root, log);
        if (index) {
          // entries covering the folder itself (guard rootBlocked leftovers)
          // carry no per-subdir intent and must not filter everything out
          const scopedExcl = scopedImportExclusions(importExclusions, [folder.uri.fsPath]);
          modules = autoModulesForFolder(index, root, folder.uri.fsPath, scopedExcl);
          log(`[aosp-nav] sourcePaths: auto-selected ${modules.length} module(s) for ${folder.uri.fsPath}`);
        } else {
          modules = [];
          noIndex = true;
        }
      }
    }
    if (modules.length > 0) {
      if (index === undefined) index = await loadJavaModuleIndex(root, log);
      if (index) {
        entries = [...configured, ...selectedFirstPartyRoots(index, modules, log)];
      } else {
        noIndex = true;
        log(
          `[aosp-nav] sourcePaths: ${modules.length} module(s) selected but ` +
            `${root}/out/soong/module_bp_java_deps.json not found (build the tree first)`
        );
      }
    }
    const r = await resolveSourceRoots(root, entries, isDirectory);
    for (const p of r.paths) {
      if (!absPaths.includes(p)) absPaths.push(p);
      // jdt.ls (InvisibleProjectImporter.getSourcePaths) rejects any absolute
      // entry, so write paths relative to *this* workspace folder.
      const rel = path.relative(folder.uri.fsPath, p).split(path.sep).join("/");
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        log(`[aosp-nav] sourcePaths: ${p} is outside ${folder.uri.fsPath}, skipped`);
        skippedOutside++;
        continue;
      }
      if (!paths.includes(rel)) paths.push(rel);
    }
    for (const p of r.missing) if (!missing.includes(p)) missing.push(p);
  }
  if (missing.length > 0) {
    log(`[aosp-nav] sourcePaths: ${missing.length} configured root(s) do not exist, skipped: ${missing.join(", ")}`);
  }
  return { paths, absPaths, previousAbs, missing, skippedOutside, noIndex };
}

/** Merge the configured roots into the workspace layer of
 *  `java.project.sourcePaths`. Returns changed=false when the effective list
 *  already matches (no reload prompt in that case). */
export async function applySourceRoots(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void
): Promise<SourceRootsApplyResult> {
  const cfg = getConfig();
  // explicit picks win once written (even an empty list = "none"); otherwise
  // auto selection derives the per-window default set from the build index
  const modInsp = vscode.workspace.getConfiguration("aosp-nav").inspect<string[]>("java.sourceRootModules");
  const explicitModules = modInsp?.workspaceValue ?? modInsp?.globalValue ?? null;
  // the unified "do not import" list: auto selection and the module picker
  // both keep their hands off these dirs (user decision 2026-11-10)
  const jInsp = vscode.workspace.getConfiguration("java").inspect<string[]>("import.exclusions");
  const importExclusions = jInsp?.workspaceValue ?? jInsp?.globalValue ?? jInsp?.defaultValue ?? [];
  const jc = vscode.workspace.getConfiguration("java");
  const inspect = jc.inspect<string[]>("project.sourcePaths");
  const ws = inspect?.workspaceValue;
  // copy an existing global user list into the workspace layer instead of
  // shadowing it away; if there is none, start from an empty list
  const base = ws ?? inspect?.globalValue ?? inspect?.defaultValue ?? [];
  const own = ownSourcePaths(ctx);
  // previousAbs comes from OUR entries only: the runtime sync must never
  // remove a root the user wrote by hand (it would silently disable it until
  // the next reload, while the setting still shows it).
  const { paths: desired, absPaths: desiredAbs, previousAbs, missing, skippedOutside, noIndex } = await collectDesired(
    cfg.javaSourceRoots,
    cfg.androidRoot,
    explicitModules,
    importExclusions,
    own,
    log
  );
  const plan = planSourcePaths(base, own, desired);

  const unchanged = ws === undefined ? plan.next.length === 0 : sameList(plan.next, ws);
  if (unchanged) {
    log(`[aosp-nav] sourcePaths: ${plan.next.length} entr(ies) already applied`);
    return {
      changed: false,
      failed: false,
      written: plan.next.length,
      added: 0,
      removed: 0,
      missing,
      desiredAbs,
      previousAbs,
      skippedOutside,
      noIndex,
    };
  }

  try {
    await jc.update(
      "project.sourcePaths",
      plan.next.length === 0 ? undefined : plan.next,
      vscode.ConfigurationTarget.Workspace
    );
  } catch (e) {
    log(`[aosp-nav] failed to write java.project.sourcePaths: ${e}`);
    return {
      changed: false,
      failed: true,
      written: 0,
      added: 0,
      removed: 0,
      missing,
      desiredAbs,
      previousAbs,
      skippedOutside,
      noIndex,
    };
  }
  await ctx.workspaceState.update(OWN_KEY, plan.own);
  log(
    `[aosp-nav] sourcePaths written to workspace layer: ${plan.next.length} entries ` +
      `(${plan.added} added, ${plan.removed} removed; live sync follows)`
  );
  return {
    changed: true,
    failed: false,
    written: plan.next.length,
    added: plan.added,
    removed: plan.removed,
    missing,
    desiredAbs,
    previousAbs,
    skippedOutside,
    noIndex,
  };
}

/** Raw jdt.ls commands, forwarded by redhat.java's
 *  `java.execute.workspaceCommand`: it awaits a pending client start and
 *  returns the server's raw response, or undefined when no client exists.
 *  The `*.command` wrappers are UI commands — `listSourcePaths.command` opens
 *  a Quick Pick and returns nothing, so its resolved value is undefined even
 *  when jdt.ls is fully ready. */
const JAVA_WS_CMD = "java.execute.workspaceCommand";

interface SourcePathReply {
  status?: boolean;
  message?: string;
  data?: { path?: string }[];
}

/** jdt.ls reports roots as file system paths or `file://` URIs, sometimes with
 *  a trailing separator; compare them in one shape. */
function normalizeRoot(p: string): string {
  let s = p;
  if (s.startsWith("file://")) {
    try {
      s = vscode.Uri.parse(s).fsPath;
    } catch {
      s = s.slice("file://".length);
    }
  }
  return s.replace(/[\\/]+$/, "");
}

async function callJavaCommand<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
  return (await vscode.commands.executeCommand(JAVA_WS_CMD, command, ...args)) as T | undefined;
}

/** The part of redhat.java's exported API used here (client/src/api.ts).
 *  `serverReady()` resolves on jdt.ls' `ServiceReady` notification — the same
 *  event behind the extension's own "ready" state; `serverMode` tells whether
 *  workspace commands exist at all (LightWeight answers them with a warning). */
interface JavaExtApi {
  serverMode?: string;
  serverReady?: () => Promise<void>;
}

type JavaReadiness = "ready" | "inactive" | "lightweight";

async function waitForJavaServer(log: (m: string) => void): Promise<JavaReadiness> {
  const ext = vscode.extensions.getExtension("redhat.java");
  if (!ext) {
    log("[aosp-nav] sourcePaths: redhat.java is not installed; live sync skipped");
    return "inactive";
  }
  if (!ext.isActive) {
    // no invisible project yet: the workspace-layer write is read on import,
    // so there is nothing to sync and nothing to reload
    log("[aosp-nav] sourcePaths: redhat.java has not started; the roots are read when it imports");
    return "inactive";
  }
  const api = ext.exports as JavaExtApi | undefined;
  if (api?.serverMode === "LightWeight") {
    log(
      "[aosp-nav] sourcePaths: the java server runs in LightWeight mode (no workspace import); " +
        "workspace commands are unavailable, the roots apply on the next import"
    );
    return "lightweight";
  }
  if (typeof api?.serverReady === "function") {
    log("[aosp-nav] sourcePaths: waiting for jdt.ls ServiceReady, then syncing the running session");
    await api.serverReady();
  }
  return "ready";
}

/** Push the desired roots into the RUNNING session. `listSourcePaths` reads
 *  classpath entries only (cheap, unlike getAll/getClasspaths). */
async function syncSourcePathsAtRuntime(
  desiredAbs: readonly string[],
  removableAbs: readonly string[],
  log: (m: string) => void
): Promise<"ok" | "unavailable" | "failed"> {
  let reply: SourcePathReply | undefined;
  try {
    reply = await callJavaCommand<SourcePathReply>("java.project.listSourcePaths");
  } catch (e) {
    log(`[aosp-nav] sourcePaths: live sync unavailable (java.project.listSourcePaths: ${e})`);
    return "unavailable";
  }
  if (!reply || reply.status === false || !Array.isArray(reply.data)) {
    log(
      `[aosp-nav] sourcePaths: live sync unavailable (${reply?.message ?? "jdt.ls did not answer the workspace command"})`
    );
    return "unavailable";
  }
  const current = reply.data.map((x) => x.path).filter((p): p is string => typeof p === "string");
  const have = new Set(current.map(normalizeRoot));
  const want = new Set(desiredAbs.map(normalizeRoot));
  const removable = new Set(removableAbs.map(normalizeRoot));
  let ok = true;
  for (const p of desiredAbs) {
    if (have.has(normalizeRoot(p))) continue;
    const r = await callJavaCommand<SourcePathReply>(
      "java.project.addToSourcePath",
      vscode.Uri.file(p).toString()
    );
    if (!r || r.status === false) {
      log(`[aosp-nav] sourcePaths: live add failed for ${p}: ${r?.message ?? "no answer from jdt.ls"}`);
      ok = false;
    }
  }
  for (const p of removableAbs) {
    const key = normalizeRoot(p);
    if (want.has(key) || !have.has(key)) continue;
    const r = await callJavaCommand<SourcePathReply>(
      "java.project.removeFromSourcePath",
      vscode.Uri.file(p).toString()
    );
    if (!r || r.status === false) {
      log(`[aosp-nav] sourcePaths: live remove failed for ${p}: ${r?.message ?? "no answer from jdt.ls"}`);
      ok = false;
    }
  }
  return ok ? "ok" : "failed";
}

/** Roots waiting for a live sync; while a runner is active, newer roots
 *  replace the pending job instead of stacking up. */
let pendingSync: { desired: string[]; removable: string[] } | null = null;
let syncRunning = false;
/** One UI notice per session each for "could not write" and "ended up empty". */
let brokenNotified = false;
let emptyNotified = false;

const RELOAD_PROMPT_KEY = "aosp-nav.reloadPromptHash";

function promptReload(ctx: vscode.ExtensionContext, roots: readonly string[]): void {
  // Dedupe ACROSS window reloads: a systematic rejection must not re-ask every
  // session. Keyed by the written list, so a real change asks once again.
  const hash = djb2(roots.join("\n"));
  if (ctx.workspaceState.get<string>(RELOAD_PROMPT_KEY) === hash) return;
  void ctx.workspaceState.update(RELOAD_PROMPT_KEY, hash);
  const button = vscode.l10n.t("Reload Window");
  void vscode.window
    .showInformationMessage(
      vscode.l10n.t(
        "[aosp-nav] java.project.sourcePaths updated ({0} entries). Reload the window so jdt.ls picks them up; go-to-definition then lands in .java sources for the listed roots (modules not listed keep jar navigation only).",
        roots.length
      ),
      button
    )
    .then((pick) => {
      if (pick === button) void vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
}

/** Visible, actionable feedback when the workspace write failed. */
function notifyWriteFailed(): void {
  if (brokenNotified) return;
  brokenNotified = true;
  const button = vscode.l10n.t("Show Diagnostics");
  void vscode.window
    .showWarningMessage(
      vscode.l10n.t(
        "[aosp-nav] java.project.sourcePaths could not be written to the workspace settings. Go-to-definition keeps using jars for the modules that are not listed."
      ),
      button
    )
    .then((pick) => {
      if (pick === button) void vscode.commands.executeCommand("aosp-nav.diagnostics");
    });
}

/** Visible, actionable feedback when this window ends up with 0 source roots
 *  (configured roots outside the window, missing on disk, or no build index). */
function notifyEmptySourcePaths(): void {
  if (emptyNotified) return;
  emptyNotified = true;
  const pick = vscode.l10n.t("Select modules");
  const diag = vscode.l10n.t("Show Diagnostics");
  void vscode.window
    .showWarningMessage(
      vscode.l10n.t(
        "[aosp-nav] This window has 0 Java source roots (configured roots are outside this window or missing, or no module is selected). Go-to-definition keeps using jars. Pick modules for this folder, or run diagnostics."
      ),
      pick,
      diag
    )
    .then((p) => {
      if (p === pick) void vscode.commands.executeCommand("aosp-nav.selectJavaSourceRoots");
      else if (p === diag) void vscode.commands.executeCommand("aosp-nav.diagnostics");
    });
}

async function runLiveSync(ctx: vscode.ExtensionContext, log: (m: string) => void): Promise<void> {
  if (syncRunning) return;
  syncRunning = true;
  try {
    while (pendingSync) {
      const job = pendingSync;
      pendingSync = null;
      let readiness: JavaReadiness;
      try {
        readiness = await waitForJavaServer(log);
      } catch (e) {
        log(`[aosp-nav] sourcePaths: waiting for jdt.ls failed: ${e}`);
        return;
      }
      if (readiness !== "ready") return; // already logged; config applies on import
      let r: "ok" | "unavailable" | "failed" = "failed";
      try {
        r = await syncSourcePathsAtRuntime(job.desired, job.removable, log);
      } catch (e) {
        log(`[aosp-nav] sourcePaths: live sync failed: ${e}`);
      }
      if (r === "ok") {
        log(`[aosp-nav] sourcePaths applied to the running session (${job.desired.length} root(s), no reload needed)`);
        continue;
      }
      // the server is up but rejected the commands: the workspace-layer write
      // is still correct, it just needs a reload to be imported
      promptReload(ctx, job.desired);
      return;
    }
  } finally {
    syncRunning = false;
  }
}

/** Remove only the entries this extension wrote (aosp-nav.resetSettings). */
export async function clearOwnSourcePaths(ctx: vscode.ExtensionContext): Promise<void> {
  const own = ownSourcePaths(ctx);
  if (own.length > 0) {
    const jc = vscode.workspace.getConfiguration("java");
    const ws = jc.inspect<string[]>("project.sourcePaths")?.workspaceValue;
    if (ws) {
      const ownSet = new Set(own);
      const next = ws.filter((p) => !ownSet.has(p));
      await jc.update(
        "project.sourcePaths",
        next.length === 0 ? undefined : next,
        vscode.ConfigurationTarget.Workspace
      );
    }
  }
  await ctx.workspaceState.update(OWN_KEY, undefined);
}

/** Apply sourcePaths (workspace layer) and hand the resulting roots to the
 *  background live sync, which waits for jdt.ls' own readiness signal and then
 *  pushes them into the running session (see runLiveSync). Shared by the scan
 *  path and the module picker so the logic exists exactly once. */
export async function applySourceRootsAndPromptReload(ctx: vscode.ExtensionContext, log: (m: string) => void): Promise<void> {
  try {
    const sp = await applySourceRoots(ctx, log);
    // silent failures are the worst kind here: the user only sees jars
    if (sp.failed) notifyWriteFailed();
    else if (sp.written === 0 && (sp.skippedOutside > 0 || sp.missing.length > 0 || sp.noIndex)) {
      notifyEmptySourcePaths();
    }
    // fire-and-forget: on a real AOSP tree ServiceReady can be many minutes
    // into the import, and the caller (scan completion) must not block on it
    pendingSync = { desired: sp.desiredAbs, removable: sp.previousAbs };
    void runLiveSync(ctx, log);
  } catch (e) {
    log(`[aosp-nav] sourcePaths: ${e}`);
  }
}
