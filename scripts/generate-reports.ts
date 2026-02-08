/**
 * Generate reports from preprocessed normalized.json.gz files.
 *
 * Reads each normalized.json.gz from preprocessed/, runs the RCV tabulator
 * and analysis code, then writes results directly to reports.sqlite3.
 *
 * This replaces the Rust report generation pipeline for the
 * preprocessed -> reports step.
 *
 * Usage:
 *   bun scripts/generate-reports.ts [preprocessed-dir] [db-path]
 */

import { Database } from "bun:sqlite";
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  unlinkSync,
} from "fs";
import { join, resolve } from "path";
import { gunzipSync } from "zlib";

import {
  tabulate,
  type NormalizedBallot,
  type TabulationOptions,
} from "./tabulate-rcv";
import { analyzeElection } from "./compute-rcv-analysis";
import type { CandidateId } from "../src/report_types";

const PREPROCESSED_DIR = process.argv[2] || "report_pipeline/preprocessed";
const DB_PATH = process.argv[3] || "report_pipeline/reports.sqlite3";

// ---------- Types for normalized.json.gz ----------

interface PreprocessedElection {
  info: {
    name: string;
    date: string;
    dataFormat: string;
    tabulationOptions?: { eager?: boolean; nycStyle?: boolean };
    jurisdictionPath: string;
    electionPath: string;
    office: string;
    officeName: string;
    jurisdictionName: string;
    electionName: string;
    loaderParams?: Record<string, string>;
    website?: string;
  };
  ballots: {
    candidates: Array<{ name: string; candidate_type?: string }>;
    ballots: Array<{ id: string; choices: number[]; overvoted: boolean }>;
  };
}

// ---------- Find all normalized.json.gz files ----------

function findNormalizedFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry === "normalized.json.gz") {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files;
}

// ---------- Main ----------

function main() {
  const preprocessedDir = resolve(PREPROCESSED_DIR);

  if (!existsSync(preprocessedDir)) {
    console.error(`Preprocessed directory not found: ${preprocessedDir}`);
    process.exit(1);
  }

  // Delete existing DB and recreate
  const dbPath = resolve(DB_PATH);
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
    // Also remove WAL/SHM files
    if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
    if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
  }

  // Initialize schema
  console.log("Initializing database...");
  const initProc = Bun.spawnSync(["bun", "scripts/init-database.ts", dbPath]);
  if (initProc.exitCode !== 0) {
    console.error("Failed to initialize database");
    console.error(initProc.stderr.toString());
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

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

  // Find all preprocessed files
  const normalizedFiles = findNormalizedFiles(preprocessedDir);
  console.log(`Found ${normalizedFiles.length} normalized.json.gz files`);

  let processed = 0;
  let errors = 0;

  const processAll = db.transaction(() => {
    for (const filePath of normalizedFiles) {
      try {
        // Read and decompress
        const raw = gunzipSync(readFileSync(filePath));
        const election: PreprocessedElection = JSON.parse(raw.toString());
        const info = election.info;

        // Convert ballots to tabulator format
        const ballots: NormalizedBallot[] = election.ballots.ballots.map(
          (b) => ({
            id: b.id,
            choices: b.choices,
            overvoted: b.overvoted,
          }),
        );

        const tabulationOptions: TabulationOptions = {
          eager: info.tabulationOptions?.eager,
          nycStyle: info.tabulationOptions?.nycStyle,
        };

        // Run tabulator
        const rounds = tabulate(ballots, tabulationOptions);

        // Get candidate IDs (non-write-in candidates for analysis)
        const nonWriteInCandidates: CandidateId[] = [];
        for (let i = 0; i < election.ballots.candidates.length; i++) {
          if (election.ballots.candidates[i].candidate_type !== "WriteIn") {
            nonWriteInCandidates.push(i);
          }
        }

        // All candidates for pairwise analysis
        const allCandidateIds: CandidateId[] = election.ballots.candidates.map(
          (_, i) => i,
        );

        // Determine candidate list for totalVotes (from rounds, sorted)
        const totalVotesCandidates: CandidateId[] = [];
        for (const alloc of rounds[0]?.allocations ?? []) {
          if (alloc.allocatee !== "X") {
            totalVotesCandidates.push(alloc.allocatee as CandidateId);
          }
        }
        totalVotesCandidates.sort((a, b) => a - b);

        // Run analysis
        const analysis = analyzeElection(totalVotesCandidates, ballots, rounds);

        const path = `${info.jurisdictionPath}/${info.electionPath}`;
        const numCandidates = nonWriteInCandidates.length;

        // Compute index-level flags

        // hasWriteInByName: check candidate name (not type), matching Rust logic
        const hasWriteInByName = election.ballots.candidates.some((c) => {
          const normalized = c.name.toLowerCase();
          return (
            normalized === "write-in" ||
            normalized === "write in" ||
            normalized === "undeclared write-ins" ||
            normalized === "uwi"
          );
        });

        const winnerNotFirstRoundLeader =
          analysis.winner != null &&
          rounds.length > 0 &&
          rounds[0].allocations.length > 0 &&
          rounds[0].allocations[0].allocatee !== analysis.winner &&
          rounds[0].allocations[0].allocatee !== "X";

        // interesting: matches Rust is_interesting() logic
        // 1. Non-Condorcet winner (Condorcet winner exists but didn't win under RCV)
        const hasNonCondorcetWinner =
          analysis.condorcet != null && analysis.condorcet !== analysis.winner;
        // 2. Condorcet cycle (Smith set has more than one candidate)
        const hasCondorcetCycle = analysis.smithSet.length > 1;
        // 3. Exhausted ballots outnumber the winner's votes in the final round
        let exhaustedExceedsWinner = false;
        if (rounds.length > 0) {
          const lastRound = rounds[rounds.length - 1];
          const exhaustedVotes =
            lastRound.allocations.find((a) => a.allocatee === "X")?.votes ?? 0;
          const winnerVotes =
            analysis.winner != null
              ? (lastRound.allocations.find(
                  (a) => a.allocatee === analysis.winner,
                )?.votes ?? 0)
              : 0;
          exhaustedExceedsWinner = exhaustedVotes > winnerVotes;
        }
        const interesting =
          hasNonCondorcetWinner || hasCondorcetCycle || exhaustedExceedsWinner;

        // Build vote lookup
        const voteMap = new Map(
          analysis.totalVotes.map((tv) => [tv.candidate, tv]),
        );

        // Insert report
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
          $ballotCount: ballots.length,
          $path: path,
          $dataFormat: info.dataFormat,
          $numCandidates: numCandidates,
          $winner: analysis.winner,
          $condorcet: analysis.condorcet ?? null,
          $interesting: interesting ? 1 : 0,
          $winnerNotFirstRoundLeader: winnerNotFirstRoundLeader ? 1 : 0,
          $hasWriteInByName: hasWriteInByName ? 1 : 0,
          $smithSet: JSON.stringify(analysis.smithSet),
          $pairwisePreferences: JSON.stringify(analysis.pairwisePreferences),
          $firstAlternate: JSON.stringify(analysis.firstAlternate),
          $firstFinal: JSON.stringify(analysis.firstFinal),
          $rankingDistribution: JSON.stringify(analysis.rankingDistribution),
        });

        const reportId = Number(result.lastInsertRowid);

        // Insert candidates
        for (let i = 0; i < election.ballots.candidates.length; i++) {
          const c = election.ballots.candidates[i];
          const tv = voteMap.get(i);
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
            $winner: analysis.winner === i ? 1 : 0,
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

        processed++;
        if (processed % 50 === 0) {
          console.log(`  Processed ${processed}/${normalizedFiles.length}...`);
        }
      } catch (err) {
        errors++;
        console.error(`Error processing ${filePath}: ${err}`);
      }
    }
  });

  processAll();

  // Checkpoint WAL
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  console.log(`\nGenerated ${processed} reports into ${dbPath}`);
  if (errors > 0) {
    console.error(`${errors} errors encountered`);
  }
}

main();
