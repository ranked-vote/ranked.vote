<script context="module">
  export async function preload(page, session) {
    let result = await this.fetch("/api/reports.json");
    let index = await result.json();
    return index;
  }
</script>

<script>
  // TODO: this could be a TS script once this Sapper issue is closed:
  // https://github.com/sveltejs/sapper/pull/1222
  import ElectionIndex from "../components/ElectionIndex.svelte";

  export let elections;
</script>

<title>rcv.report: detailed reports on ranked-choice elections.</title>

<div class="wide container">
<div class="row">
  <div class="leftCol">
    <div class="description">
      <h1>rcv.report</h1>:
      detailed reports on ranked-choice elections.
    </div>
    <p>
      Ranked-choice elections produce more data on voter preferences than
      pick-one elections. <strong>rcv.report</strong> runs analysis on the
      ballot-level data and publishes reports on each election.
    </p>

    <p>
      Some elections are highlighted with a warning badge when the RCV winner
      differs from the Condorcet winner—the candidate who would beat all others
      in head-to-head matchups. These cases reveal interesting dynamics in voter
      preferences and can indicate strategic voting or complex preference patterns.
    </p>

    <p>
      rcv.report is a fork of ranked.vote which was created by
      <a href="https://paulbutler.org">Paul Butler</a>.
      rcv.report is maintained by
      <a href="https://felixsargent.com">Felix Sargent</a>.
      It is non-partisan and has received no outside funding.
    </p>

    <p>If you enjoy alternate voting systems, you may also enjoy
      <a href="https://approval.vote">approval.vote</a>,
      which is a similar project for approval voting elections.
    </p>

    <p>
      For more information, see the <a href="/about">about page</a>.
    </p>
  </div>

  <div class="rightCol">
    <ElectionIndex {elections} />
  </div>
</div>
</div>