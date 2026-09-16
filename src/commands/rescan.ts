import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

export function invalidateCache(globalStorage: string, root: string): void {
  // jar cache files are named jars-<djb2(root)>.json; simplest robust approach:
  // remove all jar cache files (cheap to rebuild), session re-detects on next open
  const dir = globalStorage;
  fs.readdir(dir).then((files) => {
    for (const f of files) {
      if (f.startsWith("jars-") && f.endsWith(".json")) {
        void fs.rm(path.join(dir, f), { force: true });
      }
    }
  });
}
