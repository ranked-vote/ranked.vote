<script lang="ts">
  import type {
    ITabulatorRound,
    Allocatee,
    CandidateId,
  } from "../../report_types";
  import type { CandidateContext } from "../candidates";
  import { EXHAUSTED } from "../candidates";
  import { getContext } from "svelte";
  import tooltip from "../../tooltip";

  export let rounds: ITabulatorRound[];

  const { getCandidate } = getContext("candidates") as CandidateContext;

  type NodeKey = `${number}:${string}`;

  function nodeKey(roundIndex: number, allocatee: Allocatee): NodeKey {
    return `${roundIndex}:${allocatee}`;
  }

  const outerHeight = 24;
  const width = 600;
  const roundHeight = 90;
  const voteBlockHeight = 14;
  const edgeMargin = 60;

  const candidateMargin = 20; // px
  const firstRoundAllocations = rounds[0].allocations;
  const firstRoundNumCandidates = firstRoundAllocations.length - 1;
  const voteScale =
    (width - candidateMargin * firstRoundNumCandidates - edgeMargin - 10) /
    firstRoundAllocations.reduce((a, b) => a + b.votes, 0);

  const innerHeight = roundHeight * (rounds.length - 1) + voteBlockHeight;
  const labelSpace = 100;
  const height = 2 * labelSpace + innerHeight;

  class VoteBlock {
    constructor(
      public x: number,
      public width: number,
      public y: number,
      private allocatee: Allocatee,
      private votes: number,
      private round: number,
      private totalRoundVotes?: number
    ) {}

    roundIndex(): number {
      return this.round - 1;
    }

    nodeKey(): NodeKey {
      return nodeKey(this.roundIndex(), this.allocatee);
    }

    isExhausted(): boolean {
      return this.allocatee === EXHAUSTED;
    }

    label(): string {
      return getCandidate(this.allocatee).name;
    }

    percentage(): number | null {
      return this.totalRoundVotes ?
        Math.round((this.votes / this.totalRoundVotes) * 1000) / 10 : null;
    }

    tooltip(): string {
      const percentage = this.percentage();
      const percentageText = percentage ? ` (${percentage}%)` : '';

      if (this.isExhausted()) {
        return `
        <strong>${this.votes.toLocaleString()}</strong> votes${percentageText}
        were exhausted
        in round <strong>${this.round}</strong>`;
      } else {
        return `
        <strong>${getCandidate(this.allocatee).name}</strong> received
        <strong>${this.votes.toLocaleString()}</strong> votes${percentageText}
        in round <strong>${this.round}</strong>`;
      }
    }
  }

  class TransferBlock {
    constructor(
      private fromCandidate: Allocatee,
      private toCandidate: Allocatee,
      private votes: number,
      private round: number,
      private fromRoundIndex: number,
      private toRoundIndex: number,
      private r1x: number,
      private r2x: number,
      private width: number,
      private r1y: number,
      private r2y: number,
      private sourceVotes?: number
    ) {}

    sourceKey(): NodeKey {
      return nodeKey(this.fromRoundIndex, this.fromCandidate);
    }

    targetKey(): NodeKey {
      return nodeKey(this.toRoundIndex, this.toCandidate);
    }

    toPath(): string {
      let midY = (this.r1y + this.r2y) / 2;
      let width = Math.max(1, this.width);
      let { r1y, r2y, r1x, r2x } = this;
      r1x = r1x - Math.min(width - this.width, 0);
      let r1x2 = r1x + width;
      let r2x2 = r2x + width;
      return `\
            M ${r1x} ${r1y} \
            H ${r1x2} \
            C ${r1x2} ${midY} ${r2x2} ${midY} ${r2x2} ${r2y} \
            H ${r2x} \
            C ${r2x} ${midY} ${r1x} ${midY} ${r1x} ${r1y} \
            Z \
        `;
    }

    isExhaustedTransfer(): boolean {
      return this.fromCandidate === EXHAUSTED || this.toCandidate === EXHAUSTED;
    }

    tooltip(): string {
      const percentage = this.sourceVotes ?
        Math.round((this.votes / this.sourceVotes) * 1000) / 10 : null;
      const percentageText = percentage ? ` (${percentage}%)` : '';

      if (this.fromCandidate === EXHAUSTED) {
        return `<strong>${this.votes.toLocaleString()}</strong> exhausted votes
        carried over into round <strong>${this.round}</strong>`;
      } else if (this.toCandidate === EXHAUSTED) {
        return `<strong>${this.votes.toLocaleString()}</strong> votes
        for <strong>${getCandidate(this.fromCandidate).name}</strong>
        became exhausted in round <strong>${this.round}</strong>`;
      } else if (this.fromCandidate === this.toCandidate) {
        return `<strong>${this.votes.toLocaleString()}</strong> votes
        for <strong>${getCandidate(this.toCandidate).name}</strong>
        carried over into round <strong>${this.round}</strong>`;
      } else {
        return `<strong>${this.votes.toLocaleString()}</strong> votes${percentageText}
        for <strong>${getCandidate(this.fromCandidate).name}</strong>
        were transferred to <strong>${
          getCandidate(this.toCandidate).name
        }</strong>
        in round <strong>${this.round}</strong>`;
      }
    }
  }

  let transfers: TransferBlock[] = [];

  type HoverState =
    | { kind: "node"; key: NodeKey }
    | { kind: "link"; index: number }
    | null;

  let hover: HoverState = null;

  type TransferMeta = {
    sourceKey: NodeKey;
    targetKey: NodeKey;
  };

  let transferMetas: TransferMeta[] = [];
  let incoming: Map<NodeKey, number[]> = new Map();
  let outgoing: Map<NodeKey, number[]> = new Map();

  let activeNodeKeys: Set<NodeKey> = new Set();
  let activeLinkIndexes: Set<number> = new Set();

  interface CandidateState {
    xOffset: number;
    width: number;
    votes: number;
    accountedIn: number;
    accountedOut: number;
  }

  let lastVotes: Map<Allocatee, CandidateState> = new Map();

  let voteBlockRows: VoteBlock[][] = rounds.map((round, i) => {
    let voteBlocks: VoteBlock[] = [];
    let curVotes: Map<Allocatee, CandidateState> = new Map();
    let numCandidates = round.allocations.length - 1;
    let offset =
      (firstRoundNumCandidates - numCandidates) * (candidateMargin / 2);

    // Calculate total votes for this round
    const totalRoundVotes = round.allocations.reduce((sum, allocation) => sum + allocation.votes, 0);
    for (let allocation of round.allocations) {
      let width = voteScale * allocation.votes;
      voteBlocks.push(
        new VoteBlock(
          offset,
          width,
          i * roundHeight,
          allocation.allocatee,
          allocation.votes,
          i + 1,
          totalRoundVotes
        )
      );

      let last = lastVotes.get(allocation.allocatee);
      let accountedIn = 0;
      if (last) {
        transfers.push(
          new TransferBlock(
            allocation.allocatee,
            allocation.allocatee,
            last.votes,
            i + 1,
            i - 1,
            i,
            last.xOffset,
            allocation.allocatee === "X" ? offset + width - last.width : offset,
            last.width,
            (i - 1) * roundHeight + voteBlockHeight,
            i * roundHeight,
            last.votes
          )
        );

        if (allocation.allocatee !== "X") {
          accountedIn = last.width;
        }
      }

      curVotes.set(allocation.allocatee, {
        xOffset: offset,
        votes: allocation.votes,
        width,
        accountedIn,
        accountedOut: 0,
      });

      offset += width + candidateMargin;
    }

    // Compute transfers.

    for (let transfer of round.transfers) {
      let last = lastVotes.get(transfer.from);
      let cur = curVotes.get(transfer.to);

      if (!last || !cur) {
        continue;
      }

      let width = transfer.count * voteScale;

      transfers.push(
        new TransferBlock(
          transfer.from,
          transfer.to,
          transfer.count,
          i + 1,
          i - 1,
          i,
          last.xOffset + last.accountedOut,
          cur.xOffset + cur.accountedIn,
          width,
          (i - 1) * roundHeight + voteBlockHeight,
          i * roundHeight,
          last.votes
        )
      );

      last.accountedOut += width;
      cur.accountedIn += width;
    }

    lastVotes = curVotes;
    return voteBlocks;
  });

  $: {
    transferMetas = transfers.map((t) => ({
      sourceKey: t.sourceKey(),
      targetKey: t.targetKey(),
    }));

    incoming = new Map();
    outgoing = new Map();
    for (let i = 0; i < transferMetas.length; i++) {
      const meta = transferMetas[i];
      const inArr = incoming.get(meta.targetKey);
      if (inArr) inArr.push(i);
      else incoming.set(meta.targetKey, [i]);

      const outArr = outgoing.get(meta.sourceKey);
      if (outArr) outArr.push(i);
      else outgoing.set(meta.sourceKey, [i]);
    }
  }

  function computeActiveForLink(index: number): void {
    activeNodeKeys = new Set();
    activeLinkIndexes = new Set();

    const meta = transferMetas[index];
    if (!meta) return;

    const visitedUp = new Set<NodeKey>();
    const upStack: NodeKey[] = [meta.sourceKey];
    while (upStack.length) {
      const key = upStack.pop();
      if (!key || visitedUp.has(key)) continue;
      visitedUp.add(key);
      activeNodeKeys.add(key);
      const inEdges = incoming.get(key) ?? [];
      for (const edgeIdx of inEdges) {
        activeLinkIndexes.add(edgeIdx);
        const prevKey = transferMetas[edgeIdx]?.sourceKey;
        if (prevKey) upStack.push(prevKey);
      }
    }

    const visitedDown = new Set<NodeKey>();
    const downStack: NodeKey[] = [meta.targetKey];
    while (downStack.length) {
      const key = downStack.pop();
      if (!key || visitedDown.has(key)) continue;
      visitedDown.add(key);
      activeNodeKeys.add(key);
      const outEdges = outgoing.get(key) ?? [];
      for (const edgeIdx of outEdges) {
        activeLinkIndexes.add(edgeIdx);
        const nextKey = transferMetas[edgeIdx]?.targetKey;
        if (nextKey) downStack.push(nextKey);
      }
    }

    activeLinkIndexes.add(index);
    activeNodeKeys.add(meta.sourceKey);
    activeNodeKeys.add(meta.targetKey);
  }

  function computeActiveForNode(key: NodeKey): void {
    activeNodeKeys = new Set();
    activeLinkIndexes = new Set();

    const visitedUp = new Set<NodeKey>();
    const upStack: NodeKey[] = [key];
    while (upStack.length) {
      const curKey = upStack.pop();
      if (!curKey || visitedUp.has(curKey)) continue;
      visitedUp.add(curKey);
      activeNodeKeys.add(curKey);
      const inEdges = incoming.get(curKey) ?? [];
      for (const edgeIdx of inEdges) {
        activeLinkIndexes.add(edgeIdx);
        const prevKey = transferMetas[edgeIdx]?.sourceKey;
        if (prevKey) upStack.push(prevKey);
      }
    }

    const visitedDown = new Set<NodeKey>();
    const downStack: NodeKey[] = [key];
    while (downStack.length) {
      const curKey = downStack.pop();
      if (!curKey || visitedDown.has(curKey)) continue;
      visitedDown.add(curKey);
      activeNodeKeys.add(curKey);
      const outEdges = outgoing.get(curKey) ?? [];
      for (const edgeIdx of outEdges) {
        activeLinkIndexes.add(edgeIdx);
        const nextKey = transferMetas[edgeIdx]?.targetKey;
        if (nextKey) downStack.push(nextKey);
      }
    }
  }

  $: {
    if (!hover) {
      activeNodeKeys = new Set();
      activeLinkIndexes = new Set();
    } else if (hover.kind === "link") {
      computeActiveForLink(hover.index);
    } else {
      computeActiveForNode(hover.key);
    }
  }
</script>

<style>
  svg {
    color-scheme: light;
  }

  .voteBlock {
    fill: #aa0d0d;
    cursor: pointer;
  }

  .voteBlock.exhausted {
    fill: #ccc;
  }

  .voteBlock.highlight {
    stroke: #111;
    stroke-width: 2;
  }

  .voteBlock.dimmed {
    opacity: 0.35;
  }

  .transfer {
    fill: #444;
    opacity: 0.2;
    mix-blend-mode: exclusion;
    cursor: pointer;
  }

  .transfer.highlight {
    opacity: 0.85;
    mix-blend-mode: normal;
  }

  .transfer.dimmed {
    opacity: 0.06;
  }

  .percentageText {
    font-size: 9px;
    fill: white;
    font-weight: 600;
  }

  .percentageText.exhausted {
    fill: #555;
  }

  @media (prefers-color-scheme: dark) {
    .voteBlock.exhausted {
      fill: #666;
      stroke: #999;
      stroke-width: 1;
    }

    .voteBlock.highlight {
      stroke: #fff;
    }

    .percentageText.exhausted {
      fill: white;
    }

    /* Ensure red stays red in dark mode */
    .voteBlock:not(.exhausted) {
      fill: #aa0d0d;
    }

    /* Make transfer paths more visible in dark mode */
    .transfer {
      fill: #999;
      opacity: 0.4;
      mix-blend-mode: normal;
    }

    .transfer.highlight {
      opacity: 0.85;
    }

    /* Make all text in SVG light colored */
    text {
      fill: #e3e3e3;
    }
  }
</style>

<svg width="100%" viewBox={`0 0 ${width} ${height}`}>
  {#each rounds as _, i}
    <text dominant-baseline="middle" font-size="10" y={i * roundHeight + labelSpace + voteBlockHeight / 2}>Round {i+1}</text>
  {/each}
  <g transform={`translate(${edgeMargin} ${labelSpace})`}>
    {#each voteBlockRows[0] as voteBlock}
      <g
        role="img"
        transform={`translate(${voteBlock.x + voteBlock.width / 2} -10)`}
        on:pointerenter={() => (hover = { kind: "node", key: voteBlock.nodeKey() })}
        on:pointerleave={() => (hover = null)}>
        <text font-size="12" dominant-baseline="middle" transform="rotate(-90)">
          {voteBlock.label()}
        </text>
      </g>
    {/each}

    {#each voteBlockRows as voteBlockRow}
      {#each voteBlockRow as voteBlock}
        <rect
          role="img"
          use:tooltip={voteBlock.tooltip()}
          class="voteBlock"
          class:exhausted={voteBlock.isExhausted()}
          class:highlight={activeNodeKeys.has(voteBlock.nodeKey())}
          class:dimmed={hover !== null && !activeNodeKeys.has(voteBlock.nodeKey())}
          y={voteBlock.y}
          x={voteBlock.x}
          width={Math.max(1, voteBlock.width)}
          height={voteBlockHeight}
          on:pointerenter={() => (hover = { kind: "node", key: voteBlock.nodeKey() })}
          on:pointerleave={() => (hover = null)} />
        {#if voteBlock.percentage() !== null && voteBlock.width > 20}
          <text
            class="percentageText {voteBlock.isExhausted() ? 'exhausted' : ''}"
            x={voteBlock.x + voteBlock.width / 2}
            y={voteBlock.y + voteBlockHeight / 2}
            dominant-baseline="middle"
            text-anchor="middle">
            {voteBlock.percentage()}%
          </text>
        {/if}
      {/each}
    {/each}

    {#each transfers as transfer, i}
      <path
        role="img"
        use:tooltip={transfer.tooltip()}
        class="transfer"
        class:highlight={activeLinkIndexes.has(i)}
        class:dimmed={hover !== null && !activeLinkIndexes.has(i)}
        d={transfer.toPath()}
        on:pointerenter={() => (hover = { kind: "link", index: i })}
        on:pointerleave={() => (hover = null)} />
    {/each}

    {#each voteBlockRows[voteBlockRows.length - 1] as voteBlock}
      <g
        role="img"
        transform={`translate(${voteBlock.x + voteBlock.width / 2} ${innerHeight + 10})`}
        on:pointerenter={() => (hover = { kind: "node", key: voteBlock.nodeKey() })}
        on:pointerleave={() => (hover = null)}>
        <text
          font-size="12"
          dominant-baseline="middle"
          text-anchor="end"
          transform="rotate(-90)">
          {voteBlock.label()}
        </text>
      </g>
    {/each}
  </g>
</svg>
