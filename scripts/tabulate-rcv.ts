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

/**
 * BallotState uses an index pointer into the original choices array
 * instead of copying via slice(). This avoids O(K) allocation per pop.
 */
interface BallotState {
  choices: CandidateId[];
  idx: number; // current position in the choices array
  overvoted: boolean;
}

/** Get the current top choice for a ballot. */
function topChoice(ballot: BallotState): CandidateId | -1 | -2 {
  // Returns candidateId for a vote, -1 for undervote, -2 for overvote
  if (ballot.idx < ballot.choices.length) {
    return ballot.choices[ballot.idx];
  }
  return ballot.overvoted ? -2 : -1;
}

/** Advance to the next choice (mutates idx). */
function advanceChoice(ballot: BallotState): void {
  ballot.idx++;
}

// Map keys: candidate IDs stored directly as numbers, plus sentinels
const KEY_UNDERVOTE = -1;
const KEY_OVERVOTE = -2;

// ---------- Tabulator ----------

export function tabulate(
  ballots: NormalizedBallot[],
  options: TabulationOptions = {},
): ITabulatorRound[] {
  // Empty contest: return no rounds (matching Rust behavior)
  if (ballots.length === 0) return [];

  // Initial allocation: group ballots by top choice
  // Use a Map<number, BallotState[]> with numeric keys to avoid string ops
  const candidateBallots = new Map<number, BallotState[]>();
  for (const ballot of ballots) {
    const state: BallotState = {
      choices: ballot.choices,
      idx: 0,
      overvoted: ballot.overvoted,
    };
    const key = topChoice(state);
    let bucket = candidateBallots.get(key);
    if (!bucket) {
      bucket = [];
      candidateBallots.set(key, bucket);
    }
    bucket.push(state);
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
      if (key === KEY_UNDERVOTE) {
        if (!(options.nycStyle && roundNumber === 0)) {
          exhausted += count;
        }
      } else if (key === KEY_OVERVOTE) {
        if (!(options.nycStyle && roundNumber === 0)) {
          exhausted += count;
        }
      } else {
        voteCounts.set(key as CandidateId, count);
      }
    }

    // Sort candidates descending by votes
    const sortedVotes = Array.from(voteCounts.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    const continuing = sortedVotes.reduce((sum, [, v]) => sum + v, 0);

    // Build allocations (candidates sorted desc by votes, then exhausted)
    const allocations: ITabulatorAllocation[] = sortedVotes.map(
      ([cid, votes]) => ({
        allocatee: cid as Allocatee,
        votes,
      }),
    );
    allocations.push({ allocatee: "X", votes: exhausted });

    // Count undervotes and overvotes for the round
    const undervote = candidateBallots.get(KEY_UNDERVOTE)?.length ?? 0;
    const overvote = candidateBallots.get(KEY_OVERVOTE)?.length ?? 0;

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
    let candidatesToEliminate: Set<CandidateId>;
    const isEager = options.eager ?? false;

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
        sortedVotes.slice(cutoff).map(([cid]) => cid),
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
      const eliminatedBallots = candidateBallots.get(eliminatedCid) ?? [];
      candidateBallots.delete(eliminatedCid);

      const transferMap = new Map<number, number>(); // key -> count

      for (const ballot of eliminatedBallots) {
        // Advance past eliminated candidates
        let newKey: number;
        while (true) {
          advanceChoice(ballot);
          const choice = topChoice(ballot);
          if (choice >= 0 && eliminated.has(choice as CandidateId)) {
            continue;
          }
          newKey = choice;
          break;
        }

        let bucket = candidateBallots.get(newKey);
        if (!bucket) {
          bucket = [];
          candidateBallots.set(newKey, bucket);
        }
        bucket.push(ballot);

        transferMap.set(newKey, (transferMap.get(newKey) ?? 0) + 1);
      }

      for (const [toKey, count] of transferMap) {
        const to: Allocatee = toKey < 0 ? "X" : (toKey as CandidateId);
        allTransfers.push({ from: eliminatedCid, to, count });
      }
    }

    // Sort transfers: candidates with more votes first, exhausted last
    allTransfers.sort((a, b) => {
      const aVotes =
        a.to === "X" ? 0 : (candidateBallots.get(a.to as number)?.length ?? 0);
      const bVotes =
        b.to === "X" ? 0 : (candidateBallots.get(b.to as number)?.length ?? 0);
      return bVotes - aVotes; // descending
    });

    currentTransfers = allTransfers;
  }

  return rounds;
}
