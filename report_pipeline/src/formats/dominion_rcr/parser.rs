use crate::formats::common::normalize_name;
use crate::model::election::{Ballot, Candidate, CandidateId, CandidateType, Choice, Election};
use nom::{
    character::complete::{char, digit1, line_ending, not_line_ending, tab},
    combinator::all_consuming,
    multi::{count, separated_list1},
    sequence::terminated,
    IResult, Parser,
};

pub fn unsigned_int(i: &str) -> IResult<&str, u32> {
    let (i, digits) = digit1(i)?;
    let num: u32 = digits.parse().unwrap();
    Ok((i, num))
}

struct RcrHeader {
    #[allow(unused)]
    pub num_seats: u32,
    pub num_candidates: u32,
    pub num_precincts: u32,
    pub num_counting_groups: u32,
}

fn parse_header(i: &str) -> IResult<&str, RcrHeader> {
    let (i, num_seats) = terminated(unsigned_int, tab).parse(i)?;
    let (i, num_candidates) = terminated(unsigned_int, tab).parse(i)?;
    let (i, num_precincts) = terminated(unsigned_int, tab).parse(i)?;
    let (i, num_counting_groups) = terminated(unsigned_int, line_ending).parse(i)?;

    let header = RcrHeader {
        num_seats,
        num_candidates,
        num_precincts,
        num_counting_groups,
    };
    Ok((i, header))
}

fn candidate(i: &str) -> IResult<&str, Candidate> {
    let (i, name) = terminated(not_line_ending, line_ending).parse(i)?;
    Ok((
        i,
        Candidate::new(normalize_name(name, false), CandidateType::Regular),
    ))
}

fn numbered(i: &str) -> IResult<&str, ()> {
    let (i, _number) = terminated(unsigned_int, tab).parse(i)?;
    let (i, _name) = terminated(not_line_ending, line_ending).parse(i)?;
    Ok((i, ()))
}

fn choice(i: &str) -> IResult<&str, Choice> {
    let (i, candidate_id) = unsigned_int(i)?;

    let choice = if candidate_id == 0 {
        Choice::Undervote
    } else {
        Choice::Vote(CandidateId(candidate_id - 1))
    };

    Ok((i, choice))
}

fn ballot_entry(i: &str) -> IResult<&str, Choice> {
    let (i, choices) = separated_list1(char('='), choice).parse(i)?;
    let choice = match choices.as_slice() {
        [choice] => *choice,
        _ => Choice::Overvote,
    };

    Ok((i, choice))
}

fn ballot(i: &str) -> IResult<&str, (u32, Vec<Choice>)> {
    let (i, _precinct) = terminated(unsigned_int, tab).parse(i)?;
    let (i, _counting_group) = terminated(unsigned_int, tab).parse(i)?;
    let (i, ballot_count) = terminated(unsigned_int, tab).parse(i)?;

    let (i, choices) = separated_list1(tab, ballot_entry).parse(i)?;

    Ok((i, (ballot_count, choices)))
}

pub fn parse_rcr_file(i: &str) -> IResult<&str, Election> {
    // Parse header line.
    let (i, header) = parse_header(i)?;

    // Parse election name.
    let (i, _name) = terminated(not_line_ending, line_ending).parse(i)?;

    let (i, candidates) = count(candidate, header.num_candidates as usize).parse(i)?;
    let (i, _) = count(numbered, header.num_precincts as usize).parse(i)?;
    let (i, _) = count(numbered, header.num_counting_groups as usize).parse(i)?;

    let (i, agg_ballots) =
        terminated(separated_list1(line_ending, ballot), line_ending).parse(i)?;

    let mut ballots: Vec<Ballot> = Vec::new();

    for (num, choices) in agg_ballots {
        for _ in 0..num {
            ballots.push(Ballot::new(ballots.len().to_string(), choices.clone()));
        }
    }

    Ok((i, Election::new(candidates, ballots)))
}

pub fn rcr_file(i: &str) -> Election {
    let (_, result) = all_consuming(parse_rcr_file).parse(i).unwrap();
    result
}
