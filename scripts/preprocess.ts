/**
 * Full pipeline: raw-data -> reports.sqlite3
 *
 * Replaces the entire Rust pipeline with JS-only processing.
 * Reads election-metadata JSON files, invokes the appropriate format parser,
 * normalizes ballots, runs the RCV tabulator, computes analysis, and writes
 * results directly to reports.sqlite3.
 *
 * Usage:
 *   bun scripts/preprocess.ts [metadata-dir] [raw-data-dir] [db-path]
 */

import { Database } from "bun:sqlite";
import {
  readdirSync,
  readFileSync,
  existsSync,
  unlinkSync,
  statSync,
} from "fs";
import { join, resolve } from "path";

import {
  readElection,
  isFormatSupported,
  nistBatchReader,
  nycBatchReader,
} from "./pipeline/formats/index";
import { normalizeElection } from "./pipeline/normalizers/index";
import {
  tabulate,
  type NormalizedBallot,
  type TabulationOptions,
} from "./tabulate-rcv";
import { analyzeElection } from "./compute-rcv-analysis";
import type {
  Jurisdiction,
  ElectionMetadata,
  Contest,
  Election,
  NormalizedElection,
} from "./pipeline/types";
import type { CandidateId } from "../src/report_types";

const METADATA_DIR = process.argv[2] || "report_pipeline/election-metadata";
const RAW_DATA_DIR = process.argv[3] || "report_pipeline/raw-data";
const DB_PATH = process.argv[4] || "report_pipeline/reports.sqlite3";
const SKIP_FORMATS = new Set(
  (process.env.SKIP_FORMATS ?? "").split(",").filter(Boolean),
);

// ---------- Metadata loading ----------

function findMetadataFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findMetadataFiles(full));
    else if (entry.name.endsWith(".json")) files.push(full);
  }
  return files;
}

function loadJurisdictions(metaDir: string): Jurisdiction[] {
  const jurisdictions: Jurisdiction[] = [];
  for (const path of findMetadataFiles(metaDir)) {
    try {
      jurisdictions.push(JSON.parse(readFileSync(path, "utf-8")));
    } catch (e: any) {
      console.warn(`Failed to load metadata ${path}: ${e.message}`);
    }
  }
  return jurisdictions;
}

// ---------- Index-level flags (matching Rust logic) ----------

function isWriteInByName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "write-in" ||
    n === "write in" ||
    n === "undeclared write-ins" ||
    n === "uwi"
  );
}

interface ReportData {
  rounds: ReturnType<typeof tabulate>;
  winner: number | null;
  condorcet: number | null;
  smithSet: number[];
  candidates: Array<{ name: string; candidate_type?: string }>;
}

function isInteresting(r: ReportData): boolean {
  const hasNonCondorcetWinner = r.condorcet != null && r.condorcet !== r.winner;
  const hasCondorcetCycle = r.smithSet.length > 1;

  let exhaustedExceedsWinner = false;
  if (r.rounds.length > 0 && r.winner != null) {
    const lastRound = r.rounds[r.rounds.length - 1];
    const exhausted =
      lastRound.allocations.find((a) => a.allocatee === "X")?.votes ?? 0;
    const winnerVotes =
      lastRound.allocations.find((a) => a.allocatee === r.winner)?.votes ?? 0;
    exhaustedExceedsWinner = exhausted > winnerVotes;
  }

  return hasNonCondorcetWinner || hasCondorcetCycle || exhaustedExceedsWinner;
}

function winnerNotFirstRoundLeader(r: ReportData): boolean {
  if (r.winner == null || r.rounds.length === 0) return false;
  const firstRound = r.rounds[0];

  // Find first candidate allocation (the leader)
  const firstCandAlloc = firstRound.allocations.find(
    (a) => a.allocatee !== "X",
  );
  if (!firstCandAlloc) return false;
  const maxVotes = firstCandAlloc.votes;

  // Find winner's votes
  const winnerVotes =
    firstRound.allocations.find((a) => a.allocatee === r.winner)?.votes ?? 0;

  return winnerVotes < maxVotes;
}

// ---------- Process a single contest ----------

function processContest(
  normalizedElection: NormalizedElection,
  jurisdiction: Jurisdiction,
  election: ElectionMetadata,
  electionPath: string,
  contest: Contest,
  insertReport: any,
  insertCandidate: any,
  insertRound: any,
  insertAllocation: any,
  insertTransfer: any,
): boolean {
  const office = jurisdiction.offices[contest.office];
  if (!office) {
    console.warn(
      `Office ${contest.office} not found in jurisdiction ${jurisdiction.path}`,
    );
    return false;
  }

  const ballots: NormalizedBallot[] = normalizedElection.ballots;
  const candidates = normalizedElection.candidates;

  if (ballots.length === 0) return false;

  const tabulationOptions: TabulationOptions = {
    eager: election.tabulationOptions?.eager ?? undefined,
    nycStyle: election.tabulationOptions?.nycStyle ?? undefined,
  };

  // Run tabulator
  const rounds = tabulate(ballots, tabulationOptions);

  // Build candidate ID lists
  const nonWriteInCandidates: CandidateId[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].candidate_type !== "WriteIn") {
      nonWriteInCandidates.push(i);
    }
  }

  const totalVotesCandidates: CandidateId[] = [];
  for (const alloc of rounds[0]?.allocations ?? []) {
    if (alloc.allocatee !== "X") {
      totalVotesCandidates.push(alloc.allocatee as CandidateId);
    }
  }
  totalVotesCandidates.sort((a, b) => a - b);

  // Run analysis
  const analysis = analyzeElection(totalVotesCandidates, ballots, rounds);
  const path = `${jurisdiction.path}/${electionPath}`;
  const numCandidates = nonWriteInCandidates.length;

  const reportData: ReportData = {
    rounds,
    winner: analysis.winner,
    condorcet: analysis.condorcet ?? null,
    smithSet: analysis.smithSet,
    candidates: candidates as any,
  };

  const hasWriteIn = candidates.some((c) => isWriteInByName(c.name));

  // Insert report
  const result = insertReport.run({
    $name: election.name,
    $date: election.date,
    $jurisdictionPath: jurisdiction.path,
    $electionPath: electionPath,
    $office: contest.office,
    $officeName: office.name,
    $jurisdictionName: jurisdiction.name,
    $electionName: election.name,
    $website: election.website ?? null,
    $ballotCount: ballots.length,
    $path: path,
    $dataFormat: election.dataFormat,
    $numCandidates: numCandidates,
    $winner: analysis.winner,
    $condorcet: analysis.condorcet ?? null,
    $interesting: isInteresting(reportData) ? 1 : 0,
    $winnerNotFirstRoundLeader: winnerNotFirstRoundLeader(reportData) ? 1 : 0,
    $hasWriteInByName: hasWriteIn ? 1 : 0,
    $smithSet: JSON.stringify(analysis.smithSet),
    $pairwisePreferences: JSON.stringify(analysis.pairwisePreferences),
    $firstAlternate: JSON.stringify(analysis.firstAlternate),
    $firstFinal: JSON.stringify(analysis.firstFinal),
    $rankingDistribution: JSON.stringify(analysis.rankingDistribution),
  });

  const reportId = Number(result.lastInsertRowid);

  // Insert candidates
  const voteMap = new Map(analysis.totalVotes.map((tv) => [tv.candidate, tv]));
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
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

  return true;
}

// ---------- Main ----------

async function main() {
  const metaDir = resolve(METADATA_DIR);
  const rawDir = resolve(RAW_DATA_DIR);
  const dbPath = resolve(DB_PATH);

  if (!existsSync(metaDir)) {
    console.error(`Metadata directory not found: ${metaDir}`);
    process.exit(1);
  }

  // Delete existing DB and recreate
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
    if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
    if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
  }

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

  // Load jurisdictions
  const jurisdictions = loadJurisdictions(metaDir);
  console.log(`Loaded ${jurisdictions.length} jurisdictions`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const startTime = Date.now();

  // Track problems for end-of-run summary
  const problems: Array<{
    election: string;
    contest: string;
    reason: string;
  }> = [];
  const missingRawData: string[] = [];
  const skippedFormats: Array<{ election: string; format: string }> = [];

  // Deferred elections (async readers: NYC, ME, MPLS)
  const nycDeferred: Array<{
    jurisdiction: Jurisdiction;
    election: ElectionMetadata;
    electionPath: string;
    label: string;
    rawPath: string;
    electionStart: number;
  }> = [];

  // Deferred per-contest async results (ME, MPLS readers are async due to ExcelJS)
  const asyncDeferred: Array<{
    electionPromise: Promise<Election>;
    jurisdiction: Jurisdiction;
    election: ElectionMetadata;
    electionPath: string;
    contest: Contest;
    label: string;
  }> = [];

  // Count total contests for progress
  let totalContests = 0;
  for (const j of jurisdictions) {
    for (const e of Object.values(j.elections)) {
      totalContests += e.contests.length;
    }
  }
  console.log(`Total contests to process: ${totalContests}`);

  const processAll = db.transaction(() => {
    for (const jurisdiction of jurisdictions) {
      for (const [electionPath, election] of Object.entries(
        jurisdiction.elections,
      )) {
        const dataFormat = election.dataFormat;
        const label = `${jurisdiction.path}/${electionPath}`;

        if (!isFormatSupported(dataFormat)) {
          skipped += election.contests.length;
          continue;
        }
        if (SKIP_FORMATS.has(dataFormat)) {
          skipped += election.contests.length;
          skippedFormats.push({ election: label, format: dataFormat });
          continue;
        }

        const rawPath = join(rawDir, jurisdiction.path, electionPath);
        if (!existsSync(rawPath)) {
          skipped += election.contests.length;
          missingRawData.push(label);
          continue;
        }

        const electionStart = Date.now();
        console.log(
          `  ${label} [${dataFormat}, ${election.contests.length} contests]`,
        );

        // Batch processing for NIST and NYC formats
        if (dataFormat === "nist_sp_1500" && election.contests.length > 1) {
          // Check if all contests share the same CVR
          const firstCvr = election.contests[0]?.loaderParams?.cvr;
          const sameCvr = election.contests.every(
            (c) => c.loaderParams?.cvr === firstCvr,
          );

          if (sameCvr && firstCvr) {
            try {
              const batchContests = election.contests
                .filter((c) => c.loaderParams?.contest)
                .map((c) => ({
                  office: c.office,
                  contestId: parseInt(c.loaderParams!.contest!, 10),
                  params: c.loaderParams!,
                }));

              const electionResults = nistBatchReader(rawPath, batchContests);

              for (const contest of election.contests) {
                const rawElection = electionResults.get(contest.office);
                if (!rawElection || rawElection.ballots.length === 0) {
                  skipped++;
                  continue;
                }

                const normalized = normalizeElection(
                  election.normalization,
                  rawElection,
                );
                const ok = processContest(
                  normalized,
                  jurisdiction,
                  election,
                  electionPath,
                  contest,
                  insertReport,
                  insertCandidate,
                  insertRound,
                  insertAllocation,
                  insertTransfer,
                );
                if (ok) processed++;
                else skipped++;
              }
              const ms = Date.now() - electionStart;
              console.log(
                `    -> ${election.contests.length} contests (${ms}ms)`,
              );
              continue; // Skip per-contest processing
            } catch (e: any) {
              console.error(`    NIST batch error: ${e.message}`);
              errors += election.contests.length;
              for (const c of election.contests) {
                problems.push({
                  election: label,
                  contest: c.office,
                  reason: e.message,
                });
              }
              continue;
            }
          }
        }

        if (dataFormat === "us_ny_nyc") {
          // NYC reader is async (streams XLSX), so we collect results
          // here and mark them for deferred insertion after the loop.
          nycDeferred.push({
            jurisdiction,
            election,
            electionPath,
            label,
            rawPath,
            electionStart,
          });
          continue;
        }

        // Per-contest processing for other formats
        for (const contest of election.contests) {
          try {
            const params = contest.loaderParams ?? {};
            const result = readElection(dataFormat, rawPath, params);

            // If the reader returns a Promise (async readers like ME, MPLS),
            // defer processing to after the synchronous transaction
            if (result instanceof Promise) {
              asyncDeferred.push({
                electionPromise: result,
                jurisdiction,
                election,
                electionPath,
                contest,
                label,
              });
              continue;
            }

            const rawElection = result;

            if (rawElection.ballots.length === 0) {
              skipped++;
              continue;
            }

            const normalized = normalizeElection(
              election.normalization,
              rawElection,
            );
            const ok = processContest(
              normalized,
              jurisdiction,
              election,
              electionPath,
              contest,
              insertReport,
              insertCandidate,
              insertRound,
              insertAllocation,
              insertTransfer,
            );

            if (ok) processed++;
            else skipped++;
          } catch (e: any) {
            errors++;
            problems.push({
              election: label,
              contest: contest.office,
              reason: e.message,
            });
            console.error(`    Error ${contest.office}: ${e.message}`);
          }
        }
        const ms = Date.now() - electionStart;
        if (ms > 100) console.log(`    -> done (${ms}ms)`);
      }
    }
  });

  processAll();

  // Process deferred async elections (ME, MPLS — ExcelJS is async)
  if (asyncDeferred.length > 0) {
    console.log(
      `\nProcessing ${asyncDeferred.length} deferred async contests (ME/MPLS)...`,
    );
    for (const deferred of asyncDeferred) {
      const {
        electionPromise,
        jurisdiction,
        election,
        electionPath,
        contest,
        label,
      } = deferred;
      try {
        const rawElection = await electionPromise;

        if (rawElection.ballots.length === 0) {
          skipped++;
          continue;
        }

        const normalized = normalizeElection(
          election.normalization,
          rawElection,
        );
        const insertAsync = db.transaction(() => {
          const ok = processContest(
            normalized,
            jurisdiction,
            election,
            electionPath,
            contest,
            insertReport,
            insertCandidate,
            insertRound,
            insertAllocation,
            insertTransfer,
          );
          if (ok) processed++;
          else skipped++;
        });
        insertAsync();
      } catch (e: any) {
        errors++;
        problems.push({
          election: label,
          contest: contest.office,
          reason: e.message,
        });
        console.error(`    Error ${contest.office}: ${e.message}`);
      }
    }
  }

  // Process deferred NYC elections (async streaming)
  for (const nyc of nycDeferred) {
    const { jurisdiction, election, electionPath, label, rawPath } = nyc;
    const electionStart = Date.now();
    console.log(`  ${label} [us_ny_nyc, ${election.contests.length} contests]`);

    try {
      const batchContests = election.contests
        .filter((c) => c.loaderParams)
        .map((c) => ({ office: c.office, params: c.loaderParams! }));

      const electionResults = await nycBatchReader(rawPath, batchContests);

      const insertNyc = db.transaction(() => {
        for (const contest of election.contests) {
          const rawElection = electionResults.get(contest.office);
          if (!rawElection || rawElection.ballots.length === 0) {
            skipped++;
            continue;
          }

          const normalized = normalizeElection(
            election.normalization,
            rawElection,
          );
          const ok = processContest(
            normalized,
            jurisdiction,
            election,
            electionPath,
            contest,
            insertReport,
            insertCandidate,
            insertRound,
            insertAllocation,
            insertTransfer,
          );
          if (ok) processed++;
          else skipped++;
        }
      });
      insertNyc();

      const ms = Date.now() - electionStart;
      console.log(`    -> ${election.contests.length} contests (${ms}ms)`);
    } catch (e: any) {
      console.error(`    NYC batch error: ${e.message}`);
      errors += election.contests.length;
      for (const c of election.contests) {
        problems.push({
          election: label,
          contest: c.office,
          reason: e.message,
        });
      }
    }
  }

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ---- Summary ----
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Done in ${elapsed}s`);
  console.log(`  Processed: ${processed} contests`);
  console.log(`  Skipped:   ${skipped} contests`);
  console.log(`${"=".repeat(60)}`);

  const hasBroken = problems.length > 0 || missingRawData.length > 0;

  if (hasBroken) {
    console.error("");
    console.error("\x1b[1m\x1b[31m" + "!".repeat(60));
    console.error("!!!  BROKEN ELECTIONS — THESE NEED TO BE FIXED  !!!");
    console.error("!".repeat(60) + "\x1b[0m");

    if (problems.length > 0) {
      console.error(
        `\n\x1b[1m\x1b[31m  ERRORS (${problems.length} contests failed):\x1b[0m`,
      );
      // Group by election for readability
      const byElection = new Map<
        string,
        Array<{ contest: string; reason: string }>
      >();
      for (const p of problems) {
        if (!byElection.has(p.election)) byElection.set(p.election, []);
        byElection
          .get(p.election)!
          .push({ contest: p.contest, reason: p.reason });
      }
      for (const [election, contests] of byElection) {
        console.error(`\n  \x1b[1m${election}\x1b[0m`);
        for (const c of contests) {
          console.error(`    \x1b[31m✗\x1b[0m ${c.contest}: ${c.reason}`);
        }
      }
    }

    if (missingRawData.length > 0) {
      console.error(
        `\n\x1b[1m\x1b[31m  MISSING RAW DATA (${missingRawData.length} elections):\x1b[0m`,
      );
      for (const e of missingRawData) {
        console.error(`    \x1b[31m✗\x1b[0m ${e}`);
      }
    }

    console.error(`\n\x1b[1m\x1b[31m${"!".repeat(60)}\x1b[0m\n`);
  } else {
    console.log("\n  All elections processed successfully.\n");
  }

  if (skippedFormats.length > 0) {
    console.log(
      `  Deferred formats (${skippedFormats.length} elections, not yet supported):`,
    );
    for (const s of skippedFormats) {
      console.log(`    - ${s.election} [${s.format}]`);
    }
    console.log("");
  }
}

main();
