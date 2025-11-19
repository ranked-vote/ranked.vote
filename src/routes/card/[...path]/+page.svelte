<script lang="ts">
	import type { PageData } from './$types';
	import Sankey from '../../../components/report_components/Sankey.svelte';
	import VoteCounts from '../../../components/report_components/VoteCounts.svelte';
	import { setContext } from 'svelte';

	export let data: PageData;
	const { report } = data;

	// Defensive checks
	const hasReport = report && report.info && report.candidates && report.rounds;
	const hasRounds = hasReport && report.rounds && report.rounds.length > 0;

	function getCandidate(cid: string | number) {
		if (cid == "X") {
			return { name: "Exhausted", writeIn: false };
		} else {
			return report.candidates?.[cid] || { name: "Unknown", writeIn: false };
		}
	}

	setContext("candidates", {
		getCandidate,
	});
</script>

<svelte:head>
	<link rel="stylesheet" href="/card.css" />
</svelte:head>

<div class="card">
	<div class="electionHeader">
		<h3>
			<a href="/">ranked.vote</a>
			//
			<strong>{report.info.jurisdictionName}</strong>
			{report.info.officeName}
		</h3>
	</div>

	<div class="card-content">
		{#if hasRounds}
			<div class="segment">
				<Sankey rounds={report.rounds} />
			</div>
		{/if}

		{#if report.totalVotes}
			<div class="segment">
				<VoteCounts candidateVotes={report.totalVotes} />
			</div>
		{/if}
	</div>
</div>

