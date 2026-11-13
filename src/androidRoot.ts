import * as path from "path";
import { isDirectory } from "./infra/fsScan";

const PROBES = [
  "out/soong/.intermediates",
  "out/.soong/.intermediates",
  "out/target/common/obj/JAVA_LIBRARIES", // make era
];

/** Positive results only: dir -> root found beneath it. Negative results are
 *  deliberately not memoized — the markers appear on the first build, so a
 *  tree opened before building must be detected after it. */
const rootMemo = new Map<string, string>();

/** Walk up from a file path until a dir containing soong/make outputs is found.
 *  Walks are memoized (WSL stat latency makes the per-file-switch walk costly):
 *  after one hit every visited dir remembers the root, so later switches from
 *  the same tree stop at the first memoized ancestor. */
export async function detectAospRoot(seed: string): Promise<string | null> {
  let p = path.resolve(seed);
  const visited: string[] = [];
  while (true) {
    const hit = rootMemo.get(p);
    if (hit) {
      for (const d of visited) rootMemo.set(d, hit);
      return hit;
    }
    visited.push(p);
    for (const probe of PROBES) {
      if (await isDirectory(path.join(p, probe))) {
        for (const d of visited) rootMemo.set(d, p);
        return p;
      }
    }
    const parent = path.dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}
