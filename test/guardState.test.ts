// test/guardState.test.ts (vitest, pure convergence state machine)
// The guard must resolve to "no action needed" once the exclusions are written
// and the one-time clean has happened — the blocker dirs themselves stay on
// disk forever, so a raw directory count can never be the answer. Each `it`
// below walks a real session transcript; `it("never oscillates")` is the one
// that caught the period-2 nag loop.
import { describe, it, expect } from "vitest";
import { decideGuardOutcome, countBlockers, GuardInputs, GuardOutcome } from "../src/jdtls/guardState";
import { GuardReport } from "../src/jdtls/eclipseGuardScan";

const inputs = (o: Partial<GuardInputs>): GuardInputs => ({
  physical: 1, addedTotal: 0, writeFailed: false, touchedThisSession: false, wasPending: false, allHandled: false, ...o,
});

describe("decideGuardOutcome", () => {
  it("is clean when no blocker dir exists on disk", () => {
    expect(decideGuardOutcome(inputs({ physical: 0 }))).toBe("clean");
  });

  it("owes a clean+reload after writing new exclusions", () => {
    expect(decideGuardOutcome(inputs({ addedTotal: 2 }))).toBe("oweClean");
  });

  it("still owes it on a later pass of the same session", () => {
    // e.g. workspace folders changed: nothing new to write, but the window has
    // not reloaded against the new exclusions yet
    expect(decideGuardOutcome(inputs({ touchedThisSession: true, wasPending: true }))).toBe("oweClean");
  });

  it("converges on the session that follows the clean+reload", () => {
    expect(decideGuardOutcome(inputs({ wasPending: true }))).toBe("converged");
  });

  it("keeps owing after a failed settings write", () => {
    // nothing was written, so going quiet here would hide a real problem
    expect(decideGuardOutcome(inputs({ writeFailed: true, wasPending: true }))).toBe("oweClean");
  });

  it("owes a clean+reload when blockers are excluded but never asked about", () => {
    // exclusions copied from another machine: we cannot know the language
    // server workspace was ever rebuilt against them
    expect(decideGuardOutcome(inputs({ wasPending: false, allHandled: false }))).toBe("oweClean");
  });

  it("stays converged in every later session (handled record)", () => {
    expect(decideGuardOutcome(inputs({ wasPending: false, allHandled: true }))).toBe("converged");
  });

  it("re-asks when a new blocker appears next to handled ones", () => {
    // the new dir failed the allHandled check and was merged in this pass
    expect(decideGuardOutcome(inputs({ addedTotal: 1, allHandled: false }))).toBe("oweClean");
  });
});

describe("guard session transcripts", () => {
  /** Replay sessions the way guardWorkspace drives them: it clears `pending`
   *  on clean/converged and re-records the handled pattern set, and it sets
   *  `touchedThisSession` + `pending` when it owes a clean. */
  function replay(sessions: Array<Partial<GuardInputs> & { patternsHandled: boolean }>): GuardOutcome[] {
    let pending = false;
    const out: GuardOutcome[] = [];
    for (const s of sessions) {
      const outcome = decideGuardOutcome({
        physical: 1, addedTotal: 0, writeFailed: false, touchedThisSession: false,
        wasPending: pending, allHandled: s.patternsHandled, ...s,
      });
      out.push(outcome);
      pending = outcome === "oweClean";
      if (outcome === "oweClean") s.patternsHandled = true; // recorded once converged
    }
    return out;
  }

  it("never oscillates: discovery -> clean+reload -> quiet forever", () => {
    // session 1 writes and asks, session 2 is the post-reload one, sessions
    // 3..5 are ordinary later startups with the same dirs still on disk
    expect(replay([
      { addedTotal: 1, touchedThisSession: true, patternsHandled: false },
      { patternsHandled: false },
      { patternsHandled: true },
      { patternsHandled: true },
      { patternsHandled: true },
    ])).toEqual(["oweClean", "converged", "converged", "converged", "converged"]);
  });

  it("never oscillates when the rules came from another machine", () => {
    // nothing to write (exclusions already there) but no record of a clean
    expect(replay([
      { patternsHandled: false },
      { patternsHandled: false },
      { patternsHandled: true },
    ])).toEqual(["oweClean", "converged", "converged"]);
  });

  it("converges even if the user dismisses the dialog (no reload handled)", () => {
    // session 1 asks; the user refuses, reloads later by hand; from then on we
    // stay quiet instead of asking at every startup
    expect(replay([
      { addedTotal: 1, touchedThisSession: true, patternsHandled: false },
      { patternsHandled: false },
      { patternsHandled: true },
    ])).toEqual(["oweClean", "converged", "converged"]);
  });
});

describe("countBlockers", () => {
  const r = (blockers: string[], rootBlocked: boolean): GuardReport => ({ folder: "/r", blockers, rootBlocked });

  it("counts blocker dirs only — a blocked workspace root is not fixable by exclusion", () => {
    expect(countBlockers([r(["/r/a", "/r/b"], false), r([], true)])).toBe(2);
  });

  it("is 0 for a clean tree", () => {
    expect(countBlockers([r([], false)])).toBe(0);
  });
});
