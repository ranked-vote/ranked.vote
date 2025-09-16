use crate::model::election::{Ballot, Choice, NormalizedBallot};
use std::collections::BTreeSet;

pub fn nyc_normalizer(ballot: Ballot) -> Option<NormalizedBallot> {
    // NYC-style normalization: completely exclude ballots with no valid votes
    // This prevents inactive ballots from being processed at all
    let mut seen = BTreeSet::new();
    let Ballot { id, choices } = ballot;
    let mut new_choices = Vec::new();
    let mut overvoted = false;
    let mut has_valid_votes = false;

    for choice in choices {
        match choice {
            Choice::Vote(v) => {
                if !seen.contains(&v) {
                    seen.insert(v);
                    new_choices.push(v);
                    has_valid_votes = true;
                }
            }
            Choice::Overvote => {
                overvoted = true;
                break;
            }
            _ => (), // Ignore undervotes
        }
    }

    // Only return a normalized ballot if it has valid votes
    if has_valid_votes {
        Some(NormalizedBallot::new(id, new_choices, overvoted))
    } else {
        None // Completely exclude inactive ballots
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::election::{CandidateId, Choice};

    #[test]
    fn test_pass_through() {
        let c1 = Choice::Vote(CandidateId(1));
        let c2 = Choice::Vote(CandidateId(2));
        let c3 = Choice::Vote(CandidateId(3));
        let b = Ballot::new("1".into(), vec![c1, c2, c3]);

        let normalized = nyc_normalizer(b).unwrap();
        assert_eq!(
            vec![CandidateId(1), CandidateId(2), CandidateId(3)],
            normalized.choices()
        );
        assert_eq!(false, normalized.overvoted);
        assert_eq!("1", normalized.id);
    }

    #[test]
    fn test_undervote_only() {
        let b = Ballot::new("1".into(), vec![Choice::Undervote, Choice::Undervote]);
        assert!(nyc_normalizer(b).is_none());
    }

    #[test]
    fn test_overvote_only() {
        let b = Ballot::new("1".into(), vec![Choice::Overvote]);
        assert!(nyc_normalizer(b).is_none());
    }

    #[test]
    fn test_mixed_undervote() {
        let c1 = Choice::Vote(CandidateId(1));
        let c2 = Choice::Vote(CandidateId(2));
        let b = Ballot::new("1".into(), vec![c1, Choice::Undervote, c2]);

        let normalized = nyc_normalizer(b).unwrap();
        assert_eq!(vec![CandidateId(1), CandidateId(2)], normalized.choices());
        assert_eq!(false, normalized.overvoted);
        assert_eq!("1", normalized.id);
    }

    #[test]
    fn test_overvote_with_valid_votes() {
        let c1 = Choice::Vote(CandidateId(1));
        let c2 = Choice::Vote(CandidateId(2));
        let b = Ballot::new("1".into(), vec![c1, Choice::Overvote, c2]);

        let normalized = nyc_normalizer(b).unwrap();
        assert_eq!(vec![CandidateId(1)], normalized.choices());
        assert_eq!(true, normalized.overvoted);
        assert_eq!("1", normalized.id);
    }
}
