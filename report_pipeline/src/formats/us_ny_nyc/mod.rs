use crate::formats::common::CandidateMap;
use crate::model::election::{Ballot, Candidate, CandidateType, Choice, Election};
use lazy_static::lazy_static;
use regex::Regex;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::read_dir;
use std::path::Path;
use xl::{ExcelValue, Workbook, Worksheet};

/// Create a Worksheet for NYC Excel files since the xl crate's sheets() method
/// fails to parse empty elements like <sheet></sheet> (it only handles <sheet/>)
fn create_nyc_worksheet() -> Worksheet {
    Worksheet::new(
        "rId3".to_string(),
        "Sheet1".to_string(),
        1,
        "xl/worksheets/sheet1.xml".to_string(),
        1,
    )
}

struct ReaderOptions {
    office_name: String,
    jurisdiction_name: String,
    candidates_file: String,
    cvr_pattern: String,
}

impl ReaderOptions {
    pub fn from_params(params: BTreeMap<String, String>) -> ReaderOptions {
        let office_name: String = params.get("officeName").unwrap().clone();

        let jurisdiction_name: String = params.get("jurisdictionName").unwrap().clone();

        let candidates_file: String = params.get("candidatesFile").unwrap().clone();

        let cvr_pattern: String = params.get("cvrPattern").unwrap().clone();

        ReaderOptions {
            office_name,
            candidates_file,
            jurisdiction_name,
            cvr_pattern,
        }
    }
}

pub fn read_candidate_ids(workbook: &mut Workbook) -> HashMap<u32, String> {
    let mut candidates = HashMap::new();

    // Use our helper function since sheets() doesn't work with NYC files
    let worksheet = create_nyc_worksheet();
    let mut rows = worksheet.rows(workbook);
    rows.next(); // Skip header row

    for row in rows {
        if let ExcelValue::Number(id) = row[0].value {
            if let ExcelValue::String(name) = &row[1].value {
                candidates.insert(id as u32, name.to_string());
            }
        }
    }

    candidates
}

/// Single-pass worksheet scanner that collects all ballot data for a specific race
/// Returns (eligible_precincts, ballots, candidate_ids) to avoid scanning worksheets twice
fn scan_worksheets_for_race(
    path: &Path,
    office_name: &str,
    jurisdiction_name: &str,
    cvr_pattern: &str,
    candidates: &HashMap<u32, String>,
) -> (HashSet<String>, Vec<Ballot>, CandidateMap<u32>) {
    let mut eligible_precincts: HashSet<String> = HashSet::new();
    let mut ballots: Vec<Ballot> = Vec::new();
    let mut candidate_ids: CandidateMap<u32> = CandidateMap::new();
    lazy_static! {
        static ref COLUMN_RX: Regex =
            Regex::new(r#"(.+) Choice ([1-5]) of ([1-5]) (.+) \((\d+)\)"#).unwrap();
    }

    let file_rx = Regex::new(&format!("^{}$", cvr_pattern)).unwrap();

    for file in read_dir(path).unwrap() {
        if !file_rx.is_match(file.as_ref().unwrap().file_name().to_str().unwrap()) {
            continue;
        }

        let file_path = file.unwrap().path();
        eprintln!("Attempting to open file: {:?}", file_path);
        let mut workbook = match Workbook::open(file_path.to_str().unwrap()) {
            Ok(wb) => wb,
            Err(e) => {
                eprintln!("Failed to open workbook: {}", e);
                continue;
            }
        };
        // Use our helper function since sheets() doesn't work with NYC files
        let worksheet = create_nyc_worksheet();
        let mut rows = worksheet.rows(&mut workbook);
        let first_row = rows.next().unwrap();

        let mut rank_to_col: BTreeMap<u32, usize> = BTreeMap::new();
        let mut cvr_id_col: Option<usize> = None;
        let mut precinct_col: Option<usize> = None;

        // Find the precinct column, CVR ID column, and council district columns
        for (i, col) in first_row.0.iter().enumerate() {
            if let ExcelValue::String(colname) = &col.value {
                if colname == "Cast Vote Record" || colname == "\u{feff}Cast Vote Record" {
                    cvr_id_col = Some(i);
                } else if colname == "Precinct" {
                    precinct_col = Some(i);
                } else if let Some(caps) = COLUMN_RX.captures(&colname) {
                    if caps.get(1).unwrap().as_str() != office_name {
                        continue;
                    }
                    if caps.get(4).unwrap().as_str() != jurisdiction_name {
                        continue;
                    }
                    let rank: u32 = caps.get(2).unwrap().as_str().parse().unwrap();
                    assert!((1..=5).contains(&rank));
                    rank_to_col.insert(rank, i);
                }
            }
        }

        // Process all rows in a single pass
        for row in rows {
            let mut votes: Vec<Choice> = Vec::new();
            let ballot_id = if let ExcelValue::String(id) = &row[cvr_id_col.unwrap() as u16].value {
                id.to_string()
            } else {
                continue; // Skip if ballot ID is not a string
            };

            // Check if this ballot is from an eligible precinct and collect votes
            let mut has_votes = false;
            if let Some(precinct_col_idx) = precinct_col {
                if let ExcelValue::String(precinct) = &row[precinct_col_idx as u16].value {
                    // Check if this ballot has any votes for this council district
                    for col in rank_to_col.values() {
                        if let ExcelValue::String(value) = &row[*col as u16].value {
                            if value != "undervote" && value != "overvote" && !value.is_empty() {
                                eligible_precincts.insert(precinct.to_string());
                                has_votes = true;
                                break;
                            }
                        }
                    }

                    // Only process ballots from eligible precincts
                    if !has_votes {
                        continue;
                    }
                }
            }

            // Process votes for this ballot
            for col in rank_to_col.values() {
                let choice = match &row[*col as u16].value {
                    ExcelValue::String(value) => {
                        if value == "undervote" {
                            Choice::Undervote
                        } else if value == "overvote" {
                            Choice::Overvote
                        } else if value == "Write-in" {
                            candidate_ids.add_id_to_choice(
                                0,
                                Candidate::new("Write-in".to_string(), CandidateType::WriteIn),
                            )
                        } else {
                            let ext_id: u32 = value.parse().unwrap();
                            let candidate_name = candidates.get(&ext_id).unwrap();
                            candidate_ids.add_id_to_choice(
                                ext_id,
                                Candidate::new(candidate_name.clone(), CandidateType::Regular),
                            )
                        }
                    }
                    _ => Choice::Undervote, // Default to undervote for non-string values
                };

                votes.push(choice);
            }

            let ballot = Ballot::new(ballot_id, votes);
            ballots.push(ballot);
        }
    }

    (eligible_precincts, ballots, candidate_ids)
}

pub fn nyc_ballot_reader(path: &Path, params: BTreeMap<String, String>) -> Election {
    let options = ReaderOptions::from_params(params);
    let mut candidates_workbook =
        Workbook::open(path.join(options.candidates_file).to_str().unwrap()).unwrap();

    let candidates = read_candidate_ids(&mut candidates_workbook);

    // Single-pass scan to get eligible precincts, ballots, and candidate IDs
    let (eligible_precincts, ballots, candidate_ids) = scan_worksheets_for_race(
        path,
        &options.office_name,
        &options.jurisdiction_name,
        &options.cvr_pattern,
        &candidates,
    );

    eprintln!(
        "Found {} eligible precincts for {} - {}",
        eligible_precincts.len(),
        options.office_name,
        options.jurisdiction_name
    );

    eprintln!(
        "Processed {} ballots for {} - {}",
        ballots.len(),
        options.office_name,
        options.jurisdiction_name
    );

    Election::new(candidate_ids.into_vec(), ballots)
}
