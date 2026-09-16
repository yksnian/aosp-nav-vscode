import * as vscode from "vscode";

const EXCLUDES = ["**/out/**", "**/.repo/**"];

/** One-time hygiene: keep vscode's file watcher/search away from the huge out/
 *  tree. Idempotent: merges missing entries, never removes user entries. */
export async function apply(root: string): Promise<void> {
  const targets: Array<[string, string]> = [
    ["files.watcherExclude", "**/out/**"],
    ["files.watcherExclude", "**/.repo/**"],
    ["search.exclude", "**/out/**"],
    ["search.exclude", "**/.repo/**"],
  ];
  const jc = vscode.workspace.getConfiguration(undefined, vscode.Uri.file(root));
  for (const [key, value] of targets) {
    const inspect = jc.inspect<Record<string, boolean>>(key);
    const cur = inspect?.globalValue ?? inspect?.defaultValue ?? {};
    if (!(value in cur)) {
      const next = { ...cur, [value]: true };
      await vscode.workspace.getConfiguration("files").update(
        key.split(".")[1] === "watcherExclude" ? "watcherExclude" : "search.exclude",
        next, vscode.ConfigurationTarget.Global);
    }
  }
}
