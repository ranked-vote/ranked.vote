/**
 * NIST SP 1500-103 Cast Vote Record format reader.
 *
 * Ported from report_pipeline/src/formats/nist_sp_1500/mod.rs.
 *
 * Reads JSON CvrExport files with CandidateManifest.json.
 * Supports directory format with multiple CvrExport*.json files.
 * Files are stored extracted (flat), not as ZIPs.
 *
 * Session ballots may have "Original" or "Modified" records.
 * Uses "Modified" if present, otherwise "Original".
 * Contests can be nested in Cards or directly in the ballot.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { CandidateMap } from "../candidate-map";
import { normalizeName } from "../normalize-name";
import type {
  Ballot,
  Candidate,
  CandidateType,
  Choice,
  Election,
  BatchBallotReader,
} from "../types";

// ---- NIST CvrExport JSON model types ----

interface CvrExportJson {
  Version: string;
  ElectionId: string;
  Sessions: SessionJson[];
}

interface SessionJson {
  TabulatorId: number;
  BatchId: number;
  RecordId: string | number;
  CountingGroupId: number;
  ImageMask: string;
  Original: SessionBallotJson;
  Modified?: SessionBallotJson;
}

interface SessionBallotJson {
  PrecinctPortionId: number;
  BallotTypeId: number;
  IsCurrent: boolean;
  Contests?: ContestMarksJson[];
  Cards?: CardJson[];
}

interface CardJson {
  Id: number;
  PaperIndex: number;
  Contests: ContestMarksJson[];
}

interface ContestMarksJson {
  Id: number;
  Marks: MarkJson[] | string; // string for "*** REDACTED ***"
}

interface MarkJson {
  CandidateId: number;
  PartyId?: number;
  Rank: number;
  MarkDensity: number;
  IsAmbiguous: boolean;
  IsVote: boolean;
}

// ---- CandidateManifest model ----

interface CandidateManifestJson {
  Version: string;
  List: CandidateEntry[];
}

interface CandidateEntry {
  Description: string;
  Id: number;
  ExternalId?: string;
  ContestId: number;
  Type: "WriteIn" | "Regular" | "QualifiedWriteIn";
}

// ---- Helper functions ----

function getSessionContests(session: SessionJson): ContestMarksJson[] {
  // Use Modified if present, otherwise Original
  const ballot = session.Modified ?? session.Original;

  if (ballot.Contests) return ballot.Contests;

  // Contests nested in Cards
  if (ballot.Cards) {
    return ballot.Cards.flatMap((card) => card.Contests);
  }

  return [];
}

function parseMarks(rawMarks: MarkJson[] | string): MarkJson[] {
  if (typeof rawMarks === "string") return []; // "*** REDACTED ***"
  return rawMarks;
}

function getCandidates(
  manifest: CandidateManifestJson,
  contestId: number,
  dropUnqualifiedWriteIn: boolean,
): { candidateMap: CandidateMap<number>; droppedWriteInId: number | null } {
  const candidateMap = new CandidateMap<number>();
  let droppedWriteInId: number | null = null;

  for (const entry of manifest.List) {
    if (entry.ContestId !== contestId) continue;

    const candidateType: CandidateType =
      entry.Type === "WriteIn"
        ? "WriteIn"
        : entry.Type === "QualifiedWriteIn"
          ? "QualifiedWriteIn"
          : "Regular";

    if (dropUnqualifiedWriteIn && candidateType === "WriteIn") {
      droppedWriteInId = entry.Id;
      continue;
    }

    candidateMap.add(entry.Id, {
      name: normalizeName(entry.Description, false),
      candidate_type: candidateType,
    });
  }

  return { candidateMap, droppedWriteInId };
}

function processJsonCvrFile(
  content: string,
  filename: string,
  contestId: number,
  candidates: CandidateMap<number>,
  droppedWriteInId: number | null,
  ballots: Ballot[],
): number {
  let count = 0;
  const cvr: CvrExportJson = JSON.parse(content);

  for (const session of cvr.Sessions) {
    const contests = getSessionContests(session);
    for (const contest of contests) {
      if (contest.Id !== contestId) continue;

      const marks = parseMarks(contest.Marks);
      const choices: Choice[] = [];

      // Sort marks by rank, then group by rank
      const sorted = [...marks].sort((a, b) => a.Rank - b.Rank);

      let i = 0;
      while (i < sorted.length) {
        const rank = sorted[i].Rank;
        const marksAtRank: MarkJson[] = [];
        while (i < sorted.length && sorted[i].Rank === rank) {
          marksAtRank.push(sorted[i]);
          i++;
        }

        // Filter ambiguous marks
        const validMarks = marksAtRank.filter((m) => !m.IsAmbiguous);

        let choice: Choice;
        if (validMarks.length === 0) {
          choice = { type: "undervote" };
        } else if (validMarks.length === 1) {
          if (
            droppedWriteInId !== null &&
            validMarks[0].CandidateId === droppedWriteInId
          ) {
            choice = { type: "undervote" };
          } else {
            choice = candidates.idToChoice(validMarks[0].CandidateId);
          }
        } else {
          choice = { type: "overvote" };
        }

        choices.push(choice);
      }

      const recordId =
        typeof session.RecordId === "number"
          ? session.RecordId.toString()
          : session.RecordId;

      ballots.push({
        id: `${filename}:${recordId}`,
        choices,
      });
      count++;
    }
  }

  return count;
}

function resolveCvrPath(basePath: string, cvrName: string): string {
  // Handle "." as current directory
  if (cvrName === ".") return basePath;

  // Strip .zip extension — we store extracted files, not zips
  const cleanName = cvrName.replace(/\.zip$/, "");

  // Try the named subdirectory first
  const subDir = join(basePath, cleanName);
  if (existsSync(subDir) && statSync(subDir).isDirectory()) {
    return subDir;
  }

  // Fall back to base path if files are stored flat there
  const testFile = join(basePath, "CandidateManifest.json");
  if (existsSync(testFile)) {
    return basePath;
  }

  return subDir;
}

function readFromDirectory(
  dirPath: string,
  contestId: number,
  dropUnqualifiedWriteIn: boolean,
): Election {
  const manifestPath = join(dirPath, "CandidateManifest.json");
  if (!existsSync(manifestPath)) {
    console.warn(`CandidateManifest.json not found in ${dirPath}`);
    return { candidates: [], ballots: [] };
  }

  const manifest: CandidateManifestJson = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  );
  const { candidateMap, droppedWriteInId } = getCandidates(
    manifest,
    contestId,
    dropUnqualifiedWriteIn,
  );

  // Find all CvrExport JSON files
  const files = readdirSync(dirPath)
    .filter(
      (f) =>
        (f.startsWith("CvrExport") && f.endsWith(".json")) ||
        (f.startsWith("CVR_Export") && f.endsWith(".csv")),
    )
    .sort();

  const ballots: Ballot[] = [];

  for (const filename of files) {
    if (filename.endsWith(".csv")) {
      // CSV support could be added here if needed
      console.warn(`CSV format not yet supported in JS: ${filename}`);
      continue;
    }

    const content = readFileSync(join(dirPath, filename), "utf-8");
    processJsonCvrFile(
      content,
      filename,
      contestId,
      candidateMap,
      droppedWriteInId,
      ballots,
    );
  }

  return { candidates: candidateMap.intoCandidates(), ballots };
}

export function nistReader(
  basePath: string,
  params: Record<string, string>,
): Election {
  const contestId = parseInt(params.contest, 10);
  if (isNaN(contestId))
    throw new Error("nist_sp_1500 requires numeric 'contest' param");
  const cvr = params.cvr;
  if (!cvr) throw new Error("nist_sp_1500 requires 'cvr' param");
  const dropUnqualifiedWriteIn = params.dropUnqualifiedWriteIn === "true";

  const cvrPath = resolveCvrPath(basePath, cvr);

  if (existsSync(cvrPath) && statSync(cvrPath).isDirectory()) {
    return readFromDirectory(cvrPath, contestId, dropUnqualifiedWriteIn);
  }

  console.warn(
    `CVR path ${cvrPath} is not a directory, returning empty election`,
  );
  return { candidates: [], ballots: [] };
}

/**
 * Batch reader: reads CVR files once and returns elections for multiple contests.
 */
export function nistBatchReader(
  basePath: string,
  contests: Array<{
    office: string;
    contestId: number;
    params: Record<string, string>;
  }>,
): Map<string, Election> {
  const results = new Map<string, Election>();
  if (contests.length === 0) return results;

  const cvr = contests[0].params.cvr;
  if (!cvr) throw new Error("nist_sp_1500 batch requires 'cvr' param");

  const cvrPath = resolveCvrPath(basePath, cvr);

  if (!existsSync(cvrPath) || !statSync(cvrPath).isDirectory()) {
    console.warn(`Batch: CVR path ${cvrPath} is not a directory`);
    return results;
  }

  const manifestPath = join(cvrPath, "CandidateManifest.json");
  if (!existsSync(manifestPath)) {
    console.warn(`CandidateManifest.json not found in ${cvrPath}`);
    return results;
  }

  const manifest: CandidateManifestJson = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  );

  // Set up per-contest data
  const contestData = new Map<
    number,
    {
      office: string;
      candidateMap: CandidateMap<number>;
      droppedWriteInId: number | null;
      ballots: Ballot[];
    }
  >();

  for (const { office, contestId, params } of contests) {
    const dropUnqualifiedWriteIn = params.dropUnqualifiedWriteIn === "true";
    const { candidateMap, droppedWriteInId } = getCandidates(
      manifest,
      contestId,
      dropUnqualifiedWriteIn,
    );
    contestData.set(contestId, {
      office,
      candidateMap,
      droppedWriteInId,
      ballots: [],
    });
  }

  // Find all CvrExport JSON files
  const files = readdirSync(cvrPath)
    .filter((f) => f.startsWith("CvrExport") && f.endsWith(".json"))
    .sort();

  // Process each file once for all contests
  for (const filename of files) {
    const content = readFileSync(join(cvrPath, filename), "utf-8");
    const cvr: CvrExportJson = JSON.parse(content);

    for (const session of cvr.Sessions) {
      const sessionContests = getSessionContests(session);
      for (const contest of sessionContests) {
        const data = contestData.get(contest.Id);
        if (!data) continue;

        const marks = parseMarks(contest.Marks);
        const choices: Choice[] = [];
        const sorted = [...marks].sort((a, b) => a.Rank - b.Rank);

        let i = 0;
        while (i < sorted.length) {
          const rank = sorted[i].Rank;
          const marksAtRank: MarkJson[] = [];
          while (i < sorted.length && sorted[i].Rank === rank) {
            marksAtRank.push(sorted[i]);
            i++;
          }
          const validMarks = marksAtRank.filter((m) => !m.IsAmbiguous);

          let choice: Choice;
          if (validMarks.length === 0) {
            choice = { type: "undervote" };
          } else if (validMarks.length === 1) {
            if (
              data.droppedWriteInId !== null &&
              validMarks[0].CandidateId === data.droppedWriteInId
            ) {
              choice = { type: "undervote" };
            } else {
              choice = data.candidateMap.idToChoice(validMarks[0].CandidateId);
            }
          } else {
            choice = { type: "overvote" };
          }
          choices.push(choice);
        }

        const recordId =
          typeof session.RecordId === "number"
            ? session.RecordId.toString()
            : session.RecordId;

        data.ballots.push({ id: `${filename}:${recordId}`, choices });
      }
    }
  }

  // Build results
  for (const [, data] of contestData) {
    results.set(data.office, {
      candidates: data.candidateMap.intoCandidates(),
      ballots: data.ballots,
    });
  }

  return results;
}
