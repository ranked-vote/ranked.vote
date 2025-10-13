pub mod model;

use crate::formats::common::{normalize_name, CandidateMap};
use crate::formats::nist_sp_1500::model::{CandidateManifest, CandidateType, CvrExport, Mark};
use crate::model::election::{self, Ballot, Candidate, Choice, Election};
use colored::*;
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

    let cvr_path = path.join(&options.cvr);

    // Check if cvr_path is a directory or a ZIP file
    if cvr_path.is_dir() {
        // Handle raw directory format
        read_from_directory(&cvr_path, &options)
    } else {
        // Handle ZIP archive format
        read_from_zip(&cvr_path, &options)
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

fn read_from_directory(dir_path: &Path, options: &ReaderOptions) -> Election {
    let candidate_manifest_path = dir_path.join("CandidateManifest.json");

    let candidate_manifest: CandidateManifest = {
        let file = match File::open(&candidate_manifest_path) {
            Ok(file) => file,
            Err(e) => {
                eprintln!(
                    "Warning: Could not open CandidateManifest.json in {}: {}",
                    dir_path.display(),
                    e
                );
                eprintln!("Skipping this contest due to missing manifest file.");
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
                if filename.starts_with("CvrExport") && filename.ends_with(".json") {
                    cvr_files.push(filename);
                }
            }
        }
    }

    cvr_files.sort();
    let file_count = cvr_files.len();

    eprintln!(
        "Processing {} CVR files (each contains all contests)...",
        file_count
    );

    for filename in cvr_files {
        let file_path = dir_path.join(&filename);
        let file = match File::open(&file_path) {
            Ok(file) => file,
            Err(e) => {
                eprintln!("Warning: Could not open {}: {}", filename, e);
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
                    eprintln!(
                        "  → {} ballots for contest {} from {}",
                        count.to_string().cyan(),
                        options.contest,
                        filename.green()
                    );
                }
            }
            Err(e) => {
                eprintln!("Warning: Error processing {}: {}", filename.yellow(), e);
                eprintln!("Skipping this file and continuing...");
            }
        }
    }

    eprintln!("Read {} ballots", ballots.len().to_string().blue());

    Election::new(candidates.into_vec(), ballots)
}

fn read_from_zip(zip_path: &Path, options: &ReaderOptions) -> Election {
    let file = match File::open(zip_path) {
        Ok(file) => file,
        Err(e) => {
            eprintln!(
                "Warning: Could not open CVR file {}: {}",
                zip_path.display(),
                e
            );
            eprintln!("Skipping this contest due to missing data file.");
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

    eprintln!(
        "Processing {} CVR files from ZIP (each contains all contests)...",
        file_count
    );

    for filename in cvr_files {
        let file = match archive.by_name(&filename) {
            Ok(file) => file,
            Err(e) => {
                eprintln!("Warning: Could not read {} from ZIP: {}", filename, e);
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
                    eprintln!(
                        "  → {} ballots for contest {} from {}",
                        count.to_string().cyan(),
                        options.contest,
                        filename.green()
                    );
                }
            }
            Err(e) => {
                eprintln!("Warning: Error processing {}: {}", filename.yellow(), e);
                eprintln!("Skipping this file and continuing...");
            }
        }
    }

    eprintln!("Read {} ballots", ballots.len().to_string().blue());

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

    let cvr_path = path.join(&cvr_name);

    if !cvr_path.is_dir() {
        eprintln!(
            "Error: Batch processing only supports directory format, not ZIP. Path: {}",
            cvr_path.display()
        );
        return HashMap::new();
    }

    eprintln!(
        "\n{} Batch processing {} contests from {} CVR files",
        "OPTIMIZED:".green().bold(),
        contests.len().to_string().cyan(),
        cvr_name.yellow()
    );

    // Load candidate manifest once
    let candidate_manifest_path = cvr_path.join("CandidateManifest.json");
    let candidate_manifest: CandidateManifest = {
        let file = match File::open(&candidate_manifest_path) {
            Ok(file) => file,
            Err(e) => {
                eprintln!(
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
                if filename.starts_with("CvrExport") && filename.ends_with(".json") {
                    cvr_files.push(filename);
                }
            }
        }
    }

    cvr_files.sort();
    let file_count = cvr_files.len();

    eprintln!("  Processing {} CVR files...", file_count);

    // Process each CVR file once, distributing ballots to all contests
    for (file_idx, filename) in cvr_files.iter().enumerate() {
        let file_path = cvr_path.join(filename);
        let file = match File::open(&file_path) {
            Ok(file) => file,
            Err(e) => {
                eprintln!("Warning: Could not open {}: {}", filename, e);
                continue;
            }
        };

        // Read and parse the CVR file
        let content = match std::io::read_to_string(file) {
            Ok(content) => content,
            Err(e) => {
                eprintln!("Warning: Failed to read {}: {}", filename, e);
                continue;
            }
        };

        let cvr: CvrExport = match serde_json::from_str(&content) {
            Ok(cvr) => cvr,
            Err(e) => {
                eprintln!("Warning: Failed to parse {}: {}", filename, e);
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
            eprintln!(
                "    Progress: {}/{} files processed",
                (file_idx + 1).to_string().cyan(),
                file_count
            );
        }
    }

    // Convert to Election objects
    let mut results = HashMap::new();
    for (contest_id, (candidates, _dropped_write_in, ballots)) in contest_data {
        eprintln!(
            "  Contest {}: {} ballots",
            contest_id.to_string().yellow(),
            ballots.len().to_string().cyan()
        );
        results.insert(contest_id, Election::new(candidates.into_vec(), ballots));
    }

    eprintln!("{} Batch processing complete\n", "SUCCESS:".green().bold());

    results
}
