import * as vscode from "vscode";
import { record } from "./compat";

const EXCLUDES = ["**/out/**", "**/.repo/**"];

/** One-time hygiene: keep vscode's file watcher/search away from the huge
 *  out/ tree. Idempotent: merges missing entries into the GLOBAL layer only,
 *  never removes user entries. Recorded for rollback via resetSettings. */
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
  for (const [section, key] of targets) {
    const conf = vscode.workspace.getConfiguration(section);
    const cur = conf.inspect<Record<string, boolean>>(key)?.globalValue ?? {};
    const missing = EXCLUDES.filter((e) => !(e in cur));
    if (missing.length === 0) continue;
    const next = { ...cur };
    for (const e of missing) next[e] = true;
    try {
      await conf.update(key, next, vscode.ConfigurationTarget.Global);
      await record(ctx, `${section}.${key}`);
    } catch (err) {
      log(`[aosp-nav] warn: failed to write ${section}.${key}: ${err}`);
    }
  }
}
