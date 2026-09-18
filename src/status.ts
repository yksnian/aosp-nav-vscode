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
    item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
      "**AOSP Dev** blocked\n\n{0} stale Eclipse metadata dir(s) are blocking dependency injection. Click for diagnostics or run 'AOSP: Fix Eclipse Metadata Blockers'.",
      n
    ));
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
  item.tooltip = vscode.l10n.t("AOSP: scanning soong intermediates...");
  item.show();
}

export function statusReady(jars: number, fromCache: boolean, root: string): void {
  const origin = fromCache ? vscode.l10n.t("cached") : vscode.l10n.t("fresh scan");
  if (blocked > 0) {
    item.text = `$(warning) AOSP:${jars}`;
    item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
      "**AOSP Dev** jars injected but blocked by {0} stale Eclipse metadata dir(s)\n\n- jars: {1} ({2})\n- root: {3}\n\nRun 'AOSP: Fix Eclipse Metadata Blockers' for the one-time clean + reload.",
      blocked, jars, origin, root
    ));
    item.show();
    return;
  }
  item.text = `$(check) AOSP:${jars}`;
  item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
    "**AOSP Dev** ready\n\n- jars: {0} ({1})\n- root: {2}\n\nClick for diagnostics.",
    jars, origin, root
  ));
  item.show();
}

export function statusIndexing(jars: number): void {
  if (blocked > 0) {
    setBlocked(blocked);
    return;
  }
  item.text = `$(sync~spin) AOSP:${jars}`;
  item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
    "**Eclipse is indexing the classpath.**\n\nThis is a one-time cost (30-60 min on large trees). CPU usage is normal.\nDo **not** restart the language server during this phase. Later opens are instant."
  ));
  item.show();
}

export function statusNoOut(): void {
  item.text = "$(warning) AOSP: no out";
  item.tooltip = vscode.l10n.t("AOSP root detected but no build outputs found. Build the tree first.");
  item.show();
}

export function statusFailed(): void {
  item.text = "$(error) AOSP";
  item.tooltip = vscode.l10n.t("AOSP: scan failed. Run 'AOSP: Show Diagnostics' for details.");
  item.show();
}

export function statusHide(): void { item.hide(); }
