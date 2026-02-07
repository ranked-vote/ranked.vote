/**
 * NYC Board of Elections format reader.
 *
 * Ported from report_pipeline/src/formats/us_ny_nyc/efficient_reader.rs.
 *
 * Reads Excel files with a specific header column pattern:
 *   "Office Choice N of M Jurisdiction (CandidateId)"
 * Example: "Mayor Choice 1 of 5 Manhattan (1234)"
 *
 * Uses a separate candidates mapping file (Excel) with ID -> Name.
 * Files matching the cvrPattern regex are processed.
 * Multiple contests share the same set of CVR files.
 *
 * Uses NYC normalization (filters out inactive ballots).
 */

import { readdirSync } from "fs";
import { join } from "path";
import XLSX from "xlsx";
import { CandidateMap } from "../candidate-map";
import type { Ballot, Choice, Election } from "../types";

// ---- Types ----

interface RaceBallotVote {
  ballotId: string;
  raceKey: string;
  choices: Choice[];
}

// ---- Helper functions ----

function readCandidateIds(
  candidatesPath: string
): Map<number, string> {
  const candidates = new Map<number, string>();
  const workbook = XLSX.readFile(candidatesPath);
  const sheetName = workbook.SheetNames[0];
  const rows: any[][] = XLSX.utils.sheet_to_json(
    workbook.Sheets[sheetName],
    { header: 1 }
  );

  // Skip header row
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;

    const id =
      typeof row[0] === "number"
        ? Math.floor(row[0])
        : typeof row[0] === "string"
          ? parseInt(row[0], 10)
          : NaN;
    const name = row[1] != null ? String(row[1]) : "";

    if (!isNaN(id) && name) {
      candidates.set(id, name);
    }
  }

  return candidates;
}

export function nycBatchReader(
  basePath: string,
  contests: Array<{ office: string; params: Record<string, string> }>
): Map<string, Election> {
  const results = new Map<string, Election>();
  if (contests.length === 0) return results;

  const firstParams = contests[0].params;
  const candidatesFile = firstParams.candidatesFile;
  const cvrPattern = firstParams.cvrPattern;

  if (!candidatesFile || !cvrPattern) {
    throw new Error("us_ny_nyc requires 'candidatesFile' and 'cvrPattern'");
  }

  // Step 1: Load candidate ID -> name mapping
  const candidatesPath = join(basePath, candidatesFile);
  const candidateIds = readCandidateIds(candidatesPath);

  if (candidateIds.size === 0) {
    throw new Error(
      `No candidates loaded from ${candidatesFile}`
    );
  }

  // Step 2: Find matching CVR files
  const fileRx = new RegExp(`^${cvrPattern}$`);
  const columnRx = /^(.+) Choice (\d+) of (\d+) (.+) \((\d+)\)$/;

  const filePaths: Array<{ path: string; name: string }> = [];
  for (const name of readdirSync(basePath)) {
    if (fileRx.test(name)) {
      filePaths.push({ path: join(basePath, name), name });
    }
  }

  if (filePaths.length === 0) {
    console.warn(`No files matching ${cvrPattern} in ${basePath}`);
    return results;
  }

  // Step 3: Process files with on-the-fly race discovery
  const raceCandidateMaps = new Map<string, CandidateMap<number>>();
  const ballotsByRace = new Map<string, RaceBallotVote[]>();

  for (let fileIdx = 0; fileIdx < filePaths.length; fileIdx++) {
    const { path: filePath, name: filename } = filePaths[fileIdx];

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rows.length === 0) continue;

    // Parse header row to discover races and column mappings
    const headerRow = rows[0];
    let cvrIdCol: number | null = null;
    const fileRaceColumns = new Map<string, number[]>();

    for (let colIdx = 0; colIdx < headerRow.length; colIdx++) {
      const colName = String(headerRow[colIdx] ?? "");
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
      continue;
    }

    // Process data rows
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;

      const ballotId = row[cvrIdCol] != null ? String(row[cvrIdCol]) : "";
      if (!ballotId) continue;

      for (const [raceKey, raceCols] of fileRaceColumns) {
        const candidateMap = raceCandidateMaps.get(raceKey)!;
        const choices: Choice[] = [];
        let hasVotes = false;

        for (const colIdx of raceCols) {
          const cell = row[colIdx];
          let choice: Choice;

          if (cell == null || cell === "") {
            choice = { type: "undervote" };
          } else if (typeof cell === "string") {
            if (cell === "undervote") {
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
          } else if (typeof cell === "number") {
            const extId = Math.floor(cell);
            if (candidateIds.has(extId)) {
              hasVotes = true;
              choice = candidateMap.addIdToChoice(extId, {
                name: candidateIds.get(extId)!,
                candidate_type: "Regular",
              });
            } else {
              choice = { type: "undervote" };
            }
          } else {
            choice = { type: "undervote" };
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

  // Step 4: Map race keys to contest office IDs
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
