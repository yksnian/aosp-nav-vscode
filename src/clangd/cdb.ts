import * as fs from "fs/promises";
import * as path from "path";

/** Plugin-managed `compile_commands.json`.
 *
 *  clangd only consumes a directory (`--compile-commands-dir`); it does not
 *  read comments, so the file itself is always plain JSON:
 *    [{"directory": <aosp root>, "arguments": [<compiler>, <flags...>], "file": <abs>}]
 *
 *  Incremental semantics: one entry per opened source file, keyed by `file`.
 *  An existing entry is replaced wholesale when its flags changed (a rebuild
 *  may alter them); unseen files are appended. Entry count = files the user
 *  actually opened (tens), so a full rewrite is cheap and avoids append/partial
 *  rewrite complexity.
 *
 *  This never pre-writes the 146,773 entries from module_bp_cc_deps.json:
 *  clangd's startup cost would be unacceptable and almost all of it unused. */

export interface CdbEntry {
  directory: string;
  arguments: string[];
  file: string;
}

export interface UpsertResult {
  entries: CdbEntry[];
  changed: boolean;
}

export function buildEntry(
  root: string,
  file: string,
  args: string[],
  compiler: string
): CdbEntry {
  return {
    directory: root,
    // CDB spec: arguments[0] is the compiler. The bp fallback has no compiler,
    // so callers pass "clang"/"clang++" as a bare fallback name.
    arguments: [compiler, ...args],
    file,
  };
}

/** Pure upsert: replace by `file` in place, otherwise append. */
export function upsertEntry(entries: CdbEntry[], entry: CdbEntry): UpsertResult {
  const next = entries.slice();
  for (let i = 0; i < next.length; i++) {
    if (next[i].file === entry.file) {
      if (
        next[i].directory === entry.directory &&
        sameArgs(next[i].arguments, entry.arguments)
      ) {
        return { entries: next, changed: false };
      }
      next[i] = entry;
      return { entries: next, changed: true };
    }
  }
  next.push(entry);
  return { entries: next, changed: true };
}

export function sameArgs(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Read a CDB; missing or malformed files count as empty (we own this file). */
export async function readCdb(file: string): Promise<CdbEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as CdbEntry[]) : [];
  } catch {
    return [];
  }
}

/** Atomic write (unique temp + rename) so a concurrent window or a crash never
 *  leaves clangd reading a half-written JSON document. */
export async function writeCdb(file: string, entries: CdbEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries));
  await fs.rename(tmp, file);
}

/** Ensure the CDB exists (an empty `[]` is valid and lets clangd start with a
 *  directory it can watch) and contains the given entry. */
export async function ensureEntry(
  file: string,
  entry: CdbEntry
): Promise<{ changed: boolean; count: number }> {
  const entries = await readCdb(file);
  const r = upsertEntry(entries, entry);
  if (!r.changed) {
    // create the file if it was missing, otherwise leave it untouched
    try {
      await fs.stat(file);
    } catch {
      await writeCdb(file, r.entries);
    }
    return { changed: false, count: r.entries.length };
  }
  await writeCdb(file, r.entries);
  return { changed: true, count: r.entries.length };
}

export async function ensureCdbFile(file: string): Promise<void> {
  try {
    await fs.stat(file);
  } catch {
    await writeCdb(file, []);
  }
}

