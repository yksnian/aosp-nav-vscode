import { Defaults, ScanResult } from "./types";

/** Directory priority ordering: real implementations (source-built) always sort
 *  before prebuilts/unknown so that, even if an unnoticed stub shares an FQN,
 *  JDT (which takes the first classpath hit) resolves the real one. */
export function applyDirPriority(jars: string[], defaults: Defaults): void {
  const compiled = defaults.dirPriority.map(([pat, rank]) => {
    return { re: new RegExp(pat), rank };
  });
  const rankOf = (jar: string): number => {
    const m = /\.intermediates\/(.+)$/.exec(jar);
    const rel = m?.[1] ?? jar;
    for (const { re, rank } of compiled) {
      if (re.test(rel)) return rank;
    }
    return defaults.dirPriorityFallback;
  };
  jars.sort((a, b) => {
    const d = rankOf(a) - rankOf(b);
    if (d !== 0) return d;
    return a < b ? -1 : a > b ? 1 : 0; // stable deterministic order within a rank
  });
}
