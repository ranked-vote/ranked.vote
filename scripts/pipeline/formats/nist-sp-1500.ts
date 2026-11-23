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
  OutstackConditionIds?: number[] | string; // string for "*** REDACTED ***"
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
  // Match Rust behavior:
  // If Original has Contests directly, use those (even if Modified exists).
  // Only fall back to Modified (via ballot()) for the Cards path.
  if (session.Original.Contests) {
    return session.Original.Contests;
  }

  // Contests nested in Cards — use Modified if present, otherwise Original
  const ballot = session.Modified ?? session.Original;
  if (ballot.Cards) {
    return ballot.Cards.flatMap((card) => card.Contests);
  }

  return [];
}

function parseMarks(rawMarks: MarkJson[] | string): MarkJson[] {
  if (typeof rawMarks === "string") return []; // "*** REDACTED ***"
  return rawMarks;
}

/**
 * Outstack condition IDs that mean the tabulator did not count the contest
 * on this ballot ("InvalidContest"). Alaska's exports flag a few thousand
 * contest records this way, and the official count leaves them out.
 */
export function invalidContestConditionIds(dirPath: string): Set<number> {
  const path = join(dirPath, "OutstackConditionManifest.json");
  if (!existsSync(path)) return new Set();
  const manifest: { List: Array<{ Id: number; Description: string }> } =
    JSON.parse(readFileSync(path, "utf-8"));
  return new Set(
    manifest.List.filter((c) => c.Description === "InvalidContest").map(
      (c) => c.Id,
    ),
  );
}

export function isInvalidContest(
  contest: ContestMarksJson,
  invalidIds: Set<number>,
): boolean {
  const ids = contest.OutstackConditionIds;
  // Redacted contests carry "*** REDACTED ***" here instead of a list.
  if (!Array.isArray(ids)) return false;
  return ids.some((id) => invalidIds.has(id));
}

/**
 * Turn a contest's marks into one choice per rank, from rank 1 to the last
 * rank marked. Ranks with no unambiguous mark become undervotes, so
 * normalizers that act on skipped rankings (e.g. "maine") can see them.
 */
export function marksToChoices(
  marks: MarkJson[],
  candidates: CandidateMap<number>,
  droppedWriteInId: number | null,
): Choice[] {
  const byRank = new Map<number, MarkJson[]>();
  for (const mark of marks) {
    if (mark.IsAmbiguous) continue;
    const atRank = byRank.get(mark.Rank) ?? [];
    atRank.push(mark);
    byRank.set(mark.Rank, atRank);
  }
  const lastRank = Math.max(0, ...marks.map((m) => m.Rank));
  const choices: Choice[] = [];
  for (let rank = 1; rank <= lastRank; rank++) {
    const atRank = byRank.get(rank) ?? [];
    if (atRank.length === 0) {
      choices.push({ type: "undervote" });
    } else if (atRank.length > 1) {
      choices.push({ type: "overvote" });
    } else if (atRank[0].CandidateId === droppedWriteInId) {
      choices.push({ type: "undervote" });
    } else {
      choices.push(candidates.idToChoice(atRank[0].CandidateId));
    }
  }
  return choices;
}

/**
 * Display name for a manifest entry. By default names go through
 * normalizeName, which title-cases all-caps names. With nameStyle "asIs" the
 * source capitalization is kept (for mixed-case manifests such as Alaska's)
 * and "Last, First" is shown as "First Last", with a suffix like "Jr." kept
 * at the end.
 */
export function candidateName(description: string, nameStyle?: string): string {
  if (nameStyle !== "asIs") return normalizeName(description, false);
  const match = description.match(/^([^,/]+), ([^/]+)$/);
  let name = description;
  if (match) {
    const [, last, rest] = match;
    const suffix = rest.match(/^(.*?)\s+(Jr\.?|Sr\.?|II|III|IV)$/);
    name = suffix ? `${suffix[1]} ${last} ${suffix[2]}` : `${rest} ${last}`;
  }
  let open = true;
  return name.replace(/"/g, () => ((open = !open) ? "\u201d" : "\u201c"));
}

function getCandidates(
  manifest: CandidateManifestJson,
  contestId: number,
  dropUnqualifiedWriteIn: boolean,
  nameStyle?: string,
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
      name: candidateName(entry.Description, nameStyle),
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
  invalidIds: Set<number>,
): number {
  let count = 0;
  const cvr: CvrExportJson = JSON.parse(content);

  for (const session of cvr.Sessions) {
    const contests = getSessionContests(session);
    for (const contest of contests) {
      if (contest.Id !== contestId) continue;

      if (isInvalidContest(contest, invalidIds)) continue;
      const choices = marksToChoices(
        parseMarks(contest.Marks),
        candidates,
        droppedWriteInId,
      );

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
  nameStyle?: string,
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
    nameStyle,
  );

  // Find all CvrExport JSON files (exclude _old backups)
  const files = readdirSync(dirPath)
    .filter(
      (f) =>
        !f.includes("_old") &&
        ((f.startsWith("CvrExport") && f.endsWith(".json")) ||
          (f.startsWith("CVR_Export") && f.endsWith(".csv"))),
    )
    .sort();

  const ballots: Ballot[] = [];
  const invalidIds = invalidContestConditionIds(dirPath);

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
      invalidIds,
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
    return readFromDirectory(
      cvrPath,
      contestId,
      dropUnqualifiedWriteIn,
      params.nameStyle,
    );
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
      params.nameStyle,
    );
    contestData.set(contestId, {
      office,
      candidateMap,
      droppedWriteInId,
      ballots: [],
    });
  }

  // Find all CvrExport JSON files (exclude _old backups)
  const files = readdirSync(cvrPath)
    .filter(
      (f) =>
        !f.includes("_old") && f.startsWith("CvrExport") && f.endsWith(".json"),
    )
    .sort();

  const invalidIds = invalidContestConditionIds(cvrPath);

  // Process each file once for all contests
  for (const filename of files) {
    const content = readFileSync(join(cvrPath, filename), "utf-8");
    const cvr: CvrExportJson = JSON.parse(content);

    for (const session of cvr.Sessions) {
      const sessionContests = getSessionContests(session);
      for (const contest of sessionContests) {
        const data = contestData.get(contest.Id);
        if (!data) continue;

        if (isInvalidContest(contest, invalidIds)) continue;
        const choices = marksToChoices(
          parseMarks(contest.Marks),
          data.candidateMap,
          data.droppedWriteInId,
        );

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
