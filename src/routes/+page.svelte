<script lang="ts">
	import type { PageData } from './$types';
	import ElectionIndex from '../components/ElectionIndex.svelte';

	export let data: PageData;
</script>

<svelte:head>
	<title>ranked.vote: detailed reports on ranked-choice elections.</title>
</svelte:head>

<div class="wide container">
<div class="row">
  <div class="leftCol">
    <div class="description">
      <h1>ranked.vote</h1>:
      detailed reports on ranked-choice elections.
    </div>
    <p>
      Ranked-choice elections produce more data on voter preferences than
      pick-one elections. <strong>ranked.vote</strong> runs analysis on the
      ballot-level data and publishes reports on each election.
    </p>

    <p>
      Elections are highlighted when they exhibit
      interesting characteristics, such as when the winner did not lead in the first round,
      when the RCV winner differs from the Condorcet winner, there is a Condorcet cycle, 
      or exhausted ballots outnumber the winner's votes.
    </p>

    <p>
      ranked.vote was created by
      <a href="https://paulbutler.org">Paul Butler</a> and
      <a href="https://felixsargent.com">Felix Sargent</a>.
      It is non-partisan and has received no outside funding.
    </p>

    <p>If you enjoy alternate voting systems, you may also enjoy
      <a href="https://approval.vote">approval.vote</a> for approval voting elections
      and <a href="https://stv.vote">stv.vote</a> for single transferable vote elections.
    </p>

    <p>
      For more information, see the <a href="/about">about page</a>.
    </p>
  </div>

  <div class="rightCol">
    <ElectionIndex elections={data.elections} />
  </div>
</div>
</div>

