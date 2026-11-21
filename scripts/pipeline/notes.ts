import type { Contest, ElectionMetadata } from "./types";

/**
 * Notes shown on a report: the election's notes, then the contest's.
 * Returns null when neither is set.
 */
export function reportNotes(
  election: Pick<ElectionMetadata, "notes">,
  contest: Pick<Contest, "notes">,
): string | null {
  const parts = [election.notes, contest.notes]
    .map((n) => n?.trim())
    .filter((n): n is string => !!n);
  return parts.length ? parts.join(" ") : null;
}
