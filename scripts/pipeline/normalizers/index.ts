/**
 * Normalizer dispatch.
 *
 * Ported from report_pipeline/src/normalizers/mod.rs.
 * Selects the correct normalizer based on the format string from metadata.
 */

import type {
  Ballot,
  NormalizedBallot,
  Election,
  NormalizedElection,
} from "../types";
import { simpleNormalizer } from "./simple";
import { maineNormalizer } from "./maine";
import { nycNormalizer } from "./nyc";

type BallotNormalizer = (ballot: Ballot) => NormalizedBallot;
type OptionalBallotNormalizer = (ballot: Ballot) => NormalizedBallot | null;

function getNormalizerForFormat(format: string): BallotNormalizer {
  switch (format) {
    case "simple":
      return simpleNormalizer;
    case "maine":
      return maineNormalizer;
    default:
      throw new Error(`Normalizer "${format}" is not implemented.`);
  }
}

function getOptionalNormalizerForFormat(
  format: string
): OptionalBallotNormalizer | null {
  switch (format) {
    case "nyc":
      return nycNormalizer;
    default:
      return null;
  }
}

export function normalizeElection(
  format: string,
  election: Election
): NormalizedElection {
  const optionalNormalizer = getOptionalNormalizerForFormat(format);

  if (optionalNormalizer) {
    // For NYC-style normalization, filter out inactive ballots
    const ballots: NormalizedBallot[] = [];
    for (const ballot of election.ballots) {
      const normalized = optionalNormalizer(ballot);
      if (normalized) ballots.push(normalized);
    }
    return { candidates: election.candidates, ballots };
  }

  // For standard normalization, process all ballots
  const normalizer = getNormalizerForFormat(format);
  const ballots = election.ballots.map(normalizer);
  return { candidates: election.candidates, ballots };
}
