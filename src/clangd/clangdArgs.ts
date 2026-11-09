/** Pure planning for `clangd.arguments`, kept free of vscode imports so it can
 *  be unit-tested.
 *
 *  Why only arguments trigger a restart: clangd reloads its compilation
 *  database when a tracked source document changes (measured on a real tree:
 *  after one edit the log shows `Reloaded compilation database`, no process
 *  restart needed). Entry upserts therefore stay cheap. `clangd.arguments`
 *  itself is only read at process start, so a change to
 *  `--compile-commands-dir` needs exactly one `clangd.restart`. */

export const CC_DIR_FLAG = "--compile-commands-dir";

export interface ArgsPlan {
  next: string[];
  changed: boolean;
  /** true when the effective clangd args point at our CDB dir (ours or the
   *  user's own flag) */
  injected: boolean;
  flag: string | null;
}

/** Detect any form of `--compile-commands-dir` (inline `=dir` or a pair). */
export function hasCompileCommandsDir(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(CC_DIR_FLAG + "=")) return true;
    if (args[i] === CC_DIR_FLAG && i + 1 < args.length) return true;
  }
  return false;
}

export function compileCommandsFlag(cdbDir: string): string {
  return `${CC_DIR_FLAG}=${cdbDir}`;
}

/** Append our flag unless the user already configured one (their flag wins:
 *  never fight a hand-written clangd setup).
 *
 *  `own` is the list of flags this extension wrote in a previous session: they
 *  are removed before planning so a changed CDB directory (e.g. compdb appeared
 *  after a rebuild) actually updates instead of being mistaken for a user flag. */
export function planClangdArguments(
  current: string[] | undefined,
  cdbDir: string | null,
  own: string[] = []
): ArgsPlan {
  const original = current ?? [];
  if (!cdbDir) {
    return { next: original, changed: false, injected: false, flag: null };
  }
  const ownSet = new Set(own);
  const base = original.filter((a) => !ownSet.has(a));
  const flag = compileCommandsFlag(cdbDir);
  if (hasCompileCommandsDir(base)) {
    // user flag (or a pair) wins; drop any stale flag we wrote ourselves
    return { next: base, changed: !sameList(base, original), injected: true, flag };
  }
  const next = [...base, flag];
  return { next, changed: !sameList(next, original), injected: true, flag };
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Strip exactly the argument strings this extension wrote (reset path). */
export function removeOwnArguments(current: string[], own: string[]): string[] {
  const ownSet = new Set(own);
  return current.filter((a) => !ownSet.has(a));
}
