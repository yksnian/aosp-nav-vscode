import * as path from "path";
import * as vscode from "vscode";
import { detectAospRoot } from "../androidRoot";
import { getConfig } from "../config";
import { isDirectory } from "../infra/fsScan";
import { applySourceRootsAndPromptReload } from "./sourceRoots";
import {
  autoModulesForFolder,
  findImportExclusion,
  loadJavaModuleIndex,
  matchesImportExclusion,
  rootsForPath,
  scopedImportExclusions,
  splitRootsByFolders,
} from "./moduleRoots";

/** Module-based source root selection (design approved 2026-11-10):
 *  the user picks MODULES, the extension maps them to source roots via
 *  out/soong/module_bp_java_deps.json. Selections live in
 *  `aosp-nav.java.sourceRootModules` (workspace layer); third-party roots
 *  (external/, vendor/, ...) are a separate opt-in step written into
 *  `aosp-nav.java.sourceRoots` so they stay user-editable. */

const OFFERED_KEY = "aosp-nav.modulePickerOffered";
/** roots this plugin appended to aosp-nav.java.sourceRoots (workspace layer),
 *  so Reset can remove them without touching hand-written entries */
const OWN_EXTRA_ROOTS_KEY = "aosp-nav.ownExtraSourceRoots";

/** Same key the eclipse guard writes (eclipseGuard.ts OWN_EXCL_KEY): the
 *  exclusion entries this extension added itself. Read here only to label the
 *  picker hint; a missing record (new window, cleared storage) simply means
 *  "nothing provably ours", so the hint stays hidden instead of over-reporting. */
const OWN_EXCLUSIONS_KEY = "aosp-nav.ownExclusions";

/** Root-window default, persisted as a REAL module selection (product decision
 *  2026-11-11). Picking a module means "inject every first-party root of it",
 *  so these two expand to 5 + 12 roots (16 unique) on a real tree: the same
 *  list the picker shows checked, because both read the same config. */
export const DEFAULT_ROOT_MODULES = ["frameworks/base/core/java", "frameworks/base/services/core"];

/** Persists DEFAULT_ROOT_MODULES for an AOSP-root window that has no module
 *  selection yet. Runs after the one-time picker offer and before the first
 *  injection, so "nothing picked" is never an implicit injection branch: the
 *  checkbox state and the injected roots come from one source. Subdirectory
 *  windows never seed (they keep the auto selection). */
export async function seedDefaultModuleSelection(root: string, log: (m: string) => void): Promise<boolean> {
  const rootWindow = (vscode.workspace.workspaceFolders ?? []).some(
    (f) => f.uri.scheme === "file" && path.resolve(f.uri.fsPath) === path.resolve(root)
  );
  if (!rootWindow) return false;
  const insp = vscode.workspace.getConfiguration("aosp-nav").inspect<string[]>("java.sourceRootModules");
  // written value wins, including an explicit [] ("inject nothing")
  if (insp?.workspaceValue !== undefined || insp?.globalValue !== undefined) return false;
  try {
    await vscode.workspace
      .getConfiguration("aosp-nav")
      .update("java.sourceRootModules", DEFAULT_ROOT_MODULES, vscode.ConfigurationTarget.Workspace);
    log(`[aosp-nav] sourceRootModules: seeded ${DEFAULT_ROOT_MODULES.join(", ")}`);
    return true;
  } catch (e) {
    // read-only settings: leave the config alone; the root window then injects
    // only hand-written roots and the failure stays in the output channel
    log(`[aosp-nav] sourceRootModules: could not write default selection: ${e}`);
    return false;
  }
}

async function seedRoot(): Promise<string | null> {
  const cfg = getConfig();
  if (cfg.androidRoot) return cfg.androidRoot;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const root = await detectAospRoot(folder.uri.fsPath);
    if (root) return root;
  }
  return null;
}

/** One-time offer shown BEFORE the first injection, when a build index exists
 *  and no modules have been picked yet. Modal on purpose: the scan path awaits
 *  it, so the first injection reflects the user's choice. Skipping is not
 *  "never" — the root-window default modules (DEFAULT_ROOT_MODULES) are then
 *  persisted like any other pick, so the picker shows them checked. */
export async function maybeOfferModulePicker(
  ctx: vscode.ExtensionContext,
  root: string,
  log: (m: string) => void
): Promise<void> {
  // user decision 2026-11-10: only the AOSP-root window gets the hint;
  // single git-project windows (subdirectory windows) have auto selection
  // and need no prompt
  const rootWindow = (vscode.workspace.workspaceFolders ?? []).some(
    (f) => f.uri.scheme === "file" && path.relative(f.uri.fsPath, root) === ""
  );
  if (!rootWindow) return;
  const cfg = getConfig();
  if (cfg.javaSourceRootModules.length > 0) return;
  if (ctx.workspaceState.get<boolean>(OFFERED_KEY)) return;
  if (!(await isDirectory(path.join(root, "out", "soong")))) return;
  await ctx.workspaceState.update(OFFERED_KEY, true);
  const btn = vscode.l10n.t("Select modules");
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "[aosp-nav] Injecting Java source roots turns off jdt.ls' per-file source inference, so only the modules you pick keep source navigation. Pick modules now? If you skip this, the modules frameworks/base/core/java and frameworks/base/services/core are selected, and every first-party source root they own is injected."
    ),
    { modal: true },
    btn,
    vscode.l10n.t("Use defaults")
  );
  if (pick === btn) await selectJavaSourceRootsByModule(ctx, log);
}

interface ModuleItem {
  label: string;
  description: string;
  picked: boolean;
}

function pickMany(
  items: ModuleItem[],
  title: string,
  placeholder: string,
  resetTooltip: string
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.canSelectMany = true;
    qp.matchOnDescription = true;
    qp.title = title;
    qp.placeholder = placeholder;
    qp.selectedItems = items.filter((i) => i.picked);
    const resetButton: { iconPath: vscode.ThemeIcon; tooltip: string } = {
      iconPath: new vscode.ThemeIcon("clear-all"),
      tooltip: resetTooltip,
    };
    qp.buttons = [resetButton];
    let done = false;
    const finish = (v: string[] | null) => {
      if (!done) {
        done = true;
        qp.dispose();
        resolve(v);
      }
    };
    qp.onDidAccept(() => finish(qp.selectedItems.map((i) => i.label)));
    qp.onDidHide(() => finish(null));
    qp.onDidTriggerButton((b) => {
      if (b === resetButton) qp.selectedItems = [];
    });
    qp.show();
  });
}

/** Command: AOSP: Select Java Source Roots by Module. */
export async function selectJavaSourceRootsByModule(
  ctx: vscode.ExtensionContext,
  log: (m: string) => void
): Promise<void> {
  const root = await seedRoot();
  if (!root) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("[aosp-nav] not an AOSP workspace (open an AOSP file or set aosp-nav.androidRoot)")
    );
    return;
  }
  const index = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "AOSP: loading module index" },
    () => loadJavaModuleIndex(root, log)
  );
  if (!index) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "[aosp-nav] out/soong/module_bp_java_deps.json not found — it is written by soong on every full build. Build the tree first, or select roots manually via aosp-nav.java.sourceRoots."
      )
    );
    return;
  }

  // Scope the picker to THIS window: jdt.ls only accepts workspace-relative
  // source paths, so modules outside the window's folders can never be fully
  // injected here (e.g. frameworks/base modules in a packages/modules/
  // Connectivity subdirectory window). Folders that do not detect as AOSP
  // trees are ignored — collectDesired skips them anyway.
  const folders: string[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== "file") continue;
    if (await detectAospRoot(f.uri.fsPath)) folders.push(f.uri.fsPath);
  }
  // fallback: with aosp-nav.androidRoot set but no matching folder, keep the
  // unfiltered list (the user configured the root manually for a reason)
  const scoped = folders.length > 0;

  // picker scope: modules whose DIRECTORY sits inside one of this window's
  // folders — the user's mental model ("modules under this folder"). Root-based
  // scoping leaked tree-wide modules whose static_lib closure happens to pull
  // one in-window root (measured: framework-minus-apex srcs include
  // packages/modules/Connectivity/Vcn/framework-b/src; cts modules pull
  // Connectivity test libs). An in-window module still only injects its
  // in-window roots; cross-tree roots of its closure are counted but skipped
  // at apply time, and the description says so.
  // unified "do not import" list: modules under these dirs are not offered
  // here either (same rule the auto selection follows). Entries covering a
  // window folder itself (guard rootBlocked leftovers) are dropped first.
  const jInsp = vscode.workspace.getConfiguration("java").inspect<string[]>("import.exclusions");
  const importExclusions = scopedImportExclusions(
    jInsp?.workspaceValue ?? jInsp?.globalValue ?? jInsp?.defaultValue ?? [],
    scoped ? folders : []
  );

  // Checked state IS the module list: the root-window default is persisted by
  // seedDefaultModuleSelection() (DEFAULT_ROOT_MODULES), so the picker and the
  // injection read the same config — no pseudo rows and no implicit branch.
  // Subdirectory windows keep the per-folder auto selection.
  const modInsp = vscode.workspace.getConfiguration("aosp-nav").inspect<string[]>("java.sourceRootModules");
  const explicit = modInsp?.workspaceValue ?? modInsp?.globalValue ?? null;
  const rootWindow = scoped
    ? folders.some((f) => path.relative(path.resolve(f), path.resolve(root)) === "")
    : true;
  let effective: readonly string[];
  if (explicit !== null) {
    effective = explicit;
  } else if (rootWindow) {
    effective = DEFAULT_ROOT_MODULES;
  } else {
    const union = new Set<string>();
    for (const f of folders) {
      for (const m of autoModulesForFolder(index, root, f, importExclusions)) union.add(m);
    }
    effective = [...union];
  }
  const selected = new Set(effective);
  // Checked modules go first: the list is ~4.5k entries on a real tree, so the
  // current selection must be reachable without scrolling or searching. Order
  // is fixed at open time (no live re-sort: QuickPick would lose the highlight
  // and scroll position on every toggle).
  const pickedItems: ModuleItem[] = [];
  const restItems: ModuleItem[] = [];
  // Visibility only (filtering semantics untouched): a whole subtree can vanish
  // from the list because of one java.import.exclusions entry, which otherwise
  // looks like the picker is broken. Two noise filters keep the number honest:
  //  1. only dirs that WOULD have been listed (in-window dir with at least one
  //     in-window root) — the rest were never going to show up;
  //  2. only dirs blocked by an entry the eclipse guard wrote itself
  //     (aosp-nav.ownExclusions). Default globs and the user's own entries are
  //     deliberate choices, not something the extension did behind their back.
  // The source is decided by exact entry identity, never by path shape.
  const ownExclusions = new Set(ctx.workspaceState.get<string[]>(OWN_EXCLUSIONS_KEY) ?? []);
  let excludedByGuard = 0;
  for (const p of [...index.byPath.keys()].sort()) {
    if (scoped && splitRootsByFolders([path.join(root, p)], folders).inside.length === 0) continue;
    const r = rootsForPath(index, p);
    const first = scoped
      ? splitRootsByFolders(r.firstParty.map((x) => path.join(root, x)), folders)
      : { inside: r.firstParty.map((x) => path.join(root, x)), outside: [] as string[] };
    const third = scoped
      ? splitRootsByFolders(r.thirdParty.map((x) => path.join(root, x)), folders)
      : { inside: r.thirdParty, outside: [] };
    if (first.inside.length === 0 && third.inside.length === 0) continue;
    const hit = findImportExclusion(path.join(root, p), importExclusions);
    if (hit !== undefined) {
      if (ownExclusions.has(hit)) excludedByGuard++;
      continue;
    }
    const parts: string[] = [`${first.inside.length} root(s)`];
    if (first.outside.length > 0) parts.push(`${first.outside.length} outside this window`);
    if (third.inside.length > 0) parts.push(`+${third.inside.length} third-party`);
    const injectedHere = selected.has(p);
    const item: ModuleItem = { label: p, description: parts.join(", "), picked: injectedHere };
    (injectedHere ? pickedItems : restItems).push(item);
  }
  const items = [...pickedItems, ...restItems];
  const pickedPaths = await pickMany(
    items,
    vscode.l10n.t("Select Java Source Roots by Module"),
    excludedByGuard > 0
      ? vscode.l10n.t(
          "Filter modules (e.g. Connectivity) — {0} module directories are hidden by eclipse-guard exclusions",
          excludedByGuard
        )
      : vscode.l10n.t("Filter modules (e.g. Connectivity)"),
    vscode.l10n.t("Reset selection")
  );
  if (pickedPaths === null) return; // cancelled: keep the old selection
  // Nothing checked is an explicit "inject nothing" ([]), never a silent fall
  // back to the default: the checkboxes must equal the resulting injection.
  await vscode.workspace
    .getConfiguration("aosp-nav")
    .update("java.sourceRootModules", pickedPaths, vscode.ConfigurationTarget.Workspace);
  log(`[aosp-nav] sourceRootModules: ${pickedPaths.length} module(s) selected`);

  await offerThirdPartyRoots(ctx, index, pickedPaths, root, folders, scoped, importExclusions);
  // apply here (not only via the aosp-nav config-change listener) because the
  // listener only re-runs roots that already have a session; when the picker
  // is used before any java file was opened, nothing else would apply. The
  // listener's later pass is a no-op (list already matches).
  await applySourceRootsAndPromptReload(ctx, log);
}

/** Third-party roots of the picked modules (external/, vendor/, ...): shown
 *  as root-level opt-ins, none picked by default. Accepted roots are merged
 *  into the workspace layer of `aosp-nav.java.sourceRoots`, where the user
 *  can edit them later like any manual entry. */
async function offerThirdPartyRoots(
  ctx: vscode.ExtensionContext,
  index: Awaited<ReturnType<typeof loadJavaModuleIndex>>,
  pickedPaths: string[],
  root: string,
  folders: string[],
  scoped: boolean,
  importExclusions: readonly string[]
): Promise<void> {
  if (!index) return;
  const tp = new Set<string>();
  for (const m of pickedPaths) {
    for (const r of rootsForPath(index, m).thirdParty) tp.add(r);
  }
  // same window scoping as the module list: third-party roots outside the
  // window's folders would be skipped at apply time anyway
  const usable = scoped
    ? splitRootsByFolders([...tp].map((r) => path.join(root, r)), folders).inside.map((a) =>
        path.relative(root, a).split(path.sep).join("/")
      )
    : [...tp];
  const candidates = usable.filter((r) => !matchesImportExclusion(path.join(root, r), importExclusions));
  const effective = getConfig().javaSourceRoots;
  const offer = candidates.filter((r) => !effective.includes(r)).sort();
  if (offer.length === 0) return;
  const items: ModuleItem[] = offer.map((r) => ({ label: r, description: "", picked: false }));
  const picked = await pickMany(
    items,
    vscode.l10n.t("Include third-party / vendor source roots?"),
    vscode.l10n.t("Filter roots (default: none selected)"),
    vscode.l10n.t("Reset selection")
  );
  if (picked === null || picked.length === 0) return;
  await vscode.workspace
    .getConfiguration("aosp-nav")
    .update("java.sourceRoots", [...effective, ...picked], vscode.ConfigurationTarget.Workspace);
  const own = ctx.workspaceState.get<string[]>(OWN_EXTRA_ROOTS_KEY) ?? [];
  await ctx.workspaceState.update(OWN_EXTRA_ROOTS_KEY, [...new Set([...own, ...picked])]);
}

/** Removes only the roots offerThirdPartyRoots() appended; hand-written
 *  java.sourceRoots entries are left alone. */
export async function clearOwnExtraSourceRoots(ctx: vscode.ExtensionContext): Promise<void> {
  const own = ctx.workspaceState.get<string[]>(OWN_EXTRA_ROOTS_KEY);
  if (!own || own.length === 0) return;
  const conf = vscode.workspace.getConfiguration("aosp-nav");
  const cur = conf.get<string[]>("java.sourceRoots") ?? [];
  const next = cur.filter((r) => !own.includes(r));
  await conf.update("java.sourceRoots", next.length > 0 ? next : undefined, vscode.ConfigurationTarget.Workspace);
  await ctx.workspaceState.update(OWN_EXTRA_ROOTS_KEY, undefined);
}
