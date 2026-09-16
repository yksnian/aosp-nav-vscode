import * as vscode from "vscode";

const JAVA_EXT = "redhat.java";

export async function ensureJavaExtension(): Promise<boolean> {
  const ext = vscode.extensions.getExtension(JAVA_EXT);
  if (!ext) {
    // extensionDependencies should have installed it; this is a safety net
    void vscode.window.showWarningMessage(
      "[aosp-nav] Java 扩展 (redhat.java) 未安装, 无法提供跳转/补全",
      "打开扩展页"
    ).then((pick) => {
      if (pick === "打开扩展页") {
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
