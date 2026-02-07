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
import XLSX from "xlsx";
import { CandidateMap } from "../candidate-map";
import { normalizeName } from "../normalize-name";
import type { Ballot, Choice, Election } from "../types";

function parseChoice(
  candidate: string,
  candidateMap: CandidateMap<string>
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

export function maineReader(
  basePath: string,
  params: Record<string, string>
): Election {
  const files = params.files;
  if (!files) throw new Error("us_me requires 'files' parameter");

  const fileList = files.split(";").map((f) => f.trim());
  const candidateMap = new CandidateMap<string>();
  const ballots: Ballot[] = [];

  for (const file of fileList) {
    const filePath = join(basePath, file);
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Skip header row
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length === 0) continue;

      const id =
        row[0] !== undefined && row[0] !== null ? String(Math.floor(Number(row[0]))) : String(r);

      const choices: Choice[] = [];
      // Process columns 3-9 (rank columns)
      for (let i = 3; i < 10; i++) {
        const cell = i < row.length ? row[i] : undefined;
        const cand =
          cell !== undefined && cell !== null && String(cell).trim()
            ? String(cell).trim()
            : "undervote";
        choices.push(parseChoice(cand, candidateMap));
      }

      ballots.push({ id, choices });
    }
  }

  return { candidates: candidateMap.intoCandidates(), ballots };
}
