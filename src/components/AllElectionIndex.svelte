<script lang="ts">
  import type { IElectionIndexEntry } from "../report_types";

  export let elections: IElectionIndexEntry[];

  // Natural sort function that handles ordinal numbers (1st, 2nd, 3rd, etc.)
  function naturalSort(a: string, b: string): number {
    // Extract numbers from strings like "1st", "2nd", "10th", etc.
    const extractOrdinal = (str: string): number | null => {
      const match = str.match(/(\d+)(st|nd|rd|th)/i);
      return match ? parseInt(match[1], 10) : null;
    };

    // Split strings into parts (text and numbers)
    const partsA = a.match(/(\d+|[^\d]+)/g) || [];
    const partsB = b.match(/(\d+|[^\d]+)/g) || [];

    // Compare each part
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const partA = partsA[i] || '';
      const partB = partsB[i] || '';

      // Check if both parts are numbers (including ordinals)
      const numA = extractOrdinal(partA) ?? (/\d+/.test(partA) ? parseInt(partA, 10) : null);
      const numB = extractOrdinal(partB) ?? (/\d+/.test(partB) ? parseInt(partB, 10) : null);

      if (numA !== null && numB !== null) {
        // Both are numbers, compare numerically
        if (numA !== numB) {
          return numA - numB;
        }
      } else if (numA !== null) {
        // A is a number, B is text - numbers come first
        return -1;
      } else if (numB !== null) {
        // B is a number, A is text - numbers come first
        return 1;
      } else {
        // Both are text, compare alphabetically
        const cmp = partA.localeCompare(partB);
        if (cmp !== 0) {
          return cmp;
        }
      }
    }

    return 0;
  }

  $: filteredElections = (() => {
    // Show all elections and contests without filtering
    const filtered = (elections || []).map(e => {
      // Sort contests using natural sort to handle ordinals correctly
      const sortedContests = [...e.contests].sort((a, b) =>
        naturalSort(a.officeName, b.officeName)
      );
      return {
        ...e,
        contests: sortedContests
      };
    });
    return filtered;
  })();

  $: electionsByYear = (() => {
    let map = new Map<string, IElectionIndexEntry[]>();
    filteredElections.forEach((e) => {
      let year = e.date.substring(0, 4);
      if (!map.has(year)) {
        map.set(year, []);
      }
      const yearElections = map.get(year);
      if (yearElections) {
        yearElections.push(e);
      }
    });
    // Sort elections within each year by jurisdiction name alphabetically
    map.forEach((elections, year) => {
      elections.sort((a, b) => a.jurisdictionName.localeCompare(b.jurisdictionName));
    });
    return map;
  })();

  $: sortedYears = [...electionsByYear].sort((a, b) => {
    // Sort years in descending order (newest first)
    return parseInt(b[0]) - parseInt(a[0]);
  });
</script>

{#each sortedYears as [year, yearElections]}
  <div class="yearSection">
    <h2>{year}</h2>
    <div class="electionSection">
      {#each yearElections as election}
        <div class="electionHeader">
          <h3>
            <strong>{election.jurisdictionName}</strong>
            {election.electionName}
          </h3>
        </div>
        {#each election.contests as contest}
          <div class="race" class:interesting={contest.interesting}>
            <a href="/report/{election.path}/{contest.office}">
              <div class="title">
                <strong>{contest.officeName}</strong>
                {contest.winner}
              </div>
              <div class="meta">
                <strong>{contest.numCandidates}</strong>
                candidates,
                <strong>{contest.numRounds}</strong>
                rounds
              </div>
            </a>
          </div>
        {/each}
      {/each}
    </div>
  </div>
{/each}

