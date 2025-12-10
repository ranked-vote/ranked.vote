use crate::model::election::{Ballot, Candidate, CandidateId, CandidateType, Choice, Election};
use regex::Regex;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

struct ReaderOptions {
    ballots: String,
    archive: Option<String>,
}

impl ReaderOptions {
    pub fn from_params(params: BTreeMap<String, String>) -> Self {
        let ballots = params
            .get("ballots")
            .expect("BTV elections should have ballots parameter.")
            .clone();
        let archive = params.get("archive").cloned();

        ReaderOptions { ballots, archive }
    }
}

pub fn parse_ballot(source: &str) -> Vec<Choice> {
    if source.is_empty() {
        return vec![];
    }

    let ranks = source.split(',');
    let mut choices = Vec::new();

    for rank in ranks {
        let choice = if rank.contains('=') {
            Choice::Overvote
        } else if let Some(candidate_id) = rank.strip_prefix('C') {
            let candidate_id: u32 = candidate_id.parse().unwrap();
            Choice::Vote(CandidateId(candidate_id - 1))
        } else {
            panic!("Bad candidate list ({}).", rank)
        };
        choices.push(choice);
    }

    choices
}

pub fn btv_ballot_reader(path: &Path, params: BTreeMap<String, String>) -> Election {
    let options = ReaderOptions::from_params(params);

    // Try multiple path variations to handle archive extraction
    let mut ballots_path = path.join(&options.ballots);

    // If the file doesn't exist and we have an archive parameter, try prepending the archive directory name
    if !ballots_path.exists() {
        if let Some(ref archive) = options.archive {
            // Remove .zip extension if present to get the directory name
            let archive_dir = if archive.ends_with(".zip") {
                &archive[..archive.len() - 4]
            } else {
                archive
            };
            // Try: archive_dir/ballots_path
            let alternative_path = path.join(archive_dir).join(&options.ballots);
            if alternative_path.exists() {
                ballots_path = alternative_path;
            } else {
                // Try: archive_dir/filename (if ballots_path has a filename component)
                if let Some(filename) = Path::new(&options.ballots).file_name() {
                    let alternative_path2 = path.join(archive_dir).join(filename);
                    if alternative_path2.exists() {
                        ballots_path = alternative_path2;
                    }
                }
            }
        }
    }

    let file = match File::open(&ballots_path) {
        Ok(file) => file,
        Err(e) => {
            crate::log_warn!(
                "Failed to open BTV ballots file '{}': {}\n   Please ensure the file exists and is readable.\n   Run extract-from-archives.sh to extract data from archives.",
                ballots_path.display(),
                e
            );
            return Election::new(vec![], vec![]);
        }
    };
    let lines = BufReader::new(file).lines();

    let candidate_rx = Regex::new(r#".CANDIDATE C(\d+), "(.+)""#).unwrap();
    let ballot_rx = Regex::new(r#"([^,]+), \d\) (.+)"#).unwrap();

    let mut candidates: Vec<Candidate> = Vec::new();
    let mut ballots: Vec<Ballot> = Vec::new();

    for line in lines {
        let line = line.unwrap();

        if let Some(caps) = candidate_rx.captures(&line) {
            let id: u32 = caps.get(1).unwrap().as_str().parse().unwrap();
            let name: String = caps.get(2).unwrap().as_str().into();
            assert_eq!(id - 1, candidates.len() as u32);

            candidates.push(Candidate::new(name, CandidateType::Regular));
        } else if let Some(caps) = ballot_rx.captures(&line) {
            let id: &str = caps.get(1).unwrap().as_str();
            let votes: &str = caps.get(2).unwrap().as_str();

            let choices = parse_ballot(votes);
            let ballot = Ballot::new(id.into(), choices);
            ballots.push(ballot);
        }
    }

    Election {
        candidates,
        ballots,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ballot() {
        assert_eq!(Vec::new() as Vec<Choice>, parse_ballot(""));

        assert_eq!(vec![Choice::Vote(CandidateId(3))], parse_ballot("C04"));

        assert_eq!(
            vec![Choice::Vote(CandidateId(3)), Choice::Vote(CandidateId(2))],
            parse_ballot("C04,C03")
        );

        assert_eq!(
            vec![Choice::Overvote, Choice::Vote(CandidateId(2))],
            parse_ballot("C04=C06,C03")
        );
    }
}
