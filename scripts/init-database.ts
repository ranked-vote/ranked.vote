import { Database } from "bun:sqlite";

const dbPath = process.argv[2] || "report_pipeline/reports.sqlite3";

const db = new Database(dbPath);

// Enable WAL mode for better performance
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  -- Reports table stores election contest metadata
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date TEXT NOT NULL,
    jurisdictionPath TEXT NOT NULL,
    electionPath TEXT NOT NULL,
    office TEXT NOT NULL,
    officeName TEXT NOT NULL,
    jurisdictionName TEXT NOT NULL,
    electionName TEXT NOT NULL,
    website TEXT,
    ballotCount INTEGER NOT NULL DEFAULT 0,
    path TEXT NOT NULL,
    dataFormat TEXT,
    numCandidates INTEGER NOT NULL DEFAULT 0,
    winner_candidate_index INTEGER,
    condorcet INTEGER,
    interesting INTEGER DEFAULT 0,
    winnerNotFirstRoundLeader INTEGER DEFAULT 0,
    hasWriteInByName INTEGER DEFAULT 0,
    -- JSON blobs for complex data (display-only, not worth normalizing)
    smithSet TEXT,
    pairwisePreferences TEXT,
    firstAlternate TEXT,
    firstFinal TEXT,
    rankingDistribution TEXT,
    UNIQUE(path, office)
  );

  -- Candidates table
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    candidate_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    writeIn INTEGER DEFAULT 0,
    candidate_type TEXT,
    firstRoundVotes INTEGER DEFAULT 0,
    transferVotes INTEGER DEFAULT 0,
    roundEliminated INTEGER,
    winner INTEGER DEFAULT 0,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );

  -- Rounds table for tabulation rounds
  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    round_number INTEGER NOT NULL,
    undervote INTEGER DEFAULT 0,
    overvote INTEGER DEFAULT 0,
    continuingBallots INTEGER DEFAULT 0,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );

  -- Allocations within each round
  CREATE TABLE IF NOT EXISTS allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    allocatee TEXT NOT NULL,  -- candidate_index or 'X' for exhausted
    votes INTEGER NOT NULL,
    FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE
  );

  -- Transfers between rounds
  CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    from_candidate INTEGER NOT NULL,  -- candidate_index
    to_allocatee TEXT NOT NULL,       -- candidate_index or 'X' for exhausted
    count INTEGER NOT NULL,
    FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE
  );

  -- Indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_reports_path ON reports(path);
  CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(date);
  CREATE INDEX IF NOT EXISTS idx_candidates_report ON candidates(report_id);
  CREATE INDEX IF NOT EXISTS idx_rounds_report ON rounds(report_id);
  CREATE INDEX IF NOT EXISTS idx_allocations_round ON allocations(round_id);
  CREATE INDEX IF NOT EXISTS idx_transfers_round ON transfers(round_id);
`);

db.close();

console.log(`Database initialized at ${dbPath}`);
console.log(
  "Tables created: reports, candidates, rounds, allocations, transfers",
);
