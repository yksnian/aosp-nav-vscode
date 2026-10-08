/** Rollback of the "append" settings writes.
 *
 *  Several keys are written by *merging* our entries into whatever the user
 *  already had there: `java.import.exclusions` (array) and
 *  `files.watcherExclude` / `search.exclude` (objects). Deleting such a key
 *  wholesale — what `resetSettings` used to do — destroys the user's own
 *  entries along with ours. Since we know exactly which entries we appended,
 *  removing precisely those is both safe and idempotent, and unlike restoring
 *  a remembered previous value it does not clobber edits the user made after
 *  our write. */

export interface PeelResult {
  /** value to write back; `undefined` means "delete the key" */
  value: unknown;
  /** false when none of our entries were present — leave the key alone */
  changed: boolean;
}

/** Strip `entries` from an array of strings or an object keyed by them.
 *  Anything else (undefined, a malformed value) is returned untouched. */
export function peelAppended(value: unknown, entries: string[]): PeelResult {
  if (Array.isArray(value)) {
    const next = value.filter((v) => !entries.includes(v as string));
    if (next.length === value.length) return { value, changed: false };
    return { value: next.length > 0 ? next : undefined, changed: true };
  }
  if (value !== null && typeof value === "object") {
    const obj = { ...(value as Record<string, unknown>) };
    let hit = false;
    for (const e of entries) {
      if (e in obj) {
        delete obj[e];
        hit = true;
      }
    }
    if (!hit) return { value, changed: false };
    return { value: Object.keys(obj).length > 0 ? obj : undefined, changed: true };
  }
  return { value, changed: false };
}
