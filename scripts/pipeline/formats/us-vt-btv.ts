/**
 * Burlington, VT format reader.
 *
 * Ported from report_pipeline/src/formats/us_vt_btv/mod.rs.
 *
 * Reads BLT-like ballot files with candidates and ranked choices.
 * Format uses regex to parse candidates (.CANDIDATE C1, "Name")
 * and ballots (id, weight) C01,C03,...).
 */

import { readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import type { Ballot, Choice, Election, Candidate } from "../types";

function parseBallot(source: string): Choice[] {
  if (!source) return [];

  const ranks = source.split(",");
  const choices: Choice[] = [];

  for (const rank of ranks) {
    if (rank.includes("=")) {
      choices.push({ type: "overvote" });
    } else {
      const match = rank.match(/^C(\d+)$/);
      if (match) {
        const candidateId = parseInt(match[1], 10) - 1;
        choices.push({ type: "vote", candidate: candidateId });
      } else {
        throw new Error(`Bad candidate list (${rank}).`);
      }
    }
  }

  return choices;
}

export function btvReader(
  basePath: string,
  params: Record<string, string>,
): Election {
  const ballotsFile = params.ballots;
  if (!ballotsFile) throw new Error("BTV requires 'ballots' parameter");

  // Try multiple path variations to handle archive extraction
  let ballotsPath = join(basePath, ballotsFile);
  if (!existsSync(ballotsPath) && params.archive) {
    const archiveDir = params.archive.replace(/\.zip$/, "");
    const alt1 = join(basePath, archiveDir, ballotsFile);
    if (existsSync(alt1)) {
      ballotsPath = alt1;
    } else {
      const alt2 = join(basePath, archiveDir, basename(ballotsFile));
      if (existsSync(alt2)) {
        ballotsPath = alt2;
      }
    }
  }

  if (!existsSync(ballotsPath)) {
    console.warn(`BTV ballots file not found: ${ballotsPath}`);
    return { candidates: [], ballots: [] };
  }

  const raw = readFileSync(ballotsPath, "utf-8");
  const lines = raw.split("\n");

  const candidateRx = /.CANDIDATE C(\d+), "(.+)"/;
  const ballotRx = /([^,]+), \d\) (.+)/;

  const candidates: Candidate[] = [];
  const ballots: Ballot[] = [];

  for (const line of lines) {
    const candMatch = candidateRx.exec(line);
    if (candMatch) {
      const id = parseInt(candMatch[1], 10);
      const name = candMatch[2];
      if (id - 1 !== candidates.length) {
        throw new Error(
          `Expected candidate ${candidates.length + 1}, got ${id}`,
        );
      }
      candidates.push({ name, candidate_type: "Regular" });
      continue;
    }

    const ballotMatch = ballotRx.exec(line);
    if (ballotMatch) {
      const id = ballotMatch[1];
      const votes = ballotMatch[2];
      ballots.push({ id, choices: parseBallot(votes) });
    }
  }

  return { candidates, ballots };
}
