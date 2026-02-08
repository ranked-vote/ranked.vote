/**
 * Import pre-computed Rust report.json files into the SQLite database.
 *
 * Used for contests where raw ballot data is unavailable but report.json
 * files exist from the original Rust pipeline. This script reads the report
 * JSON and inserts all data (candidates, rounds, allocations, transfers,
 * analysis) directly into the DB.
 *
 * Usage:
 *   bun scripts/import-rust-reports.ts [db-path] [reports-dir]
 *
 * It finds report.json files that are NOT already present in the database
 * and imports them.
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const DB_PATH = process.argv[2] || "report_pipeline/reports.sqlite3";
const REPORTS_DIR = process.argv[3] || "report_pipeline/reports";

// ---------- Flag computation (same as preprocess.ts) ----------

function isWriteInByName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "write-in" ||
    n === "write in" ||
    n === "undeclared write-ins" ||
    n === "uwi"
  );
}

interface RoundData {
  allocations: Array<{ allocatee: number | string; votes: number }>;
  undervote: number;
  overvote: number;
  continuingBallots: number;
  transfers: Array<{ from: number; to: number | string; count: number }>;
}

function isInteresting(
  winner: number | null,
  condorcet: number | null,
  smithSet: number[],
  rounds: RoundData[],
): boolean {
  const hasNonCondorcetWinner = condorcet != null && condorcet !== winner;
  const hasCondorcetCycle = smithSet.length > 1;

  let exhaustedExceedsWinner = false;
  if (rounds.length > 0 && winner != null) {
    const lastRound = rounds[rounds.length - 1];
    const exhausted =
      lastRound.allocations.find((a) => a.allocatee === "X")?.votes ?? 0;
    const winnerVotes =
      lastRound.allocations.find((a) => a.allocatee === winner)?.votes ?? 0;
    exhaustedExceedsWinner = exhausted > winnerVotes;
  }

  return hasNonCondorcetWinner || hasCondorcetCycle || exhaustedExceedsWinner;
}

function computeWinnerNotFirstRoundLeader(
  winner: number | null,
  rounds: RoundData[],
): boolean {
  if (winner == null || rounds.length === 0) return false;
  const firstRound = rounds[0];

  const firstCandAlloc = firstRound.allocations.find(
    (a) => a.allocatee !== "X",
  );
  if (!firstCandAlloc) return false;
  const maxVotes = firstCandAlloc.votes;

  const winnerVotes =
    firstRound.allocations.find((a) => a.allocatee === winner)?.votes ?? 0;

  return winnerVotes < maxVotes;
}

// ---------- Find all report.json files ----------

function findReportFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findReportFiles(full));
    } else if (entry.name === "report.json") {
      files.push(full);
    }
  }
  return files;
}

// ---------- Main ----------

function main() {
  const dbPath = resolve(DB_PATH);
  const reportsDir = resolve(REPORTS_DIR);

  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error("Run preprocess.ts first to create the database.");
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Get existing contests in the DB
  const existingRows = db
    .prepare("SELECT path, office FROM reports")
    .all() as Array<{ path: string; office: string }>;
  const existingSet = new Set(existingRows.map((r) => `${r.path}|${r.office}`));

  // Find all report.json files
  const reportFiles = findReportFiles(reportsDir);
  console.log(`Found ${reportFiles.length} report.json files`);

  // Prepare statements
  const insertReport = db.prepare(`
    INSERT INTO reports (
      name, date, jurisdictionPath, electionPath, office, officeName,
      jurisdictionName, electionName, website, ballotCount, path, dataFormat,
      numCandidates, winner_candidate_index, condorcet,
      interesting, winnerNotFirstRoundLeader, hasWriteInByName,
      smithSet, pairwisePreferences, firstAlternate, firstFinal, rankingDistribution
    ) VALUES (
      $name, $date, $jurisdictionPath, $electionPath, $office, $officeName,
      $jurisdictionName, $electionName, $website, $ballotCount, $path, $dataFormat,
      $numCandidates, $winner, $condorcet,
      $interesting, $winnerNotFirstRoundLeader, $hasWriteInByName,
      $smithSet, $pairwisePreferences, $firstAlternate, $firstFinal, $rankingDistribution
    )
  `);

  const insertCandidate = db.prepare(`
    INSERT INTO candidates (
      report_id, candidate_index, name, writeIn, candidate_type,
      firstRoundVotes, transferVotes, roundEliminated, winner
    ) VALUES (
      $reportId, $candidateIndex, $name, $writeIn, $candidateType,
      $firstRoundVotes, $transferVotes, $roundEliminated, $winner
    )
  `);

  const insertRound = db.prepare(`
    INSERT INTO rounds (report_id, round_number, undervote, overvote, continuingBallots)
    VALUES ($reportId, $roundNumber, $undervote, $overvote, $continuingBallots)
  `);

  const insertAllocation = db.prepare(`
    INSERT INTO allocations (round_id, allocatee, votes)
    VALUES ($roundId, $allocatee, $votes)
  `);

  const insertTransfer = db.prepare(`
    INSERT INTO transfers (round_id, from_candidate, to_allocatee, count)
    VALUES ($roundId, $fromCandidate, $toAllocatee, $count)
  `);

  let imported = 0;
  let skipped = 0;

  const importAll = db.transaction(() => {
    for (const filePath of reportFiles) {
      const report = JSON.parse(readFileSync(filePath, "utf-8"));
      const info = report.info;
      const path = `${info.jurisdictionPath}/${info.electionPath}`;
      const key = `${path}|${info.office}`;

      if (existingSet.has(key)) {
        skipped++;
        continue;
      }

      const candidates: Array<{ name: string; candidate_type: string }> =
        report.candidates;
      const rounds: RoundData[] = report.rounds;
      const winner: number | null = report.winner;
      const condorcet: number | null = report.condorcet ?? null;
      const smithSet: number[] = report.smithSet ?? [];

      const numCandidates = candidates.filter(
        (c) =>
          c.candidate_type !== "WriteIn" &&
          c.candidate_type !== "QualifiedWriteIn",
      ).length;

      const hasWriteIn = candidates.some((c) => isWriteInByName(c.name));

      const result = insertReport.run({
        $name: info.name,
        $date: info.date,
        $jurisdictionPath: info.jurisdictionPath,
        $electionPath: info.electionPath,
        $office: info.office,
        $officeName: info.officeName,
        $jurisdictionName: info.jurisdictionName,
        $electionName: info.electionName,
        $website: info.website ?? null,
        $ballotCount: report.ballotCount,
        $path: path,
        $dataFormat: info.dataFormat,
        $numCandidates: numCandidates,
        $winner: winner,
        $condorcet: condorcet,
        $interesting: isInteresting(winner, condorcet, smithSet, rounds)
          ? 1
          : 0,
        $winnerNotFirstRoundLeader: computeWinnerNotFirstRoundLeader(
          winner,
          rounds,
        )
          ? 1
          : 0,
        $hasWriteInByName: hasWriteIn ? 1 : 0,
        $smithSet: JSON.stringify(smithSet),
        $pairwisePreferences: JSON.stringify(report.pairwisePreferences ?? {}),
        $firstAlternate: JSON.stringify(report.firstAlternate ?? {}),
        $firstFinal: JSON.stringify(report.firstFinal ?? {}),
        $rankingDistribution: JSON.stringify(report.rankingDistribution ?? {}),
      });

      const reportId = Number(result.lastInsertRowid);

      // Insert candidates
      const totalVotesMap = new Map(
        (report.totalVotes ?? []).map((tv: any) => [tv.candidate, tv]),
      );
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const tv = totalVotesMap.get(i) as any;
        const isWriteIn =
          c.candidate_type === "WriteIn" ||
          c.candidate_type === "QualifiedWriteIn";

        insertCandidate.run({
          $reportId: reportId,
          $candidateIndex: i,
          $name: c.name,
          $writeIn: isWriteIn ? 1 : 0,
          $candidateType: c.candidate_type ?? "Regular",
          $firstRoundVotes: tv?.firstRoundVotes ?? 0,
          $transferVotes: tv?.transferVotes ?? 0,
          $roundEliminated: tv?.roundEliminated ?? null,
          $winner: winner === i ? 1 : 0,
        });
      }

      // Insert rounds
      for (let r = 0; r < rounds.length; r++) {
        const round = rounds[r];
        const roundResult = insertRound.run({
          $reportId: reportId,
          $roundNumber: r,
          $undervote: round.undervote,
          $overvote: round.overvote,
          $continuingBallots: round.continuingBallots,
        });
        const roundId = Number(roundResult.lastInsertRowid);

        for (const alloc of round.allocations) {
          insertAllocation.run({
            $roundId: roundId,
            $allocatee: String(alloc.allocatee),
            $votes: alloc.votes,
          });
        }

        for (const transfer of round.transfers) {
          insertTransfer.run({
            $roundId: roundId,
            $fromCandidate: transfer.from,
            $toAllocatee: String(transfer.to),
            $count: transfer.count,
          });
        }
      }

      imported++;
      console.log(`  Imported: ${path}/${info.office}`);
    }
  });

  importAll();

  console.log(`\nDone. Imported: ${imported}, Already present: ${skipped}`);
  db.close();
}

main();
