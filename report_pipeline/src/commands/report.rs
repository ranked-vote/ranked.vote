use crate::model::election::ElectionPreprocessed;
use crate::model::metadata::{Contest, ElectionMetadata, Jurisdiction};
use crate::model::report::{ContestIndexEntry, ContestReport, ElectionIndexEntry, ReportIndex};
use crate::read_metadata::read_meta;
use crate::report::{generate_report, preprocess_election};
use crate::util::{read_serialized, write_serialized};
use crate::{log_debug, log_info, log_race, log_warn};
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs::{create_dir_all, read_dir};
use std::path::{Path, PathBuf};

/// Processing context containing paths and options
struct ProcessingContext<'a> {
    raw_base: &'a Path,
    report_dir: &'a Path,
    preprocessed_dir: &'a Path,
    force_preprocess: bool,
    force_report: bool,
}

/// Check if a candidate name is a write-in (handles "Write-in", "Write in", "Undeclared Write-ins", "UWI", etc.)
fn is_write_in_by_name(name: &str) -> bool {
    let normalized = name.to_lowercase();
    normalized == "write-in"
        || normalized == "write in"
        || normalized == "undeclared write-ins"
        || normalized == "uwi"
}

/// Process a single contest and return the ContestIndexEntry
fn process_contest(
    contest: &Contest,
    election: &ElectionMetadata,
    election_path: &str,
    jurisdiction: &Jurisdiction,
    ctx: &ProcessingContext,
) -> ContestIndexEntry {
    let office = jurisdiction
        .offices
        .get(&contest.office)
        .unwrap_or_else(|| panic!("Expected office {} to be in offices.", &contest.office));
    log_race!(&jurisdiction.name, &election.name, &office.name);

    let report_path = ctx
        .report_dir
        .join(&jurisdiction.path)
        .join(election_path)
        .join(&contest.office)
        .join("report.json");
    let preprocessed_path = ctx
        .preprocessed_dir
        .join(&jurisdiction.path)
        .join(election_path)
        .join(&contest.office)
        .join("normalized.json.gz");

    let report = if report_path.exists()
        && preprocessed_path.exists()
        && !ctx.force_report
        && !ctx.force_preprocess
    {
        log_debug!(
            "Skipping because {} exists. Use --force-report to regenerate.",
            report_path.to_str().unwrap()
        );
        read_serialized(&report_path)
    } else {
        create_dir_all(report_path.parent().unwrap()).unwrap();

        let preprocessed: ElectionPreprocessed = if preprocessed_path.exists()
            && !ctx.force_preprocess
        {
            log_debug!(
                "Loading preprocessed {}.",
                preprocessed_path.to_str().unwrap()
            );
            read_serialized(&preprocessed_path)
        } else {
            create_dir_all(preprocessed_path.parent().unwrap()).unwrap();

            log_debug!(
                "Generating preprocessed {}.",
                preprocessed_path.to_str().unwrap()
            );
            let preprocessed =
                preprocess_election(ctx.raw_base, election, election_path, jurisdiction, contest);
            write_serialized(&preprocessed_path, &preprocessed);
            log_debug!("Processed {} ballots", preprocessed.ballots.ballots.len());
            preprocessed
        };

        log_debug!("Generating report...");
        let contest_report = generate_report(&preprocessed);

        log_debug!("Writing report to disk...");
        write_serialized(&report_path, &contest_report);
        log_debug!("Report written successfully.");

        // Explicitly drop preprocessed data to free memory before next contest
        drop(preprocessed);

        contest_report
    };

    // Check if any candidate is named "Write-in" or "Write in" (case-insensitive)
    let has_write_in_by_name = report
        .candidates
        .iter()
        .any(|c| is_write_in_by_name(&c.name));

    // Extract just the index data we need
    let index_entry = ContestIndexEntry {
        office: report.info.office.clone(),
        office_name: report.info.office_name.clone(),
        name: report.info.name.clone(),
        winner: report
            .winner()
            .map(|w| w.name.clone())
            .unwrap_or_else(|| "No Winner".to_string()),
        num_candidates: report.num_candidates,
        num_rounds: report.rounds.len() as u32,
        condorcet_winner: report
            .condorcet
            .map(|c| report.candidates[c.0 as usize].name.clone()),
        has_non_condorcet_winner: report.condorcet != report.winner,
        has_write_in_by_name,
    };

    // Drop the full report to free memory
    drop(report);

    index_entry
}

/// Process a NYC election with batch optimization
fn process_nyc_election_batch(
    election_path: &str,
    election: &ElectionMetadata,
    jurisdiction: &Jurisdiction,
    ctx: &ProcessingContext,
) -> Vec<ContestIndexEntry> {
    use crate::formats::nyc_batch_reader;

    // raw_base is the jurisdiction path, need to add election_path
    let raw_path = ctx.raw_base.join(election_path);

    // Prepare contest data for batch processing
    let contests_with_offices: Vec<(String, std::collections::BTreeMap<String, String>)> = election
        .contests
        .iter()
        .filter_map(|contest| {
            let params = contest.loader_params.clone()?;
            Some((contest.office.clone(), params))
        })
        .collect();

    // Batch read all contests at once
    let mut elections_by_office = nyc_batch_reader(&raw_path, contests_with_offices);

    // Now process each contest using the pre-loaded election data
    election
        .contests
        .iter()
        .filter_map(|contest| {
            let office = jurisdiction
                .offices
                .get(&contest.office)
                .unwrap_or_else(|| panic!("Expected office {} to be in offices.", &contest.office));
            log_race!(&jurisdiction.name, &election.name, &office.name);

            let report_path = ctx
                .report_dir
                .join(&jurisdiction.path)
                .join(election_path)
                .join(&contest.office)
                .join("report.json");

            let preprocessed_path = ctx
                .preprocessed_dir
                .join(&jurisdiction.path)
                .join(election_path)
                .join(&contest.office)
                .join("normalized.json.gz");

            create_dir_all(report_path.parent().unwrap()).unwrap();
            create_dir_all(preprocessed_path.parent().unwrap()).unwrap();

            // Take ownership of the election data from batch results
            let raw_election = elections_by_office.remove(&contest.office)?;

            // Preprocess with the loaded election data
            let preprocessed = if ctx.force_preprocess || !preprocessed_path.exists() {
                let preprocessed = crate::report::preprocess_election_from_data(
                    raw_election,
                    election,
                    jurisdiction,
                    contest,
                    election_path,
                );
                write_serialized(&preprocessed_path, &preprocessed);
                log_debug!("Processed {} ballots", preprocessed.ballots.ballots.len());
                preprocessed
            } else {
                log_debug!(
                    "Reading cached preprocessed {}",
                    preprocessed_path.display()
                );
                read_serialized(&preprocessed_path)
            };

            // Generate report
            let report = if ctx.force_report || !report_path.exists() {
                log_debug!("Generating report...");
                let contest_report = generate_report(&preprocessed);
                log_debug!("Writing report to disk...");
                write_serialized(&report_path, &contest_report);
                log_debug!("Report written successfully.");
                contest_report
            } else {
                read_serialized(&report_path)
            };

            // Skip empty reports (no ballots, candidates, or rounds)
            if report.ballot_count == 0 || report.num_candidates == 0 || report.rounds.is_empty() {
                log_debug!("Skipping empty report: {}", report.info.office);
                drop(report);
                drop(preprocessed);
                return None;
            }

            // Check if any candidate is named "Write-in" or "Write in" (case-insensitive)
            let has_write_in_by_name = report
                .candidates
                .iter()
                .any(|c| is_write_in_by_name(&c.name));

            // Build index entry matching the existing format
            let index_entry = ContestIndexEntry {
                office: report.info.office.clone(),
                office_name: report.info.office_name.clone(),
                name: report.info.name.clone(),
                winner: report
                    .winner()
                    .map(|w| w.name.clone())
                    .unwrap_or_else(|| "No Winner".to_string()),
                num_candidates: report.num_candidates,
                num_rounds: report.rounds.len() as u32,
                condorcet_winner: report
                    .condorcet
                    .map(|c| report.candidates[c.0 as usize].name.clone()),
                has_non_condorcet_winner: report.condorcet.is_some()
                    && report.condorcet != report.winner,
                has_write_in_by_name,
            };

            drop(report);
            drop(preprocessed);

            Some(index_entry)
        })
        .collect()
}

/// Process a NIST election with batch optimization
fn process_nist_election_batch(
    election_path: &str,
    election: &ElectionMetadata,
    jurisdiction: &Jurisdiction,
    ctx: &ProcessingContext,
) -> Vec<ContestIndexEntry> {
    use crate::formats::nist_batch_reader;

    // raw_base is the jurisdiction path, need to add election_path
    let raw_path = ctx.raw_base.join(election_path);

    // Prepare contest data for batch processing
    let contests_with_ids: Vec<(u32, std::collections::BTreeMap<String, String>)> = election
        .contests
        .iter()
        .filter_map(|contest| {
            let contest_id: u32 = contest
                .loader_params
                .as_ref()?
                .get("contest")?
                .parse()
                .ok()?;
            Some((contest_id, contest.loader_params.clone().unwrap()))
        })
        .collect();

    // Batch read all contests at once
    let mut elections_by_contest = nist_batch_reader(&raw_path, contests_with_ids);

    // Now process each contest using the pre-loaded election data
    election
        .contests
        .iter()
        .filter_map(|contest| {
            let contest_id: u32 = contest
                .loader_params
                .as_ref()?
                .get("contest")?
                .parse()
                .ok()?;

            let office = jurisdiction
                .offices
                .get(&contest.office)
                .unwrap_or_else(|| panic!("Expected office {} to be in offices.", &contest.office));
            log_race!(&jurisdiction.name, &election.name, &office.name);

            let report_path = ctx
                .report_dir
                .join(&jurisdiction.path)
                .join(election_path)
                .join(&contest.office)
                .join("report.json");

            let preprocessed_path = ctx
                .preprocessed_dir
                .join(&jurisdiction.path)
                .join(election_path)
                .join(&contest.office)
                .join("normalized.json.gz");

            create_dir_all(report_path.parent().unwrap()).unwrap();
            create_dir_all(preprocessed_path.parent().unwrap()).unwrap();

            // Take ownership of the election data from batch results
            let raw_election = elections_by_contest.remove(&contest_id)?;

            // Preprocess with the loaded election data
            let preprocessed = if ctx.force_preprocess || !preprocessed_path.exists() {
                let preprocessed = crate::report::preprocess_election_from_data(
                    raw_election,
                    election,
                    jurisdiction,
                    contest,
                    election_path,
                );
                write_serialized(&preprocessed_path, &preprocessed);
                log_debug!("Processed {} ballots", preprocessed.ballots.ballots.len());
                preprocessed
            } else {
                log_debug!(
                    "Reading cached preprocessed {}",
                    preprocessed_path.display()
                );
                read_serialized(&preprocessed_path)
            };

            // Generate report
            let report = if ctx.force_report || !report_path.exists() {
                log_debug!("Generating report...");
                let contest_report = generate_report(&preprocessed);
                log_debug!("Writing report to disk...");
                write_serialized(&report_path, &contest_report);
                log_debug!("Report written successfully.");
                contest_report
            } else {
                read_serialized(&report_path)
            };

            // Skip empty reports (no ballots, candidates, or rounds)
            if report.ballot_count == 0 || report.num_candidates == 0 || report.rounds.is_empty() {
                log_debug!("Skipping empty report: {}", report.info.office);
                drop(report);
                drop(preprocessed);
                return None;
            }

            // Check if any candidate is named "Write-in" or "Write in" (case-insensitive)
            let has_write_in_by_name = report
                .candidates
                .iter()
                .any(|c| is_write_in_by_name(&c.name));

            // Build index entry matching the existing format
            let index_entry = ContestIndexEntry {
                office: report.info.office.clone(),
                office_name: report.info.office_name.clone(),
                name: report.info.name.clone(),
                winner: report
                    .winner()
                    .map(|w| w.name.clone())
                    .unwrap_or_else(|| "No Winner".to_string()),
                num_candidates: report.num_candidates,
                num_rounds: report.rounds.len() as u32,
                condorcet_winner: report
                    .condorcet
                    .map(|c| report.candidates[c.0 as usize].name.clone()),
                has_non_condorcet_winner: report.condorcet.is_some()
                    && report.condorcet != report.winner,
                has_write_in_by_name,
            };

            drop(report);
            drop(preprocessed);

            Some(index_entry)
        })
        .collect()
}

/// Process a single election and return its election index entry
fn process_election(
    election_path: &str,
    election: &ElectionMetadata,
    jurisdiction: &Jurisdiction,
    ctx: &ProcessingContext,
) -> ElectionIndexEntry {
    log_debug!("Election: {}", election_path);

    // Check if this is a NIST election with multiple contests that share CVR files
    let is_nist_batch = election.data_format == "nist_sp_1500" && election.contests.len() > 1;

    // Check if this is a NYC election (batch reader works for single or multiple contests)
    // The batch reader uses the efficient reader which handles numeric candidate IDs correctly
    let is_nyc_batch = election.data_format == "us_ny_nyc" && !election.contests.is_empty();

    let contest_index_entries: Vec<ContestIndexEntry> = if is_nyc_batch {
        // Check if all contests use the same cvrPattern and candidatesFile
        let first_params = election.contests[0].loader_params.as_ref();
        let same_params = first_params.is_some()
            && election.contests.iter().all(|c| {
                c.loader_params.as_ref().map(|p| {
                    p.get("cvrPattern") == first_params.unwrap().get("cvrPattern")
                        && p.get("candidatesFile") == first_params.unwrap().get("candidatesFile")
                }) == Some(true)
            });

        if same_params && first_params.is_some() {
            process_nyc_election_batch(election_path, election, jurisdiction, ctx)
        } else {
            // Fall back to batch reader even if params differ (shouldn't happen for NYC)
            // This ensures we always use the efficient reader, not the buggy old reader
            crate::log_warn!("NYC contests don't share same params, but using batch reader anyway");
            process_nyc_election_batch(election_path, election, jurisdiction, ctx)
        }
    } else if is_nist_batch {
        // Check if all contests use the same CVR path
        let first_cvr = election.contests[0]
            .loader_params
            .as_ref()
            .and_then(|p| p.get("cvr"));
        let same_cvr = election
            .contests
            .iter()
            .all(|c| c.loader_params.as_ref().and_then(|p| p.get("cvr")) == first_cvr);

        if same_cvr && first_cvr.is_some() {
            process_nist_election_batch(election_path, election, jurisdiction, ctx)
        } else {
            // Fall back to sequential processing with error handling
            election
                .contests
                .iter()
                .filter_map(|contest| {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        process_contest(contest, election, election_path, jurisdiction, ctx)
                    })) {
                        Ok(result) => Some(result),
                        Err(_) => {
                            log_warn!(
                                "Failed to process contest {} in election {}",
                                contest.office,
                                election_path
                            );
                            None
                        }
                    }
                })
                .collect()
        }
    } else {
        // Process contests sequentially for non-NIST or single contest elections with error handling
        election
            .contests
            .iter()
            .filter_map(|contest| {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process_contest(contest, election, election_path, jurisdiction, ctx)
                })) {
                    Ok(result) => Some(result),
                    Err(_) => {
                        log_warn!(
                            "Failed to process contest {} in election {}",
                            contest.office,
                            election_path
                        );
                        None
                    }
                }
            })
            .collect()
    };

    // Sort contests alphabetically by office name
    let mut sorted_contests = contest_index_entries;
    sorted_contests.sort_by(|a, b| a.office_name.cmp(&b.office_name));

    ElectionIndexEntry {
        path: format!("{}/{}", jurisdiction.path, election_path),
        jurisdiction_name: jurisdiction.name.clone(),
        election_name: election.name.clone(),
        date: election.date.clone(),
        contests: sorted_contests,
    }
}

/// Process a single jurisdiction and return its election index entries
fn process_jurisdiction(
    jurisdiction: &Jurisdiction,
    raw_path: &Path,
    report_dir: &Path,
    preprocessed_dir: &Path,
    force_preprocess: bool,
    force_report: bool,
) -> Vec<ElectionIndexEntry> {
    let raw_base = raw_path.join(jurisdiction.path.clone());

    // Process elections sequentially to avoid memory issues
    let election_results: Vec<ElectionIndexEntry> = jurisdiction
        .elections
        .iter()
        .filter_map(|(election_path, election)| {
            let ctx = ProcessingContext {
                raw_base: &raw_base,
                report_dir,
                preprocessed_dir,
                force_preprocess,
                force_report,
            };
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                process_election(election_path, election, jurisdiction, &ctx)
            })) {
                Ok(result) => Some(result),
                Err(_) => {
                    log_warn!(
                        "Failed to process election {} in jurisdiction {}",
                        election_path,
                        jurisdiction.name
                    );
                    None
                }
            }
        })
        .collect();

    election_results
}

pub fn report(
    meta_dir: &Path,
    raw_dir: &Path,
    report_dir: &Path,
    preprocessed_dir: &Path,
    force_preprocess: bool,
    force_report: bool,
    jurisdiction_filter: Option<&str>,
) {
    let raw_path = Path::new(raw_dir);

    // Collect all jurisdictions first
    let jurisdictions: Vec<_> = read_meta(meta_dir).collect();

    // Filter jurisdictions if a filter is provided
    let filtered_jurisdictions: Vec<_> = if let Some(filter) = jurisdiction_filter {
        log_info!("Filtering to jurisdiction: {}", filter);
        jurisdictions
            .into_iter()
            .filter(|(_, jurisdiction)| jurisdiction.path == filter)
            .collect()
    } else {
        jurisdictions
    };

    if filtered_jurisdictions.is_empty() {
        if let Some(filter) = jurisdiction_filter {
            log_warn!("No jurisdictions found matching filter '{}'", filter);
        } else {
            log_warn!("No jurisdictions found");
        }
        return;
    }

    // Track success/failure counts
    let mut total_contests = 0;
    let mut successful_contests = 0;
    let mut failed_contests = 0;

    // Process jurisdictions in parallel
    let jurisdiction_results: Vec<(Vec<ElectionIndexEntry>, usize, usize)> = filtered_jurisdictions
        .par_iter()
        .map(|(_, jurisdiction)| {
            // Count total contests in this jurisdiction
            let contests_in_jurisdiction: usize = jurisdiction
                .elections
                .values()
                .map(|e| e.contests.len())
                .sum();

            // Process with error handling
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                process_jurisdiction(
                    jurisdiction,
                    raw_path,
                    report_dir,
                    preprocessed_dir,
                    force_preprocess,
                    force_report,
                )
            })) {
                Ok(result) => {
                    // Count successful contests
                    let successful = result.iter().map(|e| e.contests.len()).sum::<usize>();
                    (result, successful, contests_in_jurisdiction - successful)
                }
                Err(_) => {
                    log_warn!(
                        "Jurisdiction {} panicked during processing",
                        jurisdiction.name
                    );
                    (Vec::new(), 0, contests_in_jurisdiction)
                }
            }
        })
        .collect();

    // Extract results and counts
    let mut election_index_entries: Vec<ElectionIndexEntry> = Vec::new();
    for (results, successful, failed) in jurisdiction_results {
        total_contests += successful + failed;
        successful_contests += successful;
        failed_contests += failed;
        election_index_entries.extend(results);
    }

    election_index_entries.sort_by(|a, b| (&b.date, &b.path).cmp(&(&a.date, &a.path)));

    // If a jurisdiction filter is provided, merge with existing index
    let mut final_election_index_entries = election_index_entries;
    if let Some(filtered_jurisdiction) = jurisdiction_filter {
        let index_path = Path::new(report_dir).join("index.json");

        // Try to read existing index
        if index_path.exists() {
            log_info!("Merging with existing index.json...");
            match std::panic::catch_unwind(|| read_serialized::<ReportIndex>(&index_path)) {
                Ok(existing_index) => {
                    let existing_count = existing_index.elections.len();
                    let new_entries_count = final_election_index_entries.len();

                    // Remove entries that belong to the filtered jurisdiction
                    let mut merged_entries: Vec<ElectionIndexEntry> = existing_index
                        .elections
                        .into_iter()
                        .filter(|entry| !entry.path.starts_with(filtered_jurisdiction))
                        .collect();

                    let kept_existing_count = merged_entries.len();
                    let removed_count = existing_count - kept_existing_count;

                    // Add the new entries
                    merged_entries.extend(final_election_index_entries);

                    // Sort merged entries
                    merged_entries.sort_by(|a, b| (&b.date, &b.path).cmp(&(&a.date, &a.path)));

                    final_election_index_entries = merged_entries;
                    log_info!("Merged index: {} elections (kept {} existing, removed {} from filtered jurisdiction, added {} new)", 
                        final_election_index_entries.len(),
                        kept_existing_count,
                        removed_count,
                        new_entries_count);
                }
                Err(_) => {
                    log_warn!("Failed to read existing index.json, will overwrite");
                }
            }
        }
    }

    let report_index = ReportIndex {
        elections: final_election_index_entries,
    };

    // Always write index.json, even if there were errors
    let index_path = Path::new(report_dir).join("index.json");

    // Ensure the report directory exists
    if let Err(e) = std::fs::create_dir_all(report_dir) {
        log_warn!(
            "Failed to create report directory {}: {}",
            report_dir.display(),
            e
        );
        return;
    }

    write_serialized(&index_path, &report_index);
    log_info!("Index written: {} elections", report_index.elections.len());

    // Print summary
    log_info!("=== Report Generation Summary ===");
    log_info!("Total contests: {}", total_contests);
    log_info!("Successful: {}", successful_contests);
    if failed_contests > 0 {
        log_warn!("Failed: {}", failed_contests);
    }
    log_info!("Index entries: {}", report_index.elections.len());
}

/// Rebuild the index.json by scanning all existing report.json files
pub fn rebuild_index(report_dir: &Path) {
    log_info!("Rebuilding index.json from existing reports...");
    log_debug!("Scanning directory: {}", report_dir.display());

    let mut election_map: HashMap<String, ElectionIndexEntry> = HashMap::new();
    let mut reports_found = 0;
    let mut reports_processed = 0;

    // Recursively find all report.json files
    fn find_report_files(dir: &Path, reports: &mut Vec<PathBuf>) {
        if let Ok(entries) = read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    find_report_files(&path, reports);
                } else if path.file_name().and_then(|n| n.to_str()) == Some("report.json") {
                    reports.push(path);
                }
            }
        }
    }

    let mut report_files = Vec::new();
    find_report_files(report_dir, &mut report_files);

    for report_path in report_files {
        reports_found += 1;

        // Extract the path relative to report_dir for the election path
        let relative_path = report_path.strip_prefix(report_dir).ok();
        let election_path = relative_path
            .and_then(|p| p.parent().and_then(|p| p.parent()))
            .and_then(|p| p.to_str())
            .map(|s| s.to_string());

        // Read the report (skip if it fails to parse)
        let report = std::panic::catch_unwind(|| read_serialized::<ContestReport>(&report_path));

        if let Ok(report) = report {
            // Skip empty reports (no ballots, candidates, or rounds)
            if report.ballot_count == 0 || report.num_candidates == 0 || report.rounds.is_empty() {
                log_debug!("Skipping empty report: {}", report_path.display());
                continue;
            }

            reports_processed += 1;

            // Use the election path from the report if available, otherwise construct from file path
            let full_election_path = election_path.unwrap_or_else(|| {
                format!(
                    "{}/{}",
                    report.info.jurisdiction_path, report.info.election_path
                )
            });

            // Check if any candidate is named "Write-in" or "Write in" (case-insensitive)
            let has_write_in_by_name = report
                .candidates
                .iter()
                .any(|c| is_write_in_by_name(&c.name));

            let contest_entry = ContestIndexEntry {
                office: report.info.office.clone(),
                office_name: report.info.office_name.clone(),
                name: report.info.name.clone(),
                winner: report
                    .winner()
                    .map(|w| w.name.clone())
                    .unwrap_or_else(|| "No Winner".to_string()),
                num_candidates: report.num_candidates,
                num_rounds: report.rounds.len() as u32,
                condorcet_winner: report.condorcet.and_then(|c| {
                    report
                        .candidates
                        .get(c.0 as usize)
                        .map(|candidate| candidate.name.clone())
                }),
                has_non_condorcet_winner: report.condorcet.is_some()
                    && report.condorcet != report.winner,
                has_write_in_by_name,
            };

            // Get or create election entry
            let election_entry = election_map
                .entry(full_election_path.clone())
                .or_insert_with(|| ElectionIndexEntry {
                    path: full_election_path.clone(),
                    jurisdiction_name: report.info.jurisdiction_name.clone(),
                    election_name: report.info.election_name.clone(),
                    date: report.info.date.clone(),
                    contests: Vec::new(),
                });

            election_entry.contests.push(contest_entry);
        }
    }

    // Convert to sorted vector
    let mut election_index_entries: Vec<ElectionIndexEntry> = election_map.into_values().collect();
    election_index_entries.sort_by(|a, b| (&b.date, &b.path).cmp(&(&a.date, &a.path)));

    // Sort contests within each election
    for election in &mut election_index_entries {
        election
            .contests
            .sort_by(|a, b| a.office_name.cmp(&b.office_name));
    }

    let report_index = ReportIndex {
        elections: election_index_entries,
    };

    // Ensure the report directory exists before writing
    if let Err(e) = std::fs::create_dir_all(report_dir) {
        log_warn!(
            "Failed to create report directory {}: {}",
            report_dir.display(),
            e
        );
        return;
    }

    let index_path = report_dir.join("index.json");
    write_serialized(&index_path, &report_index);
    log_info!(
        "Found {} report.json files, processed {} successfully",
        reports_found,
        reports_processed
    );
    log_info!("Index updated: {} elections", report_index.elections.len());
}
