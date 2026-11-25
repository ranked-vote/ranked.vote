<script lang="ts">
  import type { ICandidate } from "../../report_types";

  export let candidates: ICandidate[];
  export let rankCounts: Record<number, number[]>;

  $: ranks = Array.from({
    length: Object.values(rankCounts).reduce((max, counts) => Math.max(max, counts.length), 0),
  }, (_, index) => index);
</script>

{#if ranks.length}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to focus and scroll wide tables.) -->
  <div class="rank-counts" role="region" aria-label="Votes by rank" tabindex="0">
    <table aria-label="Votes by rank">
      <thead>
        <tr>
          <th scope="col">Candidate</th>
          {#each ranks as rank}
            <th scope="col">Rank {rank + 1}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each candidates as candidate, index}
          <tr>
            <th scope="row">{candidate.name}</th>
            {#each ranks as rank}
              <td>{(rankCounts[index]?.[rank] ?? 0).toLocaleString()}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .rank-counts {
    overflow-x: auto;
  }

  table {
    margin: auto;
    border-collapse: collapse;
  }

  th, td {
    padding: 0.4rem 0.65rem;
  }

  th[scope="row"] {
    text-align: left;
  }

  th:not([scope="row"]), td {
    text-align: right;
    white-space: nowrap;
  }

  td {
    font-variant-numeric: tabular-nums;
  }
</style>
