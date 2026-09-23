import * as vscode from "vscode";

// fwcd/vscode-kotlin: the official VSCode companion of fwcd/kotlin-language-server
// (downloads the LS to globalStorage on first use). NOTE: NOT mathiasfrohlich.Kotlin
// — that one is a stale fork from the georgewfraser era with no activation events.
const KOTLIN_EXT = "fwcd.kotlin";
let warned = false;

/** Check for the vscode-kotlin extension (fwcd kotlin-language-server).
 *  Not a hard dependency: the classpath script is written regardless (see
 *  classpathChannel), so Kotlin works as soon as the user installs the
 *  extension — hence only a one-time warning per session instead of an
 *  extensionDependencies entry that would force it on Java-only users.
 *  vscode-kotlin activates on its own when a .kt file opens. */
export async function ensureKotlinExtension(): Promise<boolean> {
  const ext = vscode.extensions.getExtension(KOTLIN_EXT);
  if (!ext) {
    if (!warned) {
      warned = true;
      const button = vscode.l10n.t("Open Extension Page");
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "[aosp-nav] Kotlin extension (fwcd.kotlin, vscode-kotlin) is not installed; Kotlin navigation is unavailable until it is installed. The classpath script is already in place."
        ),
        button
      ).then((pick) => {
        if (pick === button) {
          void vscode.commands.executeCommand("extension.open", KOTLIN_EXT);
        }
      });
    }
    return false;
  }
  return true;
}
