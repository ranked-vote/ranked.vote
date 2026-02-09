/**
 * Maine state election format reader.
 *
 * Reads ranked choice ballots from cached CSV files.
 * XLSX files are converted to CSV on first use via the xlsx-to-csv cache layer.
 *
 * Multiple files can be specified (semicolon-separated).
 * Format (0-indexed CSV columns): ballot_id in column 0, choices in columns 3-9.
 * Special values: "overvote", "undervote".
 * Candidate names may have party prefixes (DEM/REP) and parenthetical numbers.
 */

import { readFileSync } from "fs";
import { join, extname } from "path";
import { CandidateMap } from "../candidate-map";
import { normalizeName } from "../normalize-name";
import { ensureCsv, parseCsvLine } from "../xlsx-to-csv";
import type { Ballot, Choice, Election } from "../types";

function parseChoice(
  candidate: string,
  candidateMap: CandidateMap<string>,
): Choice {
  if (candidate === "overvote") return { type: "overvote" };
  if (candidate === "undervote") return { type: "undervote" };

  // Strip optional party prefix (DEM/REP) and parenthetical number suffix
  const rx = /^(?:DEM |REP )?([^(]*[^ (])(?: +\(\d+\))?$/;
  const match = rx.exec(candidate);
  const cleanName = match ? match[1] : candidate;

  return candidateMap.addIdToChoice(cleanName, {
    name: normalizeName(cleanName, true),
    candidate_type: "Regular",
  });
}

export async function maineReader(
  basePath: string,
  params: Record<string, string>,
): Promise<Election> {
  const files = params.files;
  if (!files) throw new Error("us_me requires 'files' parameter");

  const fileList = files.split(";").map((f) => f.trim());
  const candidateMap = new CandidateMap<string>();
  const ballots: Ballot[] = [];

  for (const file of fileList) {
    const filePath = join(basePath, file);
    const ext = extname(filePath).toLowerCase();

    // For XLSX files, convert to CSV first via cache layer
    let csvPath: string;
    if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
      csvPath = await ensureCsv(filePath);
    } else {
      csvPath = filePath;
    }

    const raw = readFileSync(csvPath, "utf-8");
    const lines = raw.split("\n");

    let rowIndex = 0;
    // Skip header (first line)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      rowIndex++;

      const fields = parseCsvLine(line);

      // CSV is 0-indexed. Original ExcelJS was 1-indexed:
      //   values[1] = ballot ID  ->  fields[0]
      //   values[4..10] = choices ->  fields[3..9]
      const rawId = fields[0] || "";
      const id = rawId ? String(Math.floor(Number(rawId))) : String(rowIndex);

      const choices: Choice[] = [];
      // Process columns 3-9 (0-indexed)
      for (let c = 3; c <= 9; c++) {
        const cell = fields[c];
        const cand = cell && cell.trim() ? cell.trim() : "undervote";
        choices.push(parseChoice(cand, candidateMap));
      }

      ballots.push({ id, choices });
    }
  }

  return { candidates: candidateMap.intoCandidates(), ballots };
}
