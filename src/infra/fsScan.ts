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
