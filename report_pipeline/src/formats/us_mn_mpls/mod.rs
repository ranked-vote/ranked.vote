use crate::formats::common::CandidateMap;
use crate::model::election::{Ballot, Candidate, CandidateType, Choice, Election};
use csv::ReaderBuilder;
use std::collections::BTreeMap;
use std::path::Path;

struct ReaderOptions {
    file: String,
}

impl ReaderOptions {
    pub fn from_params(params: BTreeMap<String, String>) -> ReaderOptions {
        let file: String = params
            .get("file")
            .expect("Minneapolis elections should have file parameter.")
            .clone();

        ReaderOptions { file }
    }
}

pub fn parse_choice(candidate: &str, candidate_map: &mut CandidateMap<String>) -> Choice {
    let candidate = candidate.trim();
    if candidate.eq_ignore_ascii_case("undervote") {
        Choice::Undervote
    } else if candidate.eq_ignore_ascii_case("overvote") {
        Choice::Overvote
    } else if candidate.is_empty() {
        Choice::Undervote
    } else {
        // Normalize candidate name - UWI stands for "Undeclared Write-ins"
        // Mark it as a WriteIn candidate type so it's excluded from candidate counts
        let (normalized_name, candidate_type) = if candidate.eq_ignore_ascii_case("uwi") {
            ("Undeclared Write-ins".to_string(), CandidateType::WriteIn)
        } else {
            (candidate.to_string(), CandidateType::Regular)
        };

        candidate_map.add_id_to_choice(
            candidate.to_string(),
            Candidate::new(normalized_name, candidate_type),
        )
    }
}

pub fn mpls_ballot_reader(path: &Path, params: BTreeMap<String, String>) -> Election {
    let options = ReaderOptions::from_params(params);
    let file_path = path.join(&options.file);

    let mut rdr = ReaderBuilder::new()
        .has_headers(true)
        .from_path(&file_path)
        .unwrap_or_else(|_| panic!("Failed to open CSV file: {}", file_path.display()));

    let mut candidate_map = CandidateMap::new();
    let mut ballots: Vec<Ballot> = Vec::new();
    let mut ballot_id = 0;

    for result in rdr.records() {
        let record = result.expect("Failed to read CSV record");

        if record.len() < 5 {
            continue;
        }

        let precinct = record.get(0).unwrap_or("");
        let choice1 = record.get(1).unwrap_or("");
        let choice2 = record.get(2).unwrap_or("");
        let choice3 = record.get(3).unwrap_or("");
        let count_str = record.get(4).unwrap_or("1");

        let count: u32 = count_str.parse().unwrap_or(1);

        // Parse choices - check for overvotes first
        let mut choices = Vec::new();

        // Check if any choice is explicitly marked as "overvote"
        // If so, mark the entire ballot as overvoted
        if choice1.eq_ignore_ascii_case("overvote")
            || choice2.eq_ignore_ascii_case("overvote")
            || choice3.eq_ignore_ascii_case("overvote")
        {
            choices.push(Choice::Overvote);
        } else {
            // Process first choice
            if !choice1.is_empty() && !choice1.eq_ignore_ascii_case("undervote") {
                choices.push(parse_choice(choice1, &mut candidate_map));
            } else {
                choices.push(Choice::Undervote);
            }

            // Process second choice
            if !choice2.is_empty() && !choice2.eq_ignore_ascii_case("undervote") {
                choices.push(parse_choice(choice2, &mut candidate_map));
            } else {
                choices.push(Choice::Undervote);
            }

            // Process third choice
            if !choice3.is_empty() && !choice3.eq_ignore_ascii_case("undervote") {
                choices.push(parse_choice(choice3, &mut candidate_map));
            } else {
                choices.push(Choice::Undervote);
            }
        }

        // Create ballots based on count
        for _ in 0..count {
            ballot_id += 1;
            let ballot = Ballot::new(format!("{}:{}", precinct, ballot_id), choices.clone());
            ballots.push(ballot);
        }
    }

    Election::new(candidate_map.into_vec(), ballots)
}
