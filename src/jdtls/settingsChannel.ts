import * as vscode from "vscode";

export interface ApplyResult { changed: boolean; written: number; }

/** Write java.project.referencedLibraries. Skips the write when content is
 *  unchanged (avoids a needless jdtls project reload). */
export async function applyReferencedLibraries(
  scope: "global" | "workspace",
  jars: string[]
): Promise<ApplyResult> {
  const jc = vscode.workspace.getConfiguration("java");
  const current = jc.get<{ include?: string[] } | string[]>("project.referencedLibraries");

  // normalize current for comparison (accept both legacy array and object form)
  const curInclude = Array.isArray(current) ? current : (current?.include ?? []);
  const same =
    curInclude.length === jars.length &&
    curInclude.every((v, i) => v === jars[i]);
  if (same) return { changed: false, written: jars.length };

  const target = scope === "workspace"
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  if (scope === "workspace") {
    // visible side effect on the repo: confirm once (U4)
    const proceed = await vscode.window.showWarningMessage(
      "[aosp-nav] 将在当前工作区创建/修改 .vscode/settings.json (referencedLibraries)",
      "继续", "取消");
    if (proceed !== "继续") return { changed: false, written: 0 };
  }

  await jc.update("project.referencedLibraries", { include: jars }, target);
  return { changed: true, written: jars.length };
}
