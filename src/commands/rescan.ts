import * as fs from "fs/promises";
import * as path from "path";
import { djb2 } from "../infra/hash";

/** Delete only THIS tree's jar cache.
 *
 *  The previous implementation removed every `jars-*.json` under the global
 *  storage directory. Two windows of different AOSP trees share that folder,
 *  so a manual rescan in one window forced the other tree to rescan the whole
 *  `out/soong/.intermediates` on its next open. The cache file name is derived
 *  from the root (djb2), so the target is known exactly. */
export function invalidateCache(globalStorage: string, root: string): void {
  const file = path.join(globalStorage, `jars-${djb2(root)}.json`);
  void fs.rm(file, { force: true }).catch(() => {
    /* missing/unwritable cache: a rescan rebuilds it anyway */
  });
}
