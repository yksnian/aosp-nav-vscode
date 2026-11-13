import * as vscode from "vscode";
import { decideAutobuild, autobuildState } from "./autobuild";
import type { AutobuildInspect, AutobuildState } from "./autobuild";

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

/** workspaceState flag: this plugin wrote java.autobuild.enabled=false to the
 *  workspace layer, so Reset may remove exactly that value. */
const OWN_AUTOBUILD_KEY = "aosp-nav.ownAutobuildDisabled";

function includeOf(v: unknown): string[] {
  return Array.isArray(v) ? v : ((v as { include?: string[] } | undefined)?.include ?? []);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Order-insensitive equality: a rewrite would trigger a full jdt.ls
 *  setRawClasspath (there is no per-entry classpath API), so a different
 *  order of the same jars is not worth it. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((v) => s.has(v));
}

/** first `n` entries for the diff log, with a tail counter */
function sample(xs: string[], n = 5): string {
  if (xs.length === 0) return "none";
  return `${xs.slice(0, n).join(", ")}${xs.length > n ? ` (+${xs.length - n} more)` : ""}`;
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
  const wsList = includeOf(inspect?.workspaceValue);
  const globalList = includeOf(inspect?.globalValue);

  // "already applied" is judged per LAYER, not on the effective value: with the
  // effective value, switching settingsScope from workspace to global looked
  // like a no-op (the workspace list won, list matched), so neither the global
  // write happened nor our workspace shadow got cleared — the setting silently
  // did nothing until an unrelated rescan. The workspace layer shadows global,
  // so for scope=global an identical-or-absent workspace list is required too.
  const inEffect = scope === "workspace"
    ? sameList(wsList, jars) || sameSet(wsList, jars)
    : (inspect?.workspaceValue === undefined || sameList(wsList, jars) || sameSet(wsList, jars))
      && (sameList(globalList, jars) || sameSet(globalList, jars));
  if (inEffect) {
    return { changed: false, inEffect: true, written: jars.length };
  }

  const target = scope === "workspace"
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  // diff against the layer being written: the setting is one JSON value, so a
  // write always replaces the whole list — the log at least says what changed
  // (module-picker toggles show up here as a few added/removed jars)
  const before = new Set(scope === "workspace" ? wsList : globalList);
  const after = new Set(jars);
  const added = jars.filter((j) => !before.has(j));
  const removed = (scope === "workspace" ? wsList : globalList).filter((j) => !after.has(j));

  try {
    await jc.update("project.referencedLibraries", { include: jars }, target);
  } catch (e) {
    log(`[aosp-nav] failed to write java.project.referencedLibraries (${scope}): ${e}`);
    return { changed: false, inEffect: false, written: 0 };
  }
  log(`[aosp-nav] referencedLibraries written to ${scope} layer: ${jars.length} jars (+${added.length}/-${removed.length})`);
  if (added.length > 0 || removed.length > 0) {
    log(`[aosp-nav]   added: ${sample(added)}`);
    log(`[aosp-nav]   removed: ${sample(removed)}`);
  }

  if (scope === "global") {
    const own = ctx.workspaceState.get<string[]>(OWN_WS_KEY);
    if (wsList.length > 0 && own && sameList(own, wsList)) {
      try {
        await jc.update("project.referencedLibraries", undefined, vscode.ConfigurationTarget.Workspace);
        log("[aosp-nav] cleared own stale workspace-layer referencedLibraries (scope switched to global)");
      } catch { /* best effort */ }
    }
    // A workspace-layer list that survived the clear above (authored by the
    // user) still shadows the global write for this window — report it instead
    // of claiming the jars are in effect.
    const wsAfter = includeOf(
      jc.inspect<{ include?: string[] } | string[]>("project.referencedLibraries")?.workspaceValue
    );
    if (wsAfter.length > 0 && !sameList(wsAfter, jars) && !sameSet(wsAfter, jars)) {
      log("[aosp-nav] warn: a workspace-layer referencedLibraries list still shadows the global write; the injected jars are not in effect in this window");
      return { changed: true, inEffect: false, written: jars.length };
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

/** Value and origin of java.autobuild.enabled, for the diagnostics row. */
export function currentAutobuildState(ctx: vscode.ExtensionContext): AutobuildState {
  const ins = vscode.workspace.getConfiguration("java").inspect<boolean>("autobuild.enabled");
  return autobuildState(ins as AutobuildInspect | undefined, ctx.workspaceState.get<boolean>(OWN_AUTOBUILD_KEY) === true);
}

/** Disable Eclipse autobuild for a large AOSP root, without asking and
 *  without ever overriding an explicit user value.
 *
 *  - only the WORKSPACE layer is written;
 *  - an explicit value in any layer (workspace / workspaceFolder / user)
 *    wins, including an explicit `true`;
 *  - the write is flagged in workspaceState so Reset can remove exactly this
 *    value and nothing else;
 *  - a failed write is logged and otherwise ignored (injection continues). */
export async function ensureAutobuildDisabled(
  ctx: vscode.ExtensionContext,
  opts: { workspaceIsAospRoot: boolean; jars: number },
  log: (msg: string) => void
): Promise<void> {
  const jc = vscode.workspace.getConfiguration("java");
  const ins = jc.inspect<boolean>("autobuild.enabled");
  const ours = ctx.workspaceState.get<boolean>(OWN_AUTOBUILD_KEY) === true;
  const explicit =
    ins?.workspaceValue !== undefined ||
    ins?.workspaceFolderValue !== undefined ||
    ins?.globalValue !== undefined;

  const d = decideAutobuild({ workspaceIsAospRoot: opts.workspaceIsAospRoot, jars: opts.jars, explicit, ours });
  if (!d.write) {
    // stay quiet on ordinary projects; only explain a skip that involves our
    // own previous write (so "why is autobuild still off after Reset" is visible)
    if (ours) log(`[aosp-nav] java.autobuild.enabled stays disabled (${d.reason})`);
    return;
  }

  try {
    await jc.update("autobuild.enabled", false, vscode.ConfigurationTarget.Workspace);
  } catch (e) {
    log(`[aosp-nav] could not write java.autobuild.enabled (workspace): ${e} — injection continues`);
    return;
  }
  await ctx.workspaceState.update(OWN_AUTOBUILD_KEY, true);
  log(
    `[aosp-nav] java.autobuild.enabled set to false in the workspace settings (${d.reason}): Eclipse would rebuild on every save at this size. Undo with "AOSP: Reset Plugin Settings".`
  );
}

/** Remove the workspace-layer java.autobuild.enabled this extension wrote
 *  (part of aosp-nav.resetSettings). A value the user changed afterwards is
 *  left untouched. */
export async function clearOwnAutobuild(ctx: vscode.ExtensionContext): Promise<void> {
  if (ctx.workspaceState.get<boolean>(OWN_AUTOBUILD_KEY) !== true) return;
  const jc = vscode.workspace.getConfiguration("java");
  const ins = jc.inspect<boolean>("autobuild.enabled");
  if (ins?.workspaceValue === false) {
    try {
      await jc.update("autobuild.enabled", undefined, vscode.ConfigurationTarget.Workspace);
    } catch { /* best effort */ }
  }
  await ctx.workspaceState.update(OWN_AUTOBUILD_KEY, undefined);
}
