use crate::formats::common::CandidateMap;
use crate::formats::nist_sp_1500::model::Mark;
use crate::model::election::Choice;

/// Represents a mark from any source (JSON or CSV) with candidate ID and rank
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RankedMark {
    pub candidate_id: u32,
    pub rank: u32,
}

impl RankedMark {
    pub fn new(candidate_id: u32, rank: u32) -> Self {
        Self { candidate_id, rank }
    }
}

/// Convert a list of marks (sorted by rank) to a list of choices.
///
/// Handles:
/// - Single mark at a rank -> Vote for that candidate
/// - No marks at a rank -> Undervote
/// - Multiple marks at same rank -> Overvote
/// - Dropped write-in candidate -> treated as Undervote
pub fn marks_to_choices(
    marks: &[RankedMark],
    candidates: &CandidateMap<u32>,
    dropped_write_in: Option<u32>,
) -> Vec<Choice> {
    if marks.is_empty() {
        return Vec::new();
    }

    // Filter out dropped write-ins
    let filtered_marks: Vec<RankedMark> = marks
        .iter()
        .filter(|m| {
            dropped_write_in
                .map(|d| m.candidate_id != d)
                .unwrap_or(true)
        })
        .copied()
        .collect();

    // Sort by rank
    let mut sorted_marks = filtered_marks;
    sorted_marks.sort_by_key(|m| m.rank);

    // Group by rank and convert to choices
    let mut choices: Vec<Choice> = Vec::new();
    for rank_group in sorted_marks.chunk_by(|a, b| a.rank == b.rank) {
        let candidates_at_rank: Vec<u32> = rank_group.iter().map(|m| m.candidate_id).collect();

        let choice = match candidates_at_rank.as_slice() {
            [] => Choice::Undervote,
            [candidate_id] => candidates.id_to_choice(*candidate_id),
            _ => Choice::Overvote, // Multiple candidates at same rank
        };
        choices.push(choice);
    }

    choices
}

/// Convert JSON Mark objects to choices, filtering out ambiguous marks.
///
/// This is the entry point for processing NIST JSON CVR data where marks
/// include an `is_ambiguous` field.
pub fn json_marks_to_choices(
    marks: &[Mark],
    candidates: &CandidateMap<u32>,
    dropped_write_in: Option<u32>,
) -> Vec<Choice> {
    // Filter ambiguous marks and convert to RankedMark
    let ranked_marks: Vec<RankedMark> = marks
        .iter()
        .filter(|m| !m.is_ambiguous)
        .map(|m| RankedMark::new(m.candidate_id, m.rank))
        .collect();

    marks_to_choices(&ranked_marks, candidates, dropped_write_in)
}

/// Convert CSV mark tuples (candidate_id, rank) to choices.
///
/// This is the entry point for processing CSV CVR data where marks
/// are represented as (candidate_id, rank) tuples.
pub fn csv_marks_to_choices(
    marks: &[(u32, u32)],
    candidates: &CandidateMap<u32>,
    dropped_write_in: Option<u32>,
) -> Vec<Choice> {
    let ranked_marks: Vec<RankedMark> = marks
        .iter()
        .map(|(candidate_id, rank)| RankedMark::new(*candidate_id, *rank))
        .collect();

    marks_to_choices(&ranked_marks, candidates, dropped_write_in)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::election::{Candidate, CandidateId, CandidateType};

    fn create_test_candidates() -> CandidateMap<u32> {
        let mut map = CandidateMap::new();
        map.add(
            1,
            Candidate::new("Alice".to_string(), CandidateType::Regular),
        );
        map.add(2, Candidate::new("Bob".to_string(), CandidateType::Regular));
        map.add(
            3,
            Candidate::new("Charlie".to_string(), CandidateType::Regular),
        );
        map.add(
            99,
            Candidate::new("Write-in".to_string(), CandidateType::WriteIn),
        );
        map
    }

    #[test]
    fn test_marks_to_choices_single_vote_per_rank() {
        let candidates = create_test_candidates();
        let marks = vec![
            RankedMark::new(1, 1), // Alice first
            RankedMark::new(2, 2), // Bob second
            RankedMark::new(3, 3), // Charlie third
        ];

        let choices = marks_to_choices(&marks, &candidates, None);

        assert_eq!(choices.len(), 3);
        assert_eq!(choices[0], Choice::Vote(CandidateId(0))); // Alice is internal ID 0
        assert_eq!(choices[1], Choice::Vote(CandidateId(1))); // Bob is internal ID 1
        assert_eq!(choices[2], Choice::Vote(CandidateId(2))); // Charlie is internal ID 2
    }

    #[test]
    fn test_marks_to_choices_overvote() {
        let candidates = create_test_candidates();
        let marks = vec![
            RankedMark::new(1, 1), // Alice first
            RankedMark::new(2, 1), // Bob also first - overvote!
        ];

        let choices = marks_to_choices(&marks, &candidates, None);

        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0], Choice::Overvote);
    }

    #[test]
    fn test_marks_to_choices_empty_marks() {
        let candidates = create_test_candidates();
        let marks: Vec<RankedMark> = vec![];

        let choices = marks_to_choices(&marks, &candidates, None);

        assert!(choices.is_empty());
    }

    #[test]
    fn test_marks_to_choices_dropped_write_in() {
        let candidates = create_test_candidates();
        let marks = vec![
            RankedMark::new(1, 1),  // Alice first
            RankedMark::new(99, 2), // Write-in second (will be dropped)
            RankedMark::new(2, 3),  // Bob third
        ];

        let choices = marks_to_choices(&marks, &candidates, Some(99));

        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0], Choice::Vote(CandidateId(0))); // Alice
        assert_eq!(choices[1], Choice::Vote(CandidateId(1))); // Bob (write-in filtered out)
    }

    #[test]
    fn test_marks_to_choices_unsorted_input() {
        let candidates = create_test_candidates();
        // Marks in wrong order - should still work
        let marks = vec![
            RankedMark::new(3, 3), // Charlie third
            RankedMark::new(1, 1), // Alice first
            RankedMark::new(2, 2), // Bob second
        ];

        let choices = marks_to_choices(&marks, &candidates, None);

        assert_eq!(choices.len(), 3);
        assert_eq!(choices[0], Choice::Vote(CandidateId(0))); // Alice
        assert_eq!(choices[1], Choice::Vote(CandidateId(1))); // Bob
        assert_eq!(choices[2], Choice::Vote(CandidateId(2))); // Charlie
    }

    #[test]
    fn test_json_marks_to_choices_filters_ambiguous() {
        let candidates = create_test_candidates();
        let marks = vec![
            Mark {
                candidate_id: 1,
                rank: 1,
                is_ambiguous: false,
                party_id: None,
                mark_density: 100,
                is_vote: true,
            },
            Mark {
                candidate_id: 2,
                rank: 2,
                is_ambiguous: true, // This should be filtered out
                party_id: None,
                mark_density: 50,
                is_vote: false,
            },
            Mark {
                candidate_id: 3,
                rank: 3,
                is_ambiguous: false,
                party_id: None,
                mark_density: 100,
                is_vote: true,
            },
        ];

        let choices = json_marks_to_choices(&marks, &candidates, None);

        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0], Choice::Vote(CandidateId(0))); // Alice
        assert_eq!(choices[1], Choice::Vote(CandidateId(2))); // Charlie (Bob was filtered)
    }

    #[test]
    fn test_csv_marks_to_choices() {
        let candidates = create_test_candidates();
        let marks = vec![
            (1, 1), // Alice first
            (2, 2), // Bob second
        ];

        let choices = csv_marks_to_choices(&marks, &candidates, None);

        assert_eq!(choices.len(), 2);
        assert_eq!(choices[0], Choice::Vote(CandidateId(0))); // Alice
        assert_eq!(choices[1], Choice::Vote(CandidateId(1))); // Bob
    }

    #[test]
    fn test_csv_marks_to_choices_with_dropped_write_in() {
        let candidates = create_test_candidates();
        let marks = vec![
            (99, 1), // Write-in first (will be dropped)
            (1, 2),  // Alice second
        ];

        let choices = csv_marks_to_choices(&marks, &candidates, Some(99));

        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0], Choice::Vote(CandidateId(0))); // Alice (write-in filtered)
    }
}
