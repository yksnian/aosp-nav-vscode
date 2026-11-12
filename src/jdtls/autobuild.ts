/** Decides whether the extension may disable Eclipse autobuild.
 *
 *  Why: jdt.ls re-validates and the Eclipse builder recompiles on every save.
 *  On an AOSP root with a classpath of several hundred jars that is the main
 *  CPU consumer during indexing and keeps the machine busy while editing, and
 *  the plugin already owns the classpath (so the workspace stays navigable
 *  without a save-triggered build).
 *
 *  Threshold: 300 injected jars. Rationale — the jar count is exactly the
 *  classpath size the builder has to reconcile, it is already computed by the
 *  scan (no extra I/O), and on the reference tree the closure is 774 jars
 *  while ordinary application/sub-project windows stay far below 300. The
 *  trigger additionally requires the workspace folder itself to BE the AOSP
 *  root, so a window opened on a subtree never reaches the threshold path.
 *
 *  Pure functions only (no `vscode` import) so the policy is unit-tested. */

/** injected jars at or above which autobuild is worth disabling */
export const AUTOBUILD_JAR_THRESHOLD = 300;

export type AutobuildSource =
  | "plugin"
  | "user-workspace"
  | "user-workspace-folder"
  | "user-global"
  | "default";

export interface AutobuildInspect {
  workspaceValue?: boolean;
  workspaceFolderValue?: boolean;
  globalValue?: boolean;
  defaultValue?: boolean;
}

export interface AutobuildState {
  /** effective value */
  value: boolean;
  /** which layer (or the plugin) provides it */
  source: AutobuildSource;
}

/** Current value and its origin, for the diagnostics row. */
export function autobuildState(ins: AutobuildInspect | undefined, ours: boolean): AutobuildState {
  if (ins?.workspaceValue !== undefined) {
    return { value: ins.workspaceValue, source: ours ? "plugin" : "user-workspace" };
  }
  if (ins?.workspaceFolderValue !== undefined) {
    return { value: ins.workspaceFolderValue, source: "user-workspace-folder" };
  }
  if (ins?.globalValue !== undefined) {
    return { value: ins.globalValue, source: "user-global" };
  }
  return { value: ins?.defaultValue ?? true, source: "default" };
}

export interface AutobuildDecision {
  write: boolean;
  reason: string;
}

/** Whether to write `java.autobuild.enabled: false` to the WORKSPACE layer.
 *
 *  Never writes when any layer already carries an explicit value (the user's
 *  choice wins, including an explicit `true`) and never rewrites a value this
 *  plugin itself wrote earlier. */
export function decideAutobuild(input: {
  /** the window's workspace folder IS the AOSP root (not a subtree) */
  workspaceIsAospRoot: boolean;
  /** jars the scan is about to inject */
  jars: number;
  /** workspace / workspaceFolder / global already set the key */
  explicit: boolean;
  /** this plugin wrote the current workspace value */
  ours: boolean;
}): AutobuildDecision {
  if (!input.workspaceIsAospRoot) {
    return { write: false, reason: "workspace folder is not the AOSP root" };
  }
  if (input.explicit) {
    return {
      write: false,
      reason: input.ours ? "already disabled by aosp-nav" : "java.autobuild.enabled is set by the user",
    };
  }
  if (input.ours) {
    return { write: false, reason: "already disabled by aosp-nav" };
  }
  if (input.jars < AUTOBUILD_JAR_THRESHOLD) {
    return { write: false, reason: `only ${input.jars} jars (threshold ${AUTOBUILD_JAR_THRESHOLD})` };
  }
  return { write: true, reason: `${input.jars} jars >= ${AUTOBUILD_JAR_THRESHOLD}` };
}
