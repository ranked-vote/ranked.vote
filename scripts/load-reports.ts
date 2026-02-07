/**
 * Load all report.json files into reports.sqlite3
 *
 * Reads report_pipeline/reports/ recursively, parses each report.json,
 * and inserts into the SQLite database. Also runs round-trip validation.
 */

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync, existsSync, unlinkSync } from "fs";
import { join, resolve } from "path";

const REPORTS_DIR = process.argv[2] || "report_pipeline/reports";
const DB_PATH = process.argv[3] || "report_pipeline/reports.sqlite3";

// ---------- Types matching report.json structure ----------

interface ReportJson {
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
  ballotCount: number;
  candidates: Array<{
    name: string;
    candidate_type?: string;
  }>;
  rounds: Array<{
    allocations: Array<{ allocatee: number | "X"; votes: number }>;
    undervote: number;
    overvote: number;
    continuingBallots: number;
    transfers: Array<{ from: number; to: number | "X"; count: number }>;
  }>;
  winner: number | null;
  condorcet?: number | null;
  numCandidates: number;
  totalVotes: Array<{
    candidate: number;
    firstRoundVotes: number;
    transferVotes: number;
    roundEliminated?: number | null;
  }>;
  pairwisePreferences: unknown;
  firstAlternate: unknown;
  firstFinal: unknown;
  rankingDistribution?: unknown;
  smithSet: number[];
}

// ---------- Find all report.json files ----------

function findReportFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry === "report.json") {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files;
}

// ---------- Compute index-level flags from report data ----------

function isWriteInByName(candidates: ReportJson["candidates"]): boolean {
  return candidates.some(
    (c) => c.candidate_type === "QualifiedWriteIn" || c.candidate_type === "WriteIn"
  );
}

function isWinnerNotFirstRoundLeader(report: ReportJson): boolean {
  if (report.winner == null || report.rounds.length === 0) return false;
  const firstRound = report.rounds[0];

  // Find first candidate allocation (the round 1 leader) -- allocations sorted desc by votes
  const firstPlace = firstRound.allocations.find((a) => a.allocatee !== "X");
  if (!firstPlace) return false;

  // Find winner's votes in first round
  const winnerVotes = firstRound.allocations.find(
    (a) => a.allocatee === report.winner
  )?.votes ?? 0;

  // Winner did not lead if their votes are strictly less than the leader's
  return winnerVotes < firstPlace.votes;
}

/**
 * Check if an election is "interesting" based on criteria from the Rust pipeline:
 * - Non-Condorcet winner (Condorcet winner exists but didn't win under RCV)
 * - Condorcet cycle (Smith set has more than one candidate)
 * - Exhausted ballots outnumber the winner's votes in the final round
 */
function isInteresting(report: ReportJson): boolean {
  // Non-Condorcet winner
  const hasNonCondorcetWinner =
    report.condorcet != null && report.condorcet !== report.winner;

  // Condorcet cycle (Smith set > 1)
  const hasCondorcetCycle = report.smithSet.length > 1;

  // Exhausted ballots > winner's votes in final round
  let exhaustedExceedsWinner = false;
  if (report.rounds.length > 0 && report.winner != null) {
    const lastRound = report.rounds[report.rounds.length - 1];
    const exhausted =
      lastRound.allocations.find((a) => a.allocatee === "X")?.votes ?? 0;
    const winnerVotes =
      lastRound.allocations.find((a) => a.allocatee === report.winner)?.votes ?? 0;
    exhaustedExceedsWinner = exhausted > winnerVotes;
  }

  return hasNonCondorcetWinner || hasCondorcetCycle || exhaustedExceedsWinner;
}

// ---------- Main ----------

function main() {
  const reportsDir = resolve(REPORTS_DIR);

  if (!existsSync(reportsDir)) {
    console.error(`Reports directory not found: ${reportsDir}`);
    process.exit(1);
  }

  // Delete existing DB and recreate
  const dbPath = resolve(DB_PATH);
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
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

  // Find all report.json files
  const reportFiles = findReportFiles(reportsDir);
  console.log(`Found ${reportFiles.length} report.json files`);

  // Skip index.json
  let loaded = 0;
  let errors = 0;

  // Wrap in a transaction for performance
  const loadAll = db.transaction(() => {
    for (const filePath of reportFiles) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const report: ReportJson = JSON.parse(raw);
        const info = report.info;

        // Build vote lookup from totalVotes
        const voteMap = new Map<number, (typeof report.totalVotes)[0]>();
        for (const tv of report.totalVotes) {
          voteMap.set(tv.candidate, tv);
        }

        // Compute path (jurisdictionPath/electionPath)
        const path = `${info.jurisdictionPath}/${info.electionPath}`;

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
          $ballotCount: report.ballotCount,
          $path: path,
          $dataFormat: info.dataFormat,
          $numCandidates: report.numCandidates,
          $winner: report.winner ?? null,
          $condorcet: report.condorcet ?? null,
          $interesting: isInteresting(report) ? 1 : 0,
          $winnerNotFirstRoundLeader: isWinnerNotFirstRoundLeader(report) ? 1 : 0,
          $hasWriteInByName: isWriteInByName(report.candidates) ? 1 : 0,
          $smithSet: JSON.stringify(report.smithSet),
          $pairwisePreferences: JSON.stringify(report.pairwisePreferences),
          $firstAlternate: JSON.stringify(report.firstAlternate),
          $firstFinal: JSON.stringify(report.firstFinal),
          $rankingDistribution: report.rankingDistribution
            ? JSON.stringify(report.rankingDistribution)
            : null,
        });

        const reportId = Number(result.lastInsertRowid);

        // Insert candidates
        for (let i = 0; i < report.candidates.length; i++) {
          const c = report.candidates[i];
          const tv = voteMap.get(i);
          const isWriteIn =
            c.candidate_type === "WriteIn" || c.candidate_type === "QualifiedWriteIn";

          insertCandidate.run({
            $reportId: reportId,
            $candidateIndex: i,
            $name: c.name,
            $writeIn: isWriteIn ? 1 : 0,
            $candidateType: c.candidate_type ?? "Regular",
            $firstRoundVotes: tv?.firstRoundVotes ?? 0,
            $transferVotes: tv?.transferVotes ?? 0,
            $roundEliminated: tv?.roundEliminated ?? null,
            $winner: report.winner === i ? 1 : 0,
          });
        }

        // Insert rounds
        for (let r = 0; r < report.rounds.length; r++) {
          const round = report.rounds[r];

          const roundResult = insertRound.run({
            $reportId: reportId,
            $roundNumber: r,
            $undervote: round.undervote,
            $overvote: round.overvote,
            $continuingBallots: round.continuingBallots,
          });

          const roundId = Number(roundResult.lastInsertRowid);

          // Insert allocations
          for (const alloc of round.allocations) {
            insertAllocation.run({
              $roundId: roundId,
              $allocatee: String(alloc.allocatee),
              $votes: alloc.votes,
            });
          }

          // Insert transfers
          for (const transfer of round.transfers) {
            insertTransfer.run({
              $roundId: roundId,
              $fromCandidate: transfer.from,
              $toAllocatee: String(transfer.to),
              $count: transfer.count,
            });
          }
        }

        loaded++;
      } catch (err) {
        errors++;
        console.error(`Error loading ${filePath}: ${err}`);
      }
    }
  });

  loadAll();

  db.close();

  console.log(`\nLoaded ${loaded} reports into ${dbPath}`);
  if (errors > 0) {
    console.error(`${errors} errors encountered`);
  }

  // Run validation
  console.log("\nRunning round-trip validation...");
  validate(dbPath, reportsDir, reportFiles);
}

// ---------- Validation ----------

function validate(dbPath: string, reportsDir: string, reportFiles: string[]) {
  const db = new Database(dbPath, { readonly: true });

  let passed = 0;
  let failed = 0;

  for (const filePath of reportFiles) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const original: ReportJson = JSON.parse(raw);
      const info = original.info;

      // Query report back from DB
      const row = db
        .prepare("SELECT * FROM reports WHERE path = ? AND office = ?")
        .get(`${info.jurisdictionPath}/${info.electionPath}`, info.office) as any;

      if (!row) {
        console.error(`  FAIL: Report not found in DB: ${info.jurisdictionPath}/${info.electionPath}/${info.office}`);
        failed++;
        continue;
      }

      // Check key fields
      const checks: [string, unknown, unknown][] = [
        ["ballotCount", row.ballotCount, original.ballotCount],
        ["numCandidates", row.numCandidates, original.numCandidates],
        ["winner", row.winner_candidate_index, original.winner],
        ["condorcet", row.condorcet, original.condorcet ?? null],
        ["name", row.name, info.name],
        ["date", row.date, info.date],
      ];

      let reportOk = true;
      for (const [field, got, expected] of checks) {
        if (got !== expected) {
          console.error(
            `  FAIL: ${info.office} - ${field}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`
          );
          reportOk = false;
        }
      }

      // Check candidate count
      const candidateCount = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM candidates WHERE report_id = ?")
          .get(row.id) as any
      ).cnt;

      if (candidateCount !== original.candidates.length) {
        console.error(
          `  FAIL: ${info.office} - candidate count: got ${candidateCount}, expected ${original.candidates.length}`
        );
        reportOk = false;
      }

      // Check round count
      const roundCount = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM rounds WHERE report_id = ?")
          .get(row.id) as any
      ).cnt;

      if (roundCount !== original.rounds.length) {
        console.error(
          `  FAIL: ${info.office} - round count: got ${roundCount}, expected ${original.rounds.length}`
        );
        reportOk = false;
      }

      // Validate pairwise round-trip (parse JSON blob, compare structure)
      const dbPairwise = JSON.parse(row.pairwisePreferences);
      if (
        JSON.stringify(dbPairwise.rows) !==
        JSON.stringify(original.pairwisePreferences.rows)
      ) {
        console.error(`  FAIL: ${info.office} - pairwisePreferences rows mismatch`);
        reportOk = false;
      }

      if (reportOk) {
        passed++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`  FAIL: Error validating ${filePath}: ${err}`);
      failed++;
    }
  }

  db.close();

  console.log(`\nValidation: ${passed} passed, ${failed} failed out of ${reportFiles.length}`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
