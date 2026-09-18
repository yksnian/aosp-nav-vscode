import * as vscode from "vscode";

const WRITTEN_KEYS = "aosp-nav.writtenSettings"; // state key for rollback

export async function record(ctx: vscode.ExtensionContext, key: string): Promise<void> {
  const seen = ctx.globalState.get<string[]>(WRITTEN_KEYS) ?? [];
  if (!seen.includes(key)) {
    seen.push(key);
    await ctx.globalState.update(WRITTEN_KEYS, seen);
  }
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
  log: (msg: string) => void
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await jc.update(key, value, vscode.ConfigurationTarget.Global);
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

/** AOSP compatibility switches. Only writes when the current value differs;
 *  never overwrites a user's explicit `false` with anything else. */
export async function applyOnce(
  ctx: vscode.ExtensionContext,
  log: (msg: string) => void = () => {}
): Promise<void> {
  const jc = vscode.workspace.getConfiguration("java");

  const want: Array<[string, unknown]> = [
    ["import.gradle.enabled", false],
    ["import.maven.enabled", false],
    // NOTE: java.import.gradle.wrapper.checksums was renamed upstream to
    // java.imports.gradle.wrapper.checksums long ago; the old key is not a
    // registered configuration, and update() on it throws CodeExpectedError.
    // With gradle import disabled above, checksums are irrelevant anyway.
  ];

  for (const [sub, value] of want) {
    if (!sameValue(jc.get(sub), value)) {
      if (await safeUpdate(jc, sub, value, log)) {
        await record(ctx, `java.${sub}`);
      }
    }
  }

  // java.import.exclusions: append out/.repo (dedup), do not drop user entries
  const exclusions = jc.get<string[]>("import.exclusions") ?? [];
  const wanted = ["**/out/**", "**/.repo/**"];
  const missing = wanted.filter((w) => !exclusions.includes(w));
  if (missing.length > 0) {
    if (await safeUpdate(jc, "import.exclusions", [...exclusions, ...missing], log)) {
      await record(ctx, "java.import.exclusions");
    }
  }
}

/** Reset every settings key the plugin has written (aosp-nav.resetSettings). */
export async function resetWritten(ctx: vscode.ExtensionContext): Promise<void> {
  const seen = ctx.globalState.get<string[]>(WRITTEN_KEYS) ?? [];
  for (const key of seen) {
    const [section, ...rest] = key.split(".");
    const conf = vscode.workspace.getConfiguration(section);
    await conf.update(rest.join("."), undefined, vscode.ConfigurationTarget.Global);
  }
  await ctx.globalState.update(WRITTEN_KEYS, undefined);
}
