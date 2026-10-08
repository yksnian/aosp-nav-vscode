import * as vscode from "vscode";
import * as path from "path";
import { detectAospRoot } from "../androidRoot";
import { GuardReport, patternsFor, scanBlockers } from "./eclipseGuardScan";
import { countBlockers, decideGuardOutcome } from "./guardState";
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
  log: (m: string) => void
): Promise<void> {
  const wasPending = await isCleanPending(ctx);
  const handled = new Set(ctx.workspaceState.get<string[]>(HANDLED_KEY) ?? []);

  const reports: GuardReport[] = [];
  const patternsNow: string[] = [];
  let addedTotal = 0;
  let uncovered = 0;
  let writeFailed = false;

  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== "file") continue;
    const aosp = await detectAospRoot(f.uri.fsPath);
    if (!aosp) continue; // not an AOSP workspace folder: stay silent
    const report = await scanBlockers(path.resolve(f.uri.fsPath));
    reports.push(report);
    const patterns = patternsFor(report);
    if (patterns.length === 0) continue;
    patternsNow.push(...patterns);
    const already = effectiveExclusions();
    uncovered += patterns.filter((p) => !already.has(p)).length;
    const res = await mergeExclusions(ctx, patterns, log);
    addedTotal += res.added;
    writeFailed = writeFailed || res.failed;
    if (res.added > 0) {
      log(`[aosp-nav] eclipse guard: excluded ${res.added} metadata dir(s) under ${f.uri.fsPath}`);
    }
  }
  lastReports = reports;

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
  await clearPending(ctx);
  await ctx.workspaceState.update(HANDLED_KEY, undefined);
  blockedCount = 0;
  touchedThisSession = false;
  notifiedThisSession = false;
}
