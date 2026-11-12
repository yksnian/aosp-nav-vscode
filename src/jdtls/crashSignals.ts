import * as fs from "fs/promises";
import * as path from "path";

/** Detection of jdt.ls crashes (plan: crash observability).
 *
 *  A crash leaves one of two traces, both readable without parsing the VS Code
 *  UI:
 *  - a heap dump / fatal-error file in the language server working directory
 *    (`java_pid*.hprof`, any `*.hprof`, `hs_err_pid*.log` — the JVM writes
 *    these when it dies of OutOfMemoryError);
 *  - an `OutOfMemoryError` / `GC overhead limit exceeded` trace in the Eclipse
 *    log the server keeps at `<jdt_ws>/.metadata/.log`.
 *
 *  A normal server restart (user command, extension update, workspace reload)
 *  leaves NEITHER, so the probe never reports a restart as a crash. The
 *  evidence is summarised as one line and its newest mtime lets the caller
 *  prompt once per new crash instead of on every scan.
 *
 *  Free of the `vscode` import so it can be unit-tested. */

export interface JdtlsCrashProbe {
  /** true only with heap-dump or OOM evidence */
  confirmed: boolean;
  /** basenames of heap dumps / JVM fatal-error logs */
  heapDumps: string[];
  /** number of matching lines in the Eclipse log */
  oomTraces: number;
  /** first matching line, trimmed (for the log/diagnostics detail) */
  oomSample: string | null;
  /** newest mtime among the evidence (0 when none) */
  newestMs: number;
  /** one-line summary, empty when not confirmed */
  evidence: string;
}

const EMPTY: JdtlsCrashProbe = {
  confirmed: false,
  heapDumps: [],
  oomTraces: 0,
  oomSample: null,
  newestMs: 0,
  evidence: "",
};

/** JVM crash artifacts: heap dumps (default `-XX:+HeapDumpOnOutOfMemoryError`
 *  name is `java_pid<pid>.hprof`) and fatal-error logs. */
const ARTIFACT_RE = /^((?:java_pid\d+|\w[\w.-]*)\.hprof|hs_err_pid\d+\.log)$/i;

const OOM_RE = /OutOfMemoryError|Java heap space|GC overhead limit exceeded/i;

/** log bytes examined from the tail: the Eclipse log grows to megabytes and a
 *  crash trace is always near the end (1 MB also covers the build output a
 *  restart writes after the trace) */
const LOG_TAIL_BYTES = 1024 * 1024;

/** sample line cap so one huge stack head does not flood the output channel */
const SAMPLE_MAX = 160;

function clip(s: string): string {
  const t = s.trim();
  return t.length > SAMPLE_MAX ? `${t.slice(0, SAMPLE_MAX)}…` : t;
}

/** Pure classifier over already-collected evidence (see probeJdtlsCrash). */
export function classifyJdtlsCrash(
  artifacts: readonly { name: string; mtimeMs: number }[],
  oomLines: readonly string[],
  logMtimeMs: number | null
): JdtlsCrashProbe {
  if (artifacts.length === 0 && oomLines.length === 0) return { ...EMPTY };

  const heapDumps = artifacts.map((a) => a.name).sort();
  const newest = Math.max(0, logMtimeMs ?? 0, ...artifacts.map((a) => a.mtimeMs));
  const parts: string[] = [];
  if (heapDumps.length > 0) {
    parts.push(`${heapDumps.length} heap dump(s): ${heapDumps.slice(0, 3).join(", ")}${heapDumps.length > 3 ? ` (+${heapDumps.length - 3} more)` : ""}`);
  }
  if (oomLines.length > 0) {
    parts.push(`${oomLines.length} OutOfMemoryError trace line(s) in .metadata/.log`);
  }
  return {
    confirmed: true,
    heapDumps,
    oomTraces: oomLines.length,
    oomSample: oomLines.length > 0 ? clip(oomLines[0]) : null,
    newestMs: newest,
    evidence: parts.join("; "),
  };
}

async function readTail(file: string, bytes: number): Promise<string | null> {
  try {
    const fh = await fs.open(file, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** Probe one language-server working directory (normally
 *  `<workspaceStorage>/<hash>/redhat.java/jdt_ws`). Never throws. */
export async function probeJdtlsCrash(wsDir: string): Promise<JdtlsCrashProbe> {
  let names: string[] = [];
  try {
    names = await fs.readdir(wsDir);
  } catch {
    return { ...EMPTY };
  }

  const artifacts: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!ARTIFACT_RE.test(name)) continue;
    try {
      const st = await fs.stat(path.join(wsDir, name));
      if (st.isFile()) artifacts.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }

  const logFile = path.join(wsDir, ".metadata", ".log");
  const tail = await readTail(logFile, LOG_TAIL_BYTES);
  const oomLines = tail === null
    ? []
    : tail.split(/\r?\n/).filter((l) => OOM_RE.test(l));
  let logMtimeMs: number | null = null;
  if (tail !== null) {
    try {
      logMtimeMs = (await fs.stat(logFile)).mtimeMs;
    } catch {
      logMtimeMs = null;
    }
  }

  return classifyJdtlsCrash(artifacts, oomLines, logMtimeMs);
}

/** The jdt.ls working directory for a workspace, derived from this
 *  extension's workspace-storage folder (`<workspaceStorage>/<hash>/<ext>`). */
export function jdtlsWorkspaceDir(extensionStoragePath: string): string {
  return path.join(path.dirname(extensionStoragePath), "redhat.java", "jdt_ws");
}
