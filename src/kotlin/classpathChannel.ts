import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { djb2 } from "../infra/hash";
import { isDirectory } from "../infra/fsScan";

/** Kotlin channel for fwcd/kotlin-language-server (vscode-kotlin extension).
 *
 *  fwcd resolves its classpath as
 *      global script (~/.config/kotlin-language-server/classpath)
 *        .or(workspace scan: maven -> gradle -> in-tree kls-classpath)
 *        .or(backup)
 *  where `or` is first-non-empty: a global script that PRINTS anything
 *  short-circuits the workspace scan entirely, so the stray build.gradle
 *  files inside an AOSP tree are never touched — the "no gradle" guarantee
 *  comes for free, no importer switches needed. The script runs with the
 *  first workspace folder as CWD and dispatches on $PWD: known AOSP roots
 *  cat their jar list, anything else exec's the nvim family fallback (see
 *  below) or prints nothing, in which case fwcd falls back to its normal
 *  gradle/maven resolution (zero pollution).
 *
 *  Family protocol (shared with aosp-nav.nvim, by the same author):
 *  - the nvim plugin renders a DYNAMIC script marked `# aosp-nav.nvim classpath`;
 *  - this plugin renders the DISPATCH script marked `# aosp-nav managed`;
 *  - on takeover the nvim script is moved to classpath.nvim.bak and kept as the
 *    fallback branch of the dispatch script, so nvim-specific scenarios
 *    (make-era trees, sibling checkouts, jar fallback dir) keep working;
 *  - aosp-nav.nvim recognizes our marker and does NOT rewrite the file, so the
 *    ping-pong ends and the dispatch script is the stable end state;
 *  - rollback (resetSettings) restores classpath.nvim.bak to classpath;
 *  - a script with NO family marker is a foreign user script: never touched.
 *
 *  The shell resolver's currentBuildFileVersion is the default 1, so fwcd
 *  never caches script output — a rewritten script takes effect without
 *  restarting the language server. */

const SCRIPT_MARKER = "# aosp-nav managed";
const NVIM_MARKER = "# aosp-nav.nvim classpath"; // family marker of aosp-nav.nvim
const NVIM_BACKUP_NAME = "classpath.nvim.bak";
const SCRIPT_NAME = "classpath"; // no extension: first candidate fwcd checks
const ROOT_MAP_KEY = "aosp-nav.kotlinRootMap"; // globalState: root -> {hash, matchPaths}
const OWN_DIR = "aosp-nav"; // subdir for per-root jar lists
/** Upper bound on remembered roots. Every remembered root adds one branch per
 *  workspace folder to a script that is sourced by EVERY workspace; a tree that
 *  was deleted or renamed would otherwise stay in the dispatch table forever. */
const MAX_ROOTS = 32;

interface RootEntry {
  hash: string;
  matchPaths: string[]; // root itself + workspace folders inside it (fwcd CWDs)
  lastUsed?: number; // epoch ms of the last injection; used for the cap
}

export interface KotlinApplyResult {
  changed: boolean; // the script or a jar list was rewritten this call
  blocked: boolean; // a user-managed script exists; channel not taken over
  jars: number;
}

export type ScriptState = "ours" | "family-nvim" | "user" | "none";

let warnedUserScript = false;

function configBase(): string {
  // mirrors ShellClassPathResolver: XDG_CONFIG_HOME ?? ~/.config
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function klsConfigDir(): string {
  return path.join(configBase(), "kotlin-language-server");
}

function scriptPath(): string {
  return path.join(klsConfigDir(), SCRIPT_NAME);
}

function nvimBackupPath(): string {
  return path.join(klsConfigDir(), NVIM_BACKUP_NAME);
}

/** Every global script candidate fwcd could pick up (config dir names x
 *  platform extensions). Our SCRIPT_PATH is the very first on linux. */
function allGlobalScriptCandidates(): string[] {
  const exts = process.platform === "win32"
    ? [".bat", ".cmd", ".ps1"]
    : ["", ".sh", ".bash"];
  const names = ["kotlin-language-server", "KotlinLanguageServer"];
  const out: string[] = [];
  for (const n of names) for (const e of exts) out.push(path.join(configBase(), n, `classpath${e}`));
  return out;
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** Paths that fwcd may use as CWD for this root: the AOSP root itself plus
 *  any file-scheme workspace folder located inside it (sub-checkouts like
 *  frameworks/base opened as the workspace folder). */
function matchPathsFor(root: string): string[] {
  const paths = new Set<string>([root]);
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== "file") continue;
    const p = f.uri.fsPath;
    if (p === root || p.startsWith(root + path.sep)) paths.add(p);
  }
  return [...paths];
}

function jarListPath(hash: string): string {
  return path.join(klsConfigDir(), OWN_DIR, `${hash}.txt`);
}

/** POSIX single-quote quoting: everything inside is literal (spaces, $, back-
 *  ticks, glob chars), and an embedded `'` becomes `'\''`. The previous
 *  `case "$PWD" in "…")` form silently broke on a path containing `"`, and
 *  treated `*`/`?`/`[` in the path as a glob pattern — a miss printed nothing,
 *  so fwcd fell back to its gradle scan without a single log line. */
export function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/** Exported for the shell-quoting test: the generated dispatch script must stay
 *  a valid POSIX script for roots containing spaces, quotes, `$` and globs. */
export function buildScript(map: Record<string, RootEntry>): string {
  const lines: string[] = [
    "#!/bin/sh",
    `${SCRIPT_MARKER} -- regenerated by aosp-nav-vscode; do not edit.`,
    "# Dispatches the fwcd kotlin-language-server classpath by workspace root.",
    "# Known roots cat their jar list; others fall through to the nvim family",
    "# script (make-era trees, sibling checkouts) or to fwcd's gradle/maven.",
  ];
  for (const e of Object.values(map)) {
    const txt = jarListPath(e.hash);
    for (const mp of e.matchPaths) {
      lines.push(`if [ "$PWD" = ${shQuote(mp)} ]; then cat ${shQuote(txt)}; exit 0; fi`);
    }
  }
  const bak = nvimBackupPath();
  lines.push(`[ -x ${shQuote(bak)} ] && exec ${shQuote(bak)}`);
  lines.push("exit 0", "");
  return lines.join("\n");
}

/** Rewrite the global dispatch script when its content changed.
 *
 *  `create` guards the foreign-script invariant: pruning/rescan paths may only
 *  update a script that already carries our marker, otherwise they would hijack
 *  a channel they never took over. */
async function writeDispatchScript(
  map: Record<string, RootEntry>,
  create: boolean
): Promise<boolean> {
  const script = scriptPath();
  const now = await readIfExists(script);
  if (!create && !(now !== null && now.includes(SCRIPT_MARKER))) return false;
  const next = buildScript(map);
  if (now === next) return false;
  const tmp = `${script}.${process.pid}.tmp`;
  await fs.writeFile(tmp, next);
  await fs.rename(tmp, script);
  await fs.chmod(script, 0o755).catch(() => { /* best effort */ });
  return true;
}

/** Write the jar list + global dispatch script for one AOSP root. Never
 *  throws: a filesystem failure is logged and reported via changed=false so
 *  the Java channel is unaffected. Safe to run repeatedly; content is
 *  compared before writing. */
export async function applyKotlinClasspath(
  ctx: vscode.ExtensionContext,
  root: string,
  jars: string[],
  log: (msg: string) => void
): Promise<KotlinApplyResult> {
  if (process.platform === "win32") {
    // fwcd only looks for .bat/.cmd/.ps1 classpath scripts on Windows, ours is
    // a POSIX sh script — writing it would report a success that never lands.
    log("[aosp-nav] kotlin: classpath channel not supported on Windows (fwcd reads only .bat/.cmd/.ps1 scripts); skipping");
    return { changed: false, blocked: true, jars: 0 };
  }
  try {
    const script = scriptPath();
    const current = await readIfExists(script);
    const isOurs = current !== null && current.includes(SCRIPT_MARKER);
    const isNvimFamily = current !== null && current.includes(NVIM_MARKER);

    // guard: a foreign user-managed global script means we must not take
    // over (writing ours would shadow theirs for every non-AOSP project)
    if (current !== null && !isOurs && !isNvimFamily) {
      log(`[aosp-nav] kotlin: user-managed ${script} present, not taking over`);
      if (!warnedUserScript) {
        warnedUserScript = true;
        void vscode.window.showWarningMessage(vscode.l10n.t(
          "[aosp-nav] A user-managed kotlin-language-server classpath script already exists; aosp-nav will not take over the Kotlin classpath channel."
        ));
      }
      return { changed: false, blocked: true, jars: 0 };
    }
    for (const cand of allGlobalScriptCandidates()) {
      if (cand === script) continue;
      if ((await readIfExists(cand)) !== null) {
        log(`[aosp-nav] kotlin: user-managed ${cand} present, not taking over`);
        if (!warnedUserScript) {
          warnedUserScript = true;
          void vscode.window.showWarningMessage(vscode.l10n.t(
            "[aosp-nav] A user-managed kotlin-language-server classpath script already exists; aosp-nav will not take over the Kotlin classpath channel."
          ));
        }
        return { changed: false, blocked: true, jars: 0 };
      }
    }

    // family takeover: move the aosp-nav.nvim script aside (it becomes the
    // fallback branch of our dispatch script, keeping its dynamic scenarios)
    if (isNvimFamily && !isOurs) {
      await fs.rename(script, nvimBackupPath());
      log(`[aosp-nav] kotlin: took over the aosp-nav.nvim classpath script (backup: ${NVIM_BACKUP_NAME})`);
    }

    const map = ctx.globalState.get<Record<string, RootEntry>>(ROOT_MAP_KEY) ?? {};
    const prev = map[root];
    const matchPaths = prev
      ? [...new Set([...prev.matchPaths, ...matchPathsFor(root)])]
      : matchPathsFor(root);
    const entry: RootEntry = { hash: djb2(root), matchPaths, lastUsed: Date.now() };
    map[root] = entry;
    trimMap(map);

    // per-root jar list (tmp + rename: two windows may share one root)
    const txt = jarListPath(entry.hash);
    await fs.mkdir(path.dirname(txt), { recursive: true });
    const content = jars.join(path.delimiter) + "\n";
    let txtChanged = false;
    if ((await readIfExists(txt)) !== content) {
      const tmp = `${txt}.${process.pid}.tmp`;
      await fs.writeFile(tmp, content);
      await fs.rename(tmp, txt);
      txtChanged = true;
    }

    // global dispatch script (re-read inside: family takeover renamed it away)
    const scriptChanged = await writeDispatchScript(map, true);

    await ctx.globalState.update(ROOT_MAP_KEY, map);
    log(`[aosp-nav] kotlin: ${jars.length} jars${txtChanged ? ` written (${path.basename(txt)})` : ""}${scriptChanged ? ", script updated" : ""}`);
    return { changed: txtChanged || scriptChanged, blocked: false, jars: jars.length };
  } catch (e) {
    log(`[aosp-nav] kotlin: failed to write classpath channel: ${e}`);
    return { changed: false, blocked: false, jars: 0 };
  }
}

/** Keep the dispatch table bounded: drop the least recently injected roots. */
function trimMap(map: Record<string, RootEntry>): void {
  const entries = Object.entries(map);
  if (entries.length <= MAX_ROOTS) return;
  entries.sort((a, b) => (a[1].lastUsed ?? 0) - (b[1].lastUsed ?? 0));
  for (const [root] of entries.slice(0, entries.length - MAX_ROOTS)) delete map[root];
}

/** Drop paths that no longer exist (deleted/renamed checkouts) from the
 *  dispatch table and rewrite the script when it changed. Only touches a
 *  script that already carries our marker, so a foreign/family script is never
 *  hijacked by a prune. Called when workspace folders change. */
export async function pruneKotlinRootMap(
  ctx: vscode.ExtensionContext,
  log: (msg: string) => void = () => {}
): Promise<void> {
  try {
    const map = ctx.globalState.get<Record<string, RootEntry>>(ROOT_MAP_KEY);
    if (!map) return;
    let changed = false;
    for (const [root, e] of Object.entries(map)) {
      if (!(await isDirectory(root))) {
        delete map[root];
        changed = true;
        continue;
      }
      const alive: string[] = [];
      for (const p of e.matchPaths) {
        // a workspace folder outside the root can only be stale metadata
        if (p !== root && !p.startsWith(root + path.sep)) {
          changed = true;
          continue;
        }
        if (await isDirectory(p)) alive.push(p);
        else changed = true;
      }
      if (!alive.includes(root)) alive.unshift(root);
      if (alive.length !== e.matchPaths.length) {
        e.matchPaths = alive;
        changed = true;
      }
    }
    trimMap(map);
    // orphaned jar lists: without this, diagnostics keeps reporting "N jars"
    // for a tree that is no longer reachable from the dispatch script
    const dir = path.join(klsConfigDir(), OWN_DIR);
    const keep = new Set(Object.values(map).map((e) => `${e.hash}.txt`));
    try {
      for (const f of await fs.readdir(dir)) {
        if (!keep.has(f)) {
          await fs.rm(path.join(dir, f), { force: true });
          changed = true;
        }
      }
    } catch { /* dir missing: nothing to prune */ }
    if (!changed) return;
    await ctx.globalState.update(ROOT_MAP_KEY, map);
    const wrote = await writeDispatchScript(map, false);
    log(`[aosp-nav] kotlin: pruned stale roots${wrote ? ", script updated" : ""}`);
  } catch (e) {
    log(`[aosp-nav] kotlin: prune failed: ${e}`);
  }
}

/** Diagnostics probe: state of the global script + injected jar count for
 *  a root (0 = never injected / script missing). */
export async function probeKotlinChannel(root: string): Promise<{ script: ScriptState; jars: number }> {
  const script = scriptPath();
  const current = await readIfExists(script);
  let state: ScriptState = "none";
  if (current !== null) {
    state = current.includes(SCRIPT_MARKER)
      ? "ours"
      : current.includes(NVIM_MARKER)
        ? "family-nvim"
        : "user";
  } else {
    for (const cand of allGlobalScriptCandidates()) {
      if (cand !== script && (await readIfExists(cand)) !== null) { state = "user"; break; }
    }
  }
  const txt = await readIfExists(jarListPath(djb2(root)));
  const jars = txt ? txt.trim().split(path.delimiter).filter(Boolean).length : 0;
  return { script: state, jars };
}

/** Rollback (aosp-nav.resetSettings): remove our script + jar lists and
 *  restore a family script taken over earlier. Never touches foreign
 *  user-managed scripts. */
export async function clearKotlinChannel(ctx: vscode.ExtensionContext): Promise<void> {
  const script = scriptPath();
  const current = await readIfExists(script);
  if (current !== null && current.includes(SCRIPT_MARKER)) {
    const bak = nvimBackupPath();
    if ((await readIfExists(bak)) !== null) {
      // restore the aosp-nav.nvim family script we took over
      await fs.rename(bak, script);
    } else {
      await fs.rm(script, { force: true });
    }
  }
  await fs.rm(path.join(klsConfigDir(), OWN_DIR), { recursive: true, force: true }).catch(() => { /* best effort */ });
  await ctx.globalState.update(ROOT_MAP_KEY, undefined);
}
