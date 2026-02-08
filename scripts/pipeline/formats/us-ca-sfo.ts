/**
 * San Francisco legacy ballot image format reader.
 *
 * Ported from report_pipeline/src/formats/us_ca_sfo/mod.rs.
 *
 * Reads fixed-width text files:
 * - MasterLookup.txt: Candidate metadata (fixed-width columns)
 * - BallotImage.txt: Vote records (fixed-width columns)
 *
 * Fixed-width column layouts are documented in the SF Department of Elections
 * ballot image file format specification.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { CandidateMap } from "../candidate-map";
import { normalizeName } from "../normalize-name";
import type { Ballot, Candidate, Choice, Election } from "../types";

const WRITE_IN_PREFIX = "WRITE-IN ";

interface MasterRecord {
  recordType: string;
  recordId: number;
  description: string;
  listOrder: number;
  contestId: number;
  isWritein: boolean;
  isProvisional: boolean;
}

function parseMasterRecord(line: string): MasterRecord {
  // Fixed-width character-based slicing
  const chars = [...line];
  const slice = (start: number, end: number) =>
    chars.slice(start, end).join("");

  return {
    recordType: slice(0, 10).trim(),
    recordId: parseInt(slice(10, 17).trim(), 10),
    description: slice(17, 67).trim(),
    listOrder: parseInt(slice(67, 74).trim(), 10),
    contestId: parseInt(slice(74, 81).trim(), 10),
    isWritein: slice(81, 82) === "1",
    isProvisional: slice(82, 83) === "1",
  };
}

interface BallotRecord {
  contestId: number;
  prefVoterId: number;
  serialNumber: number;
  tallyTypeId: number;
  precinctId: number;
  voteRank: number;
  candidateId: number;
  overVote: boolean;
  underVote: boolean;
}

function parseBallotRecord(line: string): BallotRecord {
  const chars = [...line];
  const slice = (start: number, end: number) =>
    chars.slice(start, end).join("");

  return {
    contestId: parseInt(slice(0, 7).trim(), 10),
    prefVoterId: parseInt(slice(7, 16).trim(), 10),
    serialNumber: parseInt(slice(16, 23).trim(), 10),
    tallyTypeId: parseInt(slice(23, 26).trim(), 10),
    precinctId: parseInt(slice(26, 33).trim(), 10),
    voteRank: parseInt(slice(33, 36).trim(), 10),
    candidateId: parseInt(slice(36, 43).trim(), 10),
    overVote: slice(43, 44) === "1",
    underVote: slice(44, 45) === "1",
  };
}

function readCandidates(
  masterContent: string,
  contestId: number,
): CandidateMap<number> {
  const candidates = new CandidateMap<number>();
  for (const line of masterContent.split("\n")) {
    if (!line.trim()) continue;
    const record = parseMasterRecord(line);
    if (record.recordType !== "Candidate") continue;
    if (record.contestId !== contestId) continue;

    let name = normalizeName(record.description, false);
    let candidateType: Candidate["candidate_type"] = record.isWritein
      ? "WriteIn"
      : "Regular";

    if (name.startsWith(WRITE_IN_PREFIX)) {
      name = name.slice(WRITE_IN_PREFIX.length);
      candidateType = "WriteIn";
    }

    candidates.add(record.recordId, {
      name,
      candidate_type: candidateType,
    });
  }
  return candidates;
}

function readBallots(
  ballotContent: string,
  candidates: CandidateMap<number>,
  contestId: number,
): Ballot[] {
  // Parse and filter records for this contest
  let records: BallotRecord[] = [];
  for (const line of ballotContent.split("\n")) {
    if (!line.trim()) continue;
    const rec = parseBallotRecord(line);
    if (rec.contestId === contestId) records.push(rec);
  }

  // Sort by voter ID
  records.sort((a, b) => a.prefVoterId - b.prefVoterId);

  // Group by voter ID
  const ballots: Ballot[] = [];
  let i = 0;
  while (i < records.length) {
    const voterId = records[i].prefVoterId;
    const voterRecords: BallotRecord[] = [];
    while (i < records.length && records[i].prefVoterId === voterId) {
      voterRecords.push(records[i]);
      i++;
    }

    const choices: Choice[] = [];
    for (let j = 0; j < voterRecords.length; j++) {
      const rec = voterRecords[j];
      if (rec.voteRank !== j + 1) {
        throw new Error("Got ballot record out of order.");
      }
      if (rec.overVote) {
        choices.push({ type: "overvote" });
      } else if (rec.underVote) {
        choices.push({ type: "undervote" });
      } else {
        choices.push(candidates.idToChoice(rec.candidateId));
      }
    }

    ballots.push({ id: voterId.toString(), choices });
  }

  return ballots;
}

export function sfoReader(
  basePath: string,
  params: Record<string, string>,
): Election {
  const contestId = parseInt(params.contest, 10);
  if (isNaN(contestId)) throw new Error("SFO requires numeric 'contest' param");
  const masterFile = params.masterLookup;
  if (!masterFile) throw new Error("SFO requires 'masterLookup' param");
  const ballotFile = params.ballotImage;
  if (!ballotFile) throw new Error("SFO requires 'ballotImage' param");

  const masterContent = readFileSync(join(basePath, masterFile), "utf-8");
  const candidates = readCandidates(masterContent, contestId);

  const ballotContent = readFileSync(join(basePath, ballotFile), "utf-8");
  const ballots = readBallots(ballotContent, candidates, contestId);

  return { candidates: candidates.intoCandidates(), ballots };
}
