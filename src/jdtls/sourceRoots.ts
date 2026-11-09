import * as path from "path";
import * as vscode from "vscode";
import { detectAospRoot } from "../androidRoot";
import { getConfig } from "../config";
import { isDirectory } from "../infra/fsScan";
import { planSourcePaths, resolveSourceRoots, sameList } from "./sourceRootsPlan";

/** `java.project.sourcePaths` injection for AOSP workspaces.
 *
 *  Why: with the invisible project, go-to-definition for types that live in
 *  another module lands in the decompiled `jdt://` view of the injected jar.
 *  Explicitly declaring source roots puts the real `.java` files ahead of the
 *  library entries, so the same jump lands in editable sources (verified on a
 *  real tree: `ArrayUtils.` inside Settings resolves to
 *  `frameworks/base/core/java/com/android/internal/util/ArrayUtils.java`).
 *
 *  Coverage is deliberately partial (v1): the configured list (default
 *  `frameworks/base/core/java`) plus user entries. Injecting sourcePaths turns
 *  off jdt.ls' per-file source inference, so modules NOT listed lose *source*
 *  navigation — jar navigation still works. Never write the whole tree: a real
 *  AOSP checkout has 210k packaged files and an 8.4k source-root union.
 *
 *  Timing: sourcePaths are read when the workspace is imported. Writing them
 *  at runtime has no effect on the running session, so the caller must offer
 *  a window reload (see extension.ts). Do NOT try to force a refresh through
 *  `java.project.updateSourcePath`-style APIs, and never call
 *  `java.project.getAll` / `getClasspaths` from activation or diagnostics: on
 *  a real AOSP tree those hang for minutes.
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
}

export function ownSourcePaths(ctx: vscode.ExtensionContext): string[] {
  return ctx.workspaceState.get<string[]>(OWN_KEY) ?? [];
}

/** Collect the configured roots of every AOSP workspace folder. Multi-root
 *  windows get the union: the workspace layer is shared by the whole window. */
async function collectDesired(
  configured: string[],
  cfgRoot: string | null,
  log: (m: string) => void
): Promise<{ paths: string[]; missing: string[] }> {
  const paths: string[] = [];
  const missing: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const root = cfgRoot ?? (await detectAospRoot(folder.uri.fsPath));
    if (!root) continue; // not part of an AOSP tree: leave its settings alone
    const r = await resolveSourceRoots(root, configured, isDirectory);
    for (const p of r.paths) {
      // jdt.ls (InvisibleProjectImporter.getSourcePaths) rejects any absolute
      // entry, so write paths relative to *this* workspace folder.
      const rel = path.relative(folder.uri.fsPath, p).split(path.sep).join("/");
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        log(`[aosp-nav] sourcePaths: ${p} is outside ${folder.uri.fsPath}, skipped`);
        continue;
      }
      if (!paths.includes(rel)) paths.push(rel);
    }
    for (const p of r.missing) if (!missing.includes(p)) missing.push(p);
  }
  if (missing.length > 0) {
    log(`[aosp-nav] sourcePaths: ${missing.length} configured root(s) do not exist, skipped: ${missing.join(", ")}`);
  }
  return { paths, missing };
}

/** Merge the configured roots into the workspace layer of
 *  `java.project.sourcePaths`. Returns changed=false when the effective list
 *  already matches (no reload prompt in that case). */
export async function applySourceRoots(
  ctx: vscode.ExtensionContext,
  configured: string[],
  log: (m: string) => void
): Promise<SourceRootsApplyResult> {
  const cfg = getConfig();
  const { paths: desired, missing } = await collectDesired(configured, cfg.androidRoot, log);
  const jc = vscode.workspace.getConfiguration("java");
  const inspect = jc.inspect<string[]>("project.sourcePaths");
  const ws = inspect?.workspaceValue;
  // copy an existing global user list into the workspace layer instead of
  // shadowing it away; if there is none, start from an empty list
  const base = ws ?? inspect?.globalValue ?? inspect?.defaultValue ?? [];
  const plan = planSourcePaths(base, ownSourcePaths(ctx), desired);

  const unchanged = ws === undefined ? plan.next.length === 0 : sameList(plan.next, ws);
  if (unchanged) {
    log(`[aosp-nav] sourcePaths: ${plan.next.length} entr(ies) already applied`);
    return { changed: false, failed: false, written: plan.next.length, added: 0, removed: 0, missing };
  }

  try {
    await jc.update(
      "project.sourcePaths",
      plan.next.length === 0 ? undefined : plan.next,
      vscode.ConfigurationTarget.Workspace
    );
  } catch (e) {
    log(`[aosp-nav] failed to write java.project.sourcePaths: ${e}`);
    return { changed: false, failed: true, written: 0, added: 0, removed: 0, missing };
  }
  await ctx.workspaceState.update(OWN_KEY, plan.own);
  log(
    `[aosp-nav] sourcePaths written to workspace layer: ${plan.next.length} entries ` +
      `(${plan.added} added, ${plan.removed} removed; reload required)`
  );
  return {
    changed: true,
    failed: false,
    written: plan.next.length,
    added: plan.added,
    removed: plan.removed,
    missing,
  };
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
