/**
 * Copy `notes` from election metadata into an existing reports database,
 * adding the column if the database predates it. Lets notes change without
 * a full (and slow) pipeline rebuild.
 *
 * Usage: bun scripts/sync-report-notes.ts [metadata-dir] [db-path]
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { reportNotes } from "./pipeline/notes";
import type { Jurisdiction } from "./pipeline/types";

const metaDir = process.argv[2] || "report_pipeline/election-metadata";
const dbPath = process.argv[3] || "report_pipeline/reports.sqlite3";

function* metadataFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* metadataFiles(p);
    else if (name.endsWith(".json")) yield p;
  }
}

const db = new Database(dbPath);
const columns = db.query("PRAGMA table_info(reports)").all() as { name: string }[];
if (!columns.some((c) => c.name === "notes")) {
  db.exec("ALTER TABLE reports ADD COLUMN notes TEXT");
  console.log("Added reports.notes column");
}

const update = db.prepare(
  "UPDATE reports SET notes = $notes WHERE path = $path AND office = $office AND notes IS NOT $notes",
);
let changed = 0;
db.transaction(() => {
  for (const file of metadataFiles(metaDir)) {
    const jurisdiction: Jurisdiction = JSON.parse(readFileSync(file, "utf-8"));
    for (const [electionPath, election] of Object.entries(jurisdiction.elections ?? {})) {
      for (const contest of election.contests) {
        changed += update.run({
          $notes: reportNotes(election, contest),
          $path: `${jurisdiction.path}/${electionPath}`,
          $office: contest.office,
        }).changes;
      }
    }
  }
})();
console.log(`Updated notes on ${changed} reports`);
db.close();
