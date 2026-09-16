import * as vscode from "vscode";

const WRITTEN_KEYS = "aosp-nav.writtenSettings"; // state key for rollback

async function record(ctx: vscode.ExtensionContext, key: string): Promise<void> {
  const seen = ctx.globalState.get<string[]>(WRITTEN_KEYS) ?? [];
  if (!seen.includes(key)) {
    seen.push(key);
    await ctx.globalState.update(WRITTEN_KEYS, seen);
  }
}

/** AOSP compatibility switches. Only writes when the current value differs;
 *  never overwrites a user's explicit `false` with anything else. */
export async function applyOnce(ctx: vscode.ExtensionContext): Promise<void> {
  const jc = vscode.workspace.getConfiguration("java");

  const want: Array<[string, unknown]> = [
    ["import.gradle.enabled", false],
    ["import.maven.enabled", false],
    ["import.gradle.wrapper.checksums", []],
  ];

  for (const [sub, value] of want) {
    if (jc.get(sub) !== value) {
      await jc.update(sub, value, vscode.ConfigurationTarget.Global);
      await record(ctx, `java.${sub}`);
    }
  }

  // java.import.exclusions: append out/.repo (dedup), do not drop user entries
  const exclusions = jc.get<string[]>("import.exclusions") ?? [];
  const wanted = ["**/out/**", "**/.repo/**"];
  const missing = wanted.filter((w) => !exclusions.includes(w));
  if (missing.length > 0) {
    await jc.update("import.exclusions", [...exclusions, ...missing],
      vscode.ConfigurationTarget.Global);
    await record(ctx, "java.import.exclusions");
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
