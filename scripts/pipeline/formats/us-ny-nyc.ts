/**
 * NYC Board of Elections format reader.
 *
 * Reads CVR (Cast Vote Record) data from cached CSV files.
 * XLSX files are converted to CSV on first use via the xlsx-to-csv cache layer,
 * avoiding the expensive XML-inside-ZIP parsing on every pipeline run.
 *
 * Header columns follow the pattern:
 *   "Office Choice N of M Jurisdiction (CandidateId)"
 * Example: "Mayor Choice 1 of 5 Manhattan (1234)"
 *
 * Uses a separate candidates mapping file with ID -> Name.
 * Files matching the cvrPattern regex are processed.
 * Multiple contests share the same set of CVR files.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { CandidateMap } from "../candidate-map";
import { ensureCsv, ensureCsvBatch, parseCsvLine } from "../xlsx-to-csv";
import type { Ballot, Choice, Election } from "../types";

// ---- Types ----

interface RaceBallotVote {
  ballotId: string;
  raceKey: string;
  choices: Choice[];
}

// ---- Helper functions ----

/**
 * Read candidate ID -> name mapping from a cached CSV file.
 * CSV columns (0-indexed): [ID, Name]
 */
function readCandidateIds(csvPath: string): Map<number, string> {
  const candidates = new Map<number, string>();
  const raw = readFileSync(csvPath, "utf-8");
  const lines = raw.split("\n");

  // Skip header (first line)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCsvLine(line);
    if (fields.length < 2) continue;

    const id = parseInt(fields[0], 10);
    const name = fields[1] || "";

    if (!isNaN(id) && name) {
      candidates.set(id, name);
    }
  }

  return candidates;
}

/**
 * Process a single CVR file (cached CSV) and accumulate ballots by race.
 * CSV columns are 0-indexed (converted from ExcelJS 1-indexed).
 */
function processFile(
  csvPath: string,
  filename: string,
  candidateIds: Map<number, string>,
  raceCandidateMaps: Map<string, CandidateMap<number>>,
  ballotsByRace: Map<string, RaceBallotVote[]>,
): void {
  const columnRx = /^(.+) Choice (\d+) of (\d+) (.+) \((\d+)\)$/;
  const raw = readFileSync(csvPath, "utf-8");
  const lines = raw.split("\n");

  if (lines.length === 0) return;

  // Parse header (first line)
  const headerFields = parseCsvLine(lines[0]);
  let cvrIdCol: number | null = null;
  const fileRaceColumns = new Map<string, number[]>();

  for (let colIdx = 0; colIdx < headerFields.length; colIdx++) {
    const colName = headerFields[colIdx] || "";
    if (colName === "Cast Vote Record") {
      cvrIdCol = colIdx;
      continue;
    }

    const match = columnRx.exec(colName);
    if (match) {
      const officeName = match[1];
      const jurisdictionName = match[4];
      const raceKey = `${officeName}|${jurisdictionName}`;

      if (!raceCandidateMaps.has(raceKey)) {
        raceCandidateMaps.set(raceKey, new CandidateMap<number>());
        ballotsByRace.set(raceKey, []);
      }

      const cols = fileRaceColumns.get(raceKey) ?? [];
      cols.push(colIdx);
      fileRaceColumns.set(raceKey, cols);
    }
  }

  if (cvrIdCol === null) {
    console.warn(`No CVR ID column found in ${filename}, skipping`);
    return;
  }

  // Process data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;

    const fields = parseCsvLine(line);
    const ballotId = fields[cvrIdCol] || "";
    if (!ballotId) continue;

    for (const [raceKey, raceCols] of fileRaceColumns) {
      const candidateMap = raceCandidateMaps.get(raceKey)!;
      const choices: Choice[] = [];
      let hasVotes = false;

      for (const colIdx of raceCols) {
        const cell = fields[colIdx] ?? "";
        let choice: Choice;

        if (!cell) {
          choice = { type: "undervote" };
        } else if (cell === "undervote") {
          choice = { type: "undervote" };
        } else if (cell === "overvote") {
          hasVotes = true;
          choice = { type: "overvote" };
        } else if (cell === "Write-in") {
          hasVotes = true;
          choice = candidateMap.addIdToChoice(0, {
            name: "Write-in",
            candidate_type: "WriteIn",
          });
        } else {
          const extId = parseInt(cell, 10);
          if (!isNaN(extId) && candidateIds.has(extId)) {
            hasVotes = true;
            choice = candidateMap.addIdToChoice(extId, {
              name: candidateIds.get(extId)!,
              candidate_type: "Regular",
            });
          } else {
            choice = { type: "undervote" };
          }
        }

        choices.push(choice);
      }

      if (hasVotes) {
        ballotsByRace.get(raceKey)!.push({
          ballotId,
          raceKey,
          choices,
        });
      }
    }
  }
}

export async function nycBatchReader(
  basePath: string,
  contests: Array<{ office: string; params: Record<string, string> }>,
): Promise<Map<string, Election>> {
  const results = new Map<string, Election>();
  if (contests.length === 0) return results;

  const firstParams = contests[0].params;
  const candidatesFile = firstParams.candidatesFile;
  const cvrPattern = firstParams.cvrPattern;

  if (!candidatesFile || !cvrPattern) {
    throw new Error("us_ny_nyc requires 'candidatesFile' and 'cvrPattern'");
  }

  // Step 1: Find matching CVR files
  const fileRx = new RegExp(`^${cvrPattern}$`);
  const xlsxPaths: string[] = [];
  const fileNames: string[] = [];

  for (const name of readdirSync(basePath)) {
    if (fileRx.test(name)) {
      xlsxPaths.push(join(basePath, name));
      fileNames.push(name);
    }
  }

  if (xlsxPaths.length === 0) {
    console.warn(`No files matching ${cvrPattern} in ${basePath}`);
    return results;
  }

  // Step 2: Ensure CSV caches exist (converts XLSX -> CSV if needed)
  const candidatesXlsx = join(basePath, candidatesFile);
  const allXlsxPaths = [candidatesXlsx, ...xlsxPaths];
  const csvPaths = await ensureCsvBatch(allXlsxPaths);
  const candidatesCsvPath = csvPaths[0];
  const cvrCsvPaths = csvPaths.slice(1);

  // Step 3: Load candidate ID -> name mapping from cached CSV
  const candidateIds = readCandidateIds(candidatesCsvPath);

  if (candidateIds.size === 0) {
    throw new Error(`No candidates loaded from ${candidatesFile}`);
  }

  // Step 4: Process each CVR file from cached CSV
  const raceCandidateMaps = new Map<string, CandidateMap<number>>();
  const ballotsByRace = new Map<string, RaceBallotVote[]>();

  for (let i = 0; i < cvrCsvPaths.length; i++) {
    const start = Date.now();
    processFile(
      cvrCsvPaths[i],
      fileNames[i],
      candidateIds,
      raceCandidateMaps,
      ballotsByRace,
    );
    const ms = Date.now() - start;
    if (ms > 1000) {
      console.log(`      ${fileNames[i]} (${ms}ms)`);
    }
  }

  // Step 5: Map race keys to contest office IDs
  for (const { office, params } of contests) {
    const officeName = params.officeName;
    const jurisdictionName = params.jurisdictionName;
    if (!officeName || !jurisdictionName) {
      results.set(office, { candidates: [], ballots: [] });
      continue;
    }

    const raceKey = `${officeName}|${jurisdictionName}`;
    const raceBallots = ballotsByRace.get(raceKey);
    const candidateMap = raceCandidateMaps.get(raceKey);

    if (!raceBallots || raceBallots.length === 0 || !candidateMap) {
      results.set(office, { candidates: [], ballots: [] });
      continue;
    }

    const ballots: Ballot[] = raceBallots.map((rb) => ({
      id: rb.ballotId,
      choices: rb.choices,
    }));

    results.set(office, {
      candidates: candidateMap.intoCandidates(),
      ballots,
    });
  }

  return results;
}
