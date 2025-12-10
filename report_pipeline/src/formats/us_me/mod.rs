use crate::formats::common::{normalize_name, CandidateMap};
use crate::model::election::{Ballot, Candidate, CandidateType, Choice, Election};
use calamine::{open_workbook_auto, Data, Reader};
use lazy_static::lazy_static;
use regex::Regex;
use std::collections::BTreeMap;
use std::path::Path;

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
            crate::log_debug!("not matched: {}", candidate);
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
    let mut ballots: Vec<Ballot> = Vec::new();
    let mut candidate_map: CandidateMap<String> = CandidateMap::new();

    for file in options.files {
        crate::log_debug!("Reading: {}", file);
        let file_path = path.join(&file);
        let mut workbook = open_workbook_auto(&file_path).unwrap();

        // Get the first sheet by name or index
        let sheet_name = workbook.sheet_names().first().unwrap().clone();
        let range = workbook.worksheet_range(&sheet_name).unwrap();

        let mut rows = range.rows();
        rows.next(); // Skip header row
        for row in rows {
            let id = match row.first() {
                Some(Data::Int(id_val)) => *id_val as u32,
                Some(Data::Float(id_val)) => *id_val as u32,
                _ => panic!("Expected number for ballot ID"),
            };

            let mut choices = Vec::new();
            // Process columns 3 onwards (assuming ballot ID is in column 0, and some other data in 1-2)
            // Use a reasonable upper bound, but be safe about bounds
            for i in 3..10 {
                // Try to access the cell safely
                let cand = if i < row.len() {
                    match row.get(i) {
                        Some(Data::String(candidate)) => candidate.as_str(),
                        _ => "undervote",
                    }
                } else {
                    "undervote"
                };
                let choice = parse_choice(cand, &mut candidate_map);
                choices.push(choice);
            }

            let ballot = Ballot::new(id.to_string(), choices);
            ballots.push(ballot);
        }
    }

    Election::new(candidate_map.into_vec(), ballots)
}
