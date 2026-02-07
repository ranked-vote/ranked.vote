/**
 * Simple normalizer.
 *
 * Ported from report_pipeline/src/normalizers/simple.rs.
 * - Removes duplicate candidate entries
 * - Stops at first overvote
 * - Ignores undervotes
 */

import type { Ballot, NormalizedBallot, CandidateId } from "../types";

export function simpleNormalizer(ballot: Ballot): NormalizedBallot {
  const seen = new Set<CandidateId>();
  const newChoices: CandidateId[] = [];
  let overvoted = false;

  for (const choice of ballot.choices) {
    switch (choice.type) {
      case "vote":
        if (!seen.has(choice.candidate)) {
          seen.add(choice.candidate);
          newChoices.push(choice.candidate);
        }
        break;
      case "overvote":
        overvoted = true;
        return { id: ballot.id, choices: newChoices, overvoted };
      case "undervote":
        // Ignore undervotes in simple normalization
        break;
    }
  }

  return { id: ballot.id, choices: newChoices, overvoted };
}
