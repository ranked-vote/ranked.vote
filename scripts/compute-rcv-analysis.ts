/**
 * RCV analysis computations.
 *
 * Ported from report_pipeline/src/report.rs and adapted from
 * stv.vote/scripts/compute-pairwise.ts.
 *
 * Computes:
 * - Pairwise preferences (Condorcet matrix)
 * - First alternate preferences
 * - First-final preferences (where first-choice voters ended up)
 * - Ranking distribution
 * - Smith set / Condorcet winner
 * - Total votes per candidate from rounds
 */

import type {
  ICandidatePairTable,
  ICandidatePairEntry,
  IRankingDistribution,
  ITabulatorRound,
  ICandidateVotes,
  Allocatee,
  CandidateId,
} from "../src/report_types";
import type { NormalizedBallot } from "./tabulate-rcv";

// ---------- Pairwise Preferences ----------

/**
 * Generate pairwise preference counts.
 *
 * For each pair (A, B): count of ballots that ranked A above B.
 * Unranked candidates are implicitly ranked below all ranked candidates
 * (matching the Rust implementation).
 */
function generatePairwiseCounts(
  candidates: CandidateId[],
  ballots: NormalizedBallot[]
): Map<string, number> {
  const counts = new Map<string, number>();
  const candidateSet = new Set(candidates);

  for (const ballot of ballots) {
    const ranked = new Set<CandidateId>();

    // For each ranked candidate, it beats all candidates ranked below
    for (const vote of ballot.choices) {
      for (const above of ranked) {
        const key = `${above},${vote}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      ranked.add(vote);
    }

    // All ranked candidates beat all unranked candidates
    for (const candidate of candidateSet) {
      if (!ranked.has(candidate)) {
        for (const above of ranked) {
          const key = `${above},${candidate}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  return counts;
}

export function generatePairwisePreferences(
  candidates: CandidateId[],
  pairwiseCounts: Map<string, number>
): ICandidatePairTable {
  const axis: Allocatee[] = candidates.map((c) => c);
  const entries: (ICandidatePairEntry | null)[][] = [];

  for (const c1 of candidates) {
    const row: (ICandidatePairEntry | null)[] = [];
    for (const c2 of candidates) {
      const m1 = pairwiseCounts.get(`${c1},${c2}`) ?? 0;
      const m2 = pairwiseCounts.get(`${c2},${c1}`) ?? 0;
      const total = m1 + m2;

      if (total === 0) {
        row.push(null);
      } else {
        row.push({
          frac: m1 / total,
          numerator: m1,
          denominator: total,
        });
      }
    }
    entries.push(row);
  }

  return { rows: [...axis], cols: [...axis], entries };
}

// ---------- First Alternate ----------

export function generateFirstAlternate(
  candidates: CandidateId[],
  ballots: NormalizedBallot[]
): ICandidatePairTable {
  const firstChoiceCount = new Map<CandidateId, number>();
  // alternateMap[first][second] = count
  const alternateMap = new Map<string, number>();

  for (const ballot of ballots) {
    const choices = ballot.choices;
    if (choices.length === 0) continue;

    const first = choices[0];
    firstChoiceCount.set(first, (firstChoiceCount.get(first) ?? 0) + 1);

    const second: Allocatee =
      choices.length > 1 ? choices[1] : "X";
    const key = `${first},${second}`;
    alternateMap.set(key, (alternateMap.get(key) ?? 0) + 1);
  }

  const rows: Allocatee[] = candidates.map((c) => c);
  const cols: Allocatee[] = [...candidates.map((c) => c as Allocatee), "X"];
  const entries: (ICandidatePairEntry | null)[][] = [];

  for (const c1 of candidates) {
    const row: (ICandidatePairEntry | null)[] = [];
    const denom = firstChoiceCount.get(c1) ?? 0;

    for (const c2 of cols) {
      const key = `${c1},${c2}`;
      const num = alternateMap.get(key) ?? 0;
      if (num === 0) {
        row.push(null);
      } else {
        row.push({ frac: denom > 0 ? num / denom : 0, numerator: num, denominator: denom });
      }
    }
    entries.push(row);
  }

  return { rows, cols, entries };
}

// ---------- First-Final ----------

export function generateFirstFinal(
  candidates: CandidateId[],
  ballots: NormalizedBallot[],
  finalRoundCandidates: Set<CandidateId>
): ICandidatePairTable {
  const firstFinal = new Map<string, number>();
  const firstTotal = new Map<CandidateId, number>();

  for (const ballot of ballots) {
    const choices = ballot.choices;
    if (choices.length === 0) continue;

    const first = choices[0];
    if (finalRoundCandidates.has(first)) continue; // Skip candidates still in final round

    const finalChoice: Allocatee =
      choices.find((c) => finalRoundCandidates.has(c)) ?? "X";

    const key = `${first},${finalChoice}`;
    firstFinal.set(key, (firstFinal.get(key) ?? 0) + 1);
    firstTotal.set(first, (firstTotal.get(first) ?? 0) + 1);
  }

  // Rows: eliminated candidates. Cols: final round candidates + exhausted
  const rows: Allocatee[] = candidates
    .filter((c) => !finalRoundCandidates.has(c))
    .map((c) => c);
  const cols: Allocatee[] = [
    ...candidates.filter((c) => finalRoundCandidates.has(c)).map((c) => c as Allocatee),
    "X",
  ];
  const entries: (ICandidatePairEntry | null)[][] = [];

  for (const c1Alloc of rows) {
    const c1 = c1Alloc as CandidateId;
    const row: (ICandidatePairEntry | null)[] = [];
    const total = firstTotal.get(c1) ?? 0;

    for (const c2 of cols) {
      const key = `${c1},${c2}`;
      const num = firstFinal.get(key) ?? 0;
      if (num === 0) {
        row.push(null);
      } else {
        row.push({ frac: total > 0 ? num / total : 0, numerator: num, denominator: total });
      }
    }
    entries.push(row);
  }

  return { rows, cols, entries };
}

// ---------- Ranking Distribution ----------

export function generateRankingDistribution(
  ballots: NormalizedBallot[]
): IRankingDistribution {
  const overallDistribution: Record<string, number> = {};
  const candidateDistributions: Record<string, Record<string, number>> = {};
  const candidateTotals: Record<string, number> = {};
  let totalBallots = 0;

  for (const ballot of ballots) {
    const choices = ballot.choices;
    if (choices.length === 0) continue;

    totalBallots++;
    const rankCount = choices.length;
    const countStr = String(rankCount);
    overallDistribution[countStr] = (overallDistribution[countStr] ?? 0) + 1;

    const first = choices[0];
    const firstStr = String(first);
    if (!candidateDistributions[firstStr]) candidateDistributions[firstStr] = {};
    candidateDistributions[firstStr][countStr] =
      (candidateDistributions[firstStr][countStr] ?? 0) + 1;
    candidateTotals[firstStr] = (candidateTotals[firstStr] ?? 0) + 1;
  }

  return { overallDistribution, candidateDistributions, totalBallots, candidateTotals };
}

// ---------- Smith Set / Condorcet ----------

/**
 * Build a directed graph of pairwise dominance.
 * Edge from A to B means A beats B in pairwise comparison.
 */
function buildGraph(
  candidates: CandidateId[],
  pairwiseCounts: Map<string, number>
): Map<CandidateId, CandidateId[]> {
  const graph = new Map<CandidateId, CandidateId[]>();

  for (const c1 of candidates) {
    for (const c2 of candidates) {
      if (c1 === c2) continue;
      const c1v = pairwiseCounts.get(`${c1},${c2}`) ?? 0;
      const c2v = pairwiseCounts.get(`${c2},${c1}`) ?? 0;
      if (c1v > c2v) {
        if (!graph.has(c1)) graph.set(c1, []);
        graph.get(c1)!.push(c2);
      }
    }
  }

  return graph;
}

/**
 * Compute the Smith set using Kosaraju's SCC algorithm.
 * The Smith set is the union of SCCs with zero in-degree in the condensation graph.
 */
export function computeSmithSet(
  candidates: CandidateId[],
  pairwiseCounts: Map<string, number>
): Set<CandidateId> {
  const graph = buildGraph(candidates, pairwiseCounts);
  const n = candidates.length;
  const idxById = new Map<CandidateId, number>();
  candidates.forEach((cid, i) => idxById.set(cid, i));

  // Build adjacency lists
  const adj: number[][] = Array.from({ length: n }, () => []);
  const radj: number[][] = Array.from({ length: n }, () => []);

  for (const [from, tos] of graph) {
    const u = idxById.get(from);
    if (u === undefined) continue;
    for (const to of tos) {
      const v = idxById.get(to);
      if (v === undefined || u === v) continue;
      adj[u].push(v);
      radj[v].push(u);
    }
  }

  // Kosaraju pass 1: DFS to get finish order
  const visited = new Array(n).fill(false);
  const order: number[] = [];

  function dfs1(u: number) {
    visited[u] = true;
    for (const v of adj[u]) {
      if (!visited[v]) dfs1(v);
    }
    order.push(u);
  }

  for (let u = 0; u < n; u++) {
    if (!visited[u]) dfs1(u);
  }

  // Kosaraju pass 2: assign SCCs in reverse finish order
  const compId = new Array(n).fill(-1);
  let compCount = 0;

  function dfs2(u: number, cid: number) {
    compId[u] = cid;
    for (const v of radj[u]) {
      if (compId[v] === -1) dfs2(v, cid);
    }
  }

  for (let i = order.length - 1; i >= 0; i--) {
    if (compId[order[i]] === -1) {
      dfs2(order[i], compCount);
      compCount++;
    }
  }

  // Compute in-degrees between SCCs
  const indeg = new Array(compCount).fill(0);
  for (let u = 0; u < n; u++) {
    for (const v of adj[u]) {
      if (compId[u] !== compId[v]) {
        indeg[compId[v]]++;
      }
    }
  }

  // Top SCCs have zero in-degree
  const topComponents = new Set<number>();
  for (let i = 0; i < compCount; i++) {
    if (indeg[i] === 0) topComponents.add(i);
  }

  const result = new Set<CandidateId>();
  for (let i = 0; i < n; i++) {
    if (topComponents.has(compId[i])) {
      result.add(candidates[i]);
    }
  }

  return result;
}

// ---------- Total Votes ----------

export function computeTotalVotes(rounds: ITabulatorRound[]): ICandidateVotes[] {
  if (rounds.length === 0) return [];

  // First round votes (excluding exhausted)
  const firstRoundVotes = new Map<CandidateId, number>();
  for (const alloc of rounds[0].allocations) {
    if (alloc.allocatee !== "X") {
      firstRoundVotes.set(alloc.allocatee, alloc.votes);
    }
  }

  // Final votes: last allocation for each candidate
  const finalVotes = new Map<CandidateId, number>(firstRoundVotes);
  const roundEliminated = new Map<CandidateId, number>();

  for (let i = 1; i < rounds.length; i++) {
    for (const alloc of rounds[i].allocations) {
      if (alloc.allocatee !== "X") {
        finalVotes.set(alloc.allocatee, alloc.votes);
      }
    }
    for (const transfer of rounds[i].transfers) {
      roundEliminated.set(transfer.from, i);
    }
  }

  const result: ICandidateVotes[] = [];
  for (const [candidate, firstVotes] of firstRoundVotes) {
    const finalV = finalVotes.get(candidate) ?? firstVotes;
    result.push({
      candidate,
      firstRoundVotes: firstVotes,
      transferVotes: finalV - firstVotes,
      roundEliminated: roundEliminated.get(candidate),
    });
  }

  // Sort by total votes descending (matching Rust), then by candidate index
  result.sort((a, b) => a.candidate - b.candidate);

  return result;
}

// ---------- Winner extraction ----------

export function getWinner(rounds: ITabulatorRound[]): CandidateId | null {
  if (rounds.length === 0) return null;
  const lastRound = rounds[rounds.length - 1];
  const firstAlloc = lastRound.allocations[0];
  if (firstAlloc && firstAlloc.allocatee !== "X") {
    return firstAlloc.allocatee;
  }
  return null;
}

// ---------- Combined analysis ----------

export interface AnalysisResult {
  pairwisePreferences: ICandidatePairTable;
  firstAlternate: ICandidatePairTable;
  firstFinal: ICandidatePairTable;
  rankingDistribution: IRankingDistribution;
  smithSet: CandidateId[];
  condorcet: CandidateId | undefined;
  totalVotes: ICandidateVotes[];
  winner: CandidateId | null;
}

export function analyzeElection(
  candidates: CandidateId[],
  ballots: NormalizedBallot[],
  rounds: ITabulatorRound[]
): AnalysisResult {
  const pairwiseCounts = generatePairwiseCounts(candidates, ballots);
  const pairwisePreferences = generatePairwisePreferences(candidates, pairwiseCounts);
  const firstAlternate = generateFirstAlternate(candidates, ballots);
  const rankingDistribution = generateRankingDistribution(ballots);
  const totalVotes = computeTotalVotes(rounds);
  const winner = getWinner(rounds);

  // Final round candidates for first-final
  const lastRound = rounds[rounds.length - 1];
  const finalRoundCandidates = new Set<CandidateId>();
  if (lastRound) {
    for (const alloc of lastRound.allocations) {
      if (alloc.allocatee !== "X") {
        finalRoundCandidates.add(alloc.allocatee);
      }
    }
  }
  const firstFinal = generateFirstFinal(candidates, ballots, finalRoundCandidates);

  // Smith set
  const smithSetSet = computeSmithSet(candidates, pairwiseCounts);
  const smithSet = Array.from(smithSetSet).sort((a, b) => a - b);
  const condorcet = smithSet.length === 1 ? smithSet[0] : undefined;

  return {
    pairwisePreferences,
    firstAlternate,
    firstFinal,
    rankingDistribution,
    smithSet,
    condorcet,
    totalVotes,
    winner,
  };
}
