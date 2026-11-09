import * as path from "path";

/** Pure planning helpers for `java.project.sourcePaths`, kept free of the
 *  `vscode` import so they can be unit-tested directly. */

export interface ResolvedRoots {
  paths: string[];
  missing: string[];
}

/** Resolve configured entries (relative to the AOSP root, or absolute) and
 *  keep only directories that exist. Relative entries are what
 *  `aosp-nav.java.sourceRoots` defaults to (`frameworks/base/core/java`), so
 *  the same list works for any checkout. */
export async function resolveSourceRoots(
  root: string,
  entries: string[],
  isDirectory: (p: string) => Promise<boolean>
): Promise<ResolvedRoots> {
  const paths: string[] = [];
  const missing: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const abs = path.isAbsolute(entry) ? path.normalize(entry) : path.resolve(root, entry);
    if (paths.includes(abs)) continue;
    if (await isDirectory(abs)) paths.push(abs);
    else missing.push(abs);
  }
  return { paths, missing };
}

export interface SourcePathsPlan {
  /** the workspace-layer list to write */
  next: string[];
  /** entries this extension now owns (used for rollback) */
  own: string[];
  added: number;
  removed: number;
}

/** Compute the workspace-layer `java.project.sourcePaths` value.
 *
 *  - entries this extension wrote earlier (`own`) are dropped when they are no
 *    longer desired, so changing the config does not leave dead roots behind;
 *  - user-authored entries are never touched;
 *  - desired entries missing from the base are appended in order, so the
 *    configured defaults keep priority over whatever happened to be there. */
export function planSourcePaths(base: string[], own: string[], desired: string[]): SourcePathsPlan {
  const ownSet = new Set(own);
  const desiredSet = new Set(desired);
  const kept = base.filter((p) => !ownSet.has(p) || desiredSet.has(p));

  const next = [...kept];
  let added = 0;
  for (const p of desired) {
    if (next.includes(p)) continue;
    next.push(p);
    added++;
  }

  const own2 = desired.filter((p) => ownSet.has(p) || !base.includes(p));
  const removed = base.filter((p) => ownSet.has(p) && !desiredSet.has(p)).length;
  return { next, own: own2, added, removed };
}

export function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
