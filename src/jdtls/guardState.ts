/** Pure state machine behind the eclipse guard's convergence, kept free of
 *  `vscode` imports so it can be unit-tested directly.
 *
 *  Why this is not just "blocker count > 0": the blocker dirs stay on disk by
 *  design (the guard only adds java.import.exclusions, it never deletes user
 *  files), so the raw directory count stays > 0 forever after a successful
 *  fix. Treating it as the answer made the guard permanent: the status bar
 *  advertised "N stale" and every reload re-asked for a clean+reload that had
 *  already been done. What matters is whether the user still has to act.
 *
 *  The state must also be STICKY: "we owed a clean at startup, so this reload
 *  means it happened" is only true for one session. A session after that one
 *  still sees the same dirs on disk, so without the handled-patterns record it
 *  would start asking again — a nag loop with a period of two. */
import type { GuardReport } from "./eclipseGuardScan";

export type GuardOutcome = "clean" | "converged" | "oweClean";

/** Stale .project dirs currently on disk. The workspace root itself is NOT
 *  counted: it cannot be excluded (that would exclude everything), so it can
 *  never be fixed by this guard — the root case gets its own one-time warning
 *  and must not keep the clean+reload nag alive forever. */
export function countBlockers(reports: GuardReport[]): number {
  return reports.reduce((n, r) => n + r.blockers.length, 0);
}

export interface GuardInputs {
  /** blocker dirs found on disk in this pass */
  physical: number;
  /** exclusion patterns newly written during this pass */
  addedTotal: number;
  /** writing java.import.exclusions failed (e.g. read-only settings) */
  writeFailed: boolean;
  /** this extension-host session already wrote patterns or already asked */
  touchedThisSession: boolean;
  /** a clean+reload was owed when this session started */
  wasPending: boolean;
  /** every blocker pattern present now was already declared handled */
  allHandled: boolean;
}

export function decideGuardOutcome(s: GuardInputs): GuardOutcome {
  // 1) nothing on disk -> clean, whatever the history says
  if (s.physical === 0) return "clean";

  // 2) this pass changed something, or this session is the one that asked:
  //    the window has not reloaded against the new exclusions yet
  if (s.addedTotal > 0 || s.writeFailed || s.touchedThisSession) return "oweClean";

  // 3) every blocker is covered and nothing was written this pass: a clean was
  //    owed at startup and we are only alive because that reload happened
  if (s.wasPending) return "converged";

  // 4) same, for every later session: the pattern set was already declared
  //    handled, so stop asking (a new blocker fails this check and re-asks)
  if (s.allHandled) return "converged";

  // 5) blockers excluded by rules we did not write (e.g. settings copied from
  //    another machine): we cannot know the language server was ever rebuilt
  //    against them, so ask once
  return "oweClean";
}
