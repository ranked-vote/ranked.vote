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
 * - numRounds
 * - condorcetWinner name
 * - hasWriteInByName flag
 *
 * Note: contests whose format parsers haven't been ported to JS yet
 * (no preprocessed data) are tracked separately and excluded from
 * value-matching tests.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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

// Load fixture and DB synchronously so test.each works
const DB_PATH = resolve(
  process.env.RANKED_VOTE_DB || "report_pipeline/reports.sqlite3",
);

const allExpected: ExpectedContest[] = JSON.parse(
  readFileSync(resolve("tests/fixtures/rust-index-flags.json"), "utf-8"),
);

const db = new Database(DB_PATH, { readonly: true });

// Pre-compute which contests exist in the DB so value tests can skip missing ones
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

afterAll(() => {
  db.close();
});

describe("SQLite DB matches Rust index flags", () => {
  test("all expected contests exist in the database", () => {
    const missing = missingFromDb.map((c) => `${c.path}/${c.office}`);
    expect(missing).toEqual([]);
  });

  test("interesting flag matches for all contests", () => {
    const mismatches: string[] = [];
    for (const contest of presentInDb) {
      const row = db
        .prepare(
          "SELECT interesting FROM reports WHERE path = ? AND office = ?",
        )
        .get(contest.path, contest.office) as { interesting: number };
      const actual = row.interesting === 1;
      if (actual !== contest.interesting) {
        mismatches.push(
          `${contest.path}/${contest.office}: DB=${actual}, expected=${contest.interesting}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("winnerNotFirstRoundLeader flag matches for all contests", () => {
    const mismatches: string[] = [];
    for (const contest of presentInDb) {
      const row = db
        .prepare(
          "SELECT winnerNotFirstRoundLeader FROM reports WHERE path = ? AND office = ?",
        )
        .get(contest.path, contest.office) as {
        winnerNotFirstRoundLeader: number;
      };
      const actual = row.winnerNotFirstRoundLeader === 1;
      if (actual !== contest.winnerNotFirstRoundLeader) {
        mismatches.push(
          `${contest.path}/${contest.office}: DB=${actual}, expected=${contest.winnerNotFirstRoundLeader}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("winner name matches for all contests", () => {
    const mismatches: string[] = [];
    for (const contest of presentInDb) {
      const row = db
        .prepare(
          `SELECT c.name FROM reports r
           JOIN candidates c ON r.id = c.report_id AND c.winner = 1
           WHERE r.path = ? AND r.office = ?`,
        )
        .get(contest.path, contest.office) as { name: string } | null;
      const actual = row?.name ?? "No Winner";
      if (actual !== contest.winner) {
        mismatches.push(
          `${contest.path}/${contest.office}: DB="${actual}", expected="${contest.winner}"`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("numCandidates matches for all contests", () => {
    const mismatches: string[] = [];
    for (const contest of presentInDb) {
      const row = db
        .prepare(
          "SELECT numCandidates FROM reports WHERE path = ? AND office = ?",
        )
        .get(contest.path, contest.office) as { numCandidates: number };
      if (row.numCandidates !== contest.numCandidates) {
        mismatches.push(
          `${contest.path}/${contest.office}: DB=${row.numCandidates}, expected=${contest.numCandidates}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("numRounds matches for all contests", () => {
    const mismatches: string[] = [];
    for (const contest of presentInDb) {
      const row = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM rounds
           WHERE report_id = (SELECT id FROM reports WHERE path = ? AND office = ?)`,
        )
        .get(contest.path, contest.office) as { cnt: number };
      if (row.cnt !== contest.numRounds) {
        mismatches.push(
          `${contest.path}/${contest.office}: DB=${row.cnt}, expected=${contest.numRounds}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("condorcetWinner matches for all contests", () => {
    const mismatches: string[] = [];
    for (const contest of presentInDb) {
      const row = db
        .prepare(
          `SELECT r.condorcet, c.name as condorcetName
           FROM reports r
           LEFT JOIN candidates c ON r.id = c.report_id AND c.candidate_index = r.condorcet
           WHERE r.path = ? AND r.office = ?`,
        )
        .get(contest.path, contest.office) as {
        condorcet: number | null;
        condorcetName: string | null;
      };

      if (contest.condorcetWinner === null) {
        if (row.condorcet !== null) {
          mismatches.push(
            `${contest.path}/${contest.office}: DB="${row.condorcetName}", expected=null`,
          );
        }
      } else {
        if (row.condorcetName !== contest.condorcetWinner) {
          mismatches.push(
            `${contest.path}/${contest.office}: DB="${row.condorcetName}", expected="${contest.condorcetWinner}"`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("hasWriteInByName matches for all contests", () => {
    const mismatches: string[] = [];
    for (const contest of presentInDb) {
      const row = db
        .prepare(
          "SELECT hasWriteInByName FROM reports WHERE path = ? AND office = ?",
        )
        .get(contest.path, contest.office) as { hasWriteInByName: number };
      const actual = row.hasWriteInByName === 1;
      if (actual !== contest.hasWriteInByName) {
        mismatches.push(
          `${contest.path}/${contest.office}: DB=${actual}, expected=${contest.hasWriteInByName}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
