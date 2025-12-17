use crate::formats::read_election;
use crate::model::election::{
    CandidateId, CandidateType, Election, ElectionInfo, ElectionPreprocessed, NormalizedBallot,
};
use crate::model::metadata::{Contest, ElectionMetadata, Jurisdiction};
use crate::model::report::{
    CandidatePairEntry, CandidatePairTable, CandidateVotes, ContestReport, RankingDistribution,
};
use crate::normalizers::normalize_election;
use crate::tabulator::{tabulate, Allocatee, TabulatorRound};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

pub fn winner(rounds: &[TabulatorRound]) -> Option<CandidateId> {
    rounds
        .last()
        .and_then(|round| round.allocations.first())
        .and_then(|allocation| allocation.allocatee.candidate_id())
}

pub fn total_votes(rounds: &[TabulatorRound]) -> Vec<CandidateVotes> {
    let candidate_to_initial_votes: BTreeMap<CandidateId, u32> = rounds[0]
        .allocations
        .iter()
        .flat_map(|x| match x.allocatee {
            Allocatee::Candidate(y) => Some((y, x.votes)),
            _ => None,
        })
        .collect();

    let mut candidate_to_final_votes: BTreeMap<CandidateId, u32> =
        candidate_to_initial_votes.clone();

    let mut round_eliminated: BTreeMap<CandidateId, u32> = BTreeMap::new();

    for (i, round) in rounds[1..].iter().enumerate() {
        for alloc in &round.allocations {
            if let Allocatee::Candidate(c) = alloc.allocatee {
                candidate_to_final_votes.insert(c, alloc.votes);
            }
        }

        for transfer in &round.transfers {
            round_eliminated.insert(transfer.from, (i + 1) as u32);
        }
    }

    let mut result: Vec<CandidateVotes> = candidate_to_initial_votes
        .into_iter()
        .map(|(candidate, first_round_votes)| CandidateVotes {
            candidate,
            first_round_votes,
            transfer_votes: candidate_to_final_votes[&candidate] - first_round_votes,
            round_eliminated: round_eliminated.get(&candidate).cloned(),
        })
        .collect();

    result.sort_by_key(|d| -((d.first_round_votes + d.transfer_votes) as i32));

    result
}

pub fn generate_pairwise_counts(
    candidates: &[CandidateId],
    ballots: &[NormalizedBallot],
) -> HashMap<(CandidateId, CandidateId), u32> {
    let mut preference_map: HashMap<(CandidateId, CandidateId), u32> = HashMap::new();
    let all_candidates: HashSet<CandidateId> = candidates.iter().copied().collect();

    for ballot in ballots {
        let mut above_ranked: HashSet<CandidateId> = HashSet::new();

        for vote in ballot.choices() {
            for arc in &above_ranked {
                *preference_map.entry((*arc, vote)).or_insert(0) += 1;
            }

            above_ranked.insert(vote);
        }

        let remaining = all_candidates.difference(&above_ranked);

        for candidate in remaining {
            for arc in &above_ranked {
                *preference_map.entry((*arc, *candidate)).or_insert(0) += 1;
            }
        }
    }

    preference_map
}

pub fn generate_pairwise_preferences(
    candidates: &[CandidateId],
    preference_map: &HashMap<(CandidateId, CandidateId), u32>,
) -> CandidatePairTable {
    let axis: Vec<Allocatee> = candidates
        .iter()
        .map(|d| Allocatee::Candidate(*d))
        .collect();

    let entries: Vec<Vec<Option<CandidatePairEntry>>> = candidates
        .iter()
        .map(|c1| {
            candidates
                .iter()
                .map(|c2| {
                    let m1 = preference_map.get(&(*c1, *c2)).unwrap_or(&0);
                    let m2 = preference_map.get(&(*c2, *c1)).unwrap_or(&0);
                    let count = m1 + m2;

                    if count == 0 {
                        None
                    } else {
                        Some(CandidatePairEntry::new(*m1, count))
                    }
                })
                .collect()
        })
        .collect();

    CandidatePairTable {
        entries,
        rows: axis.clone(),
        cols: axis,
    }
}

pub fn generate_first_alternate(
    candidates: &[CandidateId],
    ballots: &[NormalizedBallot],
) -> CandidatePairTable {
    let mut first_choice_count: HashMap<CandidateId, u32> = HashMap::new();
    let mut alternate_map: HashMap<(CandidateId, Allocatee), u32> = HashMap::new();

    for ballot in ballots {
        let choices = ballot.choices();
        if let Some(first) = choices.first() {
            let second = choices
                .get(1)
                .map(|d| Allocatee::Candidate(*d))
                .unwrap_or(Allocatee::Exhausted);
            *alternate_map.entry((*first, second)).or_insert(0) += 1;
            *first_choice_count.entry(*first).or_insert(0) += 1;
        }
    }

    let rows: Vec<Allocatee> = candidates
        .iter()
        .map(|d| Allocatee::Candidate(*d))
        .collect();
    let mut cols = rows.clone();
    cols.push(Allocatee::Exhausted);

    let entries: Vec<Vec<Option<CandidatePairEntry>>> = candidates
        .iter()
        .map(|c1| {
            let denominator = *first_choice_count.get(c1).unwrap_or(&0);

            cols.iter()
                .map(|c2| {
                    let count = *alternate_map.get(&(*c1, *c2)).unwrap_or(&0);
                    if count == 0 {
                        None
                    } else {
                        Some(CandidatePairEntry::new(count, denominator))
                    }
                })
                .collect()
        })
        .collect();

    CandidatePairTable {
        entries,
        rows,
        cols,
    }
}

pub fn generate_first_final(
    candidates: &[CandidateId],
    ballots: &[NormalizedBallot],
    final_round_candidates: &HashSet<CandidateId>,
) -> CandidatePairTable {
    let mut first_final: HashMap<(CandidateId, Allocatee), u32> = HashMap::new();
    let mut first_total: HashMap<CandidateId, u32> = HashMap::new();

    for ballot in ballots {
        let choices = ballot.choices();
        if let Some(first) = choices.first() {
            if !final_round_candidates.contains(first) {
                let final_choice = match choices.iter().find(|x| final_round_candidates.contains(x))
                {
                    Some(v) => Allocatee::Candidate(*v),
                    _ => Allocatee::Exhausted,
                };

                *first_final.entry((*first, final_choice)).or_insert(0) += 1;
                *first_total.entry(*first).or_insert(0) += 1;
            }
        }
    }

    let rows: Vec<Allocatee> = candidates
        .iter()
        .filter(|x| !final_round_candidates.contains(x))
        .map(|d| Allocatee::Candidate(*d))
        .collect();

    let mut cols: Vec<Allocatee> = candidates
        .iter()
        .filter(|x| final_round_candidates.contains(x))
        .map(|d| Allocatee::Candidate(*d))
        .collect();
    cols.push(Allocatee::Exhausted);

    let entries: Vec<Vec<Option<CandidatePairEntry>>> = rows
        .iter()
        .map(|c1| {
            let total = *first_total.get(&c1.candidate_id().unwrap()).unwrap();

            cols.iter()
                .map(|c2| {
                    let count = *first_final
                        .get(&(c1.candidate_id().unwrap(), *c2))
                        .unwrap_or(&0);
                    if count == 0 {
                        None
                    } else {
                        Some(CandidatePairEntry::new(count, total))
                    }
                })
                .collect()
        })
        .collect();

    CandidatePairTable {
        entries,
        rows,
        cols,
    }
}

/// Generate ranking distribution statistics from normalized ballots.
/// This function is format-agnostic and works with all CVR formats since
/// all formats normalize to NormalizedBallot before report generation.
pub fn generate_ranking_distribution(
    _candidates: &[CandidateId],
    ballots: &[NormalizedBallot],
) -> RankingDistribution {
    let mut overall_distribution: BTreeMap<u32, u32> = BTreeMap::new();
    let mut candidate_distributions: BTreeMap<CandidateId, BTreeMap<u32, u32>> = BTreeMap::new();
    let mut candidate_totals: BTreeMap<CandidateId, u32> = BTreeMap::new();
    let mut total_ballots = 0u32;

    // Filter ballots to only those that ranked at least one candidate
    for ballot in ballots {
        let choices = ballot.choices();
        if choices.is_empty() {
            continue;
        }

        total_ballots += 1;
        let rank_count = choices.len() as u32;

        // Update overall distribution
        *overall_distribution.entry(rank_count).or_insert(0) += 1;

        // Update candidate-specific distributions
        if let Some(first_choice) = choices.first() {
            *candidate_totals.entry(*first_choice).or_insert(0) += 1;
            let candidate_dist = candidate_distributions.entry(*first_choice).or_default();
            *candidate_dist.entry(rank_count).or_insert(0) += 1;
        }
    }

    RankingDistribution {
        overall_distribution,
        candidate_distributions,
        total_ballots,
        candidate_totals,
    }
}

pub fn graph(
    candidates: &[CandidateId],
    preference_map: &HashMap<(CandidateId, CandidateId), u32>,
) -> HashMap<CandidateId, Vec<CandidateId>> {
    let mut graph = HashMap::new();

    for c1 in candidates {
        for c2 in candidates {
            let c1v = preference_map.get(&(*c1, *c2)).unwrap_or(&0);
            let c2v = preference_map.get(&(*c2, *c1)).unwrap_or(&0);

            if c1v > c2v {
                // Directed edge from pairwise winner to pairwise loser.
                graph.entry(*c1).or_insert_with(Vec::new).push(*c2);
            }
        }
    }

    graph
}

pub fn smith_set(
    candidates: &[CandidateId],
    graph: &HashMap<CandidateId, Vec<CandidateId>>,
) -> HashSet<CandidateId> {
    // Compute the "top" strongly-connected component(s) in the pairwise dominance graph:
    // the union of SCCs with zero in-degree in the condensation graph.
    // (In a tournament graph, this equals the Smith/Schwartz/top-cycle set, and is a
    // singleton exactly when a Condorcet winner exists.)

    // Index candidates for SCC algorithm.
    let mut idx_by_id = HashMap::<CandidateId, usize>::new();
    for (i, cid) in candidates.iter().enumerate() {
        idx_by_id.insert(*cid, i);
    }

    let n = candidates.len();
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut radj: Vec<Vec<usize>> = vec![Vec::new(); n];

    for (from, tos) in graph {
        let Some(&u) = idx_by_id.get(from) else {
            continue;
        };
        for to in tos {
            let Some(&v) = idx_by_id.get(to) else {
                continue;
            };
            if u == v {
                continue;
            }
            adj[u].push(v);
            radj[v].push(u);
        }
    }

    // Kosaraju SCC
    let mut visited = vec![false; n];
    let mut order: Vec<usize> = Vec::with_capacity(n);
    fn dfs1(u: usize, adj: &Vec<Vec<usize>>, visited: &mut Vec<bool>, order: &mut Vec<usize>) {
        visited[u] = true;
        for &v in &adj[u] {
            if !visited[v] {
                dfs1(v, adj, visited, order);
            }
        }
        order.push(u);
    }
    for u in 0..n {
        if !visited[u] {
            dfs1(u, &adj, &mut visited, &mut order);
        }
    }

    let mut comp_id: Vec<usize> = vec![usize::MAX; n];
    let mut comp_count = 0;
    fn dfs2(u: usize, radj: &Vec<Vec<usize>>, comp_id: &mut Vec<usize>, cid: usize) {
        comp_id[u] = cid;
        for &v in &radj[u] {
            if comp_id[v] == usize::MAX {
                dfs2(v, radj, comp_id, cid);
            }
        }
    }
    for &u in order.iter().rev() {
        if comp_id[u] == usize::MAX {
            dfs2(u, &radj, &mut comp_id, comp_count);
            comp_count += 1;
        }
    }

    // Compute in-degrees between SCCs.
    let mut indeg = vec![0u32; comp_count];
    for u in 0..n {
        let cu = comp_id[u];
        for &v in &adj[u] {
            let cv = comp_id[v];
            if cu != cv {
                indeg[cv] += 1;
            }
        }
    }

    // Top SCCs are those with zero in-degree.
    let mut top_components = HashSet::<usize>::new();
    for (cid, d) in indeg.iter().enumerate() {
        if *d == 0 {
            top_components.insert(cid);
        }
    }

    let mut result = HashSet::<CandidateId>::new();
    for (i, candidate) in candidates.iter().enumerate() {
        if top_components.contains(&comp_id[i]) {
            result.insert(*candidate);
        }
    }
    result
}

/// Generate a `ContestReport` from preprocessed election data.
pub fn generate_report(election: &ElectionPreprocessed) -> ContestReport {
    let ballots = &election.ballots.ballots;

    // Handle empty elections
    if ballots.is_empty() {
        return ContestReport {
            info: election.info.clone(),
            ballot_count: 0,
            candidates: election.ballots.candidates.clone(),
            winner: None,
            num_candidates: 0,
            rounds: vec![],
            total_votes: vec![],
            pairwise_preferences: CandidatePairTable {
                entries: vec![],
                rows: vec![],
                cols: vec![],
            },
            first_alternate: CandidatePairTable {
                entries: vec![],
                rows: vec![],
                cols: vec![],
            },
            first_final: CandidatePairTable {
                entries: vec![],
                rows: vec![],
                cols: vec![],
            },
            ranking_distribution: Some(RankingDistribution {
                overall_distribution: BTreeMap::new(),
                candidate_distributions: BTreeMap::new(),
                total_ballots: 0,
                candidate_totals: BTreeMap::new(),
            }),
            smith_set: vec![],
            condorcet: None,
        };
    }

    crate::log_debug!("  - Tabulating rounds...");
    let rounds = tabulate(ballots, &election.info.tabulation_options);
    let winner = winner(&rounds);
    let num_candidates = election
        .ballots
        .candidates
        .iter()
        .filter(|d| d.candidate_type != CandidateType::WriteIn)
        .count() as u32;

    crate::log_debug!("  - Calculating total votes...");
    let total_votes = total_votes(&rounds);
    let mut candidates: Vec<CandidateId> = total_votes.iter().map(|d| d.candidate).collect();
    candidates.sort(); // Ensure consistent ordering
    crate::log_debug!("  - Found {} candidates", candidates.len());

    crate::log_debug!("  - Generating pairwise counts...");
    let pairwise_counts: HashMap<(CandidateId, CandidateId), u32> =
        generate_pairwise_counts(&candidates, ballots);

    crate::log_debug!("  - Generating pairwise preferences...");
    let pairwise_preferences = generate_pairwise_preferences(&candidates, &pairwise_counts);

    crate::log_debug!("  - Building preference graph...");
    let graph = graph(&candidates, &pairwise_counts);

    crate::log_debug!("  - Finding Smith set...");
    let smith_set = smith_set(&candidates, &graph);

    let condorcet = if smith_set.len() == 1 {
        smith_set.iter().next().copied()
    } else {
        None
    };

    if winner.is_some() && winner != condorcet {
        crate::log_debug!("Non-condorcet!");
    }

    crate::log_debug!("  - Generating first alternate matrix...");
    let first_alternate = generate_first_alternate(&candidates, ballots);

    crate::log_debug!("  - Determining final round candidates...");
    let final_round_candidates: HashSet<CandidateId> = rounds
        .last()
        .map(|round| {
            round
                .allocations
                .iter()
                .flat_map(|a| a.allocatee.candidate_id())
                .collect()
        })
        .unwrap_or_default();

    crate::log_debug!("  - Generating first-final matrix...");
    let first_final = generate_first_final(&candidates, ballots, &final_round_candidates);

    crate::log_debug!("  - Generating ranking distribution...");
    let ranking_distribution = generate_ranking_distribution(&candidates, ballots);

    crate::log_debug!("  - Building final report structure...");

    // Sort vectors for consistent JSON output
    let mut sorted_smith_set: Vec<CandidateId> = smith_set.into_iter().collect();
    sorted_smith_set.sort();

    let mut sorted_total_votes = total_votes;
    sorted_total_votes.sort_by_key(|v| v.candidate);

    ContestReport {
        info: election.info.clone(),
        ballot_count: election.ballots.ballots.len() as u32,
        candidates: election.ballots.candidates.clone(),
        winner,
        num_candidates,
        rounds,
        total_votes: sorted_total_votes,
        pairwise_preferences,
        first_alternate,
        first_final,
        ranking_distribution: Some(ranking_distribution),
        smith_set: sorted_smith_set,
        condorcet,
    }
}

/// Preprocess an election by reading and normalizing the raw ballot data according
/// to the rules given in the metadata for this contest.
pub fn preprocess_election(
    raw_base: &Path,
    metadata: &ElectionMetadata,
    election_path: &str,
    ec: &Jurisdiction,
    contest: &Contest,
) -> ElectionPreprocessed {
    let election = read_election(
        &metadata.data_format,
        &raw_base.join(election_path),
        contest.loader_params.clone().unwrap_or_default(),
    );
    let office = ec.offices.get(&contest.office).unwrap();

    let normalized_election = normalize_election(&metadata.normalization, election);

    ElectionPreprocessed {
        info: ElectionInfo {
            name: office.name.clone(),
            office: contest.office.clone(),
            date: metadata.date.clone(),
            data_format: metadata.data_format.clone(),
            tabulation_options: metadata.tabulation_options.clone().unwrap_or_default(),
            loader_params: contest.loader_params.clone(),
            jurisdiction_path: ec.path.clone(),
            election_path: election_path.to_string(),
            jurisdiction_name: ec.name.clone(),
            office_name: office.name.clone(),
            election_name: metadata.name.clone(),
            website: metadata.website.clone(),
        },
        ballots: normalized_election,
    }
}

/// Preprocess an election from already-loaded election data
/// This is used for batch processing where elections are loaded once and reused
pub fn preprocess_election_from_data(
    election: Election,
    metadata: &ElectionMetadata,
    jurisdiction: &Jurisdiction,
    contest: &Contest,
    election_path: &str,
) -> ElectionPreprocessed {
    let normalized_election = normalize_election(&metadata.normalization, election);
    let office = jurisdiction.offices.get(&contest.office).unwrap();

    ElectionPreprocessed {
        info: ElectionInfo {
            name: office.name.clone(),
            office: contest.office.clone(),
            date: metadata.date.clone(),
            data_format: metadata.data_format.clone(),
            tabulation_options: metadata.tabulation_options.clone().unwrap_or_default(),
            loader_params: contest.loader_params.clone(),
            jurisdiction_path: jurisdiction.path.clone(),
            election_path: election_path.to_string(),
            jurisdiction_name: jurisdiction.name.clone(),
            office_name: office.name.clone(),
            election_name: metadata.name.clone(),
            website: metadata.website.clone(),
        },
        ballots: normalized_election,
    }
}
