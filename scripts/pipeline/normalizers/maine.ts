/**
 * Maine normalizer.
 *
 * Ported from report_pipeline/src/normalizers/maine.rs.
 * - Removes duplicate candidate entries
 * - Exhausts ballot after two sequential undervotes (skipped rankings)
 * - Stops at first overvote
 */

import type { Ballot, NormalizedBallot, CandidateId } from "../types";

export function maineNormalizer(ballot: Ballot): NormalizedBallot {
  const seen = new Set<CandidateId>();
  const newChoices: CandidateId[] = [];
  let lastSkipped = false;
  let overvoted = false;

  for (const choice of ballot.choices) {
    switch (choice.type) {
      case "vote":
        if (!seen.has(choice.candidate)) {
          seen.add(choice.candidate);
          newChoices.push(choice.candidate);
        }
        lastSkipped = false;
        break;
      case "undervote":
        if (lastSkipped) {
          // Two sequential skipped rankings -- exhaust ballot
          return { id: ballot.id, choices: newChoices, overvoted };
        }
        lastSkipped = true;
        break;
      case "overvote":
        overvoted = true;
        return { id: ballot.id, choices: newChoices, overvoted };
    }
  }

  return { id: ballot.id, choices: newChoices, overvoted };
}
