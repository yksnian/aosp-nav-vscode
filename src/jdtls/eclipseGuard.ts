import * as vscode from "vscode";
import { detectAospRoot } from "../androidRoot";
import { GuardReport, patternsFor, scanBlockers } from "./eclipseGuardScan";
import { countBlockers, decideGuardOutcome } from "./guardState";
import { ScanCancelledError, DEFAULT_WALK_CONCURRENCY } from "../infra/fsScan";
import * as status from "../status";

/** vscode glue for the eclipse guard: merges blocker exclusion patterns into
 *  the workspace layer of java.import.exclusions and walks the user through
 *  the one-time clean+reload needed to make them effective (already-imported
 *  projects persist inside the jdt.ls metadata workspace and are only
 *  removed by "Clean Workspace Cache").
 *
 *  Convergence (0.1.7): the blocker dirs stay on disk by design — we only add
 *  exclusions — so counting raw directories made the guard permanent: the
 *  status bar kept advertising "N stale" and every reload re-asked for a
 *  clean+reload that had already been done. The guard now counts what still
 *  needs user action and resolves to 0 once the exclusions are in place and
 *  the one-time clean has happened (or is no longer owed). */

const PENDING_KEY = "aosp-nav.eclipseCleanPending";
const OWN_EXCL_KEY = "aosp-nav.ownExclusions";
/** Patterns the guard has already dealt with (exclusions written + clean
 *  asked). Consecutive sessions keep seeing the same dirs on disk, so this
 *  record is what stops them from asking again. */
const HANDLED_KEY = "aosp-nav.eclipseCleanHandled";
/** Last scan result per workspace folder. The walk is the expensive part of
 *  activation (12 s serial on a real AOSP tree; ~4 s with the shared
 *  concurrency-8 walker), while the dirs it looks for are leftovers from old
 *  buildship sessions and do not churn. 24 h is therefore enough; folder
 *  changes and manual rescans force a fresh scan. */
const CACHE_KEY = "aosp-nav.eclipseGuardCache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedGuard {
  at: number;
  blockers: string[];
  rootBlocked: boolean;
}
type GuardCache = Record<string, CachedGuard>;

export interface GuardOptions {
  /** ignore the cache and rescan every AOSP workspace folder */
  force?: boolean;
}

let lastReports: GuardReport[] = [];
let notifiedThisSession = false;
/** This extension-host session already wrote exclusions or already asked for
 *  the clean. After a reload this is false again — that is how a fresh session
 *  tells "we are the reload that followed the clean" from "we are still the
 *  session that asked". */
let touchedThisSession = false;
/** Blockers still requiring user action; the status bar and the diagnostics
 *  both read this one number. Distinct from the on-disk blocker count, which
 *  stays > 0 after a successful fix. */
let blockedCount = 0;
/** The workspace-root `.project` warning is issued once per session; there is
 *  no action the guard can take for that case, so repeating it every scan
 *  would only be noise. */
let rootWarned = false;

export function getLastReports(): GuardReport[] {
  return lastReports;
}

export function getBlockedCount(): number {
  return blockedCount;
}

export async function isCleanPending(ctx: vscode.ExtensionContext): Promise<boolean> {
  return ctx.workspaceState.get<boolean>(PENDING_KEY) === true;
}

/** The exclusion patterns currently in effect (first layer that is set). */
function effectiveExclusions(): Set<string> {
  const conf = vscode.workspace.getConfiguration("java");
  const inspect = conf.inspect<string[]>("import.exclusions");
  const base = inspect?.workspaceValue ?? inspect?.globalValue ?? inspect?.defaultValue ?? [];
  return new Set(base);
}

/** Merge our patterns into the workspace layer. The base is
 *  workspaceValue ?? globalValue ?? defaultValue so a user's own entries (any
 *  layer) are never lost to the workspace shadow. */
async function mergeExclusions(
  ctx: vscode.ExtensionContext,
  patterns: string[],
  log: (m: string) => void
): Promise<{ added: number; failed: boolean }> {
  const conf = vscode.workspace.getConfiguration("java");
  const inspect = conf.inspect<string[]>("import.exclusions");
  const base = inspect?.workspaceValue ?? inspect?.globalValue ?? inspect?.defaultValue ?? [];
  const baseSet = new Set(base);
  const missing = patterns.filter((p) => !baseSet.has(p));
  if (missing.length === 0) return { added: 0, failed: false };
  try {
    await conf.update("import.exclusions", [...base, ...missing], vscode.ConfigurationTarget.Workspace);
  } catch (e) {
    log(`[aosp-nav] failed to write java.import.exclusions: ${e}`);
    return { added: 0, failed: true };
  }
  const own = ctx.workspaceState.get<string[]>(OWN_EXCL_KEY) ?? [];
  await ctx.workspaceState.update(OWN_EXCL_KEY, [...new Set([...own, ...missing])]);
  return { added: missing.length, failed: false };
}

/** The one-time action: delegate to redhat.java's clean-workspace command (it
 *  asks for its own confirmation, then reloads the window). The pending flag
 *  stays armed across that reload — the next extension-host session reads it
 *  and knows the clean has been dealt with.
 *
 *  There is deliberately no "did the user cancel?" probe: a timer that fires
 *  when the window survives races with the host teardown after a real clean
 *  (which would re-arm the nag forever). Dismissing the confirmation is an
 *  explicit "no" — the command stays available in the palette and the
 *  diagnostics keep reporting the situation. */
export async function cleanAndReload(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void
): Promise<void> {
  await ctx.workspaceState.update(PENDING_KEY, true);
  try {
    await vscode.commands.executeCommand("java.clean.workspace");
  } catch (e) {
    log(`[aosp-nav] java.clean.workspace failed: ${e}`);
  }
  status.setBlocked(blockedCount);
}

function blockerCount(): number {
  return countBlockers(lastReports);
}

async function clearPending(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.workspaceState.update(PENDING_KEY, undefined);
}

/** Scan every workspace folder that belongs to an AOSP tree, neutralize any
 *  eclipse-metadata blockers found, and surface what still needs user action.
 *  Safe to run repeatedly; only notifies once per session. */
export async function guardWorkspace(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void,
  opts: GuardOptions = {}
): Promise<void> {
  const wasPending = await isCleanPending(ctx);
  const handled = new Set(ctx.workspaceState.get<string[]>(HANDLED_KEY) ?? []);

  // collect the AOSP folders first; only those are walked
  const folders: string[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== "file") continue;
    const aosp = await detectAospRoot(f.uri.fsPath);
    if (!aosp) continue; // not an AOSP workspace folder: stay silent
    folders.push(f.uri.fsPath);
  }

  const cache = ctx.workspaceState.get<GuardCache>(CACHE_KEY) ?? {};
  const isFresh = (folder: string): boolean => {
    const c = cache[folder];
    return !!c && Date.now() - c.at < CACHE_TTL_MS;
  };
  const toScan = folders.filter((folder) => opts.force || !isFresh(folder));

  if (toScan.length > 0) {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("AOSP: checking Eclipse metadata"),
          cancellable: true,
        },
        async (progress, token) => {
          for (const folder of toScan) {
            const report = await scanBlockers(folder, {
              concurrency: DEFAULT_WALK_CONCURRENCY,
              shouldCancel: () => token.isCancellationRequested,
              onDirs: (d) =>
                progress.report({ message: `${vscode.workspace.asRelativePath(folder, false)}: ${d}` }),
            });
            cache[folder] = { at: Date.now(), blockers: report.blockers, rootBlocked: report.rootBlocked };
          }
        }
      );
    } catch (e) {
      if (e instanceof ScanCancelledError) {
        log("[aosp-nav] eclipse guard: scan cancelled, will retry on next activation");
        return;
      }
      throw e;
    }
    await ctx.workspaceState.update(CACHE_KEY, cache);
  }

  const reports: GuardReport[] = folders.map((folder) => {
    const c = cache[folder];
    return { folder, blockers: c?.blockers ?? [], rootBlocked: c?.rootBlocked ?? false };
  });
  const patternsNow: string[] = [];
  let addedTotal = 0;
  let uncovered = 0;
  let writeFailed = false;

  for (const report of reports) {
    const patterns = patternsFor(report);
    if (patterns.length === 0) continue;
    patternsNow.push(...patterns);
    const already = effectiveExclusions();
    uncovered += patterns.filter((p) => !already.has(p)).length;
    const res = await mergeExclusions(ctx, patterns, log);
    addedTotal += res.added;
    writeFailed = writeFailed || res.failed;
    if (res.added > 0) {
      log(`[aosp-nav] eclipse guard: excluded ${res.added} metadata dir(s) under ${report.folder}`);
    }
  }
  lastReports = reports;

  // A `.project` in the workspace root cannot be excluded (that would exclude
  // the whole window), so say what actually fixes it instead of writing a
  // useless rule. Once per session.
  const rootBlocked = reports.filter((r) => r.rootBlocked).map((r) => r.folder);
  if (rootBlocked.length > 0 && !rootWarned) {
    rootWarned = true;
    log(
      `[aosp-nav] eclipse guard: workspace root carries .project (${rootBlocked.join(", ")}); open the AOSP root or a sub-directory instead`
    );
    const button = vscode.l10n.t("Show Diagnostics");
    void vscode.window
      .showWarningMessage(
        vscode.l10n.t(
          "[aosp-nav] The workspace folder {0} itself contains a .project file, so jdt.ls imports it as an Eclipse project and the injected jars cannot take effect. Whole-window exclusion is not applied for this case — open the AOSP root or a sub-directory (for example frameworks/base) as the workspace folder instead.",
          rootBlocked.join(", ")
        ),
        button
      )
      .then((pick) => {
        if (pick === button) void vscode.commands.executeCommand("aosp-nav.diagnostics");
      });
  }

  const physical = blockerCount();
  const allHandled = patternsNow.length > 0 && patternsNow.every((p) => handled.has(p));
  const outcome = decideGuardOutcome({
    physical,
    addedTotal,
    writeFailed,
    touchedThisSession,
    wasPending,
    allHandled,
  });

  // The blocker dirs stay on disk after a successful fix (they are excluded,
  // not deleted), so the outcome — not the directory count — is what every
  // status surface reports.
  if (outcome === "clean") {
    await clearPending(ctx);
    await ctx.workspaceState.update(HANDLED_KEY, undefined);
    blockedCount = 0;
    status.setBlocked(0);
    return;
  }
  if (outcome === "converged") {
    await clearPending(ctx);
    await ctx.workspaceState.update(HANDLED_KEY, patternsNow);
    blockedCount = 0;
    status.setBlocked(0);
    log(`[aosp-nav] eclipse guard: ${physical} metadata dir(s) already excluded, clean+reload assumed done`);
    return;
  }

  // Still owed: remember that we asked, so the session after the reload knows
  // the window came back and this one does not start asking again.
  touchedThisSession = true;
  await ctx.workspaceState.update(PENDING_KEY, true);
  blockedCount = physical;
  status.setBlocked(physical);
  log(`[aosp-nav] eclipse guard: ${physical} blocker(s), clean+reload pending (${uncovered} not yet excluded)`);
  if (!notifiedThisSession) {
    notifiedThisSession = true;
    const button = vscode.l10n.t("Clean && Reload");
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "[aosp-nav] Detected {0} Eclipse metadata dir(s) left behind by old jdtls/buildship sessions. They prevent the injected jars from taking effect. Exclusion rules have been written; a one-time clean-and-reload is required (the first Eclipse indexing after the clean takes about 30-60 minutes).",
        physical
      ),
      button
    ).then((pick) => {
      if (pick === button) void cleanAndReload(ctx, log);
    });
  }
}

/** Rollback of everything this guard wrote (aosp-nav.resetSettings). */
export async function clearOwnExclusions(ctx: vscode.ExtensionContext): Promise<void> {
  const own = ctx.workspaceState.get<string[]>(OWN_EXCL_KEY);
  if (own && own.length > 0) {
    const conf = vscode.workspace.getConfiguration("java");
    const ws = conf.inspect<string[]>("import.exclusions")?.workspaceValue;
    if (ws) {
      const ownSet = new Set(own);
      const next = ws.filter((v) => !ownSet.has(v));
      await conf.update(
        "import.exclusions",
        next.length === 0 ? undefined : next,
        vscode.ConfigurationTarget.Workspace
      );
    }
  }
  await ctx.workspaceState.update(OWN_EXCL_KEY, undefined);
  await ctx.workspaceState.update(CACHE_KEY, undefined);
  await clearPending(ctx);
  await ctx.workspaceState.update(HANDLED_KEY, undefined);
  blockedCount = 0;
  touchedThisSession = false;
  notifiedThisSession = false;
  rootWarned = false;
}
