import { readFileSync } from "fs";
import { readdirSync, statSync } from "fs";
import { join } from "path";

const metadataDir = "report_pipeline/election-metadata";

function findJsonFiles(dir, basePath = "") {
  const files = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relativePath = basePath ? `${basePath}/${entry}` : entry;

    if (statSync(fullPath).isDirectory()) {
      files.push(...findJsonFiles(fullPath, relativePath));
    } else if (entry.endsWith(".json")) {
      files.push({ path: fullPath, relativePath });
    }
  }

  return files;
}

function hasWebsite(election) {
  const website = election.website;
  return website !== null && website !== undefined && website !== "";
}

const jsonFiles = findJsonFiles(metadataDir);
const electionsWithoutWebsites = [];
const electionsWithWebsites = [];
let totalElections = 0;

for (const { path, relativePath } of jsonFiles) {
  try {
    const content = readFileSync(path, "utf-8");
    const metadata = JSON.parse(content);

    if (metadata.elections) {
      for (const [electionKey, election] of Object.entries(
        metadata.elections,
      )) {
        totalElections++;
        const electionInfo = {
          jurisdiction: metadata.name,
          jurisdictionPath: metadata.path,
          electionKey,
          electionName: election.name,
          date: election.date,
          metadataFile: relativePath,
        };

        if (!hasWebsite(election)) {
          electionsWithoutWebsites.push(electionInfo);
        } else {
          electionsWithWebsites.push(electionInfo);
        }
      }
    }
  } catch (error) {
    console.error(`Error reading ${relativePath}:`, error.message);
  }
}

console.log("Elections Website Report");
console.log("=======================\n");

console.log(`Total elections: ${totalElections}`);
console.log(`Elections with websites: ${electionsWithWebsites.length}`);
console.log(`Elections without websites: ${electionsWithoutWebsites.length}\n`);

if (electionsWithoutWebsites.length === 0) {
  console.log("✓ All elections have websites!");
} else {
  console.log("Elections Missing Websites:");
  console.log("==========================\n");

  const byJurisdiction = {};
  for (const election of electionsWithoutWebsites) {
    if (!byJurisdiction[election.jurisdictionPath]) {
      byJurisdiction[election.jurisdictionPath] = {
        name: election.jurisdiction,
        elections: [],
      };
    }
    byJurisdiction[election.jurisdictionPath].elections.push(election);
  }

  for (const [jurisdictionPath, { name, elections }] of Object.entries(
    byJurisdiction,
  )) {
    console.log(`${name} (${jurisdictionPath}): ${elections.length} election(s)`);
    for (const election of elections) {
      console.log(`  - ${election.electionName} (${election.date})`);
      console.log(`    Key: ${election.electionKey}`);
      console.log(`    File: ${election.metadataFile}`);
    }
    console.log("");
  }

  console.log("\nSummary by Jurisdiction:");
  console.log("========================");
  for (const [jurisdictionPath, { name, elections }] of Object.entries(
    byJurisdiction,
  )) {
    console.log(`  ${jurisdictionPath}: ${elections.length} election(s)`);
  }
}

