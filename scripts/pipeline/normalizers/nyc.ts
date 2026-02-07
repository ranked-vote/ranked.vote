/**
 * NYC normalizer.
 *
 * Ported from report_pipeline/src/normalizers/nyc.rs.
 * - Removes duplicate candidate entries
 * - Stops at first overvote
 * - Ignores undervotes
 * - Returns null for ballots with no valid votes (filters inactive ballots)
 */

import type { Ballot, NormalizedBallot, CandidateId } from "../types";

export function nycNormalizer(ballot: Ballot): NormalizedBallot | null {
  const seen = new Set<CandidateId>();
  const newChoices: CandidateId[] = [];
  let overvoted = false;
  let hasValidVotes = false;

  for (const choice of ballot.choices) {
    switch (choice.type) {
      case "vote":
        if (!seen.has(choice.candidate)) {
          seen.add(choice.candidate);
          newChoices.push(choice.candidate);
          hasValidVotes = true;
        }
        break;
      case "overvote":
        overvoted = true;
        if (hasValidVotes) {
          return { id: ballot.id, choices: newChoices, overvoted };
        }
        return null; // No valid votes before overvote
      case "undervote":
        // Ignore undervotes
        break;
    }
  }

  if (!hasValidVotes) return null;
  return { id: ballot.id, choices: newChoices, overvoted };
}
