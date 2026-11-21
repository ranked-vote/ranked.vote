/**
 * Maine state election format reader.
 *
 * Reads ranked choice ballots from cached CSV files.
 * XLSX files are converted to CSV on first use via the xlsx-to-csv cache layer.
 *
 * Multiple files can be specified (semicolon-separated).
 * Columns are found from the header row: the ballot ID is the "Cast Vote
 * Record" column and the choices are the columns whose header contains
 * "Choice". Older exports without those headers use column 0 for the ID and
 * columns 3-9 for choices.
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

export function columnLayout(header: string[]): {
  idCol: number;
  choiceCols: number[];
} {
  const choiceCols = header
    .map((h, i) => (/choice/i.test(h) ? i : -1))
    .filter((i) => i >= 0);
  if (choiceCols.length === 0) {
    return { idCol: 0, choiceCols: [3, 4, 5, 6, 7, 8, 9] };
  }
  const idCol = header.findIndex((h) => /^cast vote record$/i.test(h.trim()));
  return { idCol: idCol >= 0 ? idCol : 0, choiceCols };
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

    const { idCol, choiceCols } = columnLayout(parseCsvLine(lines[0] ?? ""));

    let rowIndex = 0;
    // Skip header (first line)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      rowIndex++;

      const fields = parseCsvLine(line);

      const rawId = fields[idCol] || "";
      const id = rawId ? String(Math.floor(Number(rawId))) : String(rowIndex);

      const choices: Choice[] = [];
      for (const c of choiceCols) {
        const cell = fields[c];
        const cand = cell && cell.trim() ? cell.trim() : "undervote";
        choices.push(parseChoice(cand, candidateMap));
      }

      ballots.push({ id, choices });
    }
  }

  return { candidates: candidateMap.intoCandidates(), ballots };
}
