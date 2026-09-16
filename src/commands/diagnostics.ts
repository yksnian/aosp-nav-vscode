import * as vscode from "vscode";

export interface DiagLine { ok: boolean | null; label: string; detail: string; action?: string; }

export function openOutput(channel: vscode.OutputChannel): void {
  channel.show(true);
}

export function printDiagnostics(
  channel: vscode.OutputChannel,
  lines: DiagLine[]
): void {
  channel.appendLine(`[aosp-nav diagnostics] ${new Date().toISOString()}`);
  for (const l of lines) {
    const mark = l.ok === null ? "-" : l.ok ? "✓" : "⚠";
    channel.appendLine(`${mark} ${l.label}: ${l.detail}`);
    if (l.action) channel.appendLine(`  → action: ${l.action}`);
  }
  channel.appendLine("");
}
