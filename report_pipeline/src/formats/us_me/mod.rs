use crate::formats::common::{normalize_name, CandidateMap};
use crate::model::election::{Ballot, Candidate, CandidateType, Choice, Election};
use lazy_static::lazy_static;
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
    let mut ballots: Vec<Ballot> = Vec::new();
    let mut candidate_map: CandidateMap<String> = CandidateMap::new();

    for file in options.files {
        eprintln!("Reading: {}", file);
        let mut workbook = Workbook::open(path.join(file).to_str().unwrap()).unwrap();
        let sheets = workbook.sheets();
        let sheet = sheets.get(1).unwrap(); // Get the first sheet by position (1-based indexing)

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
            for i in 3..10 {
                // Use a reasonable upper bound
                let cand = if let ExcelValue::String(candidate) = &row[i as u16].value {
                    candidate.as_ref()
                } else {
                    "undervote" // Default to undervote if no string value
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
