import * as vscode from "vscode";

let item: vscode.StatusBarItem;

/** Eclipse-metadata blockers detected by the guard: while > 0, referenced
 *  libraries cannot take effect (invisible project is suppressed) — every
 *  status surface should say so instead of silently reporting "ready". */
let blocked = 0;

/** Last "jars applied" state, kept around so setBlocked(0) can restore it
 *  instead of leaving a stale warning text in the status bar. */
let ready: { jars: number; fromCache: boolean; root: string } | null = null;

/** What the item currently shows, so resolving the blockers only redraws what
 *  it owns and never clobbers a scan-in-progress text. */
type Mode = "ready" | "blocked" | "transient";
let mode: Mode = "transient";

function renderBlocked(): void {
  if (ready) {
    item.text = `$(warning) AOSP:${ready.jars}`;
    item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
      "**AOSP Dev** jars injected but blocked by {0} stale Eclipse metadata dir(s)\n\n- jars: {1} ({2})\n- root: {3}\n\nRun 'AOSP: Fix Eclipse Metadata Blockers' for the one-time clean + reload.",
      blocked, ready.jars, ready.fromCache ? vscode.l10n.t("cached") : vscode.l10n.t("fresh scan"), ready.root
    ));
  } else {
    item.text = `$(warning) AOSP:${blocked} stale`;
    item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
      "**AOSP Dev** blocked\n\n{0} stale Eclipse metadata dir(s) are blocking dependency injection. Click for diagnostics or run 'AOSP: Fix Eclipse Metadata Blockers'.",
      blocked
    ));
  }
  mode = "blocked";
  item.show();
}

function renderReady(): void {
  if (!ready) return;
  item.text = `$(check) AOSP:${ready.jars}`;
  item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
    "**AOSP Dev** ready\n\n- jars: {0} ({1})\n- root: {2}\n\nClick for diagnostics.",
    ready.jars, ready.fromCache ? vscode.l10n.t("cached") : vscode.l10n.t("fresh scan"), ready.root
  ));
  mode = "ready";
  item.show();
}

export function setBlocked(n: number): void {
  blocked = n;
  if (n > 0) {
    renderBlocked();
    return;
  }
  // Blockers resolved: the warning has to actually go away, otherwise a tree
  // that was fixed keeps advertising "N stale" until the next full rescan.
  if (mode !== "blocked") return; // a scan in progress redraws on its own
  if (ready) {
    renderReady();
  } else {
    item.hide();
    mode = "transient";
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
  mode = "transient";
  item.show();
}

export function statusReady(jars: number, fromCache: boolean, root: string): void {
  ready = { jars, fromCache, root };
  if (blocked > 0) {
    renderBlocked();
    return;
  }
  renderReady();
}

export function statusIndexing(jars: number): void {
  if (blocked > 0) {
    renderBlocked();
    return;
  }
  item.text = `$(sync~spin) AOSP:${jars}`;
  item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
    "**Eclipse is indexing the classpath.**\n\nThis is a one-time cost (30-60 min on large trees). CPU usage is normal.\nDo **not** restart the language server during this phase. Later opens are instant."
  ));
  mode = "transient";
  item.show();
}

export function statusNoOut(): void {
  item.text = "$(warning) AOSP: no out";
  item.tooltip = vscode.l10n.t("AOSP root detected but no build outputs found. Build the tree first.");
  mode = "transient";
  item.show();
}

export function statusFailed(): void {
  item.text = "$(error) AOSP";
  item.tooltip = vscode.l10n.t("AOSP: scan failed. Run 'AOSP: Show Diagnostics' for details.");
  mode = "transient";
  item.show();
}

export function statusHide(): void {
  mode = "transient";
  item.hide();
}
