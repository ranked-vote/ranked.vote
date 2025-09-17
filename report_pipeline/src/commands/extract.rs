use crate::read_metadata::read_meta;
use colored::*;
use rusqlite::{params, Connection, Result as SqliteResult};
use std::path::Path;

/// Format file size in human-readable format (KB, MB, GB)
fn format_file_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

/// Extract all raw data files to SQLite databases using election metadata filtering
pub fn extract(raw_dir: &Path) {
    eprintln!("Extracting raw data files to SQLite databases using election metadata...");

    // Read election metadata to get the contests we care about
    let meta_dir = Path::new("election-metadata");
    let jurisdictions = read_meta(meta_dir);

    for (_, jurisdiction) in jurisdictions {
        let raw_base = raw_dir.join(&jurisdiction.path);

        for (election_path, election) in &jurisdiction.elections {
            eprintln!("Processing election: {} ({})", election_path, election.name);

            // Only process NIST SP 1500 elections
            if election.data_format == "nist_sp_1500" {
                for contest in &election.contests {
                    if let Some(loader_params) = &contest.loader_params {
                        if let (Some(contest_id), Some(cvr_file)) =
                            (loader_params.get("contest"), loader_params.get("cvr"))
                        {
                            let contest_id: u32 = contest_id.parse().unwrap();
                            let cvr_path = raw_base.join(election_path).join(cvr_file);

                            if cvr_path.exists() {
                                eprintln!("  Extracting contest {} from {}", contest_id, cvr_file);
                                extract_contest_to_database(&cvr_path, contest_id);
                            } else {
                                eprintln!("  ⚠️  CVR file not found: {}", cvr_path.display());
                            }
                        }
                    }
                }
            }
        }
    }

    eprintln!("Extraction complete!");
}

fn extract_contest_to_database(cvr_path: &Path, contest_id: u32) {
    eprintln!(
        "    Extracting: {} (contest {})",
        cvr_path.file_name().unwrap().to_string_lossy().green(),
        contest_id
    );

    // Create database path based on the CVR file
    let db_path = format!("{}.db", cvr_path.display());
    let mut conn = match Connection::open(&db_path) {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("    Failed to open database {}: {}", db_path, e);
            return;
        }
    };

    // Create schema
    if let Err(e) = create_extraction_schema(&conn) {
        eprintln!("    Failed to create schema: {}", e);
        return;
    }

    // Extract the contest using the proven logic
    if let Err(e) = extract_contest_using_proven_logic(cvr_path, contest_id, &mut conn) {
        eprintln!("    Failed to extract contest: {}", e);
        return;
    }

    eprintln!("    ✓ Extracted contest {} to {}", contest_id, db_path);
}

fn create_extraction_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS ballots (
            ballot_id TEXT,
            contest_id INTEGER,
            choices TEXT,  -- JSON array of candidate IDs in rank order
            overvoted BOOLEAN,
            PRIMARY KEY (ballot_id, contest_id)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_ballots_contest ON ballots(contest_id)",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS contests (
            contest_id INTEGER PRIMARY KEY,
            contest_name TEXT,
            election_id TEXT
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS candidates (
            candidate_id INTEGER PRIMARY KEY,
            candidate_name TEXT,
            contest_id INTEGER,
            candidate_type TEXT
        )",
        [],
    )?;

    Ok(())
}

fn extract_contest_using_proven_logic(
    cvr_path: &Path,
    contest_id: u32,
    conn: &mut Connection,
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::formats::nist_sp_1500::model::{CandidateManifest, CvrExport};
    use serde_json;
    use std::fs::File;
    use std::io::{BufReader, Read};
    use zip::ZipArchive;

    let file = File::open(cvr_path)?;
    let mut archive = ZipArchive::new(file)?;

    // Read candidate manifest
    let candidate_manifest: CandidateManifest = {
        let file = archive.by_name("CandidateManifest.json")?;
        let reader = BufReader::new(file);
        serde_json::from_reader(reader)?
    };

    // Store candidates for this contest only
    let mut candidate_stmt = conn.prepare(
        "INSERT OR REPLACE INTO candidates (candidate_id, candidate_name, contest_id, candidate_type) VALUES (?, ?, ?, ?)"
    )?;

    for candidate in &candidate_manifest.list {
        if candidate.contest_id == contest_id {
            let candidate_type = match candidate.candidate_type {
                crate::formats::nist_sp_1500::model::CandidateType::WriteIn => "WriteIn",
                crate::formats::nist_sp_1500::model::CandidateType::QualifiedWriteIn => {
                    "QualifiedWriteIn"
                }
                crate::formats::nist_sp_1500::model::CandidateType::Regular => "Regular",
            };

            candidate_stmt.execute(params![
                candidate.id,
                candidate.description,
                candidate.contest_id,
                candidate_type,
            ])?;
        }
    }

    // Store contest info
    let mut contest_stmt = conn.prepare(
        "INSERT OR REPLACE INTO contests (contest_id, contest_name, election_id) VALUES (?, ?, ?)",
    )?;

    contest_stmt.execute(params![
        contest_id,
        format!("Contest {}", contest_id),
        cvr_path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy(),
    ])?;

    // Find all CVR files
    let filenames: Vec<String> = archive.file_names().map(|d| d.to_string()).collect();
    let cvr_files: Vec<String> = filenames
        .into_iter()
        .filter(|filename| filename.starts_with("CvrExport"))
        .collect();

    eprintln!("      Found {} CVR files", cvr_files.len());

    // Process each CVR file using the proven get_ballots logic
    let mut ballot_stmt = conn.prepare(
        "INSERT OR REPLACE INTO ballots (ballot_id, contest_id, choices, overvoted) VALUES (?, ?, ?, ?)"
    )?;

    let mut total_ballots = 0;

    for (i, filename) in cvr_files.iter().enumerate() {
        eprintln!(
            "      Processing CVR file {}/{}: {}",
            i + 1,
            cvr_files.len(),
            filename
        );

        let mut file = archive.by_name(filename)?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;

        eprintln!(
            "        File size: {} ({})",
            format_file_size(data.len()),
            data.len()
        );
        eprintln!("        Parsing JSON...");

        let cvr: CvrExport = match serde_json::from_slice::<CvrExport>(&data) {
            Ok(cvr) => {
                eprintln!("        ✓ JSON parsed successfully");
                eprintln!("        Sessions: {}", cvr.sessions.len());

                // Count total contests across all sessions
                let total_contests: usize = cvr
                    .sessions
                    .iter()
                    .map(|session| session.contests().len())
                    .sum();
                eprintln!("        Total contests: {}", total_contests);

                // Count contests matching our target contest_id
                let matching_contests: usize = cvr
                    .sessions
                    .iter()
                    .map(|session| {
                        session
                            .contests()
                            .iter()
                            .filter(|contest| contest.id == contest_id)
                            .count()
                    })
                    .sum();
                eprintln!(
                    "        Matching contest {}: {} sessions",
                    contest_id, matching_contests
                );

                cvr
            }
            Err(e) => {
                eprintln!("        ⚠️  Failed to parse JSON: {}", e);
                continue;
            }
        };

        // Use the proven get_ballots logic - this is the key!
        // We need to create a CandidateMap for the get_ballots function
        use crate::formats::common::CandidateMap;
        use crate::model::election::{Candidate, CandidateType};

        let mut candidate_map: CandidateMap<u32> = CandidateMap::new();
        for candidate in &candidate_manifest.list {
            if candidate.contest_id == contest_id {
                let candidate_type = match candidate.candidate_type {
                    crate::formats::nist_sp_1500::model::CandidateType::WriteIn => {
                        CandidateType::WriteIn
                    }
                    crate::formats::nist_sp_1500::model::CandidateType::QualifiedWriteIn => {
                        CandidateType::QualifiedWriteIn
                    }
                    crate::formats::nist_sp_1500::model::CandidateType::Regular => {
                        CandidateType::Regular
                    }
                };
                candidate_map.add(
                    candidate.id,
                    Candidate::new(candidate.description.clone(), candidate_type),
                );
            }
        }

        let ballots = crate::formats::nist_sp_1500::get_ballots(
            &cvr,
            contest_id,
            &candidate_map,
            filename,
            None, // dropped_write_in
        );

        let ballot_count = ballots.len();

        // Store the ballots
        for ballot in ballots {
            // Convert choices to a simple format for storage
            let choices_data: Vec<String> = ballot
                .choices
                .iter()
                .map(|choice| match choice {
                    crate::model::election::Choice::Vote(candidate_id) => {
                        format!("vote:{}", candidate_id.0)
                    }
                    crate::model::election::Choice::Undervote => "undervote".to_string(),
                    crate::model::election::Choice::Overvote => "overvote".to_string(),
                })
                .collect();

            let choices_json = serde_json::to_string(&choices_data)?;
            let overvoted = ballot
                .choices
                .iter()
                .any(|c| matches!(c, crate::model::election::Choice::Overvote));

            ballot_stmt.execute(params![ballot.id, contest_id, choices_json, overvoted,])?;
            total_ballots += 1;
        }

        eprintln!(
            "        ✓ {} ballots for contest {}",
            ballot_count, contest_id
        );
    }

    eprintln!(
        "      ✓ Total: {} ballots for contest {} from {} CVR files",
        total_ballots,
        contest_id,
        cvr_files.len()
    );

    Ok(())
}

fn extract_zip_to_database(
    zip_path: &Path,
    conn: &mut Connection,
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::formats::nist_sp_1500::model::{CandidateManifest, CvrExport};
    use serde_json;
    use std::fs::File;
    use std::io::{BufReader, Read};
    use zip::ZipArchive;

    let file = File::open(zip_path)?;
    let mut archive = ZipArchive::new(file)?;

    // Read candidate manifest
    let candidate_manifest: CandidateManifest = {
        let file = archive.by_name("CandidateManifest.json")?;
        let reader = BufReader::new(file);
        serde_json::from_reader(reader)?
    };

    // Store candidates
    let mut candidate_stmt = conn.prepare(
        "INSERT OR REPLACE INTO candidates (candidate_id, candidate_name, contest_id, candidate_type) VALUES (?, ?, ?, ?)"
    )?;

    for candidate in &candidate_manifest.list {
        let candidate_type = match candidate.candidate_type {
            crate::formats::nist_sp_1500::model::CandidateType::WriteIn => "WriteIn",
            crate::formats::nist_sp_1500::model::CandidateType::QualifiedWriteIn => {
                "QualifiedWriteIn"
            }
            crate::formats::nist_sp_1500::model::CandidateType::Regular => "Regular",
        };

        candidate_stmt.execute(params![
            candidate.id,
            candidate.description,
            candidate.contest_id,
            candidate_type,
        ])?;
    }

    // Read contest manifest if it exists
    let contest_manifest = if let Ok(file) = archive.by_name("ContestManifest.json") {
        let reader = BufReader::new(file);
        Some(serde_json::from_reader::<_, serde_json::Value>(reader)?)
    } else {
        None
    };

    // Store contests
    let mut contest_stmt = conn.prepare(
        "INSERT OR REPLACE INTO contests (contest_id, contest_name, election_id) VALUES (?, ?, ?)",
    )?;

    if let Some(manifest) = contest_manifest {
        if let Some(contests) = manifest.get("List").and_then(|l| l.as_array()) {
            for contest in contests {
                if let (Some(id), Some(name)) = (
                    contest.get("Id").and_then(|i| i.as_u64()),
                    contest.get("Name").and_then(|n| n.as_str()),
                ) {
                    contest_stmt.execute(params![
                        id as i64,
                        name,
                        zip_path
                            .parent()
                            .unwrap()
                            .file_name()
                            .unwrap()
                            .to_string_lossy(),
                    ])?;
                }
            }
        }
    }

    // Find all CVR files
    let filenames: Vec<String> = archive.file_names().map(|d| d.to_string()).collect();
    let cvr_files: Vec<String> = filenames
        .into_iter()
        .filter(|filename| filename.starts_with("CvrExport"))
        .collect();

    eprintln!("      Found {} CVR files", cvr_files.len());

    // Process each CVR file using the proven logic from nist_ballot_reader
    let mut ballot_stmt = conn.prepare(
        "INSERT OR REPLACE INTO ballots (ballot_id, contest_id, choices, overvoted) VALUES (?, ?, ?, ?)"
    )?;

    let mut total_ballots = 0;
    let mut total_sessions = 0;

    for (i, filename) in cvr_files.iter().enumerate() {
        eprintln!(
            "      Processing CVR file {}/{}: {}",
            i + 1,
            cvr_files.len(),
            filename
        );

        let mut file = archive.by_name(filename)?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;

        eprintln!(
            "        File size: {} ({})",
            format_file_size(data.len()),
            data.len()
        );
        eprintln!("        Parsing JSON...");

        let cvr: CvrExport = match serde_json::from_slice::<CvrExport>(&data) {
            Ok(cvr) => {
                eprintln!("        ✓ JSON parsed successfully");
                cvr
            }
            Err(e) => {
                eprintln!("        ⚠️  Failed to parse JSON: {}", e);
                continue;
            }
        };

        let session_count = cvr.sessions.len();
        total_sessions += session_count;

        let mut file_ballots = 0;

        // Use the proven logic from the original nist_ballot_reader
        for (session_idx, session) in cvr.sessions.iter().enumerate() {
            if session_idx % 10000 == 0 {
                eprintln!(
                    "        Processing session {}/{}",
                    session_idx + 1,
                    session_count
                );
            }

            for contest_marks in session.contests() {
                let mut choices: Vec<u32> = Vec::new();

                // Group marks by rank (this is the proven logic from the original)
                let mut rank_groups: std::collections::HashMap<
                    u32,
                    Vec<&crate::formats::nist_sp_1500::model::Mark>,
                > = std::collections::HashMap::new();
                for mark in &contest_marks.marks {
                    if !mark.is_ambiguous {
                        rank_groups
                            .entry(mark.rank)
                            .or_insert_with(Vec::new)
                            .push(mark);
                    }
                }

                // Process each rank group (exactly like the original)
                for (_, marks) in &rank_groups {
                    let marks: Vec<&crate::formats::nist_sp_1500::model::Mark> =
                        marks.iter().cloned().collect();

                    match marks.as_slice() {
                        [mark] => {
                            choices.push(mark.candidate_id);
                        }
                        [] => {
                            // Undervote - no choice for this rank
                        }
                        _ => {
                            // Overvote - multiple choices for this rank
                            // Store as overvoted ballot
                            let ballot_id = format!("{}:{}", filename, session.record_id);
                            let choices_json = "[]".to_string();

                            ballot_stmt.execute(params![
                                ballot_id,
                                contest_marks.id,
                                choices_json,
                                true, // overvoted
                            ])?;
                            file_ballots += 1;
                            continue; // Skip to next contest
                        }
                    }
                }

                // Store the ballot if it has choices
                if !choices.is_empty() {
                    let ballot_id = format!("{}:{}", filename, session.record_id);
                    let choices_json = serde_json::to_string(&choices)?;

                    ballot_stmt.execute(params![
                        ballot_id,
                        contest_marks.id,
                        choices_json,
                        false, // not overvoted
                    ])?;
                    file_ballots += 1;
                }
            }
        }

        total_ballots += file_ballots;
        eprintln!(
            "        ✓ {} sessions, {} ballots",
            session_count, file_ballots
        );
    }

    eprintln!(
        "      ✓ Total: {} ballots from {} sessions across {} CVR files",
        total_ballots,
        total_sessions,
        cvr_files.len()
    );

    Ok(())
}
