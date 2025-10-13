use crate::model::election::ElectionPreprocessed;
use crate::model::metadata::{Contest, ElectionMetadata, Jurisdiction};
use crate::model::report::{ContestIndexEntry, ElectionIndexEntry, ReportIndex};
use crate::read_metadata::read_meta;
use crate::report::{generate_report, preprocess_election};
use crate::util::{read_serialized, write_serialized};
use colored::*;
use rayon::prelude::*;
use std::fs::create_dir_all;
use std::path::Path;

/// Process a single contest and return the ContestIndexEntry
fn process_contest(
    contest: &Contest,
    election: &ElectionMetadata,
    election_path: &str,
    jurisdiction: &Jurisdiction,
    raw_base: &Path,
    report_dir: &Path,
    preprocessed_dir: &Path,
    force_preprocess: bool,
    force_report: bool,
) -> ContestIndexEntry {
    let office = jurisdiction
        .offices
        .get(&contest.office)
        .unwrap_or_else(|| panic!("Expected office {} to be in offices.", &contest.office));
    eprintln!("Office: {}", office.name.red());

    let report_path = Path::new(report_dir)
        .join(&jurisdiction.path)
        .join(&election_path)
        .join(&contest.office)
        .join("report.json");
    let preprocessed_path = Path::new(preprocessed_dir)
        .join(&jurisdiction.path)
        .join(&election_path)
        .join(&contest.office)
        .join("normalized.json.gz");

    let report =
        if report_path.exists() && preprocessed_path.exists() && !force_report && !force_preprocess
        {
            eprintln!(
                "Skipping because {} exists.",
                report_path.to_str().unwrap().bright_cyan()
            );
            read_serialized(&report_path)
        } else {
            create_dir_all(&report_path.parent().unwrap()).unwrap();

            let preprocessed: ElectionPreprocessed = if preprocessed_path.exists()
                && !force_preprocess
            {
                eprintln!(
                    "Loading preprocessed {}.",
                    preprocessed_path.to_str().unwrap().bright_cyan()
                );
                read_serialized(&preprocessed_path)
            } else {
                create_dir_all(preprocessed_path.parent().unwrap()).unwrap();

                eprintln!(
                    "Generating preprocessed {}.",
                    preprocessed_path.to_str().unwrap().bright_cyan()
                );
                let preprocessed =
                    preprocess_election(raw_base, election, election_path, jurisdiction, contest);
                write_serialized(&preprocessed_path, &preprocessed);
                eprintln!("Processed {} ballots", preprocessed.ballots.ballots.len());
                preprocessed
            };

            eprintln!("Generating report...");
            let contest_report = generate_report(&preprocessed);

            eprintln!("Writing report to disk...");
            write_serialized(&report_path, &contest_report);
            eprintln!("Report written successfully.");

            // Explicitly drop preprocessed data to free memory before next contest
            drop(preprocessed);

            contest_report
        };

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
        has_non_condorcet_winner: report.condorcet.is_some() && report.condorcet != report.winner,
    };

    // Drop the full report to free memory
    drop(report);

    index_entry
}

/// Process a NIST election with batch optimization
fn process_nist_election_batch(
    election_path: &str,
    election: &ElectionMetadata,
    jurisdiction: &Jurisdiction,
    raw_base: &Path,
    report_dir: &Path,
    preprocessed_dir: &Path,
    force_preprocess: bool,
    force_report: bool,
) -> Vec<ContestIndexEntry> {
    use crate::formats::nist_batch_reader;

    // raw_base is the jurisdiction path, need to add election_path
    let raw_path = raw_base.join(election_path);

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
            eprintln!("Office: {}", office.name.red());

            let report_path = Path::new(report_dir)
                .join(&jurisdiction.path)
                .join(election_path)
                .join(&contest.office)
                .join("report.json");

            let preprocessed_path = Path::new(preprocessed_dir)
                .join(&jurisdiction.path)
                .join(election_path)
                .join(&contest.office)
                .join("normalized.json.gz");

            create_dir_all(report_path.parent().unwrap()).unwrap();
            create_dir_all(preprocessed_path.parent().unwrap()).unwrap();

            // Take ownership of the election data from batch results
            let raw_election = elections_by_contest.remove(&contest_id)?;

            // Preprocess with the loaded election data
            let preprocessed = if force_preprocess || !preprocessed_path.exists() {
                let preprocessed = crate::report::preprocess_election_from_data(
                    raw_election,
                    election,
                    jurisdiction,
                    contest,
                    election_path,
                );
                write_serialized(&preprocessed_path, &preprocessed);
                eprintln!("Processed {} ballots", preprocessed.ballots.ballots.len());
                preprocessed
            } else {
                eprintln!(
                    "Reading cached preprocessed {}",
                    preprocessed_path.display()
                );
                read_serialized(&preprocessed_path)
            };

            // Generate report
            let report = if force_report || !report_path.exists() {
                eprintln!("Generating report...");
                let contest_report = generate_report(&preprocessed);
                eprintln!("Writing report to disk...");
                write_serialized(&report_path, &contest_report);
                eprintln!("Report written successfully.");
                contest_report
            } else {
                read_serialized(&report_path)
            };

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
    raw_base: &Path,
    report_dir: &Path,
    preprocessed_dir: &Path,
    force_preprocess: bool,
    force_report: bool,
) -> ElectionIndexEntry {
    eprintln!("Election: {}", election_path.red());

    // Check if this is a NIST election with multiple contests that share CVR files
    let is_nist_batch = election.data_format == "nist_sp_1500" && election.contests.len() > 1;

    let contest_index_entries: Vec<ContestIndexEntry> = if is_nist_batch {
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
            eprintln!(
                "  {} Using optimized batch processing for {} contests",
                "OPTIMIZATION:".green().bold(),
                election.contests.len()
            );
            process_nist_election_batch(
                election_path,
                election,
                jurisdiction,
                raw_base,
                report_dir,
                preprocessed_dir,
                force_preprocess,
                force_report,
            )
        } else {
            // Fall back to sequential processing
            election
                .contests
                .iter()
                .map(|contest| {
                    process_contest(
                        contest,
                        election,
                        election_path,
                        jurisdiction,
                        raw_base,
                        report_dir,
                        preprocessed_dir,
                        force_preprocess,
                        force_report,
                    )
                })
                .collect()
        }
    } else {
        // Process contests sequentially for non-NIST or single contest elections
        election
            .contests
            .iter()
            .map(|contest| {
                process_contest(
                    contest,
                    election,
                    election_path,
                    jurisdiction,
                    raw_base,
                    report_dir,
                    preprocessed_dir,
                    force_preprocess,
                    force_report,
                )
            })
            .collect()
    };

    ElectionIndexEntry {
        path: format!("{}/{}", jurisdiction.path, election_path),
        jurisdiction_name: jurisdiction.name.clone(),
        election_name: election.name.clone(),
        date: election.date.clone(),
        contests: contest_index_entries,
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
        .map(|(election_path, election)| {
            process_election(
                election_path,
                election,
                jurisdiction,
                &raw_base,
                report_dir,
                preprocessed_dir,
                force_preprocess,
                force_report,
            )
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
        eprintln!("Filtering to jurisdiction: {}", filter.bright_yellow());
        jurisdictions
            .into_iter()
            .filter(|(_, jurisdiction)| jurisdiction.path == filter)
            .collect()
    } else {
        jurisdictions
    };

    if filtered_jurisdictions.is_empty() {
        if let Some(filter) = jurisdiction_filter {
            eprintln!(
                "Warning: No jurisdictions found matching filter '{}'",
                filter.red()
            );
        } else {
            eprintln!("Warning: No jurisdictions found");
        }
        return;
    }

    // Process jurisdictions in parallel
    let jurisdiction_results: Vec<Vec<ElectionIndexEntry>> = filtered_jurisdictions
        .par_iter()
        .map(|(_, jurisdiction)| {
            process_jurisdiction(
                jurisdiction,
                &raw_path,
                report_dir,
                preprocessed_dir,
                force_preprocess,
                force_report,
            )
        })
        .collect();

    // Flatten results from all jurisdictions
    let mut election_index_entries: Vec<ElectionIndexEntry> =
        jurisdiction_results.into_iter().flatten().collect();

    election_index_entries.sort_by(|a, b| (&b.date, &b.path).cmp(&(&a.date, &a.path)));
    let report_index = ReportIndex {
        elections: election_index_entries,
    };

    write_serialized(&Path::new(report_dir).join("index.json"), &report_index);
}
