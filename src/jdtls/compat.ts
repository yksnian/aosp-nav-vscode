import * as vscode from "vscode";
import { peelAppended } from "../core/peelExcludes";

const WRITTEN_KEYS = "aosp-nav.writtenSettings"; // state key for rollback

/** Entries this plugin appends to java.import.exclusions / files.watcherExclude
 *  / search.exclude — single source of truth, shared with workspaceHygiene. */
export const APPENDED_EXCLUDES = ["**/out/**", "**/.repo/**"];

/** The merge-style keys, as [section, sub-key] — see resetWritten. */
const MERGE_KEYS: Array<[string, string]> = [
  ["java", "import.exclusions"],
  ["files", "watcherExclude"],
  ["search", "exclude"],
];

/** The switches we force to `false` (see applyOnce). */
const IMPORTER_KEYS = ["import.gradle.enabled", "import.maven.enabled"];

interface WrittenKey {
  /** "<section>.<sub.key>", e.g. "java.import.exclusions" */
  key: string;
  /** layer we wrote to; the merge keys are peeled on every layer regardless */
  layer: "global" | "workspace";
}

/** State written by <=0.1.6 held bare key names (strings); newer records are
 *  objects. Both are accepted so an upgrade does not lose the rollback list. */
function readWritten(ctx: vscode.ExtensionContext): WrittenKey[] {
  const raw = ctx.globalState.get<Array<string | WrittenKey>>(WRITTEN_KEYS) ?? [];
  return raw.map((e) => (typeof e === "string" ? { key: e, layer: "global" } : e));
}

export async function record(
  ctx: vscode.ExtensionContext,
  key: string,
  layer: "global" | "workspace" = "global"
): Promise<void> {
  const seen = readWritten(ctx);
  const hit = seen.find((e) => e.key === key);
  if (hit) {
    if (hit.layer !== layer) {
      hit.layer = layer;
      await ctx.globalState.update(WRITTEN_KEYS, seen);
    }
    return;
  }
  seen.push({ key, layer });
  await ctx.globalState.update(WRITTEN_KEYS, seen);
}

/** Content equality (arrays compare element-wise; === is reference-equal for
 *  arrays, which made wrapper.checksums rewrite on every activation). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Update one key; a failure (e.g. key not yet registered because redhat.java
 *  is still activating) must not abort the whole compat pass. Retry once after
 *  a short delay to ride out the activation race. */
async function safeUpdate(
  jc: vscode.WorkspaceConfiguration,
  key: string,
  value: unknown,
  target: vscode.ConfigurationTarget,
  log: (msg: string) => void
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await jc.update(key, value, target);
      return true;
    } catch (e) {
      if (attempt === 2) {
        log(`[aosp-nav] warn: failed to write java.${key}: ${e}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

/** Serialize writers of java.import.exclusions. compat's applyOnce and the
 *  eclipse guard's mergeExclusions both do read-modify-write on the same key
 *  and run concurrently at activation; without the lock the second writer
 *  reads a stale base and drops the first writer's entries. */
let exclusionLock: Promise<unknown> = Promise.resolve();
export function withExclusionLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = exclusionLock.then(fn, fn);
  exclusionLock = next.catch(() => undefined);
  return next;
}

/** AOSP compatibility switches.
 *
 *  The importer switches are written at the layer `aosp-nav.settingsScope`
 *  selects (workspace by default), so a window that is not the AOSP repo is
 *  left alone. They are only written when NO layer carries an explicit value:
 *  a user who sets the switch back to `true` keeps it — previously the plugin
 *  re-forced `false` on every activation, with no way to opt out. */
export async function applyOnce(
  ctx: vscode.ExtensionContext,
  scope: "global" | "workspace" = "global",
  log: (msg: string) => void = () => {}
): Promise<void> {
  const jc = vscode.workspace.getConfiguration("java");
  // With no folder open there is no workspace layer to write to (a single-file
  // window); fall back to global rather than leaving Gradle import enabled —
  // the stray build.gradle files in a tree would be imported.
  const workspaceLayer = scope === "workspace" && !!vscode.workspace.workspaceFolders?.length;
  const target = workspaceLayer
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  if (scope === "workspace" && !workspaceLayer) {
    log("[aosp-nav] no workspace folder open; writing the importer switches to the global layer instead");
  }

  for (const sub of IMPORTER_KEYS) {
    const insp = jc.inspect<unknown>(sub);
    if (insp?.workspaceValue === false || insp?.globalValue === false) continue; // already off
    if (insp?.workspaceValue !== undefined || insp?.globalValue !== undefined) {
      log(`[aosp-nav] java.${sub} is explicitly enabled by the user; leaving it alone`);
      continue;
    }
    if (await safeUpdate(jc, sub, false, target, log)) {
      await record(ctx, `java.${sub}`, workspaceLayer ? "workspace" : "global");
    }
  }

  // java.import.exclusions: append out/.repo (dedup), do not drop user entries.
  // Written at the same layer `aosp-nav.settingsScope` selects (workspace by
  // default), matching the eclipse guard, which merges into the workspace layer
  // with the same base chain — one layer, serialized by withExclusionLock so
  // the two activation-time writers cannot lose each other's entries.
  //
  // The base is that layer's own value (or the registered default), NOT the
  // effective value: layers override rather than merge for this key, so
  // reading the effective value would copy the other layer's entries into
  // ours — a shadow the other layer then keeps winning over anyway.
  const exclHasFolder = !!vscode.workspace.workspaceFolders?.length;
  const exclWorkspaceLayer = scope === "workspace" && exclHasFolder;
  const exclInsp = jc.inspect<string[]>("import.exclusions");
  const base = exclWorkspaceLayer
    ? exclInsp?.workspaceValue ?? exclInsp?.globalValue ?? exclInsp?.defaultValue ?? []
    : exclInsp?.globalValue ?? exclInsp?.defaultValue ?? [];
  const missing = APPENDED_EXCLUDES.filter((w) => !base.includes(w));
  if (missing.length > 0) {
    const target = exclWorkspaceLayer
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    const written = await withExclusionLock(() =>
      safeUpdate(jc, "import.exclusions", [...base, ...missing], target, log)
    );
    if (written) {
      await record(ctx, "java.import.exclusions", exclWorkspaceLayer ? "workspace" : "global");
    }
  }
  // Only relevant when we wrote global (no folder / global scope): a
  // workspace-layer list then shadows our entries for this window.
  if (!exclWorkspaceLayer) {
    const wsExcl = jc.inspect<string[]>("import.exclusions")?.workspaceValue;
    if (wsExcl && APPENDED_EXCLUDES.some((w) => !wsExcl.includes(w))) {
      log(`[aosp-nav] warn: java.import.exclusions is overridden by the workspace layer, without ${APPENDED_EXCLUDES.join(", ")}`);
    }
  }
}

/** Reset every settings key the plugin has written (aosp-nav.resetSettings).
 *
 *  Merge-style keys are PEELED, not deleted: rest.join() used to run
 *  `update(key, undefined)`, which took the user's own watcherExclude /
 *  search.exclude / import.exclusions entries down with ours. Peel is applied
 *  to every layer because the entries are known exactly, so it also covers
 *  legacy (pre-0.1.7) records and a scope switch since the write.
 *
 *  The importer switches are only cleared when the value still is the `false`
 *  we wrote — a user who set `false` themselves (the README FAQ tells them to)
 *  keeps it. */
export async function resetWritten(
  ctx: vscode.ExtensionContext,
  log: (msg: string) => void = () => {}
): Promise<void> {
  const seen = readWritten(ctx);

  for (const [section, sub] of MERGE_KEYS) {
    const conf = vscode.workspace.getConfiguration(section);
    const insp = conf.inspect<unknown>(sub);
    const layers: Array<[vscode.ConfigurationTarget, unknown]> = [
      [vscode.ConfigurationTarget.Workspace, insp?.workspaceValue],
      [vscode.ConfigurationTarget.Global, insp?.globalValue],
    ];
    for (const [target, value] of layers) {
      const { value: next, changed } = peelAppended(value, APPENDED_EXCLUDES);
      if (!changed) continue;
      try {
        await conf.update(sub, next, target);
        log(`[aosp-nav] removed our entries from ${section}.${sub}`);
      } catch (e) {
        log(`[aosp-nav] warn: could not roll back ${section}.${sub}: ${e}`);
      }
    }
  }

  for (const { key, layer } of seen) {
    const [section, ...rest] = key.split(".");
    const sub = rest.join(".");
    if (MERGE_KEYS.some(([s, k]) => s === section && k === sub)) continue; // peeled above
    if (section !== "java" || !IMPORTER_KEYS.includes(sub)) continue;
    const conf = vscode.workspace.getConfiguration(section);
    const target =
      layer === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const insp = conf.inspect<unknown>(sub);
    const cur = layer === "workspace" ? insp?.workspaceValue : insp?.globalValue;
    if (cur !== false) continue; // not ours any more — the user's choice
    try {
      await conf.update(sub, undefined, target);
      log(`[aosp-nav] restored default for java.${sub}`);
    } catch (e) {
      log(`[aosp-nav] warn: could not roll back java.${sub}: ${e}`);
    }
  }

  await ctx.globalState.update(WRITTEN_KEYS, undefined);
}
