import * as path from "path";
import type { Dirent } from "fs";
import { walkDirs, DEFAULT_WALK_CONCURRENCY } from "../infra/fsScan";

const SKIP_DIRS = new Set(["out", ".repo", ".git", "node_modules", ".metadata"]);

export interface GuardReport {
  folder: string;
  blockers: string[];
  rootBlocked: boolean;
}

export interface GuardScanOptions {
  concurrency?: number;
  shouldCancel?: () => boolean;
  onDirs?: (dirs: number) => void;
}

export function escapeGlob(p: string): string {
  return p.replace(/[*?[\]{}\\]/g, (c) => "\\" + c);
}

export function patternsFor(report: GuardReport): string[] {
  // The root itself is never excluded: a `**`-style whole-window exclude would
  // leave nothing for jdt.ls to work on. rootBlocked is surfaced as an
  // actionable warning instead (the fix is to open the AOSP root or a
  // sub-directory, which this extension cannot do for the user).
  return [...new Set(report.blockers)].map(escapeGlob);
}

/** Walk the whole tree looking for directories that still carry a .project
 *  file. `.project` ALONE is the blocker: redhat.java treats any such dir as
 *  an Eclipse project, and a single imported project suppresses the invisible
 *  project that referencedLibraries depends on. Requiring .classpath too was
 *  wrong — on a real AOSP tree that found 100 of 159 marker dirs, and after
 *  excluding all of them the root invisible project finally appeared.
 *
 *  No depth cap: the 4 dirs deeper than level 5 would otherwise stay behind
 *  and keep the invisible project away. Cost on the real tree (325k dirs,
 *  concurrency 8) is 7.9 s, versus 1.6 s at depth 5 — paid once per 24 h
 *  because the report is cached, and cancellable via the progress notification.
 *  Runs through the shared bounded-concurrency walker (the serial version used
 *  to cost 12 s at activation). */
export async function scanBlockers(
  folder: string,
  opts: GuardScanOptions = {}
): Promise<GuardReport> {
  folder = path.resolve(folder);
  const blockers: string[] = [];
  let rootBlocked = false;
  await walkDirs(folder, {
    concurrency: opts.concurrency ?? DEFAULT_WALK_CONCURRENCY,
    shouldCancel: opts.shouldCancel,
    onDirs: opts.onDirs,
    skipDir: (name: string) => SKIP_DIRS.has(name),
    visit: ({ dir, depth, entries }: { dir: string; depth: number; entries: Dirent[] }) => {
      const hasProject = entries.some((e) => e.isFile() && e.name === ".project");
      if (!hasProject) return;
      if (dir === folder && depth === 0) rootBlocked = true;
      else blockers.push(dir);
    },
  });
  return { folder, blockers, rootBlocked };
}
