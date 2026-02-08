/**
 * NYC Board of Elections format reader.
 *
 * Ported from report_pipeline/src/formats/us_ny_nyc/efficient_reader.rs.
 *
 * Streams Excel files using ExcelJS to avoid loading entire files into memory.
 * Header columns follow the pattern:
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
import ExcelJS from "exceljs";
import { CandidateMap } from "../candidate-map";
import type { Ballot, Choice, Election } from "../types";

// ---- Types ----

interface RaceBallotVote {
  ballotId: string;
  raceKey: string;
  choices: Choice[];
}

// ---- Helper functions ----

async function readCandidateIds(
  candidatesPath: string,
): Promise<Map<number, string>> {
  const candidates = new Map<number, string>();
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(candidatesPath);

  for await (const ws of reader) {
    let isHeader = true;
    for await (const row of ws) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      const values = row.values as any[];
      if (!values || values.length < 3) continue;

      // ExcelJS row.values is 1-indexed (index 0 is undefined)
      const rawId = values[1];
      const rawName = values[2];

      const id =
        typeof rawId === "number"
          ? Math.floor(rawId)
          : typeof rawId === "string"
            ? parseInt(rawId, 10)
            : NaN;
      const name = rawName != null ? String(rawName) : "";

      if (!isNaN(id) && name) {
        candidates.set(id, name);
      }
    }
    break; // Only read first sheet
  }

  return candidates;
}

async function processFile(
  filePath: string,
  filename: string,
  candidateIds: Map<number, string>,
  raceCandidateMaps: Map<string, CandidateMap<number>>,
  ballotsByRace: Map<string, RaceBallotVote[]>,
): Promise<void> {
  const columnRx = /^(.+) Choice (\d+) of (\d+) (.+) \((\d+)\)$/;
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath);

  for await (const ws of reader) {
    let headerParsed = false;
    let cvrIdCol: number | null = null;
    const fileRaceColumns = new Map<string, number[]>();

    for await (const row of ws) {
      const values = row.values as any[];
      if (!values) continue;

      // Parse header on first row
      if (!headerParsed) {
        headerParsed = true;
        for (let colIdx = 1; colIdx < values.length; colIdx++) {
          const colName = String(values[colIdx] ?? "");
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
        continue;
      }

      // Process data row
      const ballotId =
        values[cvrIdCol!] != null ? String(values[cvrIdCol!]) : "";
      if (!ballotId) continue;

      for (const [raceKey, raceCols] of fileRaceColumns) {
        const candidateMap = raceCandidateMaps.get(raceKey)!;
        const choices: Choice[] = [];
        let hasVotes = false;

        for (const colIdx of raceCols) {
          const cell = values[colIdx];
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
    break; // Only read first sheet
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

  // Step 1: Load candidate ID -> name mapping
  const candidatesPath = join(basePath, candidatesFile);
  const candidateIds = await readCandidateIds(candidatesPath);

  if (candidateIds.size === 0) {
    throw new Error(`No candidates loaded from ${candidatesFile}`);
  }

  // Step 2: Find matching CVR files
  const fileRx = new RegExp(`^${cvrPattern}$`);

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

  // Step 3: Stream each file
  const raceCandidateMaps = new Map<string, CandidateMap<number>>();
  const ballotsByRace = new Map<string, RaceBallotVote[]>();

  for (let i = 0; i < filePaths.length; i++) {
    const { path: filePath, name: filename } = filePaths[i];
    const start = Date.now();
    await processFile(
      filePath,
      filename,
      candidateIds,
      raceCandidateMaps,
      ballotsByRace,
    );
    const ms = Date.now() - start;
    if (ms > 1000) {
      console.log(`      ${filename} (${ms}ms)`);
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
