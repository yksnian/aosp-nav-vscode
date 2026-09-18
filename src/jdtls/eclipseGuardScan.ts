import * as path from "path";
import * as fs from "fs/promises";
import type { Dirent } from "fs";

const SKIP_DIRS = new Set(["out", ".repo", ".git", "node_modules", ".metadata"]);
const MAX_DEPTH = 5;

export interface GuardReport {
  folder: string;
  blockers: string[];
  rootBlocked: boolean;
}

export function escapeGlob(p: string): string {
  return p.replace(/[*?[\]{}\\]/g, (c) => "\\" + c);
}

export function patternsFor(report: GuardReport): string[] {
  const set = new Set<string>(report.blockers);
  if (report.rootBlocked) set.add(report.folder);
  return [...set].map(escapeGlob);
}

export async function scanBlockers(folder: string): Promise<GuardReport> {
  folder = path.resolve(folder);
  const blockers: string[] = [];
  let rootBlocked = false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: folder, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const hasProject = entries.some((e) => e.isFile() && e.name === ".project");
    const hasClasspath = entries.some((e) => e.isFile() && e.name === ".classpath");
    if (hasProject && hasClasspath) {
      if (dir === folder) rootBlocked = true;
      else blockers.push(dir);
    }
    if (depth >= MAX_DEPTH) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return { folder, blockers, rootBlocked };
}
