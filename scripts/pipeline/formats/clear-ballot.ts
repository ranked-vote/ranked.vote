/**
 * Clear Ballot (ClearVote) cast vote record reader.
 *
 * Used by Multnomah County, Oregon (Portland). The CSV has one row per
 * ballot and one column per candidate per rank. Choice column headers look
 * like:
 *
 *   Choice_3_1:City of Portland, Mayor:2:Number of Winners 1:Keith Wilson:NON
 *
 * which is <id>:<contest>:<rank>:<winners>:<candidate>:<party>. A cell holds
 * 1 when that candidate is marked at that rank.
 *
 * Params:
 *   file         CSV file name (required)
 *   contestName  only read columns for this contest (optional when the file
 *                holds a single contest)
 *   overvote     "skip" to ignore a rank with more than one mark and move on
 *                to the next rank (Portland's rule), or "exhaust" (default)
 *                to stop counting the ballot at that rank
 */

import { readFileSync } from "fs";
import { join } from "path";
import { CandidateMap } from "../candidate-map";
import { parseCsvLine } from "../xlsx-to-csv";
import type { Ballot, CandidateType, Choice, Election } from "../types";

export interface ChoiceColumn {
  index: number;
  contest: string;
  rank: number;
  candidate: string;
}

export function parseChoiceHeader(
  header: string,
  index: number,
): ChoiceColumn | null {
  if (!header.startsWith("Choice_")) return null;
  const parts = header.split(":");
  if (parts.length < 5) return null;
  const rank = parseInt(parts[2], 10);
  if (!Number.isFinite(rank)) return null;
  return { index, contest: parts[1], rank, candidate: parts[4] };
}

export function candidateInfo(name: string): {
  name: string;
  candidate_type: CandidateType;
} {
  if (/^write-?in(-\d+)?$/i.test(name) || /uncertified write.?in/i.test(name)) {
    return { name: "Write-in", candidate_type: "WriteIn" };
  }
  return { name, candidate_type: "Regular" };
}

export function clearBallotReader(
  basePath: string,
  params: Record<string, string>,
): Election {
  if (!params.file) throw new Error("clear_ballot requires 'file' parameter");
  const skipOvervotes = params.overvote === "skip";

  const raw = readFileSync(join(basePath, params.file), "utf-8");
  const lines = raw.split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? "");

  let columns = header
    .map((h, i) => parseChoiceHeader(h, i))
    .filter((c): c is ChoiceColumn => c !== null);
  if (params.contestName) {
    columns = columns.filter((c) => c.contest === params.contestName);
  }
  const contests = new Set(columns.map((c) => c.contest));
  if (contests.size !== 1) {
    throw new Error(
      `clear_ballot expected one contest, found: ${[...contests].join("; ") || "none"}`,
    );
  }

  const maxRank = Math.max(...columns.map((c) => c.rank));
  const candidateMap = new CandidateMap<string>();
  const ballotIdCol = header.indexOf("BallotID");

  const ballots: Ballot[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const fields = parseCsvLine(line);

    const marks: string[][] = Array.from({ length: maxRank }, () => []);
    for (const col of columns) {
      if (fields[col.index]?.trim() === "1") {
        marks[col.rank - 1].push(col.candidate);
      }
    }

    const choices: Choice[] = [];
    for (const marked of marks) {
      if (marked.length === 0) {
        choices.push({ type: "undervote" });
      } else if (marked.length > 1) {
        choices.push(
          skipOvervotes ? { type: "undervote" } : { type: "overvote" },
        );
      } else {
        const info = candidateInfo(marked[0]);
        choices.push(candidateMap.addIdToChoice(info.name, info));
      }
    }

    const id = (ballotIdCol >= 0 && fields[ballotIdCol]) || String(i);
    ballots.push({ id, choices });
  }

  return { candidates: candidateMap.intoCandidates(), ballots };
}
