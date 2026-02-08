/**
 * PrefLib format reader.
 *
 * Ported from report_pipeline/src/formats/preflib/mod.rs.
 *
 * Reads PrefLib .toi/.soi files. Format:
 * - Header lines starting with # contain metadata (candidate names)
 * - Data lines: "count: preference_list"
 * - Ties in curly braces are treated as overvotes
 */

import { readFileSync } from "fs";
import { join } from "path";
import { CandidateMap } from "../candidate-map";
import { normalizeName } from "../normalize-name";
import type { Ballot, Candidate, Choice, Election } from "../types";

function parsePreferenceList(
  prefStr: string,
  candidateMap: CandidateMap<number>,
): Choice[] {
  const choices: Choice[] = [];

  // Split by commas, respecting curly braces
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;

  for (const ch of prefStr) {
    if (ch === "{") {
      braceDepth++;
      current += ch;
    } else if (ch === "}") {
      braceDepth--;
      current += ch;
    } else if (ch === "," && braceDepth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current.trim());

  for (const part of parts) {
    if (!part) continue;

    if (part.startsWith("{") && part.endsWith("}")) {
      // Tie group -- overvote for RCV
      choices.push({ type: "overvote" });
    } else {
      const candId = parseInt(part, 10);
      if (!isNaN(candId)) {
        choices.push(candidateMap.idToChoice(candId));
      }
    }
  }

  return choices;
}

export function preflibReader(
  basePath: string,
  params: Record<string, string>,
): Election {
  const file = params.file;
  if (!file) throw new Error("preflib requires 'file' parameter");

  const raw = readFileSync(join(basePath, file), "utf-8");
  const lines = raw.split("\n");

  const candidatesOrdered: Array<[number, Candidate]> = [];
  const candidateMap = new CandidateMap<number>();
  const ballots: Ballot[] = [];
  let ballotCounter = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      // Parse header metadata
      const altMatch = line.match(/^# ALTERNATIVE NAME (\d+):\s*(.+)$/);
      if (altMatch) {
        const candId = parseInt(altMatch[1], 10);
        let name = altMatch[2].trim();
        // Remove surrounding quotes
        if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
          name = name.slice(1, -1);
        }
        const candidateType =
          name.toLowerCase() === "write-in"
            ? ("WriteIn" as const)
            : ("Regular" as const);
        const candidate: Candidate = {
          name: normalizeName(name, false),
          candidate_type: candidateType,
        };
        candidateMap.add(candId, candidate);
        candidatesOrdered.push([candId, { ...candidate }]);
      }
    } else {
      // Preference data: "count: preference_list"
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const countStr = line.slice(0, colonIdx).trim();
      const prefStr = line.slice(colonIdx + 1).trim();
      const count = parseInt(countStr, 10);
      if (isNaN(count)) continue;

      const choices = parsePreferenceList(prefStr, candidateMap);

      for (let i = 0; i < count; i++) {
        ballotCounter++;
        ballots.push({
          id: `${file}:${ballotCounter}`,
          choices: [...choices],
        });
      }
    }
  }

  // Sort candidates by external ID to maintain file order
  candidatesOrdered.sort((a, b) => a[0] - b[0]);
  const candidates = candidatesOrdered.map(([, c]) => c);

  return { candidates, ballots };
}
