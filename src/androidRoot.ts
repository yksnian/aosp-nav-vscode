import * as path from "path";
import { isDirectory } from "./infra/fsScan";

const PROBES = [
  "out/soong/.intermediates",
  "out/.soong/.intermediates",
  "out/target/common/obj/JAVA_LIBRARIES", // make era
];

/** Walk up from a file path until a dir containing soong/make outputs is found. */
export async function detectAospRoot(seed: string): Promise<string | null> {
  let p = path.resolve(seed);
  while (true) {
    for (const probe of PROBES) {
      if (await isDirectory(path.join(p, probe))) return p;
    }
    const parent = path.dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}
