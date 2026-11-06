import * as fs from "fs/promises";
import * as path from "path";

/** Recursively list all *.jar files under base. Node-only, no external deps. */
export async function scanJars(base: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [base];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".jar")) {
        out.push(full);
      }
    }
  }
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

/** Sample the cached jar list for missing files.
 *
 *  A rebuild can delete/replace jars while the cached list survives; feeding
 *  jdt.ls a list with dead paths silently loses navigation for those modules
 *  until a manual rescan. `stat`-ing every entry (1000+) over WSL's 9p mounts
 *  is too expensive on every hit, so probe a fixed number of evenly spaced
 *  entries — deletions from a rebuild are broad, not one-off. */
export async function anyJarMissing(jars: string[], probes = 8): Promise<boolean> {
  if (jars.length === 0) return true;
  const step = Math.max(1, Math.floor(jars.length / probes));
  for (let i = 0; i < jars.length; i += step) {
    if (!(await fileExists(jars[i]))) return true;
  }
  return false;
}
