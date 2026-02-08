/**
 * Maine state election format reader.
 *
 * Ported from report_pipeline/src/formats/us_me/mod.rs.
 *
 * Reads Excel files with ranked choice ballots.
 * Multiple files can be specified (semicolon-separated).
 * Format: ballot_id in column 0, choices in columns 3-9.
 * Special values: "overvote", "undervote".
 * Candidate names may have party prefixes (DEM/REP) and parenthetical numbers.
 */

import { join } from "path";
import ExcelJS from "exceljs";
import { CandidateMap } from "../candidate-map";
import { normalizeName } from "../normalize-name";
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
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    if (!sheet) continue;

    let rowIndex = 0;
    sheet.eachRow((row, rowNumber) => {
      // Skip header row
      if (rowNumber === 1) return;
      rowIndex++;

      const values = row.values as any[];
      // ExcelJS row.values is 1-indexed
      const rawId = values[1];
      const id =
        rawId !== undefined && rawId !== null
          ? String(Math.floor(Number(rawId)))
          : String(rowIndex);

      const choices: Choice[] = [];
      // Process columns 4-10 (1-indexed, originally columns 3-9 in 0-indexed)
      for (let i = 4; i <= 10; i++) {
        const cell = values[i];
        const cand =
          cell !== undefined && cell !== null && String(cell).trim()
            ? String(cell).trim()
            : "undervote";
        choices.push(parseChoice(cand, candidateMap));
      }

      ballots.push({ id, choices });
    });
  }

  return { candidates: candidateMap.intoCandidates(), ballots };
}
