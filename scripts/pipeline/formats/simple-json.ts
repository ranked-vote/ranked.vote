/**
 * Simple JSON format reader.
 *
 * Ported from report_pipeline/src/formats/simple_json/mod.rs.
 *
 * Reads a JSON file with structure:
 * {
 *   "ballots": [
 *     { "id": "1", "votes": ["Alice", "Bob", "over", "under"] }
 *   ]
 * }
 *
 * Special vote values: "over" = overvote, "under" = undervote.
 * All other values are treated as candidate names.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { CandidateMap } from "../candidate-map";
import type { Ballot, Choice, Election } from "../types";

interface RawBallots {
  ballots: Array<{
    id: string;
    votes: string[];
  }>;
}

function parseChoice(
  candidateName: string,
  candidateMap: CandidateMap<string>,
): Choice {
  if (candidateName === "over") return { type: "overvote" };
  if (candidateName === "under") return { type: "undervote" };
  return candidateMap.addIdToChoice(candidateName, {
    name: candidateName,
    candidate_type: "Regular",
  });
}

export function jsonReader(
  basePath: string,
  params: Record<string, string>,
): Election {
  const file = params.file;
  if (!file) throw new Error("simple_json requires 'file' parameter");

  const raw = readFileSync(join(basePath, file), "utf-8");
  const rawBallots: RawBallots = JSON.parse(raw);
  const candidateMap = new CandidateMap<string>();

  const ballots: Ballot[] = rawBallots.ballots.map((d) => ({
    id: d.id,
    choices: d.votes.map((v) => parseChoice(v, candidateMap)),
  }));

  return { candidates: candidateMap.intoCandidates(), ballots };
}
