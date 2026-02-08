/**
 * SQLite database access layer for ranked.vote reports.
 *
 * Replaces the JSON file-based getIndex()/getReport() functions
 * with SQLite queries. Returns the same IReportIndex / IContestReport
 * shapes so the rest of the site is unchanged.
 */

import Database from "better-sqlite3";
import { resolve } from "path";
import type {
  IReportIndex,
  IContestReport,
  IElectionIndexEntry,
  IContestIndexEntry,
  ICandidate,
  ICandidateVotes,
  ITabulatorRound,
  ITabulatorAllocation,
  Transfer,
  ICandidatePairTable,
  IRankingDistribution,
  Allocatee,
} from "../../report_types";

const RANKED_VOTE_DB = process.env.RANKED_VOTE_DB
  ? resolve(process.env.RANKED_VOTE_DB)
  : resolve("./report_pipeline/reports.sqlite3");

function getDatabase(): Database.Database {
  return new Database(RANKED_VOTE_DB, { readonly: true });
}

// ---------- Row types from SQLite ----------

interface ReportRow {
  id: number;
  name: string;
  date: string;
  jurisdictionPath: string;
  electionPath: string;
  office: string;
  officeName: string;
  jurisdictionName: string;
  electionName: string;
  website: string | null;
  ballotCount: number;
  path: string;
  dataFormat: string | null;
  numCandidates: number;
  winner_candidate_index: number | null;
  condorcet: number | null;
  interesting: number;
  winnerNotFirstRoundLeader: number;
  hasWriteInByName: number;
  smithSet: string | null;
  pairwisePreferences: string | null;
  firstAlternate: string | null;
  firstFinal: string | null;
  rankingDistribution: string | null;
}

interface CandidateRow {
  id: number;
  report_id: number;
  candidate_index: number;
  name: string;
  writeIn: number;
  candidate_type: string | null;
  firstRoundVotes: number;
  transferVotes: number;
  roundEliminated: number | null;
  winner: number;
}

interface RoundRow {
  id: number;
  report_id: number;
  round_number: number;
  undervote: number;
  overvote: number;
  continuingBallots: number;
}

interface AllocationRow {
  round_id: number;
  allocatee: string;
  votes: number;
}

interface TransferRow {
  round_id: number;
  from_candidate: number;
  to_allocatee: string;
  count: number;
}

// ---------- Helpers ----------

function parseAllocatee(value: string): Allocatee {
  if (value === "X") return "X";
  return parseInt(value, 10);
}

// ---------- Public API ----------

export function getIndex(): IReportIndex {
  let db: Database.Database;
  try {
    db = getDatabase();
  } catch {
    return { elections: [] };
  }

  try {
    const rows = db
      .prepare(
        `SELECT r.*, COUNT(c.id) AS candidateCount
         FROM reports r
         LEFT JOIN candidates c ON r.id = c.report_id
         GROUP BY r.id
         ORDER BY r.date DESC, r.jurisdictionName ASC`,
      )
      .all() as (ReportRow & { candidateCount: number })[];

    // Group by election path
    const electionMap = new Map<string, IElectionIndexEntry>();

    for (const row of rows) {
      // Get winner name
      const winnerRow = db
        .prepare(
          "SELECT name FROM candidates WHERE report_id = ? AND winner = 1 LIMIT 1",
        )
        .get(row.id) as { name: string } | undefined;

      // Get condorcet winner name
      let condorcetWinnerName: string | undefined;
      if (row.condorcet != null) {
        const condorcetRow = db
          .prepare(
            "SELECT name FROM candidates WHERE report_id = ? AND candidate_index = ?",
          )
          .get(row.id, row.condorcet) as { name: string } | undefined;
        condorcetWinnerName = condorcetRow?.name;
      }

      // Count rounds
      const roundCount = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM rounds WHERE report_id = ?")
          .get(row.id) as { cnt: number }
      ).cnt;

      const contest: IContestIndexEntry = {
        office: row.office,
        officeName: row.officeName,
        name: row.name,
        winner: winnerRow?.name ?? "No Winner",
        numCandidates: row.numCandidates,
        numRounds: roundCount,
        condorcetWinner: condorcetWinnerName,
        interesting: row.interesting === 1,
        hasWriteInByName: row.hasWriteInByName === 1,
        winnerNotFirstRoundLeader: row.winnerNotFirstRoundLeader === 1,
      };

      if (!electionMap.has(row.path)) {
        electionMap.set(row.path, {
          path: row.path,
          jurisdictionName: row.jurisdictionName,
          electionName: row.electionName,
          date: row.date,
          contests: [],
        });
      }

      electionMap.get(row.path)!.contests.push(contest);
    }

    return { elections: Array.from(electionMap.values()) };
  } finally {
    db.close();
  }
}

export function getReport(path: string): IContestReport | null {
  let db: Database.Database;
  try {
    db = getDatabase();
  } catch {
    return null;
  }

  try {
    // Path format: "us/ca/sfo/2024/11/mayor"
    // Split into election path and office
    const parts = path.split("/");
    const office = parts[parts.length - 1];
    const electionPath = parts.slice(0, -1).join("/");

    const reportRow = db
      .prepare("SELECT * FROM reports WHERE path = ? AND office = ?")
      .get(electionPath, office) as ReportRow | undefined;

    if (!reportRow) {
      return null;
    }

    // Get candidates ordered by index
    const candidateRows = db
      .prepare(
        "SELECT * FROM candidates WHERE report_id = ? ORDER BY candidate_index",
      )
      .all(reportRow.id) as CandidateRow[];

    const candidates: ICandidate[] = candidateRows.map((row) => ({
      name: row.name,
      candidate_type: row.candidate_type || undefined,
    }));

    const totalVotes: ICandidateVotes[] = candidateRows.map((row) => ({
      candidate: row.candidate_index,
      firstRoundVotes: row.firstRoundVotes,
      transferVotes: row.transferVotes,
      roundEliminated: row.roundEliminated,
    }));

    // Get rounds
    const roundRows = db
      .prepare("SELECT * FROM rounds WHERE report_id = ? ORDER BY round_number")
      .all(reportRow.id) as RoundRow[];

    const rounds: ITabulatorRound[] = roundRows.map((roundRow) => {
      const allocationRows = db
        .prepare("SELECT * FROM allocations WHERE round_id = ?")
        .all(roundRow.id) as AllocationRow[];

      const transferRows = db
        .prepare("SELECT * FROM transfers WHERE round_id = ?")
        .all(roundRow.id) as TransferRow[];

      const allocations: ITabulatorAllocation[] = allocationRows.map((a) => ({
        allocatee: parseAllocatee(a.allocatee),
        votes: a.votes,
      }));

      const transfers: Transfer[] = transferRows.map((t) => ({
        from: t.from_candidate,
        to: parseAllocatee(t.to_allocatee),
        count: t.count,
      }));

      return {
        allocations,
        undervote: roundRow.undervote,
        overvote: roundRow.overvote,
        continuingBallots: roundRow.continuingBallots,
        transfers,
      };
    });

    // Parse JSON blob fields
    const pairwisePreferences: ICandidatePairTable =
      reportRow.pairwisePreferences
        ? JSON.parse(reportRow.pairwisePreferences)
        : { rows: [], cols: [], entries: [] };
    const firstAlternate: ICandidatePairTable = reportRow.firstAlternate
      ? JSON.parse(reportRow.firstAlternate)
      : { rows: [], cols: [], entries: [] };
    const firstFinal: ICandidatePairTable = reportRow.firstFinal
      ? JSON.parse(reportRow.firstFinal)
      : { rows: [], cols: [], entries: [] };
    const rankingDistribution: IRankingDistribution | undefined =
      reportRow.rankingDistribution
        ? JSON.parse(reportRow.rankingDistribution)
        : undefined;

    const smithSet: number[] = reportRow.smithSet
      ? JSON.parse(reportRow.smithSet)
      : [];

    const report: IContestReport = {
      info: {
        name: reportRow.name,
        date: reportRow.date,
        dataFormat: reportRow.dataFormat || "unknown",
        tabulation: "rcv",
        jurisdictionPath: reportRow.jurisdictionPath,
        electionPath: reportRow.electionPath,
        office: reportRow.office,
        jurisdictionName: reportRow.jurisdictionName,
        officeName: reportRow.officeName,
        electionName: reportRow.electionName,
        website: reportRow.website || undefined,
      },
      ballotCount: reportRow.ballotCount,
      candidates,
      rounds,
      winner: reportRow.winner_candidate_index ?? 0,
      condorcet: reportRow.condorcet ?? undefined,
      smithSet,
      numCandidates: reportRow.numCandidates,
      totalVotes,
      pairwisePreferences,
      firstAlternate,
      firstFinal,
      rankingDistribution,
    };

    return report;
  } finally {
    db.close();
  }
}
