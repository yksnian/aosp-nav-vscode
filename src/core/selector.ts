import { Defaults, ScanResult } from "./types";

/** Directory priority ordering: real implementations (source-built) always sort
 *  before prebuilts/unknown so that, even if an unnoticed stub shares an FQN,
 *  JDT (which takes the first classpath hit) resolves the real one. */
export function applyDirPriority(jars: string[], defaults: Defaults): void {
  const compiled = defaults.dirPriority.map(([pat, rank]) => {
    return { re: new RegExp(pat), rank };
  });
  const rankOf = (jar: string): number => {
    // The rules (shared with aosp-nav.nvim) are POSIX: on Windows every path
    // arrives with `\` and neither the .intermediates/ split nor a pattern like
    // `^frameworks/` would ever match, collapsing all ranks to the fallback and
    // silently dropping the "real implementation sorts before any stub"
    // guarantee. Normalize backslashes explicitly rather than via path.sep so
    // the behavior is the same on every platform (and testable from one).
    const norm = jar.replace(/\\/g, "/");
    const m = /\.intermediates\/(.+)$/.exec(norm);
    const rel = m?.[1] ?? norm;
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
