<svelte:head>
	<title>About ranked.vote</title>
</svelte:head>

<div class="container">
<div class="description">
  <h1>About <a href="/">ranked.vote</a></h1>
</div>

<p>
  <a href="https://en.wikipedia.org/wiki/Instant-runoff_voting">
    Instant-runoff elections
  </a>
  produce a lot of data about voter preferences. Typically, this information is
  made available by election boards in specialized file formats and requires
  processing to interpret. The purpose of ranked.vote is to increase transparency into these
  elections by creating detailed and intuitive reports about them.
</p>

<p>
  All reports are generated from the raw ballot data, rather than using the
  official tabulation. As a result, the reports also serve as an independent
  tabulation of the results that can be reproduced using published source code.
</p>

<h2>Featured Elections</h2>

<p>
  We feature elections where the ranked-choice voting process was meaningful—specifically,
  races that required three or more rounds of tabulation. Elections decided in one or two
  rounds are excluded because they represent cases where a candidate won with a clear
  majority from the start, making the instant-runoff mechanism less relevant. By focusing
  on elections with multiple rounds of elimination and vote transfers, we highlight cases
  where ranked-choice voting had a substantial impact on determining the winner.
</p>

<p>
  To view all elections in our database, including those excluded from the featured list,
  see the <a href="/all">all elections page</a>.
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

<h2>Learning More</h2>

<p>
  To learn more about social choice theory and voting methods, check out
  <a href="https://ncase.me/ballot">Nicky Case's "Build a Better Ballot"</a>,
  an interactive guide to voting methods, and the
  <a href="https://electionscience.org">Center for Election Science</a>,
  which promotes evidence-based voting methods.
</p>

<h2>Database Access</h2>

<p>
  The election data is stored in a SQLite database. You can explore it using the
  <a href="/data">Database Explorer</a>, which uses Datasette Lite and runs entirely in
  your browser. The database file is also available directly from
  <a href="https://github.com/ranked-vote/rcv.report">GitHub</a>.
</p>

<h2>Contributing</h2>

<p>
  Contributions are welcome! The project is open source and available on
  <a href="https://github.com/ranked-vote/rcv.report">GitHub</a>. Please feel free to
  open issues, submit pull requests, or reach out with questions.
</p>

<h2>License</h2>

<p>
  This website and the data pipeline behind it (including the tabulator) are
  <a href="https://github.com/ranked-vote/rcv.report">open source</a> and liberally licensed. Website content and generated reports may
  be freely distributed with attribution under the <a href="https://creativecommons.org/licenses/by/2.0/">CC-BY</a> license.
</p>

<h2>Colophon</h2>

<p>
  The font is <a href="https://github.com/adobe-fonts/source-sans-pro">Source Sans Pro</a>.
</p>
</div>

