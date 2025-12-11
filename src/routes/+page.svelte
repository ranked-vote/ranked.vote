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
      Some elections are highlighted when they exhibit
      interesting characteristics: the RCV winner differs from the Condorcet
      winner (the candidate who would beat all others in head-to-head matchups),
      there is a Condorcet cycle (no single candidate beats all others), or
      exhausted ballots outnumbering the winner's votes.
    </p>

    <p>
      ranked.vote was created by
      <a href="https://paulbutler.org">Paul Butler</a> and
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
    <ElectionIndex elections={data.elections} />
  </div>
</div>
</div>

