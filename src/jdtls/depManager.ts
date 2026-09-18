import * as vscode from "vscode";

const JAVA_EXT = "redhat.java";

export async function ensureJavaExtension(): Promise<boolean> {
  const ext = vscode.extensions.getExtension(JAVA_EXT);
  if (!ext) {
    // extensionDependencies should have installed it; this is a safety net
    const button = vscode.l10n.t("Open Extension Page");
    void vscode.window.showWarningMessage(
      vscode.l10n.t("[aosp-nav] Java extension (redhat.java) is not installed; go-to-definition and completion are unavailable"),
      button
    ).then((pick) => {
      if (pick === button) {
        void vscode.commands.executeCommand("extension.open", JAVA_EXT);
      }
    });
    return false;
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  return true;
}
