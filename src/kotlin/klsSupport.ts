import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { djb2 } from "../infra/hash";
import { extractZip } from "../infra/unzip";
import { jarListPathFor, shQuote } from "./classpathChannel";

/** ktlsp support: the community-maintained fork (winlogon/ktlsp) of the
 *  deprecated fwcd kotlin-language-server.
 *
 *  From an AOSP root the server hangs in two successive unbounded scans.
 *  ktlsp gives each scan its own prune channel, both read from project files
 *  (no client setting involved):
 *  - source walk -> `.kls/exclusions.txt`. Each entry is a glob matched
 *    against every path segment, so `out` prunes any dir named `out` at any
 *    depth.
 *  - gradle/maven build-file scan -> the root `.gitignore`. Same segment
 *    semantics against absolute paths, so entries must be bare names: a
 *    gitignore-style line with a leading slash ends up with a doubled slash
 *    inside the generated pattern and never matches.
 *  The build-file scan is what actually stalls: every build.gradle under
 *  frameworks starts a Gradle Tooling API connection (distribution download)
 *  plus CLI fallbacks that all fail offline — dozens of projects,
 *  minutes of error spam, repeated on each refresh. So the .gitignore block
 *  prunes every top-level dir except `.kls`: the remaining in-tree resolvers
 *  are unioned with the global classpath script, and the global script is only
 *  consulted when nothing else yields a classpath — leaving
 *  `.kls/kls-classpath` (the injected jar list) as the only effective resolver.
 *  The source walk only needs the huge non-Kotlin trees gone, so it keeps a
 *  conservative static set: a whitelist complement is wrong here because
 *  matching is depth-agnostic — pruning `packages` would also drop
 *  frameworks/base/packages (19k Kotlin files: SystemUI, Settings, ...).
 *  `.kls` is pruned from the source walk but kept in the build-file walk so
 *  the script stays discoverable. All writes are marker-managed and
 *  content-compared; a failure is logged and never affects the Java channel. */

const EXCL_MARKER = "# aosp-nav managed -- ktlsp source exclusions";
const GI_BEGIN = "# aosp-nav managed -- ktlsp classpath pruning (begin)";
const GI_END = "# aosp-nav managed -- ktlsp classpath pruning (end)";
const KLS_DIR = ".kls";
const EXCL_NAME = "exclusions.txt";
const CP_NAME = "kls-classpath";
/** Segment globs pruned from ktlsp's source walk (users extend via
 *  aosp-nav.kotlin.klsExcludes): giant trees that hold no Kotlin sources.
 *  Names that also occur inside frameworks or packages (`packages`, `tools`,
 *  `test`, `log`, `system`, ...) are deliberately absent — matching is
 *  depth-agnostic, so they would silently drop real sources. */
const DEFAULT_KLS_EXCLUDES = [
  ".repo",
  "device",
  "external",
  "kernel",
  "out",
  "prebuilts",
  "toolchain",
  "vendor",
];
/** Top-level AOSP dirs. Completes the classpath prune set so trees created
 *  after the write (e.g. `out` after a build) are covered without another
 *  pass; `.repo` is a symlink into the checkout metadata and must never be
 *  walked. */
const AOSP_TOP_LEVEL = [
  ".repo",
  "art",
  "bionic",
  "bootable",
  "build",
  "cts",
  "dalvik",
  "developers",
  "development",
  "device",
  "external",
  "frameworks",
  "hardware",
  "kernel",
  "libcore",
  "libnativehelper",
  "log",
  "out",
  "outputs",
  "packages",
  "pdk",
  "platform_testing",
  "prebuilts",
  "sdk",
  "system",
  "test",
  "toolchain",
  "tools",
  "trusty",
  "vendor",
];
/** Pinned ktlsp release. rc1 carries the exclusion feature; bump when the
 *  stable 1.4.0 lands. Requires Java 21 (fwcd needed 11). */
const KTLSP_VERSION = "v1.4.0-rc1";
const KTLSP_URL = `https://codeberg.org/winlogon/ktlsp/releases/download/${KTLSP_VERSION}/server.zip`;
/** Hard ceiling for the ktlsp download: the archive is 87 MiB, so slow
 *  links still finish in well under a minute; the margin covers captive
 *  portals and slow mirrors instead of hanging the progress UI forever. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** Content-compared atomic write; returns whether anything was written. */
async function writeIfChanged(p: string, content: string, mode?: number): Promise<boolean> {
  const same = (await readIfExists(p)) === content;
  // chmod before the compare: a mode drifted by an external touch self-heals
  // even when the content is unchanged
  if (mode !== undefined && same) await fs.chmod(p, mode).catch(() => { /* best effort */ });
  if (same) return false;
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, p);
  if (mode !== undefined) await fs.chmod(p, mode).catch(() => { /* best effort */ });
  return true;
}

/** The managed .gitignore block is the begin/end marker interval; the upsert
 *  replaces exactly that interval, so user content around it is preserved. A
 *  block left unterminated by a torn write (or the pre-dual-marker format
 *  that ran to EOF) is replaced from the begin marker to EOF. Entries are
 *  bare names: ktlsp turns each line into a glob matcher anchored at the
 *  root with a wildcard path prefix, so a gitignore-style "/out/" line
 *  produces a doubled slash inside the pattern and matches nothing. */
function upsertGitignoreBlock(cur: string | null, prunes: string[]): string | null {
  const block = [GI_BEGIN, ...prunes, GI_END].join("\n") + "\n";
  if (cur === null) return block;
  const idx = cur.indexOf(GI_BEGIN);
  if (idx < 0) {
    return cur.endsWith("\n") || cur === "" ? cur + block : cur + "\n" + block;
  }
  const end = cur.indexOf(GI_END, idx + GI_BEGIN.length);
  const stop = end < 0 ? cur.length : end + GI_END.length;
  let prefix = cur.slice(0, idx);
  if (prefix !== "" && !prefix.endsWith("\n")) prefix += "\n";
  return prefix + block + (end < 0 ? "" : cur.slice(stop).replace(/^\n/, ""));
}

/** Top-level dirs/symlinks of the root; empty when it cannot be read, in
 *  which case the static AOSP list still covers the common case. */
async function listTopLevelDirs(root: string, log: (msg: string) => void): Promise<string[]> {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch (e) {
    log(`[aosp-nav] kotlin: cannot enumerate ${root}, relying on the static AOSP top-level list: ${e}`);
    return [];
  }
}

/** Write the ktlsp support files for one AOSP root. `jars` is the list just
 *  injected through the global channel; the .kls/kls-classpath script cats
 *  the same per-root jar list, and its manifest comment (a digest of the jar
 *  list) changes whenever the list changes — that busts ktlsp's content-hash
 *  classpath cache, which would otherwise keep serving the old list because
 *  the script itself merely cats a file. */
export async function ensureKlsSupport(
  root: string,
  jars: string[],
  log: (msg: string) => void
): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration("aosp-nav");
    const extra = cfg.get<string[]>("kotlin.klsExcludes") ?? [];
    // depth-agnostic segment match: a name that also occurs inside frameworks
    // or packages would silently drop real Kotlin sources there
    const risky = extra.filter((n) => ["packages", "tools", "test", "tests", "log", "system", "build", "src"].includes(n));
    if (risky.length > 0) {
      log(`[aosp-nav] kotlin: klsExcludes contain names that also occur inside frameworks/packages (${risky.join(", ")}); real sources under same-named dirs may be dropped from the Kotlin index`);
    }
    // source walk: static safe set + user extras; .kls holds no Kotlin sources
    const src = [...new Set([...DEFAULT_KLS_EXCLUDES, ...extra, KLS_DIR])].sort();
    const lines = [EXCL_MARKER, ...src, ""];
    let wrote = await writeIfChanged(path.join(root, KLS_DIR, EXCL_NAME), lines.join("\n"));
    // build-file walk: prune every top-level dir except .kls, so ktlsp finds
    // no gradle/maven resolver and uses the kls-classpath script below
    const gi = [...new Set([...AOSP_TOP_LEVEL, ...(await listTopLevelDirs(root, log))])]
      .filter((n) => n !== KLS_DIR)
      .sort();
    const giPath = path.join(root, ".gitignore");
    const next = upsertGitignoreBlock(await readIfExists(giPath), gi);
    if (next !== null) wrote = (await writeIfChanged(giPath, next)) || wrote;
    const manifest = djb2(jars.join("\n"));
    const cp =
      "#!/bin/sh\n" +
      `# aosp-nav managed -- ktlsp classpath (manifest ${manifest})\n` +
      `cat ${shQuote(jarListPathFor(root))}\n`;
    wrote = (await writeIfChanged(path.join(root, KLS_DIR, CP_NAME), cp, 0o755)) || wrote;
    if (wrote) log("[aosp-nav] kotlin: ktlsp exclusions/pruning files ready");
  } catch (e) {
    log(`[aosp-nav] kotlin: failed to write ktlsp support files: ${e}`);
  }
}

function installDir(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, "ktlsp");
}

function serverBin(ctx: vscode.ExtensionContext): string {
  return path.join(installDir(ctx), "server", "bin", "kotlin-language-server");
}

/** JDK 21 is a hard requirement of ktlsp rc1 (AOSP builds usually run 17).
 *  Anything already set by the user is never touched; only a detection hit is
 *  written, workspace-level. */
async function findJava21Home(): Promise<string | null> {
  const has21 = async (dir: string): Promise<string | null> => {
    const rel = await readIfExists(path.join(dir, "release"));
    return rel && /^JAVA_VERSION="?21/m.test(rel) ? dir : null;
  };
  // JAVA_HOME usually points at the JDK itself, not at the jvm parent dir
  const jh = process.env.JAVA_HOME;
  if (jh && (await has21(jh))) return jh;
  for (const base of ["/usr/lib/jvm", "/Library/Java/JavaVirtualMachines", ...(jh ? [jh] : [])]) {
    let names: string[] = [];
    try {
      names = await fs.readdir(base);
    } catch {
      continue;
    }
    for (const n of names) {
      const hit = await has21(path.join(base, n));
      if (hit) return hit;
    }
  }
  return null;
}

function settingIsUserSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

async function writeKtlspSettings(ctx: vscode.ExtensionContext, log: (msg: string) => void): Promise<void> {
  try {
    const kc = vscode.workspace.getConfiguration("kotlin");
    const insp = kc.inspect<string>("languageServer.path");
    if (
      settingIsUserSet(insp?.workspaceValue) ||
      settingIsUserSet(insp?.globalValue) ||
      settingIsUserSet(insp?.workspaceFolderValue)
    ) {
      log("[aosp-nav] kotlin: user-managed kotlin.languageServer.path present, bootstrap stays out of the way");
      return;
    }
    await kc.update("languageServer.path", serverBin(ctx), vscode.ConfigurationTarget.Workspace);
    const inspH = kc.inspect<string>("java.home");
    if (!settingIsUserSet(inspH?.workspaceValue) && !settingIsUserSet(inspH?.globalValue)) {
      const jdk = await findJava21Home();
      if (jdk) await kc.update("java.home", jdk, vscode.ConfigurationTarget.Workspace);
      else log("[aosp-nav] kotlin: no JDK 21 detected; set kotlin.java.home yourself (ktlsp rc1 requirement)");
    }
    log("[aosp-nav] kotlin: kotlin.languageServer.path -> ktlsp (workspace settings; reload the window to apply)");
    void vscode.window.showInformationMessage(vscode.l10n.t(
      "[aosp-nav] The Kotlin language server was switched to ktlsp (the fwcd server is deprecated and freezes on large trees). Reload the window to apply."
    ));
  } catch (e) {
    log(`[aosp-nav] kotlin: failed to write ktlsp settings: ${e}`);
  }
}

let bootstrapped = false;

/** Download the pinned ktlsp server.zip into the extension's global storage
 *  and point kotlin.languageServer.path at it. Fire-and-forget: the 87 MiB
 *  download must not delay the injection flow, and a failure falls back to
 *  guiding the user through the manual install (README Kotlin section); the
 *  flag is reset so the next Kotlin file open retries automatically. */
export function ensureKtlspBootstrap(ctx: vscode.ExtensionContext, log: (msg: string) => void): void {
  if (process.platform === "win32" || bootstrapped) return;
  bootstrapped = true;
  void (async () => {
    const bin = serverBin(ctx);
    if ((await readIfExists(bin)) !== null) {
      await writeKtlspSettings(ctx, log);
      return;
    }
    log(`[aosp-nav] kotlin: downloading ktlsp ${KTLSP_VERSION} ...`);
    const zip = path.join(ctx.globalStorageUri.fsPath, "ktlsp-server.zip");
    await fs.mkdir(ctx.globalStorageUri.fsPath, { recursive: true });
    // bounded and cancellable, and the 87 MiB archive is piped to disk
    // instead of being buffered as one ArrayBuffer in memory
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new Error(`timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`)),
      DOWNLOAD_TIMEOUT_MS
    );
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `[aosp-nav] Downloading ktlsp ${KTLSP_VERSION}`,
          cancellable: true,
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => ac.abort(new Error("cancelled by user")));
          const res = await fetch(KTLSP_URL, { signal: ac.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status} from ${KTLSP_URL}`);
          if (!res.body) throw new Error(`empty response body from ${KTLSP_URL}`);
          await pipeline(
            Readable.fromWeb(res.body as import("stream/web").ReadableStream),
            createWriteStream(zip)
          );
        }
      );
    } finally {
      clearTimeout(timer);
    }
    await fs.mkdir(installDir(ctx), { recursive: true });
    await extractZip(zip, installDir(ctx));
    await fs.rm(zip, { force: true });
    await fs.chmod(bin, 0o755).catch(() => { /* best effort */ });
    await fs.writeFile(path.join(installDir(ctx), "VERSION"), `${KTLSP_VERSION}\n`);
    log(`[aosp-nav] kotlin: ktlsp ${KTLSP_VERSION} installed to ${installDir(ctx)}`);
    await writeKtlspSettings(ctx, log);
  })().catch((e) => {
    const chain: string[] = [];
    for (let c: unknown = e; c; c = (c as Error).cause) chain.push(String(c));
    log(`[aosp-nav] kotlin: ktlsp bootstrap failed: ${chain.join(" <- ")}`);
    // remove a truncated archive so the next attempt starts clean
    void fs.rm(path.join(ctx.globalStorageUri.fsPath, "ktlsp-server.zip"), { force: true }).catch(() => {});
    bootstrapped = false; // transient fetch errors must not stick for the session
    void vscode.window.showWarningMessage(vscode.l10n.t(
      "[aosp-nav] The ktlsp download failed; install it manually per the ktlsp release page (codeberg.org/winlogon/ktlsp) and set kotlin.languageServer.path. Kotlin navigation stays on the frozen fwcd server until then."
    ));
  });
}

export interface KlsProbe {
  /** entries in .kls/exclusions.txt, or null when the file is missing */
  exclusions: number | null;
  /** managed prune block present in the root .gitignore */
  gitignore: boolean;
  klsClasspath: boolean;
  ls: "ktlsp (bundled)" | "custom" | "fwcd default (deprecated)";
  version: string | null;
}

/** Diagnostics probe for the ktlsp side of the channel: separates "stuck on
 *  the frozen fwcd server" from "ktlsp active but support files missing". */
export async function probeKlsSupport(root: string, ctx: vscode.ExtensionContext): Promise<KlsProbe> {
  const excl = await readIfExists(path.join(root, KLS_DIR, EXCL_NAME));
  const exclusions = excl === null
    ? null
    : excl.split("\n").filter((l) => { const t = l.trim(); return t !== "" && !t.startsWith("#"); }).length;
  const gi = await readIfExists(path.join(root, ".gitignore"));
  const lsPath = vscode.workspace.getConfiguration("kotlin").get<string>("languageServer.path");
  const ours = installDir(ctx);
  const version = lsPath && lsPath.startsWith(ours) ? (await readIfExists(path.join(ours, "VERSION")))?.trim() ?? null : null;
  return {
    exclusions,
    gitignore: gi !== null && gi.includes(GI_BEGIN),
    klsClasspath: (await readIfExists(path.join(root, KLS_DIR, CP_NAME))) !== null,
    ls: !lsPath ? "fwcd default (deprecated)" : lsPath.startsWith(ours) ? "ktlsp (bundled)" : "custom",
    version,
  };
}

/** Rollback (aosp-nav.resetSettings): remove our .kls artifacts and the
 *  managed .gitignore block, then drop the ktlsp settings we wrote (only when
 *  kotlin.languageServer.path points into our install — a user's own LS path
 *  or JDK choice is never touched). */
export async function clearKlsSupport(ctx: vscode.ExtensionContext, roots: string[]): Promise<void> {
  for (const root of roots) {
    const excl = path.join(root, KLS_DIR, EXCL_NAME);
    if ((await readIfExists(excl))?.includes(EXCL_MARKER)) await fs.rm(excl, { force: true });
    const cp = path.join(root, KLS_DIR, CP_NAME);
    if ((await readIfExists(cp))?.includes("aosp-nav managed")) await fs.rm(cp, { force: true });
    await fs.rmdir(path.join(root, KLS_DIR)).catch(() => { /* not empty or missing */ });
    const gi = path.join(root, ".gitignore");
    const cur = await readIfExists(gi);
    const idx = cur !== null ? cur.indexOf(GI_BEGIN) : -1;
    if (idx >= 0) {
      const end = cur!.indexOf(GI_END, idx + GI_BEGIN.length);
      const stop = end < 0 ? cur!.length : end + GI_END.length;
      let prefix = cur!.slice(0, idx);
      if (prefix !== "" && !prefix.endsWith("\n")) prefix += "\n";
      await writeIfChanged(gi, prefix + (end < 0 ? "" : cur!.slice(stop).replace(/^\n/, "")));
    }
  }
  const kc = vscode.workspace.getConfiguration("kotlin");
  const ls = kc.inspect<string>("languageServer.path");
  if (ls?.workspaceValue && ls.workspaceValue.startsWith(installDir(ctx))) {
    await kc.update("languageServer.path", undefined, vscode.ConfigurationTarget.Workspace);
    // both settings were written together by the bootstrap, so they go together
    await kc.update("java.home", undefined, vscode.ConfigurationTarget.Workspace);
  }
}
