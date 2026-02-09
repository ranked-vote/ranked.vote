/**
 * Minneapolis election format reader.
 *
 * Reads CSV or Excel files with aggregated ballot data.
 * XLSX files are converted to CSV on first use via the xlsx-to-csv cache layer.
 *
 * Format: Precinct, 1st Choice, 2nd Choice, 3rd Choice, Count
 * Special values: "undervote", "overvote" (case-insensitive).
 * "UWI" maps to "Undeclared Write-ins" with WriteIn candidate type.
 * If any choice is "overvote", the entire ballot is marked as overvoted.
 */

import { readFileSync } from "fs";
import { join, extname } from "path";
import { CandidateMap } from "../candidate-map";
import { ensureCsv } from "../xlsx-to-csv";
import type { Ballot, Choice, Election } from "../types";

function parseChoice(
  candidate: string,
  candidateMap: CandidateMap<string>,
): Choice {
  const trimmed = candidate.trim();
  if (trimmed.toLowerCase() === "undervote") return { type: "undervote" };
  if (trimmed.toLowerCase() === "overvote") return { type: "overvote" };
  if (!trimmed) return { type: "undervote" };

  const [normalizedName, candidateType] =
    trimmed.toLowerCase() === "uwi"
      ? (["Undeclared Write-ins", "WriteIn"] as const)
      : ([trimmed, "Regular"] as const);

  return candidateMap.addIdToChoice(trimmed, {
    name: normalizedName,
    candidate_type: candidateType,
  });
}

function appendBallots(
  candidateMap: CandidateMap<string>,
  ballots: Ballot[],
  precinct: string,
  choice1: string,
  choice2: string,
  choice3: string,
  count: number,
  ballotId: { value: number },
): void {
  const choices: Choice[] = [];

  // If any choice is "overvote", mark entire ballot
  if (
    choice1.toLowerCase() === "overvote" ||
    choice2.toLowerCase() === "overvote" ||
    choice3.toLowerCase() === "overvote"
  ) {
    choices.push({ type: "overvote" });
  } else {
    choices.push(
      !choice1 || choice1.toLowerCase() === "undervote"
        ? { type: "undervote" }
        : parseChoice(choice1, candidateMap),
    );
    choices.push(
      !choice2 || choice2.toLowerCase() === "undervote"
        ? { type: "undervote" }
        : parseChoice(choice2, candidateMap),
    );
    choices.push(
      !choice3 || choice3.toLowerCase() === "undervote"
        ? { type: "undervote" }
        : parseChoice(choice3, candidateMap),
    );
  }

  for (let i = 0; i < count; i++) {
    ballotId.value++;
    ballots.push({
      id: `${precinct}:${ballotId.value}`,
      choices: [...choices],
    });
  }
}

/**
 * Parse a CSV line respecting quoted fields.
 * Double quotes inside quoted fields are escaped as "".
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function readCsv(filePath: string): Election {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");
  const candidateMap = new CandidateMap<string>();
  const ballots: Ballot[] = [];
  const ballotId = { value: 0 };

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCsvLine(line);
    if (fields.length < 5) continue;

    const precinct = fields[0];
    const choice1 = fields[1];
    const choice2 = fields[2];
    const choice3 = fields[3];
    const count = parseInt(fields[4], 10) || 1;

    appendBallots(
      candidateMap,
      ballots,
      precinct,
      choice1,
      choice2,
      choice3,
      count,
      ballotId,
    );
  }

  return { candidates: candidateMap.intoCandidates(), ballots };
}

export async function mplsReader(
  basePath: string,
  params: Record<string, string>,
): Promise<Election> {
  const file = params.file;
  if (!file) throw new Error("us_mn_mpls requires 'file' parameter");

  const filePath = join(basePath, file);
  const ext = extname(filePath).toLowerCase();

  if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
    // Convert to CSV via cache layer, then read as CSV
    const csvPath = await ensureCsv(filePath);
    return readCsv(csvPath);
  }
  return readCsv(filePath);
}
