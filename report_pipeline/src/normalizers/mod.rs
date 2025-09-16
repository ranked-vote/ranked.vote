mod maine;
mod nyc;
mod simple;

use crate::model::election::{Ballot, Election, NormalizedBallot, NormalizedElection};

type BallotNormalizer = dyn Fn(Ballot) -> NormalizedBallot;
type OptionalBallotNormalizer = dyn Fn(Ballot) -> Option<NormalizedBallot>;

fn get_normalizer_for_format(format: &str) -> &'static BallotNormalizer {
    match format {
        "simple" => &simple::simple_normalizer,
        "maine" => &maine::maine_normalizer,
        _ => panic!("The normalizer {} is not implemented.", format),
    }
}

fn get_optional_normalizer_for_format(format: &str) -> Option<&'static OptionalBallotNormalizer> {
    match format {
        "nyc" => Some(&nyc::nyc_normalizer),
        _ => None,
    }
}

pub fn normalize_election(format: &str, election: Election) -> NormalizedElection {
    if let Some(optional_normalizer) = get_optional_normalizer_for_format(format) {
        // For NYC-style normalization, filter out inactive ballots
        let ballots: Vec<NormalizedBallot> = election
            .ballots
            .into_iter()
            .filter_map(optional_normalizer)
            .collect();

        NormalizedElection {
            candidates: election.candidates,
            ballots,
        }
    } else {
        // For standard normalization, process all ballots
        let normalizer = get_normalizer_for_format(format);
        let ballots = election.ballots.into_iter().map(normalizer).collect();

        NormalizedElection {
            candidates: election.candidates,
            ballots,
        }
    }
}
