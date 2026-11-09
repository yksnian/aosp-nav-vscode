import * as fs from "fs/promises";
import * as path from "path";
import type { Dirent } from "fs";

/** Concurrency used by the tree walks. Measured on a real AOSP tree
 *  (`out/soong/.intermediates`, 2552 jars): serial 403-506 ms, 8 workers
 *  ~200 ms, 16 workers ~190 ms — the curve flattens after 8, so 8 is the
 *  default (keeps WSL/9p I/O bounded too). */
export const DEFAULT_WALK_CONCURRENCY = 8;

/** Highlight: a rebuild replaces jars wholesale, so a full stat of the list is
 *  affordable up to this size. Measured: 2552 jars = 56 ms at concurrency 8. */
export const FULL_VERIFY_LIMIT = 4000;
/** Above FULL_VERIFY_LIMIT only evenly spaced entries are probed. */
export const SAMPLE_PROBES = 128;

export class ScanCancelledError extends Error {
  constructor(message = "scan cancelled") {
    super(message);
    this.name = "ScanCancelledError";
  }
}

export interface WalkVisit {
  dir: string;
  depth: number;
  entries: Dirent[];
}

export interface WalkOptions {
  /** readdir calls allowed at once (default DEFAULT_WALK_CONCURRENCY) */
  concurrency?: number;
  /** polled before every readdir; throw ScanCancelledError when true */
  shouldCancel?: () => boolean;
  /** progress callback, fired every `progressEvery` directories */
  onDirs?: (dirs: number) => void;
  progressEvery?: number;
  /** return true to skip a subdirectory */
  skipDir?: (name: string, parent: string, depth: number) => boolean;
  /** do not descend past this depth (0 = only the base directory) */
  maxDepth?: number;
  visit?: (v: WalkVisit) => void;
}

/** Bounded-concurrency directory walk.
 *
 *  The serial DFS this replaces left the extension single-threaded on
 *  readdir for the whole tree; a small worker pool roughly halves the wall
 *  clock and makes cancellation possible between directories. */
export async function walkDirs(
  base: string,
  opts: WalkOptions = {}
): Promise<{ dirs: number }> {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_WALK_CONCURRENCY);
  const shouldCancel = opts.shouldCancel ?? (() => false);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: base, depth: 0 }];
  /** queued + currently being read */
  let outstanding = 1;
  let dirs = 0;
  const waiters: Array<() => void> = [];

  const wakeOne = (): void => {
    const w = waiters.pop();
    if (w) w();
  };
  const wakeAll = (): void => {
    while (waiters.length > 0) waiters.pop()!();
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (shouldCancel()) throw new ScanCancelledError();
      if (queue.length === 0) {
        if (outstanding === 0) return;
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      const { dir, depth } = queue.pop()!;
      let entries: Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        /* unreadable directory: treat as empty, same as the serial version */
      }
      dirs++;
      if (opts.onDirs && dirs % (opts.progressEvery ?? 200) === 0) opts.onDirs(dirs);
      opts.visit?.({ dir, depth, entries });
      if (depth < (opts.maxDepth ?? Infinity)) {
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (opts.skipDir?.(e.name, dir, depth + 1)) continue;
          queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
          outstanding++;
          wakeOne();
        }
      }
      outstanding--;
      if (outstanding === 0) wakeAll();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { dirs };
}

/** Recursively list all *.jar files under base. Node-only, no external deps. */
export async function scanJars(
  base: string,
  opts: Omit<WalkOptions, "visit"> = {}
): Promise<string[]> {
  const out: string[] = [];
  await walkDirs(base, {
    ...opts,
    visit: ({ dir, entries }) => {
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".jar")) out.push(path.join(dir, e.name));
      }
    },
  });
  return out;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface JarVerifyResult {
  checked: number;
  missing: number;
  /** true when only samples were probed (list larger than FULL_VERIFY_LIMIT) */
  sampled: boolean;
}

async function pooled<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/** Verify that the cached jar list still points at existing files.
 *
 *  A rebuild can delete/replace jars while the cached list survives; feeding
 *  jdt.ls a list with dead paths silently loses navigation for those modules
 *  until a manual rescan. Measuring showed a full stat of 2552 jars costs
 *  ~56 ms at concurrency 8, so lists up to FULL_VERIFY_LIMIT are checked
 *  completely; larger lists (network mounts, huge trees) fall back to evenly
 *  spaced probes, where deletions from a rebuild are broad rather than
 *  one-off. */
export async function verifyJars(
  jars: string[],
  opts: { concurrency?: number; shouldCancel?: () => boolean } = {}
): Promise<JarVerifyResult> {
  if (jars.length === 0) return { checked: 0, missing: 0, sampled: false };
  const sampled = jars.length > FULL_VERIFY_LIMIT;
  let targets = jars;
  if (sampled) {
    const step = Math.max(1, Math.floor(jars.length / SAMPLE_PROBES));
    targets = [];
    for (let i = 0; i < jars.length; i += step) targets.push(jars[i]);
  }
  let missing = 0;
  await pooled(targets, Math.max(1, opts.concurrency ?? DEFAULT_WALK_CONCURRENCY), async (p) => {
    if (opts.shouldCancel?.()) return;
    if (!(await fileExists(p))) missing++;
  });
  return { checked: targets.length, missing, sampled };
}
