use crate::formats::common::{normalize_name, CandidateMap};
use crate::model::election::{Ballot, Candidate, CandidateType, Choice, Election};
use lazy_static::lazy_static;
use rayon::prelude::*;
use regex::Regex;
use std::collections::BTreeMap;
use std::path::Path;
use xl::{ExcelValue, Workbook};

struct ReaderOptions {
    files: Vec<String>,
}

impl ReaderOptions {
    pub fn from_params(params: BTreeMap<String, String>) -> ReaderOptions {
        let files: Vec<String> = params
            .get("files")
            .unwrap()
            .split(';')
            .map(|x| x.to_string())
            .collect();

        ReaderOptions { files }
    }
}

pub fn parse_choice(candidate: &str, candidate_map: &mut CandidateMap<String>) -> Choice {
    if candidate == "overvote" {
        Choice::Overvote
    } else if candidate == "undervote" {
        Choice::Undervote
    } else {
        lazy_static! {
            static ref CANDIDATE_RX: Regex =
                Regex::new(r#"(?:DEM |REP )?([^\(]*[^ \()])(?: +\(\d+\))?"#).unwrap();
        }
        let candidate = if let Some(c) = CANDIDATE_RX.captures(candidate) {
            c.get(1).unwrap().as_str()
        } else {
            eprintln!("not matched: {}", candidate);
            candidate
        };

        candidate_map.add_id_to_choice(
            candidate.to_string(),
            Candidate::new(normalize_name(candidate, true), CandidateType::Regular),
        )
    }
}

// Inline ballot processing to avoid private type issues

pub fn maine_ballot_reader(path: &Path, params: BTreeMap<String, String>) -> Election {
    let options = ReaderOptions::from_params(params);
    let mut candidate_map: CandidateMap<String> = CandidateMap::new();

    // Process files in parallel to extract ballots and build candidate map
    let file_results: Vec<(Vec<Ballot>, Vec<String>)> = options
        .files
        .par_iter()
        .map(|file| {
            eprintln!("Reading: {}", file);
            let mut workbook = Workbook::open(path.join(file).to_str().unwrap()).unwrap();
            let sheets = workbook.sheets();
            let sheet = sheets.get(1).unwrap(); // Get the first sheet by position (1-based indexing)

            let mut ballots = Vec::new();
            let mut local_candidate_map: CandidateMap<String> = CandidateMap::new();
            let mut rows = sheet.rows(&mut workbook);
            rows.next(); // Skip header row
            for row in rows {
                let id = if let ExcelValue::Number(id_val) = row[0].value {
                    id_val as u32
                } else {
                    panic!("Expected number for ballot ID");
                };

                let mut choices = Vec::new();
                // Process columns 3 onwards (assuming ballot ID is in column 0, and some other data in 1-2)
                // Use a reasonable upper bound, but be safe about bounds
                for i in 3..10 {
                    // Try to access the cell safely
                    let cand = if i < 6 {
                        // Conservative bound - only process columns 3, 4, 5
                        if let ExcelValue::String(candidate) = &row[i as u16].value {
                            candidate.as_ref()
                        } else {
                            "undervote"
                        }
                    } else {
                        "undervote"
                    };
                    let choice = parse_choice(cand, &mut local_candidate_map);
                    choices.push(choice);
                }

                let ballot = Ballot::new(id.to_string(), choices);
                ballots.push(ballot);
            }
            (
                ballots,
                local_candidate_map
                    .into_vec()
                    .into_iter()
                    .map(|c| c.name)
                    .collect(),
            )
        })
        .collect();

    // Merge all ballots and candidates
    let ballots: Vec<Ballot> = file_results
        .iter()
        .flat_map(|(b, _)| b.iter().cloned())
        .collect();
    let all_candidates: Vec<String> = file_results
        .iter()
        .flat_map(|(_, c)| c.iter().cloned())
        .collect();

    // Build final candidate map
    for candidate_name in all_candidates {
        candidate_map.add(
            candidate_name.clone(),
            Candidate::new(candidate_name, CandidateType::Regular),
        );
    }

    Election::new(candidate_map.into_vec(), ballots)
}
