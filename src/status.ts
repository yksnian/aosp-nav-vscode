import * as vscode from "vscode";

let item: vscode.StatusBarItem;

/** Eclipse-metadata blockers detected by the guard: while > 0, referenced
 *  libraries cannot take effect (invisible project is suppressed) — every
 *  status surface should say so instead of silently reporting "ready". */
let blocked = 0;

export function setBlocked(n: number): void {
  blocked = n;
  if (n > 0) {
    item.text = `$(warning) AOSP:${n} stale`;
    item.tooltip = new vscode.MarkdownString(
      `**AOSP Dev** blocked\n\n` +
      `${n} 个 Eclipse 元数据目录阻止了依赖注入 (点击查看诊断, 或运行\n` +
      `\`AOSP: Fix Eclipse Metadata Blockers\`)。`
    );
    item.show();
  }
}

export function initStatus(ctx: vscode.ExtensionContext): void {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  item.name = "AOSP Dev";
  item.command = "aosp-nav.diagnostics";
  ctx.subscriptions.push(item);
}

export function statusScanning(): void {
  item.text = "$(sync~spin) AOSP";
  item.tooltip = "AOSP: scanning soong intermediates...";
  item.show();
}

export function statusReady(jars: number, fromCache: boolean, root: string): void {
  if (blocked > 0) {
    item.text = `$(warning) AOSP:${jars}`;
    item.tooltip = new vscode.MarkdownString(
      `**AOSP Dev** jars 已注入, 但被 ${blocked} 个 Eclipse 元数据目录阻止生效\n\n` +
      `- jars: ${jars} (${fromCache ? "cached" : "fresh scan"})\n` +
      `- root: ${root}\n\n` +
      `运行 \`AOSP: Fix Eclipse Metadata Blockers\` 清理并重载 (一次性)。`
    );
    item.show();
    return;
  }
  item.text = `$(check) AOSP:${jars}`;
  item.tooltip = new vscode.MarkdownString(
    `**AOSP Dev** ready\n\n` +
    `- jars: ${jars} (${fromCache ? "cached" : "fresh scan"})\n` +
    `- root: ${root}\n\n` +
    `Click for diagnostics.`
  );
  item.show();
}

export function statusIndexing(jars: number): void {
  if (blocked > 0) {
    setBlocked(blocked);
    return;
  }
  item.text = `$(sync~spin) AOSP:${jars}`;
  item.tooltip = new vscode.MarkdownString(
    `**Eclipse is indexing the classpath.**\n\n` +
    `This is a one-time cost (30-60 min on large trees). CPU usage is normal.\n` +
    `Do **not** restart the language server during this phase. Later opens are instant.`
  );
  item.show();
}

export function statusNoOut(): void {
  item.text = "$(warning) AOSP: no out";
  item.tooltip = "AOSP root detected but no build outputs found. Build the tree first.";
  item.show();
}

export function statusFailed(): void {
  item.text = "$(error) AOSP";
  item.tooltip = "AOSP: scan failed. Run 'AOSP: Show Diagnostics' for details.";
  item.show();
}

export function statusHide(): void { item.hide(); }
