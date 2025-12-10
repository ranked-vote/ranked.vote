//! PrefLib Format Parser
//!
//! This module implements a parser for PrefLib ordinal preference format files.
//! PrefLib is a library for preferences data. Supported formats include:
//! - TOI (Tied Orders - Incomplete): ties allowed, incomplete rankings permitted
//! - SOI (Strict Orders - Incomplete): no ties, incomplete rankings permitted
//!
//! Format Specification: <https://preflib.github.io/PrefLib-Jekyll/format#toi>
//!
//! ## File Format
//!
//! PrefLib files consist of:
//! 1. **Metadata Header**: Lines starting with `#` containing:
//!    - `# NUMBER ALTERNATIVES: N` - Total number of candidates
//!    - `# NUMBER VOTERS: N` - Total number of voters
//!    - `# NUMBER UNIQUE ORDERS: N` - Number of unique preference orders
//!    - `# ALTERNATIVE NAME X: Name` - Candidate names (X starts at 1)
//!
//! 2. **Preference Data**: Lines in format `count: preference_list`
//!    - `count` is the number of voters with this preference
//!    - `preference_list` is comma-separated with ties in curly braces
//!    - Example: `100: 3,1,2,4` means 100 voters ranked candidate 3 first, then 1, 2, 4
//!    - Example: `9: 3,{1,2,4}` means 9 voters ranked candidate 3 first, then 1, 2, 4 tied
//!
//! ## Tie Handling
//!
//! Ties in PrefLib format (e.g., `{1,2}`) are converted to overvotes for RCV tabulation.
//! In ranked choice voting, each rank must contain exactly one candidate. Multiple
//! candidates at the same rank is treated the same as marking multiple candidates
//! on a paper ballot—an overvote. This is consistent with how NIST CVR and other
//! format parsers handle this case.
//!
//! ## Incomplete Rankings
//!
//! Voters may not rank all candidates. Missing candidates are treated as not ranked
//! rather than ranked last.

use crate::formats::common::{normalize_name, CandidateMap};
use crate::model::election::{Ballot, Candidate, CandidateType, Choice, Election};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Configuration options for reading PrefLib files
struct ReaderOptions {
    /// Path to the .toi/.soi file relative to the election directory
    file: String,
}

impl ReaderOptions {
    pub fn from_params(params: BTreeMap<String, String>) -> ReaderOptions {
        let file = params
            .get("file")
            .expect("preflib elections should have file parameter.")
            .clone();

        ReaderOptions { file }
    }
}

/// Result of parsing a preference list
struct ParseResult {
    choices: Vec<Choice>,
    warnings: Vec<String>,
}

/// Parse a PrefLib preference list string into a vector of Choices
///
/// Handles ties in curly braces (e.g., `{1,2}`) by converting them to overvotes.
/// Processes comma-separated candidate IDs, respecting brace grouping.
///
/// # Examples
/// - `"3,1,2,4"` → [Vote(3), Vote(1), Vote(2), Vote(4)]
/// - `"3,{1,2},4"` → [Vote(3), Overvote, Vote(4)]
/// - `"{1,2}"` → [Overvote]
///
/// Ties are converted to [`Choice::Overvote`] because RCV requires exactly one
/// candidate per rank. This matches the behavior of NIST and other format parsers.
fn parse_preference_list(
    pref_str: &str,
    candidate_map: &CandidateMap<u32>,
    line_context: &str,
) -> ParseResult {
    let mut choices = Vec::new();
    let mut warnings = Vec::new();

    // Split by commas, but handle ties in curly braces
    let mut parts = Vec::new();
    let mut current_part = String::new();
    let mut brace_depth: i32 = 0;

    for ch in pref_str.chars() {
        match ch {
            '{' => {
                brace_depth += 1;
                current_part.push(ch);
            }
            '}' => {
                brace_depth -= 1;
                current_part.push(ch);
            }
            ',' => {
                if brace_depth == 0 {
                    parts.push(current_part.trim().to_string());
                    current_part.clear();
                } else {
                    current_part.push(ch);
                }
            }
            _ => {
                current_part.push(ch);
            }
        }
    }
    if !current_part.is_empty() {
        parts.push(current_part.trim().to_string());
    }

    // Check for unbalanced braces
    if brace_depth != 0 {
        warnings.push(format!(
            "Unbalanced braces in preference list '{}' ({})",
            pref_str, line_context
        ));
    }

    // Process each rank
    for part in parts {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }

        if part.starts_with('{') && part.ends_with('}') {
            // This is a tie group - convert to overvote for RCV
            choices.push(Choice::Overvote);
        } else if let Ok(cand_id) = part.parse::<u32>() {
            // Single candidate at this rank
            // Check if candidate exists before calling id_to_choice
            choices.push(candidate_map.id_to_choice(cand_id));
        } else {
            // Non-parseable entry - warn and skip
            warnings.push(format!(
                "Could not parse '{}' as candidate ID in preference list ({})",
                part, line_context
            ));
        }
    }

    ParseResult { choices, warnings }
}

/// Read and parse a PrefLib format election file
///
/// This function reads a PrefLib .toi/.soi file and converts it into an Election object.
/// It parses the metadata header to extract candidate information, then processes
/// the preference data, expanding ballot counts and handling ties.
///
/// # Parameters
/// - `path`: Base path to the election directory (e.g., `raw-data/us/ca/alameda/2010/11`)
/// - `params`: Loader parameters containing `file` key pointing to the data file
///
/// # Returns
/// An `Election` object containing candidates and ballots
///
/// # Format Details
/// See: <https://preflib.github.io/PrefLib-Jekyll/format#toi>
pub fn preflib_ballot_reader(path: &Path, params: BTreeMap<String, String>) -> Election {
    let options = ReaderOptions::from_params(params);
    let file_path = path.join(&options.file);

    let file = File::open(&file_path)
        .unwrap_or_else(|e| panic!("Failed to open PrefLib file {}: {}", file_path.display(), e));
    let reader = BufReader::new(file);

    let mut candidates_ordered: Vec<(u32, Candidate)> = Vec::new();
    let mut candidate_map: CandidateMap<u32> = CandidateMap::new();
    let mut ballots = Vec::new();
    let mut ballot_counter = 0u32;
    let mut line_number = 0usize;

    for line_result in reader.lines() {
        line_number += 1;

        let line = match line_result {
            Ok(l) => l,
            Err(e) => {
                crate::log_warn!(
                    "Failed to read line {} of {}: {}",
                    line_number,
                    file_path.display(),
                    e
                );
                continue;
            }
        };

        let line = line.trim();

        if line.is_empty() {
            continue;
        }

        if line.starts_with('#') {
            // Parse header metadata
            if let Some(rest) = line.strip_prefix("# ALTERNATIVE NAME ") {
                // Format: # ALTERNATIVE NAME X: Name
                if let Some((id_str, name)) = rest.split_once(':') {
                    if let Ok(cand_id) = id_str.trim().parse::<u32>() {
                        let mut name = name.trim().to_string();
                        // Remove surrounding quotes if present
                        if name.starts_with('"') && name.ends_with('"') && name.len() >= 2 {
                            name = name[1..name.len() - 1].to_string();
                        }
                        let candidate_type = if name.eq_ignore_ascii_case("Write-In") {
                            CandidateType::WriteIn
                        } else {
                            CandidateType::Regular
                        };

                        let candidate =
                            Candidate::new(normalize_name(&name, false), candidate_type);
                        candidate_map.add(cand_id, candidate.clone());
                        candidates_ordered.push((cand_id, candidate));
                    } else {
                        crate::log_warn!(
                            "Could not parse candidate ID '{}' at line {} of {}",
                            id_str.trim(),
                            line_number,
                            file_path.display()
                        );
                    }
                }
            }
            // Other # lines are metadata we don't need to process
        } else {
            // Non-comment, non-empty line = preference data
            // Format: count: preference_list
            if let Some((count_str, pref_str)) = line.split_once(':') {
                match count_str.trim().parse::<u32>() {
                    Ok(count) => {
                        let line_context = format!("line {} of {}", line_number, options.file);
                        let result =
                            parse_preference_list(pref_str.trim(), &candidate_map, &line_context);

                        // Log any warnings
                        for warning in result.warnings {
                            crate::log_warn!("{}", warning);
                        }

                        // Create 'count' ballots with these choices
                        for _ in 0..count {
                            ballot_counter += 1;
                            ballots.push(Ballot::new(
                                format!("{}:{}", options.file, ballot_counter),
                                result.choices.clone(),
                            ));
                        }
                    }
                    Err(_) => {
                        crate::log_warn!(
                            "Could not parse ballot count '{}' at line {} of {}",
                            count_str.trim(),
                            line_number,
                            file_path.display()
                        );
                    }
                }
            } else {
                crate::log_warn!(
                    "Malformed data line (no colon) at line {} of {}: '{}'",
                    line_number,
                    file_path.display(),
                    line
                );
            }
        }
    }

    if candidates_ordered.is_empty() {
        crate::log_warn!(
            "No candidates found in PrefLib file {}",
            file_path.display()
        );
    }

    if ballots.is_empty() {
        crate::log_warn!("No ballots found in PrefLib file {}", file_path.display());
    }

    // Sort candidates by their external ID to maintain order from file
    candidates_ordered.sort_by_key(|(id, _)| *id);
    let final_candidates: Vec<Candidate> = candidates_ordered.into_iter().map(|(_, c)| c).collect();

    Election::new(final_candidates, ballots)
}
