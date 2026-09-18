import * as vscode from "vscode";
import * as path from "path";
import { detectAospRoot } from "../androidRoot";
import { GuardReport, patternsFor, scanBlockers } from "./eclipseGuardScan";
import * as status from "../status";

/** vscode glue for the eclipse guard: merges blocker exclusion patterns into
 *  the workspace layer of java.import.exclusions and walks the user through
 *  the one-time clean+reload needed to make them effective (already-imported
 *  projects persist inside the jdt.ls metadata workspace and are only
 *  removed by "Clean Workspace Cache"). */

const PENDING_KEY = "aosp-nav.eclipseCleanPending";
const OWN_EXCL_KEY = "aosp-nav.ownExclusions";

let lastReports: GuardReport[] = [];
let notifiedThisSession = false;

export function getLastReports(): GuardReport[] {
  return lastReports;
}

export async function isCleanPending(ctx: vscode.ExtensionContext): Promise<boolean> {
  return ctx.workspaceState.get<boolean>(PENDING_KEY) === true;
}

/** Merge our patterns into the workspace layer. The base is
 *  workspaceValue ?? globalValue ?? defaultValue so a user's own entries (any
 *  layer) are never lost to the workspace shadow. Returns count added. */
async function mergeExclusions(
  ctx: vscode.ExtensionContext,
  patterns: string[],
  log: (m: string) => void
): Promise<number> {
  const conf = vscode.workspace.getConfiguration("java");
  const inspect = conf.inspect<string[]>("import.exclusions");
  const base = inspect?.workspaceValue ?? inspect?.globalValue ?? inspect?.defaultValue ?? [];
  const baseSet = new Set(base);
  const missing = patterns.filter((p) => !baseSet.has(p));
  if (missing.length === 0) return 0;
  try {
    await conf.update("import.exclusions", [...base, ...missing], vscode.ConfigurationTarget.Workspace);
  } catch (e) {
    log(`[aosp-nav] failed to write java.import.exclusions: ${e}`);
    return 0;
  }
  const own = ctx.workspaceState.get<string[]>(OWN_EXCL_KEY) ?? [];
  await ctx.workspaceState.update(OWN_EXCL_KEY, [...new Set([...own, ...missing])]);
  return missing.length;
}

/** The one-time action: delegate to redhat.java's clean-workspace command
 *  (it asks for its own confirmation, then reloads the window). If the user
 *  cancels that dialog the window survives, so re-arm the pending flag after
 *  3s; on a real reload the extension host dies and the timer never fires. */
export async function cleanAndReload(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void
): Promise<void> {
  await ctx.workspaceState.update(PENDING_KEY, false);
  try {
    await vscode.commands.executeCommand("java.clean.workspace");
  } catch (e) {
    log(`[aosp-nav] java.clean.workspace failed: ${e}`);
    await ctx.workspaceState.update(PENDING_KEY, true);
    return;
  }
  setTimeout(() => {
    void ctx.workspaceState.update(PENDING_KEY, true).then(() => {
      status.setBlocked(blockerCount());
    });
  }, 3000);
}

function blockerCount(): number {
  return lastReports.reduce((n, r) => n + r.blockers.length + (r.rootBlocked ? 1 : 0), 0);
}

/** Scan every workspace folder that belongs to an AOSP tree, neutralize any
 *  eclipse-metadata blockers found, and surface the pending clean state.
 *  Safe to run repeatedly; only notifies once per session. */
export async function guardWorkspace(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void
): Promise<void> {
  const reports: GuardReport[] = [];
  let addedTotal = 0;
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== "file") continue;
    const aosp = await detectAospRoot(f.uri.fsPath);
    if (!aosp) continue; // not an AOSP workspace folder: stay silent
    const report = await scanBlockers(path.resolve(f.uri.fsPath));
    reports.push(report);
    const patterns = patternsFor(report);
    if (patterns.length === 0) continue;
    const added = await mergeExclusions(ctx, patterns, log);
    addedTotal += added;
    if (added > 0) {
      log(`[aosp-nav] eclipse guard: excluded ${added} metadata dir(s) under ${f.uri.fsPath}`);
    }
  }
  lastReports = reports;

  if (addedTotal > 0) {
    await ctx.workspaceState.update(PENDING_KEY, true);
  }

  const n = blockerCount();
  if (n > 0 && (addedTotal > 0 || (await isCleanPending(ctx)))) {
    status.setBlocked(n);
    log(`[aosp-nav] eclipse guard: ${n} blocker(s), clean+reload pending`);
    if (!notifiedThisSession) {
      notifiedThisSession = true;
      const button = vscode.l10n.t("Clean && Reload");
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "[aosp-nav] Detected {0} Eclipse metadata dir(s) left behind by old jdtls/buildship sessions. They prevent the injected jars from taking effect. Exclusion rules have been written; a one-time clean-and-reload is required (the first Eclipse indexing after the clean takes about 30-60 minutes).",
          n
        ),
        button
      ).then((pick) => {
        if (pick === button) void cleanAndReload(ctx, log);
      });
    }
  } else if (n === 0) {
    status.setBlocked(0);
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
  await ctx.workspaceState.update(PENDING_KEY, undefined);
}
