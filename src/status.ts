import * as vscode from "vscode";

let item: vscode.StatusBarItem;

/** Eclipse-metadata blockers detected by the guard: while > 0, referenced
 *  libraries cannot take effect (invisible project is suppressed) — every
 *  status surface should say so instead of silently reporting "ready". */
let blocked = 0;

/** Per-root "jars applied" state. The single global slot this used to be made
 *  a multi-root window show whichever tree injected last, not the one the user
 *  is editing. `indexing` marks the one-time Eclipse index that follows a
 *  fresh write; the entry settles to "ready" on its own so the spinner is not
 *  permanent (the old code never called statusReady after statusIndexing). */
interface ReadyEntry {
  jars: number;
  fromCache: boolean;
  root: string;
  indexing: boolean;
}

const readyByRoot = new Map<string, ReadyEntry>();
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Root the status bar currently reflects (last file open / last injection). */
let currentRoot: string | null = null;

/** How long a fresh injection keeps the "indexing" spinner before settling.
 *  jdt.ls does not expose "Eclipse index finished" as an event we can hook, so
 *  this is a display-only settle: the tooltip keeps telling the user the index
 *  may still be running. */
const INDEXING_SETTLE_MS = 5 * 60 * 1000;

/** What the item currently shows, so resolving the blockers only redraws what
 *  it owns and never clobbers a scan-in-progress text. */
type Mode = "ready" | "blocked" | "transient";
let mode: Mode = "transient";

function entryFor(root: string | null): ReadyEntry | undefined {
  if (root) {
    const e = readyByRoot.get(root);
    if (e) return e;
  }
  if (currentRoot) {
    const e = readyByRoot.get(currentRoot);
    if (e) return e;
  }
  // no current root (e.g. diagnostics with no editor): fall back to the last one
  let last: ReadyEntry | undefined;
  for (const e of readyByRoot.values()) last = e;
  return last;
}

function renderBlocked(): void {
  const e = entryFor(currentRoot);
  if (e) {
    item.text = `$(warning) AOSP:${e.jars}`;
    item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
      "**AOSP Dev** jars injected but blocked by {0} stale Eclipse metadata dir(s)\n\n- jars: {1} ({2})\n- root: {3}\n\nRun 'AOSP: Fix Eclipse Metadata Blockers' for the one-time clean + reload.",
      blocked, e.jars, e.fromCache ? vscode.l10n.t("cached") : vscode.l10n.t("fresh scan"), e.root
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
  const e = entryFor(currentRoot);
  if (!e) return;
  if (e.indexing) {
    item.text = `$(sync~spin) AOSP:${e.jars}`;
    item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
      "**Eclipse is indexing the classpath.**\n\nThis is a one-time cost (30-60 min on large trees) and high CPU is normal.\nDo **not** restart the language server during this phase. The status bar settles to ready automatically; navigation may already work.\n\n- jars: {0}\n- root: {1}",
      e.jars, e.root
    ));
  } else {
    item.text = `$(check) AOSP:${e.jars}`;
    item.tooltip = new vscode.MarkdownString(vscode.l10n.t(
      "**AOSP Dev** ready\n\n- jars: {0} ({1})\n- root: {2}\n\nClick for diagnostics.",
      e.jars, e.fromCache ? vscode.l10n.t("cached") : vscode.l10n.t("fresh scan"), e.root
    ));
  }
  mode = "ready";
  item.show();
}

function clearSettle(root: string): void {
  const t = settleTimers.get(root);
  if (t) {
    clearTimeout(t);
    settleTimers.delete(root);
  }
}

function settleLater(root: string): void {
  clearSettle(root);
  const timer = setTimeout(() => {
    settleTimers.delete(root);
    const e = readyByRoot.get(root);
    if (!e || !e.indexing) return;
    e.indexing = false;
    if (mode === "blocked") return; // blocked text wins until the guard clears
    if (mode === "ready" && entryFor(currentRoot) === e) renderReady();
  }, INDEXING_SETTLE_MS);
  // do not keep the extension host alive just for a display timer
  timer.unref?.();
  settleTimers.set(root, timer);
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
  if (entryFor(currentRoot)) {
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

export function statusScanning(root: string): void {
  currentRoot = root;
  item.text = "$(sync~spin) AOSP";
  item.tooltip = vscode.l10n.t("AOSP: scanning soong intermediates...");
  mode = "transient";
  item.show();
}

export function statusReady(root: string, jars: number, fromCache: boolean): void {
  clearSettle(root);
  readyByRoot.set(root, { jars, fromCache, root, indexing: false });
  currentRoot = root;
  if (blocked > 0) {
    renderBlocked();
    return;
  }
  renderReady();
}

/** Fresh injection: show the indexing spinner, then settle to ready after a
 *  bounded delay instead of spinning forever. */
export function statusIndexing(root: string, jars: number): void {
  readyByRoot.set(root, { jars, fromCache: false, root, indexing: true });
  currentRoot = root;
  settleLater(root);
  if (blocked > 0) {
    renderBlocked();
    return;
  }
  renderReady();
}

export function statusNoOut(root?: string): void {
  if (root) currentRoot = root;
  item.text = "$(warning) AOSP: no out";
  item.tooltip = vscode.l10n.t("AOSP root detected but no build outputs found. Build the tree first.");
  mode = "transient";
  item.show();
}

export function statusFailed(root?: string): void {
  if (root) currentRoot = root;
  item.text = "$(error) AOSP";
  item.tooltip = vscode.l10n.t("AOSP: scan failed. Run 'AOSP: Show Diagnostics' for details.");
  mode = "transient";
  item.show();
}

/** User cancelled the progress notification: the scan wrote no cache and the
 *  session stays retryable, so say so instead of leaving a permanent spinner. */
export function statusCancelled(root?: string): void {
  if (root) currentRoot = root;
  item.text = "$(circle-slash) AOSP: cancelled";
  item.tooltip = vscode.l10n.t("Scan cancelled. Open a Java/Kotlin file to scan again.");
  mode = "transient";
  item.show();
}

export function statusHide(): void {
  for (const root of [...settleTimers.keys()]) clearSettle(root);
  mode = "transient";
  item.hide();
}
