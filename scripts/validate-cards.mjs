import fs from "fs/promises";
import path from "path";

async function validateCards() {
  console.log("Starting card validation...");

  // Read reports index
  const indexRaw = await fs.readFile(
    "report_pipeline/reports/index.json",
    "utf8",
  );
  const index = JSON.parse(indexRaw);

  // Flatten all contests from all elections
  const reports = [];
  for (const election of index.elections || []) {
    for (const contest of election.contests || []) {
      reports.push({
        path: `${election.path}/${contest.office}`,
        election: election,
        contest: contest,
      });
    }
  }

  console.log(`Found ${reports.length} reports to validate`);

  let successCount = 0;
  let failureCount = 0;
  const failures = [];

  for (const report of reports) {
    const reportPath = report.path;
    const outputPath = `static/share/${reportPath}.png`;

    try {
      await fs.access(outputPath);
      successCount++;
      console.log(`✓ ${outputPath} - OK`);
    } catch (error) {
      failureCount++;
      failures.push(`${outputPath} - Not found`);
      console.error(`✗ ${outputPath} - Not found`);
    }
  }

  console.log(`\nValidation complete!`);
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${failureCount}`);

  if (failures.length > 0) {
    console.log(`\nFailures:`);
    failures.forEach((failure) => console.log(`  - ${failure}`));
    process.exit(1);
  }

  console.log(`\n🎉 All ${reports.length} card images are accessible!`);
}

validateCards().catch((error) => {
  console.error("Validation failed:", error);
  process.exit(1);
});
