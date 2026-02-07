/**
 * RCV (Instant Runoff Voting) tabulator.
 *
 * Ported from report_pipeline/src/tabulator/mod.rs.
 * Takes normalized ballots and produces round-by-round results.
 */

import type {
  ITabulatorRound,
  ITabulatorAllocation,
  Transfer,
  Allocatee,
  CandidateId,
} from "../src/report_types";

// ---------- Input types ----------

export interface NormalizedBallot {
  id: string;
  choices: CandidateId[]; // ranked list of candidate indices
  overvoted: boolean;
}

export interface TabulationOptions {
  eager?: boolean;
  nycStyle?: boolean;
}

// ---------- Internal types ----------

type Choice = { type: "vote"; candidate: CandidateId } | { type: "undervote" } | { type: "overvote" };

interface BallotState {
  choices: CandidateId[];
  overvoted: boolean;
}

function topVote(ballot: BallotState): Choice {
  if (ballot.choices.length > 0) {
    return { type: "vote", candidate: ballot.choices[0] };
  }
  return ballot.overvoted ? { type: "overvote" } : { type: "undervote" };
}

function popTopVote(ballot: BallotState): BallotState {
  return {
    choices: ballot.choices.slice(1),
    overvoted: ballot.overvoted,
  };
}

function choiceKey(c: Choice): string {
  if (c.type === "vote") return `v${c.candidate}`;
  return c.type;
}

function choiceToAllocatee(c: Choice): Allocatee {
  if (c.type === "vote") return c.candidate;
  return "X";
}

// ---------- Tabulator ----------

export function tabulate(
  ballots: NormalizedBallot[],
  options: TabulationOptions = {}
): ITabulatorRound[] {
  // Empty contest: return no rounds (matching Rust behavior)
  if (ballots.length === 0) return [];

  // Initial allocation: group ballots by top choice
  const candidateBallots = new Map<string, BallotState[]>();
  for (const ballot of ballots) {
    const state: BallotState = { choices: [...ballot.choices], overvoted: ballot.overvoted };
    const choice = topVote(state);
    const key = choiceKey(choice);
    if (!candidateBallots.has(key)) candidateBallots.set(key, []);
    candidateBallots.get(key)!.push(state);
  }

  const eliminated = new Set<CandidateId>();
  let currentTransfers: Transfer[] = [];
  const rounds: ITabulatorRound[] = [];
  const maxRounds = 1000;

  for (let roundNumber = 0; roundNumber <= maxRounds; roundNumber++) {
    // Count allocations
    const voteCounts = new Map<CandidateId, number>();
    let exhausted = 0;

    for (const [key, ballotList] of candidateBallots) {
      const count = ballotList.length;
      if (key === "undervote") {
        if (!(options.nycStyle && roundNumber === 0)) {
          exhausted += count;
        }
      } else if (key === "overvote") {
        if (!(options.nycStyle && roundNumber === 0)) {
          exhausted += count;
        }
      } else {
        // key is "v{candidateId}"
        const candidateId = parseInt(key.slice(1), 10);
        voteCounts.set(candidateId, count);
      }
    }

    // Sort candidates descending by votes
    const sortedVotes = Array.from(voteCounts.entries()).sort((a, b) => b[1] - a[1]);
    const continuing = sortedVotes.reduce((sum, [, v]) => sum + v, 0);

    // Build allocations (candidates sorted desc by votes, then exhausted)
    const allocations: ITabulatorAllocation[] = sortedVotes.map(([cid, votes]) => ({
      allocatee: cid as Allocatee,
      votes,
    }));
    allocations.push({ allocatee: "X", votes: exhausted });

    // Count undervotes and overvotes for the round
    const undervote = candidateBallots.get("undervote")?.length ?? 0;
    const overvote = candidateBallots.get("overvote")?.length ?? 0;

    rounds.push({
      allocations,
      undervote,
      overvote,
      continuingBallots: continuing,
      transfers: currentTransfers,
    });

    // Stop if 2 or fewer candidates remain
    if (sortedVotes.length <= 2) break;
    if (roundNumber >= maxRounds) break;

    // Determine which candidates to eliminate
    const isEager = options.eager ?? false;
    let candidatesToEliminate: Set<CandidateId>;

    if (isEager) {
      // Eager mode: eliminate all candidates that cannot mathematically win.
      // Walk from top, subtracting votes. When a candidate's votes exceed
      // the remaining sum below them (and we've passed at least the first),
      // everyone below is eliminated.
      let remainingVotes = continuing;
      let cutoff = sortedVotes.length; // default: no elimination

      for (let i = 0; i < sortedVotes.length; i++) {
        remainingVotes -= sortedVotes[i][1];
        if (sortedVotes[i][1] > remainingVotes && i > 0) {
          cutoff = i + 1;
          break;
        }
      }

      const toEliminate = new Set<CandidateId>(
        sortedVotes.slice(cutoff).map(([cid]) => cid)
      );

      // If no candidates would be eliminated (e.g. all tied), eliminate the last one
      if (toEliminate.size === 0 && sortedVotes.length > 0) {
        toEliminate.add(sortedVotes[sortedVotes.length - 1][0]);
      }

      candidatesToEliminate = toEliminate;
    } else {
      // Non-eager mode: eliminate only the single candidate with the fewest votes.
      candidatesToEliminate = new Set<CandidateId>();
      if (sortedVotes.length > 0) {
        candidatesToEliminate.add(sortedVotes[sortedVotes.length - 1][0]);
      }
    }

    // Mark candidates as eliminated
    for (const cid of candidatesToEliminate) {
      eliminated.add(cid);
    }

    // Transfer ballots from eliminated candidates
    const allTransfers: Transfer[] = [];

    for (const eliminatedCid of candidatesToEliminate) {
      const key = `v${eliminatedCid}`;
      const eliminatedBallots = candidateBallots.get(key) ?? [];
      candidateBallots.delete(key);

      const transferMap = new Map<string, number>(); // allocatee key -> count

      for (let ballot of eliminatedBallots) {
        // Pop choices until we find a non-eliminated candidate, or exhaust
        let newChoice: Choice;
        while (true) {
          ballot = popTopVote(ballot);
          newChoice = topVote(ballot);
          if (newChoice.type === "vote" && eliminated.has(newChoice.candidate)) {
            continue;
          }
          break;
        }

        const newKey = choiceKey(newChoice);
        if (!candidateBallots.has(newKey)) candidateBallots.set(newKey, []);
        candidateBallots.get(newKey)!.push(ballot);

        const allocKey =
          newChoice.type === "vote" ? String(newChoice.candidate) : "X";
        transferMap.set(allocKey, (transferMap.get(allocKey) ?? 0) + 1);
      }

      for (const [toKey, count] of transferMap) {
        const to: Allocatee = toKey === "X" ? "X" : parseInt(toKey, 10);
        allTransfers.push({ from: eliminatedCid, to, count });
      }
    }

    // Sort transfers: candidates with more votes first, exhausted last
    allTransfers.sort((a, b) => {
      const aVotes =
        a.to === "X" ? 0 : candidateBallots.get(`v${a.to}`)?.length ?? 0;
      const bVotes =
        b.to === "X" ? 0 : candidateBallots.get(`v${b.to}`)?.length ?? 0;
      return bVotes - aVotes; // descending
    });

    currentTransfers = allTransfers;
  }

  return rounds;
}
