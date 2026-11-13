import * as vscode from "vscode";
import { record, APPENDED_EXCLUDES as EXCLUDES } from "./compat";

/** One-time hygiene: keep vscode's file watcher/search away from the huge
 *  out/ tree. Idempotent: merges missing entries into the layer
 *  `aosp-nav.settingsScope` selects (workspace when a folder is open, else
 *  global — the workspace layer shadows global for this key, so a global-only
 *  write would be invisible in windows with a workspace-layer value), never
 *  removes user entries. Recorded for rollback via resetSettings. */
export async function apply(
  ctx: vscode.ExtensionContext,
  log: (msg: string) => void
): Promise<void> {
  // [section, key]: files.watcherExclude / search.exclude — note the ORIGINAL
  // bug wrote search.exclude through getConfiguration("files"), producing the
  // bogus key files.search.exclude.
  const targets: Array<[string, string]> = [
    ["files", "watcherExclude"],
    ["search", "exclude"],
  ];
  const hasFolder = !!vscode.workspace.workspaceFolders?.length;
  for (const [section, key] of targets) {
    const conf = vscode.workspace.getConfiguration(section);
    const insp = conf.inspect<Record<string, boolean>>(key);
    const base = hasFolder
      ? insp?.workspaceValue ?? insp?.globalValue ?? {}
      : insp?.globalValue ?? {};
    const missing = EXCLUDES.filter((e) => !(e in base));
    if (missing.length === 0) continue;
    const next = { ...base };
    for (const e of missing) next[e] = true;
    try {
      await conf.update(key, next, hasFolder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
      await record(ctx, `${section}.${key}`, hasFolder ? "workspace" : "global");
    } catch (err) {
      log(`[aosp-nav] warn: failed to write ${section}.${key}: ${err}`);
    }
  }
}
