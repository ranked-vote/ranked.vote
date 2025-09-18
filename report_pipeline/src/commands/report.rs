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

            let contest_report = generate_report(&preprocessed);

            write_serialized(&report_path, &contest_report);
            contest_report
        };

    ContestIndexEntry {
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
    }
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

    // Process contests in parallel
    let contest_index_entries: Vec<ContestIndexEntry> = election
        .contests
        .par_iter()
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
        .collect();

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

    // Process elections in parallel within the jurisdiction
    let election_results: Vec<ElectionIndexEntry> = jurisdiction
        .elections
        .par_iter()
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
) {
    let raw_path = Path::new(raw_dir);

    // Collect all jurisdictions first
    let jurisdictions: Vec<_> = read_meta(meta_dir).collect();

    // Process jurisdictions in parallel
    let jurisdiction_results: Vec<Vec<ElectionIndexEntry>> = jurisdictions
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
