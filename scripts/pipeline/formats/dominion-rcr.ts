/**
 * Dominion RCV Results format reader.
 *
 * Ported from report_pipeline/src/formats/dominion_rcr/parser.rs.
 *
 * Tab-separated format:
 * Line 1: header (num_seats, num_candidates, num_precincts, num_counting_groups)
 * Line 2: election name
 * Next N lines: candidate names
 * Next P lines: numbered precincts
 * Next G lines: numbered counting groups
 * Remaining: ballot data (precinct, counting_group, count, choices...)
 *
 * Choices are candidate IDs (1-based, 0 = undervote).
 * Multiple IDs joined with '=' represent overvotes.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { normalizeName } from "../normalize-name";
import type { Ballot, Choice, Election, Candidate } from "../types";

function parseChoice(part: string): Choice {
  const candidateId = parseInt(part, 10);
  if (candidateId === 0) {
    return { type: "undervote" };
  }
  return { type: "vote", candidate: candidateId - 1 };
}

function parseBallotEntry(entry: string): Choice {
  const parts = entry.split("=");
  if (parts.length === 1) {
    return parseChoice(parts[0]);
  }
  // Multiple candidates at same rank = overvote
  return { type: "overvote" };
}

export function dominionRcrReader(
  basePath: string,
  params: Record<string, string>
): Election {
  const rcrFile = params.rcr;
  if (!rcrFile) throw new Error("dominion_rcr requires 'rcr' parameter");

  const raw = readFileSync(join(basePath, rcrFile), "utf-8");
  const lines = raw.split("\n");
  let lineIdx = 0;

  const nextLine = (): string => {
    while (lineIdx < lines.length) {
      const line = lines[lineIdx++];
      if (line !== undefined) return line;
    }
    throw new Error("Unexpected end of RCR file");
  };

  // Parse header
  const headerParts = nextLine().split("\t");
  const numCandidates = parseInt(headerParts[1], 10);
  const numPrecincts = parseInt(headerParts[2], 10);
  const numCountingGroups = parseInt(headerParts[3], 10);

  // Election name (skip)
  nextLine();

  // Parse candidates
  const candidates: Candidate[] = [];
  for (let i = 0; i < numCandidates; i++) {
    const name = nextLine().trim();
    candidates.push({
      name: normalizeName(name, false),
      candidate_type: "Regular",
    });
  }

  // Skip precincts and counting groups
  for (let i = 0; i < numPrecincts; i++) nextLine();
  for (let i = 0; i < numCountingGroups; i++) nextLine();

  // Parse ballots
  const ballots: Ballot[] = [];

  while (lineIdx < lines.length) {
    const line = lines[lineIdx++];
    if (!line || !line.trim()) continue;

    const parts = line.split("\t");
    if (parts.length < 4) continue;

    // precinct, counting_group, count, choices...
    const count = parseInt(parts[2], 10);
    const choices: Choice[] = [];
    for (let j = 3; j < parts.length; j++) {
      if (parts[j].trim()) {
        choices.push(parseBallotEntry(parts[j].trim()));
      }
    }

    for (let k = 0; k < count; k++) {
      ballots.push({
        id: ballots.length.toString(),
        choices: [...choices],
      });
    }
  }

  return { candidates, ballots };
}
