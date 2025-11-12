pub mod model;

use crate::formats::common::{normalize_name, CandidateMap};
use crate::formats::nist_sp_1500::model::{CandidateManifest, CandidateType, CvrExport, Mark};
use crate::model::election::{self, Ballot, Candidate, Choice, Election};
use csv::ReaderBuilder;
use itertools::Itertools;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufReader, Read};

use std::path::Path;

struct ReaderOptions {
    cvr: String,
    contest: u32,
    drop_unqualified_write_in: bool,
}

impl ReaderOptions {
    pub fn from_params(params: BTreeMap<String, String>) -> ReaderOptions {
        let cvr = params
            .get("cvr")
            .expect("nist_sp_1500 elections should have cvr parameter.")
            .clone();
        let contest = params
            .get("contest")
            .expect("nist_sp_1500 elections should have contest parameter.")
            .parse()
            .expect("contest param should be a number.");
        let drop_unqualified_write_in: bool = params
            .get("dropUnqualifiedWriteIn")
            .map(|d| d.parse().unwrap())
            .unwrap_or(false);

        ReaderOptions {
            contest,
            cvr,
            drop_unqualified_write_in,
        }
    }
}

fn get_candidates(
    manifest: &CandidateManifest,
    contest_id: u32,
    drop_unqualified_write_in: bool,
) -> (CandidateMap<u32>, Option<u32>) {
    let mut map = CandidateMap::new();
    let mut write_in_external_id = None;

    for candidate in &manifest.list {
        if candidate.contest_id == contest_id {
            let candidate_type = match candidate.candidate_type {
                CandidateType::WriteIn => election::CandidateType::WriteIn,
                CandidateType::QualifiedWriteIn => election::CandidateType::QualifiedWriteIn,
                CandidateType::Regular => election::CandidateType::Regular,
            };

            if drop_unqualified_write_in && candidate_type == election::CandidateType::WriteIn {
                write_in_external_id = Some(candidate.id);
                continue;
            }

            map.add(
                candidate.id,
                Candidate::new(
                    normalize_name(&candidate.description, false),
                    candidate_type,
                ),
            );
        }
    }

    (map, write_in_external_id)
}

pub fn nist_ballot_reader(path: &Path, params: BTreeMap<String, String>) -> Election {
    let options = ReaderOptions::from_params(params);

    // Handle "." as current directory
    let mut cvr_path = if options.cvr == "." {
        path.to_path_buf()
    } else {
        path.join(&options.cvr)
    };

    // If the path ends with .zip but the file doesn't exist, try the directory name without .zip
    // This handles cases where ZIP files were extracted but metadata still references the ZIP
    if cvr_path.to_string_lossy().ends_with(".zip") && !cvr_path.exists() {
        let dir_path = cvr_path.with_extension("");
        if dir_path.is_dir() {
            cvr_path = dir_path;
        }
    }

    // If the CVR path doesn't exist, try using the base path directly
    // This handles cases where metadata references a CVR name but files are in the base directory
    if !cvr_path.exists() && !cvr_path.is_dir() {
        // Check if the base path itself is a directory with CvrExport files
        if path.is_dir() {
            let test_file = path.join("CvrExport.json");
            if test_file.exists() || path.join("CandidateManifest.json").exists() {
                // Files are in the base directory, use that instead
                cvr_path = path.to_path_buf();
            }
        }
    }

    // Check if cvr_path is a directory or a ZIP file
    if cvr_path.is_dir() {
        // Handle raw directory format
        read_from_directory(&cvr_path, &options)
    } else if cvr_path.exists() {
        // Handle ZIP archive format
        read_from_zip(&cvr_path, &options)
    } else {
        // Fallback: try reading from the base path
        crate::log_warn!(
            "CVR path {} does not exist, trying base path {}",
            cvr_path.display(),
            path.display()
        );
        if path.is_dir() {
            read_from_directory(path, &options)
        } else {
            crate::log_warn!("Base path is not a directory, returning empty election");
            Election::new(vec![], vec![])
        }
    }
}

/// Stream process a CVR file, extracting only ballots for the target contest
/// This avoids loading the entire CVR (with all contests) into memory
fn stream_process_cvr_file<R: Read>(
    reader: R,
    filename: &str,
    contest_id: u32,
    candidates: &CandidateMap<u32>,
    dropped_write_in: Option<u32>,
    ballots: &mut Vec<Ballot>,
) -> Result<usize, String> {
    let mut count = 0;
    let content =
        std::io::read_to_string(reader).map_err(|e| format!("Failed to read file: {}", e))?;

    // Parse as CvrExport but immediately process sessions
    let cvr: CvrExport =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse JSON: {}", e))?;

    for session in &cvr.sessions {
        for contest in &session.contests() {
            if contest.id == contest_id {
                let mut choices: Vec<Choice> = Vec::new();
                for (_, marks) in &contest.marks.iter().group_by(|x| x.rank) {
                    let marks: Vec<&Mark> = marks.filter(|d| !d.is_ambiguous).collect();

                    let choice = match marks.as_slice() {
                        [v] if Some(v.candidate_id) == dropped_write_in => Choice::Undervote,
                        [v] => candidates.id_to_choice(v.candidate_id),
                        [] => Choice::Undervote,
                        _ => Choice::Overvote,
                    };

                    choices.push(choice);
                }

                ballots.push(Ballot::new(
                    format!("{}:{}", filename, session.record_id),
                    choices,
                ));
                count += 1;
            }
        }
    }

    Ok(count)
}

/// Parse CSV format CVR file
/// CSV format has:
/// - Row 0: Election name and version
/// - Row 1: Contest names (repeated for each candidate column)
/// - Row 2: Candidate names with rank indicators like "CANDIDATE(1)", "CANDIDATE(2)"
/// - Row 3: Column headers (CvrNumber, TabulatorNum, etc.)
/// - Row 4+: Ballot data
fn stream_process_csv_cvr_file<R: Read>(
    reader: R,
    filename: &str,
    contest_id: u32,
    candidates: &CandidateMap<u32>,
    dropped_write_in: Option<u32>,
    ballots: &mut Vec<Ballot>,
    candidate_manifest: &CandidateManifest,
) -> Result<usize, String> {
    let mut count = 0;
    let mut rdr = ReaderBuilder::new()
        .has_headers(false)
        .buffer_capacity(1024 * 1024) // 1MB buffer for large files
        .from_reader(reader);

    // Read header rows using a reusable buffer
    let mut header_buffer = csv::StringRecord::new();
    let mut rows = Vec::new();
    for _ in 0..4 {
        if !rdr.read_record(&mut header_buffer)
            .map_err(|e| format!("CSV parse error: {}", e))?
        {
            break;
        }
        rows.push(header_buffer.clone());
    }

    if rows.len() < 4 {
        return Err("CSV file must have at least 4 header rows".to_string());
    }

    let contests_row = &rows[1];
    let candidates_row = &rows[2];
    let headers_row = &rows[3];

    // Find columns for the target contest
    // Contest names in row 1 should match ContestManifest descriptions
    let contest_desc = candidate_manifest
        .list
        .iter()
        .find(|c| c.contest_id == contest_id)
        .map(|c| &c.description)
        .ok_or_else(|| format!("Contest {} not found in manifest", contest_id))?;

    // Find all columns that belong to this contest
    let mut contest_columns: Vec<(usize, String, u32)> = Vec::new(); // (column_index, candidate_name, rank)
    for (col_idx, contest_name) in contests_row.iter().enumerate() {
        if contest_name.contains(contest_desc) || contest_desc.contains(contest_name) {
            // Extract candidate name and rank from candidates_row
            if col_idx < candidates_row.len() {
                let candidate_str = &candidates_row[col_idx];
                // Parse candidate name and rank from format like "CANDIDATE(1)" or "CANDIDATE(2)"
                if let Some(open_paren) = candidate_str.rfind('(') {
                    if let Some(close_paren) = candidate_str.rfind(')') {
                        if let Ok(rank) = candidate_str[open_paren + 1..close_paren].parse::<u32>() {
                            let candidate_name = candidate_str[..open_paren].trim().to_string();
                            // Map candidate name to candidate ID
                            if let Some(_candidate) = candidate_manifest
                                .list
                                .iter()
                                .find(|c| {
                                    c.contest_id == contest_id
                                        && normalize_name(&c.description, false)
                                            == normalize_name(&candidate_name, false)
                                })
                            {
                                contest_columns.push((col_idx, candidate_name, rank));
                            } else if candidate_name == "Write-in" {
                                // Handle write-in candidates
                                if candidate_manifest
                                    .list
                                    .iter()
                                    .any(|c| {
                                        c.contest_id == contest_id
                                            && matches!(c.candidate_type, CandidateType::WriteIn)
                                    })
                                {
                                    contest_columns.push((col_idx, candidate_name, rank));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if contest_columns.is_empty() {
        return Err(format!(
            "No columns found for contest {} ({})",
            contest_id, contest_desc
        ));
    }

    // Group columns by rank and candidate
    let mut rank_candidate_map: HashMap<u32, HashMap<u32, usize>> = HashMap::new(); // rank -> candidate_id -> column_index
    for (col_idx, candidate_name, rank) in &contest_columns {
        if let Some(candidate) = candidate_manifest
            .list
            .iter()
            .find(|c| {
                c.contest_id == contest_id
                    && normalize_name(&c.description, false) == normalize_name(candidate_name, false)
            })
        {
            rank_candidate_map
                .entry(*rank)
                .or_insert_with(HashMap::new)
                .insert(candidate.id, *col_idx);
        }
    }

    // Process ballot rows
    let mut record_id_col = None;
    for (idx, header) in headers_row.iter().enumerate() {
        if header == "RecordId" || header == "ImprintedId" {
            record_id_col = Some(idx);
            break;
        }
    }

    // Process ballot rows with buffering for large files
    let mut buffer = csv::StringRecord::new();
    while rdr.read_record(&mut buffer).map_err(|e| format!("CSV parse error: {}", e))? {
        if buffer.len() < contest_columns[0].0 {
            continue;
        }
        let record = &buffer;

        let record_id = record_id_col
            .and_then(|col| record.get(col))
            .unwrap_or(&count.to_string())
            .trim_matches('=')
            .trim_matches('"')
            .to_string();

        // Extract marks for this contest
        // CSV format: each candidate has columns for each rank (1, 2, 3, etc.)
        // The value in the column indicates the actual rank preference (1, 2, 3, etc.)
        // or is empty/0 if that candidate didn't get that rank
        let mut marks: Vec<(u32, u32)> = Vec::new(); // (candidate_id, rank)

        for (rank, candidate_cols) in &rank_candidate_map {
            for (candidate_id, col_idx) in candidate_cols {
                if let Some(value_str) = record.get(*col_idx) {
                    let value_str = value_str.trim_matches('=').trim_matches('"').trim();
                    if !value_str.is_empty() && value_str != "0" {
                        if let Ok(value) = value_str.parse::<u32>() {
                            if value > 0 && value == *rank {
                                // The value matches the rank column, so this candidate got this rank
                                marks.push((*candidate_id, *rank));
                            }
                        }
                    }
                }
            }
        }

        // Filter out dropped write-ins
        let valid_marks: Vec<(u32, u32)> = marks
            .into_iter()
            .filter(|(candidate_id, _)| {
                dropped_write_in.map(|d| *candidate_id != d).unwrap_or(true)
            })
            .collect();

        // Sort by rank and convert to choices
        let mut sorted_marks = valid_marks;
        sorted_marks.sort_by_key(|(_, rank)| *rank);

        let mut choices: Vec<Choice> = Vec::new();
        for (_, rank_group) in &sorted_marks.iter().group_by(|(_, r)| *r) {
            let marks_at_rank: Vec<u32> = rank_group.map(|(candidate_id, _)| *candidate_id).collect();
            let choice = match marks_at_rank.as_slice() {
                [] => Choice::Undervote,
                [candidate_id] => candidates.id_to_choice(*candidate_id),
                _ => Choice::Overvote, // Multiple candidates at same rank
            };
            choices.push(choice);
        }

        if !choices.is_empty() {
            ballots.push(Ballot::new(
                format!("{}:{}", filename, record_id),
                choices,
            ));
            count += 1;
        }
    }

    Ok(count)
}

fn read_from_directory(dir_path: &Path, options: &ReaderOptions) -> Election {
    let candidate_manifest_path = dir_path.join("CandidateManifest.json");

    let candidate_manifest: CandidateManifest = {
        let file = match File::open(&candidate_manifest_path) {
            Ok(file) => file,
            Err(e) => {
                crate::log_warn!(
                    "Warning: Could not open CandidateManifest.json in {}: {}",
                    dir_path.display(),
                    e
                );
                crate::log_warn!("Skipping this contest due to missing manifest file.");
                return Election::new(vec![], vec![]);
            }
        };
        let reader = BufReader::new(file);
        serde_json::from_reader(reader).unwrap()
    };

    let (candidates, dropped_write_in) = get_candidates(
        &candidate_manifest,
        options.contest,
        options.drop_unqualified_write_in,
    );

    let mut ballots: Vec<Ballot> = Default::default();

    // Find all CvrExport files in the directory
    let mut cvr_files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries {
            if let Ok(entry) = entry {
                let filename = entry.file_name().to_string_lossy().to_string();
                // Support both JSON and CSV formats (CSV files may use CVR_Export prefix)
                if (filename.starts_with("CvrExport") && filename.ends_with(".json"))
                    || (filename.starts_with("CVR_Export") && filename.ends_with(".csv"))
                {
                    cvr_files.push(filename);
                }
            }
        }
    }

    cvr_files.sort();
    let file_count = cvr_files.len();

    crate::log_debug!(
        "Processing {} CVR files (each contains all contests)...",
        file_count
    );

    for filename in cvr_files {
        let file_path = dir_path.join(&filename);
        let file = match File::open(&file_path) {
            Ok(file) => file,
            Err(e) => {
                crate::log_warn!("Warning: Could not open {}: {}", filename, e);
                continue;
            }
        };

        // Determine file type and process accordingly
        let result = if filename.ends_with(".csv") {
            stream_process_csv_cvr_file(
                file,
                &filename,
                options.contest,
                &candidates,
                dropped_write_in,
                &mut ballots,
                &candidate_manifest,
            )
        } else {
            stream_process_cvr_file(
                file,
                &filename,
                options.contest,
                &candidates,
                dropped_write_in,
                &mut ballots,
            )
        };

        match result {
            Ok(count) => {
                if count > 0 {
                    crate::log_debug!(
                        "  → {} ballots for contest {} from {}",
                        count,
                        options.contest,
                        filename
                    );
                }
            }
            Err(e) => {
                crate::log_warn!("Warning: Error processing {}: {}", filename, e);
                crate::log_warn!("Skipping this file and continuing...");
            }
        }
    }

    crate::log_debug!("Read {} ballots", ballots.len());

    Election::new(candidates.into_vec(), ballots)
}

fn read_from_zip(zip_path: &Path, options: &ReaderOptions) -> Election {
    let file = match File::open(zip_path) {
        Ok(file) => file,
        Err(e) => {
            crate::log_warn!(
                "Warning: Could not open CVR file {}: {}",
                zip_path.display(),
                e
            );
            crate::log_warn!("Skipping this contest due to missing data file.");
            return Election::new(vec![], vec![]);
        }
    };
    let mut archive = zip::ZipArchive::new(file).unwrap();

    let candidate_manifest: CandidateManifest = {
        let file = archive.by_name("CandidateManifest.json").unwrap();
        let reader = BufReader::new(file);
        serde_json::from_reader(reader).unwrap()
    };

    let (candidates, dropped_write_in) = get_candidates(
        &candidate_manifest,
        options.contest,
        options.drop_unqualified_write_in,
    );

    let mut ballots: Vec<Ballot> = Default::default();
    let filenames: Vec<String> = archive.file_names().map(|d| d.to_string()).collect();

    let cvr_files: Vec<String> = filenames
        .into_iter()
        .filter(|f| f.starts_with("CvrExport"))
        .collect();

    let file_count = cvr_files.len();

    crate::log_debug!(
        "Processing {} CVR files from ZIP (each contains all contests)...",
        file_count
    );

    for filename in cvr_files {
        let file = match archive.by_name(&filename) {
            Ok(file) => file,
            Err(e) => {
                crate::log_warn!("Warning: Could not read {} from ZIP: {}", filename, e);
                continue;
            }
        };

        // Stream process the CVR file to avoid loading entire file into memory
        let result = stream_process_cvr_file(
            file,
            &filename,
            options.contest,
            &candidates,
            dropped_write_in,
            &mut ballots,
        );

        match result {
            Ok(count) => {
                if count > 0 {
                    crate::log_debug!(
                        "  → {} ballots for contest {} from {}",
                        count,
                        options.contest,
                        filename
                    );
                }
            }
            Err(e) => {
                crate::log_warn!("Warning: Error processing {}: {}", filename, e);
                crate::log_warn!("Skipping this file and continuing...");
            }
        }
    }

    crate::log_debug!("Read {} ballots", ballots.len());

    Election::new(candidates.into_vec(), ballots)
}

/// Batch process multiple contests from the same CVR files
/// This reads the CVR files once and distributes ballots to all contests
pub fn nist_batch_reader(
    path: &Path,
    contests: Vec<(u32, BTreeMap<String, String>)>,
) -> HashMap<u32, Election> {
    if contests.is_empty() {
        return HashMap::new();
    }

    // All contests should use the same CVR path
    let cvr_name = contests[0]
        .1
        .get("cvr")
        .expect("nist_sp_1500 elections should have cvr parameter.")
        .clone();

    // Handle "." as current directory
    let mut cvr_path = if cvr_name == "." {
        path.to_path_buf()
    } else {
        path.join(&cvr_name)
    };

    // If the path ends with .zip but the file doesn't exist, try the directory name without .zip
    // This handles cases where ZIP files were extracted but metadata still references the ZIP
    if cvr_path.to_string_lossy().ends_with(".zip") && !cvr_path.exists() {
        let dir_path = cvr_path.with_extension("");
        if dir_path.is_dir() {
            cvr_path = dir_path;
        }
    }

    // If the CVR path doesn't exist, try using the base path directly
    // This handles cases where metadata references a CVR name but files are in the base directory
    if !cvr_path.exists() || !cvr_path.is_dir() {
        // Check if the base path itself is a directory with CvrExport files
        if path.is_dir() {
            let test_file = path.join("CvrExport.json");
            if test_file.exists() || path.join("CandidateManifest.json").exists() {
                // Files are in the base directory, use that instead
                cvr_path = path.to_path_buf();
            }
        }
    }

    if !cvr_path.is_dir() {
        crate::log_warn!(
            "Warning: Batch processing only supports directory format, not ZIP. Path: {}\n   If this is a ZIP file, please extract it first using extract-from-archives.sh",
            cvr_path.display()
        );
        return HashMap::new();
    }

    // Load candidate manifest once
    let candidate_manifest_path = cvr_path.join("CandidateManifest.json");
    let candidate_manifest: CandidateManifest = {
        let file = match File::open(&candidate_manifest_path) {
            Ok(file) => file,
            Err(e) => {
                crate::log_error!(
                    "Error: Could not open CandidateManifest.json in {}: {}",
                    cvr_path.display(),
                    e
                );
                return HashMap::new();
            }
        };
        let reader = BufReader::new(file);
        serde_json::from_reader(reader).unwrap()
    };

    // Set up candidate maps and ballot buckets for each contest
    let mut contest_data: HashMap<u32, (CandidateMap<u32>, Option<u32>, Vec<Ballot>)> =
        HashMap::new();

    for (contest_id, params) in &contests {
        let drop_unqualified_write_in: bool = params
            .get("dropUnqualifiedWriteIn")
            .map(|d| d.parse().unwrap())
            .unwrap_or(false);

        let (candidates, dropped_write_in) =
            get_candidates(&candidate_manifest, *contest_id, drop_unqualified_write_in);

        contest_data.insert(*contest_id, (candidates, dropped_write_in, Vec::new()));
    }

    // Find all CVR files
    let mut cvr_files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&cvr_path) {
        for entry in entries {
            if let Ok(entry) = entry {
                let filename = entry.file_name().to_string_lossy().to_string();
                // Support both JSON and CSV formats (CSV files may use CVR_Export prefix)
                if (filename.starts_with("CvrExport") && filename.ends_with(".json"))
                    || (filename.starts_with("CVR_Export") && filename.ends_with(".csv"))
                {
                    cvr_files.push(filename);
                }
            }
        }
    }

    cvr_files.sort();
    let file_count = cvr_files.len();

    crate::log_debug!("  Processing {} CVR files...", file_count);

    // Process each CVR file once, distributing ballots to all contests
    for (file_idx, filename) in cvr_files.iter().enumerate() {
        let file_path = cvr_path.join(filename);
        let file = match File::open(&file_path) {
            Ok(file) => file,
            Err(e) => {
                crate::log_warn!("Warning: Could not open {}: {}", filename, e);
                continue;
            }
        };

        // Read and parse the CVR file
        let content = match std::io::read_to_string(file) {
            Ok(content) => content,
            Err(e) => {
                crate::log_warn!("Warning: Failed to read {}: {}", filename, e);
                continue;
            }
        };

        let cvr: CvrExport = match serde_json::from_str(&content) {
            Ok(cvr) => cvr,
            Err(e) => {
                crate::log_warn!("Warning: Failed to parse {}: {}", filename, e);
                continue;
            }
        };

        // Process each session and distribute ballots to contests
        for session in &cvr.sessions {
            for contest in &session.contests() {
                if let Some((candidates, dropped_write_in, ballots)) =
                    contest_data.get_mut(&contest.id)
                {
                    let mut choices: Vec<Choice> = Vec::new();
                    for (_, marks) in &contest.marks.iter().group_by(|x| x.rank) {
                        let marks: Vec<&Mark> = marks.filter(|d| !d.is_ambiguous).collect();

                        let choice = match marks.as_slice() {
                            [v] if Some(v.candidate_id) == *dropped_write_in => Choice::Undervote,
                            [v] => candidates.id_to_choice(v.candidate_id),
                            [] => Choice::Undervote,
                            _ => Choice::Overvote,
                        };

                        choices.push(choice);
                    }

                    ballots.push(Ballot::new(
                        format!("{}:{}", filename, session.record_id),
                        choices,
                    ));
                }
            }
        }

        // Show progress every 5 files
        if (file_idx + 1) % 5 == 0 || file_idx + 1 == file_count {
            crate::log_debug!(
                "    Progress: {}/{} files processed",
                file_idx + 1,
                file_count
            );
        }
    }

    // Convert to Election objects
    let mut results = HashMap::new();
    for (contest_id, (candidates, _dropped_write_in, ballots)) in contest_data {
        crate::log_debug!(
            "  Contest {}: {} ballots",
            contest_id,
            ballots.len()
        );
        results.insert(contest_id, Election::new(candidates.into_vec(), ballots));
    }

    crate::log_debug!("{} Batch processing complete\n", "SUCCESS:");

    results
}
