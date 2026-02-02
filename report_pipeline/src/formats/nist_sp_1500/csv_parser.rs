use crate::formats::common::normalize_name;
use crate::formats::nist_sp_1500::model::{CandidateManifest, CandidateType, ContestManifest};
use std::collections::HashMap;

/// Header rows from a NIST CSV CVR file
#[derive(Debug)]
pub struct CsvHeaders {
    pub contests_row: csv::StringRecord,
    pub candidates_row: csv::StringRecord,
    pub headers_row: csv::StringRecord,
}

impl CsvHeaders {
    /// Read the 4 header rows from a CSV reader
    pub fn from_reader<R: std::io::Read>(rdr: &mut csv::Reader<R>) -> Result<Self, String> {
        let mut header_buffer = csv::StringRecord::new();
        let mut rows = Vec::new();
        for _ in 0..4 {
            if !rdr
                .read_record(&mut header_buffer)
                .map_err(|e| format!("CSV parse error: {}", e))?
            {
                break;
            }
            rows.push(header_buffer.clone());
        }

        if rows.len() < 4 {
            return Err("CSV file must have at least 4 header rows".to_string());
        }

        Ok(Self {
            contests_row: rows[1].clone(),
            candidates_row: rows[2].clone(),
            headers_row: rows[3].clone(),
        })
    }

    /// Find the column index for the record ID (RecordId or ImprintedId)
    pub fn find_record_id_column(&self) -> Option<usize> {
        for (idx, header) in self.headers_row.iter().enumerate() {
            if header == "RecordId" || header == "ImprintedId" {
                return Some(idx);
            }
        }
        None
    }
}

/// Mapping of columns for a single contest in a CSV file
#[derive(Debug)]
pub struct CsvContestMapping {
    /// Map of rank -> candidate_id -> column_index
    pub rank_candidate_map: HashMap<u32, HashMap<u32, usize>>,
    /// Index of record ID column
    pub record_id_col: Option<usize>,
    /// Minimum column index (for quick validation)
    pub min_column_idx: usize,
}

impl CsvContestMapping {
    /// Create a mapping for a single contest from CSV headers
    pub fn from_headers(
        headers: &CsvHeaders,
        contest_id: u32,
        candidate_manifest: &CandidateManifest,
    ) -> Result<Self, String> {
        // Find contest description from candidate manifest
        let contest_desc = candidate_manifest
            .list
            .iter()
            .find(|c| c.contest_id == contest_id)
            .map(|c| &c.description)
            .ok_or_else(|| format!("Contest {} not found in manifest", contest_id))?;

        // Find all columns that belong to this contest
        let contest_columns =
            Self::find_contest_columns(headers, contest_id, contest_desc, candidate_manifest);

        if contest_columns.is_empty() {
            return Err(format!(
                "No columns found for contest {} ({})",
                contest_id, contest_desc
            ));
        }

        // Build rank -> candidate_id -> column_index map
        let rank_candidate_map =
            Self::build_rank_candidate_map(&contest_columns, contest_id, candidate_manifest);

        let min_column_idx = contest_columns
            .iter()
            .map(|(idx, _, _)| *idx)
            .min()
            .unwrap_or(0);

        Ok(Self {
            rank_candidate_map,
            record_id_col: headers.find_record_id_column(),
            min_column_idx,
        })
    }

    /// Find all columns that belong to a contest
    fn find_contest_columns(
        headers: &CsvHeaders,
        contest_id: u32,
        contest_desc: &str,
        candidate_manifest: &CandidateManifest,
    ) -> Vec<(usize, String, u32)> {
        let mut columns = Vec::new();

        for (col_idx, contest_name) in headers.contests_row.iter().enumerate() {
            if !Self::matches_contest(contest_name, contest_desc) {
                continue;
            }

            if col_idx >= headers.candidates_row.len() {
                continue;
            }

            let candidate_str = &headers.candidates_row[col_idx];
            if let Some((candidate_name, rank)) = Self::parse_candidate_rank(candidate_str) {
                if Self::is_valid_candidate(&candidate_name, contest_id, candidate_manifest) {
                    columns.push((col_idx, candidate_name, rank));
                }
            }
        }

        columns
    }

    /// Check if a contest name matches the expected description
    fn matches_contest(contest_name: &str, contest_desc: &str) -> bool {
        contest_name.contains(contest_desc) || contest_desc.contains(contest_name)
    }

    /// Parse candidate name and rank from format like "CANDIDATE(1)"
    fn parse_candidate_rank(s: &str) -> Option<(String, u32)> {
        let open_paren = s.rfind('(')?;
        let close_paren = s.rfind(')')?;
        if close_paren <= open_paren {
            return None;
        }
        let rank: u32 = s[open_paren + 1..close_paren].parse().ok()?;
        let name = s[..open_paren].trim().to_string();
        Some((name, rank))
    }

    /// Check if a candidate name is valid for the contest
    fn is_valid_candidate(
        candidate_name: &str,
        contest_id: u32,
        candidate_manifest: &CandidateManifest,
    ) -> bool {
        // Check for regular candidates
        let found_regular = candidate_manifest.list.iter().any(|c| {
            c.contest_id == contest_id
                && normalize_name(&c.description, false) == normalize_name(candidate_name, false)
        });

        if found_regular {
            return true;
        }

        // Check for write-in candidates
        if candidate_name == "Write-in" {
            return candidate_manifest.list.iter().any(|c| {
                c.contest_id == contest_id && matches!(c.candidate_type, CandidateType::WriteIn)
            });
        }

        false
    }

    /// Build the rank -> candidate_id -> column_index map
    fn build_rank_candidate_map(
        columns: &[(usize, String, u32)],
        contest_id: u32,
        candidate_manifest: &CandidateManifest,
    ) -> HashMap<u32, HashMap<u32, usize>> {
        let mut map: HashMap<u32, HashMap<u32, usize>> = HashMap::new();

        for (col_idx, candidate_name, rank) in columns {
            // Find the candidate ID
            let candidate_id = if candidate_name == "Write-in" {
                candidate_manifest
                    .list
                    .iter()
                    .find(|c| {
                        c.contest_id == contest_id
                            && matches!(c.candidate_type, CandidateType::WriteIn)
                    })
                    .map(|c| c.id)
            } else {
                candidate_manifest
                    .list
                    .iter()
                    .find(|c| {
                        c.contest_id == contest_id
                            && normalize_name(&c.description, false)
                                == normalize_name(candidate_name, false)
                    })
                    .map(|c| c.id)
            };

            if let Some(id) = candidate_id {
                map.entry(*rank).or_default().insert(id, *col_idx);
            }
        }

        map
    }

    /// Extract marks from a CSV record for this contest
    pub fn extract_marks(&self, record: &csv::StringRecord) -> Vec<(u32, u32)> {
        let mut marks = Vec::new();

        for (rank, candidate_cols) in &self.rank_candidate_map {
            for (candidate_id, col_idx) in candidate_cols {
                if let Some(value_str) = record.get(*col_idx) {
                    let value_str = value_str.trim_matches('=').trim_matches('"').trim();
                    if !value_str.is_empty() && value_str != "0" {
                        if let Ok(value) = value_str.parse::<u32>() {
                            if value > 0 && value == *rank {
                                marks.push((*candidate_id, *rank));
                            }
                        }
                    }
                }
            }
        }

        marks
    }

    /// Extract record ID from a CSV record
    pub fn extract_record_id(&self, record: &csv::StringRecord, default: &str) -> String {
        self.record_id_col
            .and_then(|col| record.get(col))
            .map(|s| s.trim_matches('=').trim_matches('"').to_string())
            .unwrap_or_else(|| default.to_string())
    }
}

/// Mappings for multiple contests in a batch CSV processing
#[derive(Debug)]
pub struct CsvBatchMappings {
    /// Map of contest_id -> (rank -> candidate_id -> column_index)
    pub contest_column_maps: HashMap<u32, HashMap<u32, HashMap<u32, usize>>>,
    /// Index of record ID column
    pub record_id_col: Option<usize>,
}

impl CsvBatchMappings {
    /// Create mappings for multiple contests from CSV headers
    pub fn from_headers(
        headers: &CsvHeaders,
        contest_ids: &[u32],
        candidate_manifest: &CandidateManifest,
        contest_manifest: &ContestManifest,
    ) -> Self {
        let mut contest_column_maps = HashMap::new();

        for contest_id in contest_ids {
            // Find contest description from ContestManifest
            let contest_desc = contest_manifest
                .list
                .iter()
                .find(|c| c.id == Some(*contest_id))
                .map(|c| &c.description);

            if let Some(contest_desc) = contest_desc {
                let columns = CsvContestMapping::find_contest_columns(
                    headers,
                    *contest_id,
                    contest_desc,
                    candidate_manifest,
                );

                if !columns.is_empty() {
                    let rank_map = Self::build_rank_candidate_map_batch(
                        &columns,
                        *contest_id,
                        candidate_manifest,
                    );

                    if !rank_map.is_empty() {
                        contest_column_maps.insert(*contest_id, rank_map);
                    }
                }
            }
        }

        Self {
            contest_column_maps,
            record_id_col: headers.find_record_id_column(),
        }
    }

    /// Build rank map for batch processing (slightly different logic)
    fn build_rank_candidate_map_batch(
        columns: &[(usize, String, u32)],
        contest_id: u32,
        candidate_manifest: &CandidateManifest,
    ) -> HashMap<u32, HashMap<u32, usize>> {
        let mut map: HashMap<u32, HashMap<u32, usize>> = HashMap::new();

        for (col_idx, candidate_name, rank) in columns {
            // Find the candidate ID
            let candidate_id = if candidate_name == "Write-in" {
                candidate_manifest
                    .list
                    .iter()
                    .find(|c| {
                        c.contest_id == contest_id
                            && matches!(c.candidate_type, CandidateType::WriteIn)
                    })
                    .map(|c| c.id)
            } else {
                candidate_manifest
                    .list
                    .iter()
                    .find(|c| {
                        c.contest_id == contest_id
                            && normalize_name(&c.description, false)
                                == normalize_name(candidate_name, false)
                    })
                    .map(|c| c.id)
            };

            if let Some(id) = candidate_id {
                map.entry(*rank).or_default().insert(id, *col_idx);
            }
        }

        map
    }

    /// Extract marks from a CSV record for a specific contest
    pub fn extract_marks_for_contest(
        &self,
        contest_id: u32,
        record: &csv::StringRecord,
    ) -> Vec<(u32, u32)> {
        let mut marks = Vec::new();

        if let Some(rank_candidate_map) = self.contest_column_maps.get(&contest_id) {
            for (rank, candidate_cols) in rank_candidate_map {
                for (candidate_id, col_idx) in candidate_cols {
                    if let Some(value_str) = record.get(*col_idx) {
                        let value_str = value_str.trim_matches('=').trim_matches('"').trim();
                        if !value_str.is_empty() && value_str != "0" {
                            if let Ok(value) = value_str.parse::<u32>() {
                                if value > 0 {
                                    marks.push((*candidate_id, *rank));
                                }
                            }
                        }
                    }
                }
            }
        }

        marks
    }

    /// Extract record ID from a CSV record
    pub fn extract_record_id(&self, record: &csv::StringRecord, default: &str) -> String {
        self.record_id_col
            .and_then(|col| record.get(col))
            .map(|s| s.trim_matches('=').trim_matches('"').to_string())
            .unwrap_or_else(|| default.to_string())
    }

    /// Check if any contests were found
    pub fn is_empty(&self) -> bool {
        self.contest_column_maps.is_empty()
    }

    /// Get contest IDs that have mappings
    pub fn contest_ids(&self) -> impl Iterator<Item = &u32> {
        self.contest_column_maps.keys()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_headers() -> CsvHeaders {
        // Create test header rows
        let contests_row = csv::StringRecord::from(vec![
            "CvrNumber",
            "TabulatorNum",
            "Mayor Race",
            "Mayor Race",
            "Mayor Race",
            "Council Race",
        ]);
        let candidates_row =
            csv::StringRecord::from(vec!["", "", "Alice(1)", "Bob(1)", "Alice(2)", "Charlie(1)"]);
        let headers_row = csv::StringRecord::from(vec![
            "RecordId",
            "Tabulator",
            "Vote1",
            "Vote2",
            "Vote3",
            "Vote4",
        ]);

        CsvHeaders {
            contests_row,
            candidates_row,
            headers_row,
        }
    }

    #[test]
    fn test_parse_candidate_rank_valid() {
        let result = CsvContestMapping::parse_candidate_rank("Alice(1)");
        assert_eq!(result, Some(("Alice".to_string(), 1)));

        let result = CsvContestMapping::parse_candidate_rank("Bob Smith(3)");
        assert_eq!(result, Some(("Bob Smith".to_string(), 3)));

        let result = CsvContestMapping::parse_candidate_rank("Write-in(2)");
        assert_eq!(result, Some(("Write-in".to_string(), 2)));
    }

    #[test]
    fn test_parse_candidate_rank_invalid() {
        assert_eq!(CsvContestMapping::parse_candidate_rank("Alice"), None);
        assert_eq!(CsvContestMapping::parse_candidate_rank("Alice()"), None);
        assert_eq!(CsvContestMapping::parse_candidate_rank("Alice(abc)"), None);
        assert_eq!(CsvContestMapping::parse_candidate_rank(""), None);
    }

    #[test]
    fn test_matches_contest() {
        assert!(CsvContestMapping::matches_contest(
            "Mayor Race",
            "Mayor Race"
        ));
        assert!(CsvContestMapping::matches_contest(
            "Mayor Race 2024",
            "Mayor Race"
        ));
        assert!(CsvContestMapping::matches_contest(
            "Mayor Race",
            "Mayor Race 2024"
        ));
        assert!(!CsvContestMapping::matches_contest(
            "Council Race",
            "Mayor Race"
        ));
    }

    #[test]
    fn test_find_record_id_column() {
        let headers = create_test_headers();
        assert_eq!(headers.find_record_id_column(), Some(0));

        // Test with ImprintedId
        let headers_imprinted = CsvHeaders {
            contests_row: csv::StringRecord::from(vec!["", ""]),
            candidates_row: csv::StringRecord::from(vec!["", ""]),
            headers_row: csv::StringRecord::from(vec!["ImprintedId", "Other"]),
        };
        assert_eq!(headers_imprinted.find_record_id_column(), Some(0));

        // Test without record ID
        let headers_none = CsvHeaders {
            contests_row: csv::StringRecord::from(vec!["", ""]),
            candidates_row: csv::StringRecord::from(vec!["", ""]),
            headers_row: csv::StringRecord::from(vec!["Other1", "Other2"]),
        };
        assert_eq!(headers_none.find_record_id_column(), None);
    }

    #[test]
    fn test_extract_record_id() {
        let mapping = CsvContestMapping {
            rank_candidate_map: HashMap::new(),
            record_id_col: Some(0),
            min_column_idx: 0,
        };

        let record = csv::StringRecord::from(vec!["12345", "data"]);
        assert_eq!(mapping.extract_record_id(&record, "default"), "12345");

        // Test with quoted value
        let record_quoted = csv::StringRecord::from(vec!["=\"67890\"", "data"]);
        assert_eq!(
            mapping.extract_record_id(&record_quoted, "default"),
            "67890"
        );

        // Test with missing column
        let mapping_none = CsvContestMapping {
            rank_candidate_map: HashMap::new(),
            record_id_col: None,
            min_column_idx: 0,
        };
        assert_eq!(
            mapping_none.extract_record_id(&record, "default"),
            "default"
        );
    }

    #[test]
    fn test_extract_marks() {
        let mut rank_candidate_map = HashMap::new();
        let mut rank1 = HashMap::new();
        rank1.insert(101u32, 2usize); // candidate 101 is at column 2
        rank1.insert(102u32, 3usize); // candidate 102 is at column 3
        rank_candidate_map.insert(1u32, rank1);

        let mapping = CsvContestMapping {
            rank_candidate_map,
            record_id_col: Some(0),
            min_column_idx: 2,
        };

        // Test with vote for candidate 101 at rank 1
        let record = csv::StringRecord::from(vec!["id", "x", "1", "0"]);
        let marks = mapping.extract_marks(&record);
        assert_eq!(marks.len(), 1);
        assert!(marks.contains(&(101, 1)));

        // Test with no votes
        let record_empty = csv::StringRecord::from(vec!["id", "x", "0", "0"]);
        let marks = mapping.extract_marks(&record_empty);
        assert!(marks.is_empty());

        // Test with quoted values
        let record_quoted = csv::StringRecord::from(vec!["id", "x", "=\"1\"", "0"]);
        let marks = mapping.extract_marks(&record_quoted);
        assert_eq!(marks.len(), 1);
        assert!(marks.contains(&(101, 1)));
    }
}
