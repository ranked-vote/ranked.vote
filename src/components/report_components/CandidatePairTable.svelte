<script lang="ts">
  import type {
    ICandidatePairTable,
    ICandidatePairEntry,
    Allocatee,
  } from "../../report_types";
  import type { CandidateContext } from "../candidates";
  import { getContext, onMount } from "svelte";
  import tooltip from "../../tooltip";

  export let data: ICandidatePairTable;
  export let rowLabel: string;
  export let colLabel: string;
  export let generateTooltip: ((c1: Allocatee, c2: Allocatee, entry: ICandidatePairEntry) => string) | undefined = undefined;

  const { getCandidate } = getContext("candidates") as CandidateContext;

  function smooth(low: number, high: number, frac: number): number {
    return low * (1 - frac) + high * frac;
  }

  let maxFrac = Math.max(
    ...data.entries.map((row) => Math.max(...row.map((d) => (d ? d.frac : 0))))
  );

  // Detect dark mode reactively - initialize immediately
  let isDarkMode = false;
  if (typeof window !== 'undefined') {
    isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  onMount(() => {
    if (typeof window !== 'undefined') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      
      const updateDarkMode = (e: MediaQueryListEvent) => {
        isDarkMode = e.matches;
      };
      
      mediaQuery.addEventListener('change', updateDarkMode);
      return () => mediaQuery.removeEventListener('change', updateDarkMode);
    }
  });

  // Color function - reactive to isDarkMode changes
  function fracToColor(frac: number): string {
    frac = frac / maxFrac;
    let h = smooth(0, 0, frac);
    let s = smooth(50, 95, frac);
    // Invert lightness for dark mode: lower values = darker, higher values = lighter
    // Access isDarkMode directly - Svelte will track it when used in template
    let l = isDarkMode 
      ? smooth(25, 50, frac)  // Dark mode: 25% (dark) to 50% (lighter)
      : smooth(97, 75, frac);  // Light mode: 97% (light) to 75% (darker)

    return `hsl(${h} ${s}% ${l}%)`;
  }
</script>

<style>
  table {
    font-size: 8pt;
    margin: auto;
    cursor: default;
  }

  .colLabel div {
    writing-mode: sideways-lr;
    margin: auto;
  }

  .colLabel {
    vertical-align: bottom;
  }

  .rowLabel {
    text-align: right;
  }

  .entry {
    height: 40px;
    width: 40px;
    font-size: 8pt;
    vertical-align: middle;
    text-align: center;
    color: black;
  }

  .colsLabel {
    text-align: center;
    font-size: 10pt;
    font-weight: bold;
    padding-bottom: 20px;
  }

  .rowsLabel {
    font-size: 10pt;
    font-weight: bold;
    padding-right: 20px;
  }

  .rowsLabel div {
    transform: rotate(180deg);
    writing-mode: vertical-lr;
  }

  @media (prefers-color-scheme: dark) {
    .entry {
      color: #e3e3e3;
    }

    .rowLabel,
    .colLabel div,
    .colsLabel,
    .rowsLabel div {
      color: #e3e3e3;
    }
  }
</style>

<table>
  <tbody>
    <tr>
      <td></td>
      <td class="colsLabel" colspan={data.cols.length + 1}>{colLabel}</td>
    </tr>
    <tr>
      <td class="rowsLabel" rowspan={data.rows.length + 1}><div>{rowLabel}</div></td>
      <td></td>
      {#each data.cols as col}
        <td class="colLabel">
          <div>{getCandidate(col).name}</div>
        </td>
      {/each}
    </tr>
    {#each data.rows as row, i}
      <tr>
        <td class="rowLabel">{getCandidate(row).name}</td>
        {#each data.entries[i] as entry, j}
          {@const normalizedFrac = entry ? entry.frac / maxFrac : 0}
          {@const bgColor = entry ? (() => {
            const h = smooth(0, 0, normalizedFrac);
            const s = smooth(50, 95, normalizedFrac);
            const l = isDarkMode 
              ? smooth(25, 50, normalizedFrac)
              : smooth(97, 75, normalizedFrac);
            return `hsl(${h} ${s}% ${l}%)`;
          })() : null}
          <td
            use:tooltip={(generateTooltip && entry) ? generateTooltip(row, data.cols[j], entry) : null}
            class="entry"
            style={bgColor ? `background: ${bgColor}` : null}>
            {#if entry}{Math.round(entry.frac * 1000) / 10}%{/if}
          </td>
        {/each}
      </tr>
    {/each}
  </tbody>
</table>
