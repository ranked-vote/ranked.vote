/**
 * Regression test: verify SQLite database flags match Rust-generated index.json.
 *
 * The fixture file tests/fixtures/rust-index-flags.json was generated from
 * the Rust pipeline's index.json output. This test reads the SQLite database
 * and ensures all index-level fields match, catching regressions in:
 * - interesting flag
 * - winnerNotFirstRoundLeader flag
 * - winner name
 * - numCandidates
 * - condorcetWinner name
 * - hasWriteInByName flag
 *
 * numRounds is tracked but not asserted — differences are expected due to
 * eager vs non-eager elimination settings between pipelines.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";

interface ExpectedContest {
  path: string;
  office: string;
  interesting: boolean;
  winnerNotFirstRoundLeader: boolean;
  winner: string;
  numCandidates: number;
  numRounds: number;
  condorcetWinner: string | null;
  hasWriteInByName: boolean;
}

interface DbReportRow {
  path: string;
  office: string;
  interesting: number;
  winnerNotFirstRoundLeader: number;
  numCandidates: number;
  ballotCount: number;
  condorcet: number | null;
  hasWriteInByName: number;
}

// Load fixture and DB
const DB_PATH = resolve(
  process.env.RANKED_VOTE_DB || "report_pipeline/reports.sqlite3",
);

const allExpected: ExpectedContest[] = JSON.parse(
  readFileSync(resolve("tests/fixtures/rust-index-flags.json"), "utf-8"),
);

const db = new Database(DB_PATH, { readonly: true });

// Pre-compute which contests exist in the DB
const dbContestSet = new Set<string>();
const dbRows = db.prepare("SELECT path, office FROM reports").all() as Array<{
  path: string;
  office: string;
}>;
for (const row of dbRows) {
  dbContestSet.add(`${row.path}|${row.office}`);
}

const presentInDb = allExpected.filter((c) =>
  dbContestSet.has(`${c.path}|${c.office}`),
);
const missingFromDb = allExpected.filter(
  (c) => !dbContestSet.has(`${c.path}|${c.office}`),
);

// Helper: get full DB row for a contest
function getDbReport(path: string, office: string): DbReportRow | null {
  return db
    .prepare(
      `SELECT path, office, interesting, winnerNotFirstRoundLeader,
              numCandidates, ballotCount, condorcet, hasWriteInByName
       FROM reports WHERE path = ? AND office = ?`,
    )
    .get(path, office) as DbReportRow | null;
}

function getDbWinner(path: string, office: string): string | null {
  const row = db
    .prepare(
      `SELECT c.name FROM reports r
       JOIN candidates c ON r.id = c.report_id AND c.winner = 1
       WHERE r.path = ? AND r.office = ?`,
    )
    .get(path, office) as { name: string } | null;
  return row?.name ?? null;
}

function getDbCondorcetName(path: string, office: string): string | null {
  const row = db
    .prepare(
      `SELECT c.name FROM reports r
       JOIN candidates c ON r.id = c.report_id AND c.candidate_index = r.condorcet
       WHERE r.path = ? AND r.office = ?`,
    )
    .get(path, office) as { name: string } | null;
  return row?.name ?? null;
}

function getDbRoundCount(path: string, office: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM rounds
       WHERE report_id = (SELECT id FROM reports WHERE path = ? AND office = ?)`,
    )
    .get(path, office) as { cnt: number };
  return row.cnt;
}

afterAll(() => {
  db.close();
});

describe("SQLite DB matches Rust index flags", () => {
  test("all expected contests exist in the database", () => {
    if (missingFromDb.length > 0) {
      const grouped = new Map<string, string[]>();
      for (const c of missingFromDb) {
        const key = c.path;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(c.office);
      }
      const summary = [...grouped.entries()]
        .map(([path, offices]) => `  ${path}: ${offices.join(", ")}`)
        .join("\n");
      throw new Error(
        `${missingFromDb.length} contests missing from DB:\n${summary}`,
      );
    }
  });

  // Per-contest validation: each contest gets its own test
  // so failures are easy to identify and investigate
  for (const contest of presentInDb) {
    const label = `${contest.path}/${contest.office}`;

    test(label, () => {
      const dbRow = getDbReport(contest.path, contest.office);
      expect(dbRow).not.toBeNull();
      if (!dbRow) return;

      const dbWinner = getDbWinner(contest.path, contest.office);
      const dbCondorcet = getDbCondorcetName(contest.path, contest.office);
      const dbRounds = getDbRoundCount(contest.path, contest.office);

      const failures: string[] = [];

      // interesting
      const dbInteresting = dbRow.interesting === 1;
      if (dbInteresting !== contest.interesting) {
        failures.push(
          `interesting: got ${dbInteresting}, expected ${contest.interesting}`,
        );
      }

      // winnerNotFirstRoundLeader
      const dbWNFRL = dbRow.winnerNotFirstRoundLeader === 1;
      if (dbWNFRL !== contest.winnerNotFirstRoundLeader) {
        failures.push(
          `winnerNotFirstRoundLeader: got ${dbWNFRL}, expected ${contest.winnerNotFirstRoundLeader}`,
        );
      }

      // winner name
      const actualWinner = dbWinner ?? "No Winner";
      if (actualWinner !== contest.winner) {
        failures.push(
          `winner: got "${actualWinner}", expected "${contest.winner}"`,
        );
      }

      // numCandidates
      if (dbRow.numCandidates !== contest.numCandidates) {
        failures.push(
          `numCandidates: got ${dbRow.numCandidates}, expected ${contest.numCandidates}`,
        );
      }

      // condorcetWinner
      if (contest.condorcetWinner === null) {
        if (dbRow.condorcet !== null) {
          failures.push(
            `condorcetWinner: got "${dbCondorcet}", expected null`,
          );
        }
      } else {
        if (dbCondorcet !== contest.condorcetWinner) {
          failures.push(
            `condorcetWinner: got "${dbCondorcet}", expected "${contest.condorcetWinner}"`,
          );
        }
      }

      // hasWriteInByName
      const dbHasWriteIn = dbRow.hasWriteInByName === 1;
      if (dbHasWriteIn !== contest.hasWriteInByName) {
        failures.push(
          `hasWriteInByName: got ${dbHasWriteIn}, expected ${contest.hasWriteInByName}`,
        );
      }

      // numRounds — tracked but not asserted (eager elimination differences)
      if (dbRounds !== contest.numRounds) {
        failures.push(
          `[info] numRounds: got ${dbRounds}, expected ${contest.numRounds} (not asserted)`,
        );
      }

      // Report all real failures (exclude [info] lines)
      const realFailures = failures.filter((f) => !f.startsWith("[info]"));
      if (realFailures.length > 0) {
        const context = `ballotCount=${dbRow.ballotCount}, candidates=${dbRow.numCandidates}, rounds=${dbRounds}`;
        const detail = failures.map((f) => `  - ${f}`).join("\n");
        throw new Error(`${label} (${context}):\n${detail}`);
      }
    });
  }
});
