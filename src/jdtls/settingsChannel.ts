import * as vscode from "vscode";

export interface ApplyResult {
  changed: boolean; // a write happened this call
  inEffect: boolean; // the effective config now equals jars
  written: number;
}

/** workspaceState key recording the exact jar list this extension last wrote
 *  to the WORKSPACE layer. Used to recognize (and later un-shadow) our own
 *  writes when the user switches settingsScope to global — without ever
 *  touching a list the user authored themselves. */
const OWN_WS_KEY = "aosp-nav.ownWorkspaceLibs";

function includeOf(v: unknown): string[] {
  return Array.isArray(v) ? v : ((v as { include?: string[] } | undefined)?.include ?? []);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Write java.project.referencedLibraries with NO user interaction.
 *
 *  Design notes (0.1.2):
 *  - skip the write when the effective value already matches (avoids a
 *    needless jdtls project reload);
 *  - on write failure return inEffect=false so the caller keeps the session
 *    retryable — the 0.1.1 confirm dialog could be missed/cancelled and the
 *    session was then marked ready with nothing applied, leaving navigation
 *    silently dead until a manual rescan;
 *  - when writing GLOBAL, clear a previous workspace-layer list written by
 *    us: it would otherwise shadow the new global value forever (VS Code
 *    resolves workspace layer over global). */
export async function applyReferencedLibraries(
  ctx: vscode.ExtensionContext,
  scope: "global" | "workspace",
  jars: string[],
  log: (msg: string) => void
): Promise<ApplyResult> {
  const jc = vscode.workspace.getConfiguration("java");
  const inspect = jc.inspect<{ include?: string[] } | string[]>("project.referencedLibraries");
  const effective = includeOf(inspect?.workspaceValue ?? inspect?.globalValue ?? inspect?.defaultValue);
  if (sameList(effective, jars)) {
    return { changed: false, inEffect: true, written: jars.length };
  }

  const target = scope === "workspace"
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  try {
    await jc.update("project.referencedLibraries", { include: jars }, target);
  } catch (e) {
    log(`[aosp-nav] failed to write java.project.referencedLibraries (${scope}): ${e}`);
    return { changed: false, inEffect: false, written: 0 };
  }
  log(`[aosp-nav] referencedLibraries written to ${scope} layer: ${jars.length} jars`);

  if (scope === "global") {
    const wsList = includeOf(inspect?.workspaceValue);
    const own = ctx.workspaceState.get<string[]>(OWN_WS_KEY);
    if (wsList.length > 0 && own && sameList(own, wsList)) {
      try {
        await jc.update("project.referencedLibraries", undefined, vscode.ConfigurationTarget.Workspace);
        log("[aosp-nav] cleared own stale workspace-layer referencedLibraries (scope switched to global)");
      } catch { /* best effort */ }
    }
  } else {
    await ctx.workspaceState.update(OWN_WS_KEY, jars);
  }

  return { changed: true, inEffect: true, written: jars.length };
}

/** Remove a workspace-layer referencedLibraries list written by this
 *  extension (part of aosp-nav.resetSettings). Never touches user-authored
 *  values. */
export async function clearOwnWorkspaceLibs(ctx: vscode.ExtensionContext): Promise<void> {
  const own = ctx.workspaceState.get<string[]>(OWN_WS_KEY);
  if (!own) return;
  const jc = vscode.workspace.getConfiguration("java");
  const wsList = includeOf(jc.inspect<{ include?: string[] } | string[]>("project.referencedLibraries")?.workspaceValue);
  if (sameList(wsList, own)) {
    await jc.update("project.referencedLibraries", undefined, vscode.ConfigurationTarget.Workspace);
  }
  await ctx.workspaceState.update(OWN_WS_KEY, undefined);
}
