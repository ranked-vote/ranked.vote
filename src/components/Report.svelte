<script lang="ts">
  import type {
    IContestReport,
    Allocatee,
    ICandidate,
    ICandidatePairEntry,
  } from "../report_types";
  import VoteCounts from "./report_components/VoteCounts.svelte";
  import Sankey from "./report_components/Sankey.svelte";
  import CandidatePairTable from "./report_components/CandidatePairTable.svelte";
  import RankingDistribution from "./report_components/RankingDistribution.svelte";
  import { EXHAUSTED } from "./candidates";

  import { onMount, setContext } from "svelte";

  export let report: IContestReport;

  // Defensive check
  $: hasReport = report && report.info && report.candidates;
  $: hasCandidates = hasReport && report.numCandidates > 0;

  function getCandidate(cid: Allocatee): ICandidate {
    if (cid == "X") {
      return { name: "Exhausted", writeIn: false };
    } else if (cid == null || cid === undefined) {
      return { name: "Unknown", writeIn: false };
    } else {
      return report.candidates[cid] || { name: "Unknown", writeIn: false };
    }
  }

  function getCandidateNameById(cid: number): string {
    const c = report.candidates[cid];
    return c ? c.name : "";
  }

  setContext("candidates", {
    getCandidate,
  });

  function formatDate(dateStr: string): string {
    let date = new Date(dateStr);
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    return `${
      months[date.getUTCMonth()]
    } ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
  }
</script>

<style>
  @media (prefers-color-scheme: dark) {
    :global(body) {
      background-color: black;
    }
  }
</style>

{#if hasReport}
<div class="row">
  <p class="description"></p>
  <div class="electionHeader">
    <h3>
      <a href="/">ranked.vote</a>
      //
      <strong>{report.info.jurisdictionName}</strong>
      {report.info.officeName}
    </h3>
  </div>
</div>

<div class="row">
  <div class="leftCol">
    <p>
      The
      {#if report.info.website}
      <a href={report.info.website}>{report.info.jurisdictionName} {report.info.electionName}</a>
      {:else}
      {report.info.jurisdictionName} {report.info.electionName}
      {/if}
      was held on
      <strong>{formatDate(report.info.date)}</strong>.
      {#if hasCandidates}
        {#if report.winner != null}
        <strong>{getCandidate(report.winner).name}</strong>
        was the winner out of
        {:else}
        The winner could not be determined out of
        {/if}
        <strong>{report.numCandidates}</strong>&nbsp;{#if report.numCandidates == 1}candidate {:else}candidates{/if}{#if report.rounds && report.rounds.length > 1}{" "}after
          {" "}<strong>{report.rounds.length - 1}</strong>&nbsp;elimination {#if report.rounds.length == 2}round{:else}rounds{/if}.
        {:else}. No elimination rounds were necessary to determine the outcome.
        {/if}
      {:else}
        No candidate data available for this election.
      {/if}
    </p>
    {#if hasCandidates}
      {#if report.condorcet != null && report.winner != null}
        <p>
          {#if report.winner == report.condorcet}
            <strong>{getCandidate(report.winner).name}</strong> was also the <a href="https://en.wikipedia.org/wiki/Condorcet_method">Condorcet winner</a>.
          {:else}
            <strong>{getCandidate(report.condorcet).name}</strong> was the <a href="https://en.wikipedia.org/wiki/Condorcet_method">Condorcet winner</a>, meaning that they would have won in a head-to-head matchup against <strong>{getCandidate(report.winner).name}</strong>.
          {/if}
        </p>
      {:else if report.condorcet == null && report.winner != null && report.smithSet}
        <p>
          No Condorcet winner exists; multiple candidates form a
          <a href="https://en.wikipedia.org/wiki/Condorcet_paradox">Condorcet cycle</a>:
          {report.smithSet.map(getCandidateNameById).join(", ")}. This means that among these candidates, each one would beat some others in head-to-head matchups, but no single candidate beats all others. In this situation, the winner depends on the order of eliminations in the ranked-choice voting process, rather than a clear preference.
        </p>
      {/if}
    {/if}
  </div>
  <div class="rightCol">
    <VoteCounts candidateVotes={report.totalVotes} />
  </div>
</div>

{#if report.rounds.length > 1}
  <div class="row">
    <div class="leftCol">
      <h2>Runoff Rounds</h2>

      <p>
        This <a href="https://en.wikipedia.org/wiki/Sankey_diagram">Sankey diagram</a> shows the votes of each remaining candidate at each round,
        as well as the breakdown of votes transferred when each candidate was
        eliminated.
      </p>

      <p>
        Note that the tabulation (but not the winner) may differ from the official count. You
        can <a href="/discrepancies">read more about why this is</a>.
      </p>
    </div>

    <div class="rightCol">
      <Sankey rounds={report.rounds} />
    </div>
  </div>
{/if}

{#if report.numCandidates > 1}
<div class="row">
  <div class="leftCol">
    <h2>Pairwise Preferences</h2>
    <p>
      For every pair of candidates, this table shows the fraction of voters who
      preferred one to the other. A preference means that either a voter ranks a
      candidate ahead of the other, or ranks one candidate but does not list the
      other. Ballots which rank neither candidate are not counted towards the
      percent counts.
    </p>
  </div>

  <div class="rightCol">
    <CandidatePairTable
      data={report.pairwisePreferences}
      rowLabel="Preferred Candidate"
      colLabel="Less-preferred Candidate"
      generateTooltip={(row: Allocatee, col: Allocatee, entry: ICandidatePairEntry) => `
        Of the <strong>${entry.denominator.toLocaleString()}</strong> voters
        who expressed a preference, <strong>${Math.round(entry.frac * 1000) / 10}%</strong>
        (<strong>${entry.numerator.toLocaleString()}</strong>) preferred
        <strong>${getCandidate(row).name}</strong> to <strong>${getCandidate(col).name}</strong>.
      `} />
  </div>
</div>

<div class="row">
  <div class="leftCol">
    <h2>First Alternate</h2>
    <p>
      For every pair of candidates, this table shows the fraction of voters who
      ranked one candidate first ranked the other candidate second.
    </p>
  </div>

  <div class="rightCol">
    <CandidatePairTable
      generateTooltip={(row, col, entry) => (col !== EXHAUSTED ? `
        Of the <strong>${entry.denominator.toLocaleString()}</strong> voters who chose <strong>${getCandidate(row).name}</strong>
        as their first choice, <strong>${entry.numerator.toLocaleString()}</strong>
        (<strong>${Math.round(entry.frac * 1000) / 10}%</strong>)
        chose <strong>${getCandidate(col).name}</strong>
        as their second choice.
        ` : `
        Of the <strong>${entry.denominator.toLocaleString()}</strong> voters who chose <strong>${getCandidate(row).name}</strong>
        as their first choice, <strong>${entry.numerator.toLocaleString()}</strong>
        (<strong>${Math.round(entry.frac * 1000) / 10}%</strong>)
        did not rank another candidate.
       `)}
      data={report.firstAlternate}
      rowLabel="First Choice"
      colLabel="Second Choice" />
  </div>
</div>

{#if report.rankingDistribution && report.rankingDistribution.totalBallots > 0}
<div class="row">
  <div class="leftCol">
    <h2>Ranking Distribution</h2>
    <p>
      This shows how many candidates voters ranked, both overall and broken down by each candidate's first-choice supporters. This reveals whether some candidates attracted voters who ranked multiple candidates versus those who ranked fewer candidates.
    </p>
  </div>

  <div class="rightCol">
    <RankingDistribution
      candidates={report.candidates}
      rankingDistribution={report.rankingDistribution}
      totalVotes={report.totalVotes} />
  </div>
</div>
{/if}
{/if}

{#if hasCandidates && report.rounds && report.rounds.length > 1}
  <div class="row">
    <div class="leftCol">
      <h2>Final Vote by First Choice</h2>
      <p>
        This table tracks which candidate ballots were ultimately allocated to,
        among ballots that ranked an eliminated candidate first.
      </p>
    </div>

    <div class="rightCol">
      <CandidatePairTable
        generateTooltip={(row: Allocatee, col: Allocatee, entry: ICandidatePairEntry) => (col !== EXHAUSTED ? `
        Of the <strong>${entry.denominator.toLocaleString()}</strong> ballots that ranked <strong>${getCandidate(row).name}</strong>
        first, <strong>${entry.numerator.toLocaleString()}</strong>
        (<strong>${Math.round(entry.frac * 1000) / 10}%</strong>)
        were allocated to <strong>${getCandidate(col).name}</strong>
        in the final round.
        ` : `
        Of the <strong>${entry.denominator.toLocaleString()}</strong> ballots that ranked <strong>${getCandidate(row).name}</strong>
        first, <strong>${entry.numerator.toLocaleString()}</strong>
        (<strong>${Math.round(entry.frac * 1000) / 10}%</strong>)
        were exhausted by the final round.
        `)}
        data={report.firstFinal}
        rowLabel="First Round Choice"
        colLabel="Final Round Choice" />
    </div>
  </div>
{/if}
{/if}
