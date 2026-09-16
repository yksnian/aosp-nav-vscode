import * as vscode from "vscode";

let item: vscode.StatusBarItem;

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
