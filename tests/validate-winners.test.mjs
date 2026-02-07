import fs from "fs/promises";
import path from "path";

// Known valid winners from the user's list
const EXPECTED_WINNERS = [
  // 2025
  {
    year: 2025,
    electionName: "Municipal Election",
    jurisdictionName: "Minneapolis",
    officeName: "Mayor",
    winner: "Jacob Frey",
    numCandidates: 16,
    numRounds: 2,
  },
  // 2022
  {
    year: 2022,
    electionName: "Special Election",
    jurisdictionName: "Alaska",
    officeName: "At-large Congressional District",
    winner: "Peltola, Mary S.",
    numCandidates: 3,
    numRounds: 2,
  },
  // 2021
  {
    year: 2021,
    electionName: "Democratic Caucus",
    jurisdictionName: "New York City",
    officeName: "Mayor Nominee (Dem)",
    winner: "Eric L. Adams",
    numCandidates: 13,
    numRounds: 8,
  },
  // 2020
  {
    year: 2020,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 1",
    winner: "Connie Chan",
    numCandidates: 7,
    numRounds: 6,
  },
  {
    year: 2020,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 3",
    winner: "Aaron Peskin",
    numCandidates: 4,
    numRounds: 3,
  },
  {
    year: 2020,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 5",
    winner: "Dean Preston",
    numCandidates: 4,
    numRounds: 3,
  },
  {
    year: 2020,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 7",
    winner: "Myrna Melgar",
    numCandidates: 7,
    numRounds: 6,
  },
  {
    year: 2020,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 11",
    winner: "Ahsha Safai",
    numCandidates: 4,
    numRounds: 3,
  },
  {
    year: 2020,
    electionName: "Primary Election",
    jurisdictionName: "Maine",
    officeName: "Congressional District 2 (R)",
    winner: "Dale John Crafts",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2020,
    electionName: "Primary Election",
    jurisdictionName: "Maine",
    officeName: "State Senate - District 11 (D)",
    winner: "Glenn Chip Curry",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2020,
    electionName: "Primary Election",
    jurisdictionName: "Maine",
    officeName: "State Representative - District 41 (D)",
    winner: "Samuel Lewis Zager",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2020,
    electionName: "Primary Election",
    jurisdictionName: "Maine",
    officeName: "State Representative - District 47 (D)",
    winner: "Arthur L. Bell",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2020,
    electionName: "Primary Election",
    jurisdictionName: "Maine",
    officeName: "State Representative - District 49 (D)",
    winner: "Poppy Arford",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2020,
    electionName: "Primary Election",
    jurisdictionName: "Maine",
    officeName: "State Representative - District 90 (D)",
    winner: "Lydia V. Crafts",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2020,
    electionName: "Democratic Caucus",
    jurisdictionName: "Wyoming Democrats",
    officeName: "Presidential Nominee",
    winner: "Joe Biden",
    numCandidates: 9,
    numRounds: 2,
  },
  // 2019
  {
    year: 2019,
    electionName: "Consolidated Municipal Election",
    jurisdictionName: "San Francisco",
    officeName: "Mayor",
    winner: "London N. Breed",
    numCandidates: 7,
    numRounds: 5,
  },
  {
    year: 2019,
    electionName: "Consolidated Municipal Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 5",
    winner: "Dean Preston",
    numCandidates: 4,
    numRounds: 3,
  },
  {
    year: 2019,
    electionName: "Consolidated Municipal Election",
    jurisdictionName: "San Francisco",
    officeName: "District Attorney",
    winner: "Chesa Boudin",
    numCandidates: 4,
    numRounds: 3,
  },
  // 2018
  {
    year: 2018,
    electionName: "General Election",
    jurisdictionName: "Maine",
    officeName: "Congressional District 2",
    winner: "Jared F. Golden",
    numCandidates: 4,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 2",
    winner: "Catherine Stefani",
    numCandidates: 4,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 4",
    winner: "Gordon Mar",
    numCandidates: 8,
    numRounds: 7,
  },
  {
    year: 2018,
    electionName: "General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 6",
    winner: "Matt Haney",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 10",
    winner: "Shamann Walton",
    numCandidates: 6,
    numRounds: 6,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Mayor",
    winner: "Ed Holder",
    numCandidates: 14,
    numRounds: 4,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 1 Councilor",
    winner: "Michael Van Holst",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 2 Councilor",
    winner: "Shawn Lewis",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 4 Councilor",
    winner: "Jesse Helmer",
    numCandidates: 5,
    numRounds: 3,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 5 Councilor",
    winner: "Maureen Cassidy",
    numCandidates: 6,
    numRounds: 4,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 8 Councilor",
    winner: "Steve Lehman",
    numCandidates: 9,
    numRounds: 6,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 9 Councilor",
    winner: "Anna Hopkins",
    numCandidates: 5,
    numRounds: 3,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 10 Councilor",
    winner: "Paul Van Meerbergen",
    numCandidates: 5,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 11 Councilor",
    winner: "Stephen Turner",
    numCandidates: 6,
    numRounds: 3,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 12 Councilor",
    winner: "Elizabeth Peloza",
    numCandidates: 6,
    numRounds: 3,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 13 Councilor",
    winner: "Arielle Kayabaga",
    numCandidates: 8,
    numRounds: 6,
  },
  {
    year: 2018,
    electionName: "Municipal Election",
    jurisdictionName: "London, Ontario",
    officeName: "Ward 14 Councilor",
    winner: "Steve Hillier",
    numCandidates: 4,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "Primary Election",
    jurisdictionName: "Maine",
    officeName: "Congressional District 2 (D)",
    winner: "Jared F. Golden",
    numCandidates: 4,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "Primary Election",
    jurisdictionName: "Maine",
    officeName: "Governor (D)",
    winner: "Janet T. Mills",
    numCandidates: 8,
    numRounds: 4,
  },
  {
    year: 2018,
    electionName: "Consolidated Statewide Primary Election",
    jurisdictionName: "San Francisco",
    officeName: "Mayor",
    winner: "London Breed",
    numCandidates: 8,
    numRounds: 8,
  },
  {
    year: 2018,
    electionName: "Consolidated Statewide Primary Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 8",
    winner: "Rafael Mandelman",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "Regular Municipal Election",
    jurisdictionName: "Santa Fe",
    officeName: "Mayor",
    winner: "Alan Webber",
    numCandidates: 5,
    numRounds: 3,
  },
  {
    year: 2018,
    electionName: "Regular Municipal Election",
    jurisdictionName: "Santa Fe",
    officeName: "District 2 Councilor",
    winner: "Carol Romero-Wirth",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2018,
    electionName: "Regular Municipal Election",
    jurisdictionName: "Santa Fe",
    officeName: "District 4 Councilor",
    winner: "Joanne Vigil Coppler",
    numCandidates: 3,
    numRounds: 2,
  },
  // 2016
  {
    year: 2016,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 1",
    winner: "Sandra Lee Fewer",
    numCandidates: 10,
    numRounds: 9,
  },
  {
    year: 2016,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 7",
    winner: "Norman Yee",
    numCandidates: 5,
    numRounds: 4,
  },
  {
    year: 2016,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 9",
    winner: "Hillary Ronen",
    numCandidates: 4,
    numRounds: 3,
  },
  {
    year: 2016,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 11",
    winner: "Ahsha Safai",
    numCandidates: 5,
    numRounds: 4,
  },
  // 2015
  {
    year: 2015,
    electionName: "Consolidated Municipal Election",
    jurisdictionName: "San Francisco",
    officeName: "Mayor",
    winner: "Ed Lee",
    numCandidates: 6,
    numRounds: 11,
  },
  {
    year: 2015,
    electionName: "Consolidated Municipal Election",
    jurisdictionName: "San Francisco",
    officeName: "Sheriff",
    winner: "Vicki Hennessy",
    numCandidates: 3,
    numRounds: 2,
  },
  {
    year: 2015,
    electionName: "Consolidated Municipal Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 3",
    winner: "Aaron Peskin",
    numCandidates: 3,
    numRounds: 2,
  },
  // 2014
  {
    year: 2014,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 10",
    winner: "Malia Cohen",
    numCandidates: 5,
    numRounds: 4,
  },
  // 2012
  {
    year: 2012,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 5",
    winner: "London Breed",
    numCandidates: 8,
    numRounds: 7,
  },
  {
    year: 2012,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 7",
    winner: "Norman Yee",
    numCandidates: 9,
    numRounds: 8,
  },
  // 2011
  {
    year: 2011,
    electionName: "Consolidated Municipal Election",
    jurisdictionName: "San Francisco",
    officeName: "District Attorney",
    winner: "George Gascón",
    numCandidates: 5,
    numRounds: 4,
  },
  {
    year: 2011,
    electionName: "Consolidated Municipal Election",
    jurisdictionName: "San Francisco",
    officeName: "Mayor",
    winner: "Ed Lee",
    numCandidates: 16,
    numRounds: 22,
  },
  {
    year: 2011,
    electionName: "Consolidated Municipal Election",
    jurisdictionName: "San Francisco",
    officeName: "Sheriff",
    winner: "Ross Mirkarimi",
    numCandidates: 4,
    numRounds: 3,
  },
  // 2010
  {
    year: 2010,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 2",
    winner: "Mark Farrell",
    numCandidates: 6,
    numRounds: 6,
  },
  {
    year: 2010,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 6",
    winner: "Jane Kim",
    numCandidates: 14,
    numRounds: 14,
  },
  {
    year: 2010,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 8",
    winner: "Scott Wiener",
    numCandidates: 4,
    numRounds: 4,
  },
  {
    year: 2010,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 10",
    winner: "Malia Cohen",
    numCandidates: 21,
    numRounds: 21,
  },
  // 2009
  {
    year: 2009,
    electionName: "Mayoral Election",
    jurisdictionName: "Burlington",
    officeName: "Mayor",
    winner: "Bob Kiss",
    numCandidates: 6,
    numRounds: 3,
  },
  // 2008
  {
    year: 2008,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 1",
    winner: "Eric Mar",
    numCandidates: 9,
    numRounds: 9,
  },
  {
    year: 2008,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 3",
    winner: "David Chiu",
    numCandidates: 9,
    numRounds: 9,
  },
  {
    year: 2008,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 4",
    winner: "Carmen Chu",
    numCandidates: 3,
    numRounds: 3,
  },
  {
    year: 2008,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 5",
    winner: "Ross Mirkarimi",
    numCandidates: 3,
    numRounds: 3,
  },
  {
    year: 2008,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 7",
    winner: "Sean R. Elsbernd",
    numCandidates: 3,
    numRounds: 3,
  },
  {
    year: 2008,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 9",
    winner: "David Campos",
    numCandidates: 7,
    numRounds: 7,
  },
  {
    year: 2008,
    electionName: "Consolidated General Election",
    jurisdictionName: "San Francisco",
    officeName: "Board of Supervisors, District 11",
    winner: "John Avalos",
    numCandidates: 8,
    numRounds: 9,
  },
];

function extractYearFromPath(pathStr) {
  const match = pathStr.match(/\/(\d{4})\//);
  return match ? parseInt(match[1], 10) : null;
}

function normalizeName(name) {
  return (
    name
      .trim()
      .replace(/\s+/g, " ")
      // Normalize different quote styles to straight quotes
      .replace(/[\u201C\u201D"]/g, '"') // Left/right double quotes to straight
      .replace(/[\u2018\u2019']/g, "'")
  ); // Left/right single quotes to straight
}

function findContest(index, expected) {
  for (const election of index.elections || []) {
    const electionYear = extractYearFromPath(election.path);
    if (electionYear !== expected.year) {
      continue;
    }

    if (
      normalizeName(election.electionName) !==
        normalizeName(expected.electionName) ||
      normalizeName(election.jurisdictionName) !==
        normalizeName(expected.jurisdictionName)
    ) {
      continue;
    }

    for (const contest of election.contests || []) {
      if (
        normalizeName(contest.officeName) ===
          normalizeName(expected.officeName) ||
        normalizeName(contest.name) === normalizeName(expected.officeName)
      ) {
        return { election, contest };
      }
    }
  }
  return null;
}

describe("Election Winner Validation", () => {
  let index;

  beforeAll(async () => {
    const indexRaw = await fs.readFile(
      path.join(process.cwd(), "report_pipeline/reports/index.json"),
      "utf8",
    );
    index = JSON.parse(indexRaw);
  });

  test.each(EXPECTED_WINNERS)(
    "should have correct winner for $year $jurisdictionName - $electionName - $officeName",
    (expected) => {
      const found = findContest(index, expected);

      expect(found).not.toBeNull();
      expect(found).toBeTruthy();

      const { contest } = found;

      const actualWinner = normalizeName(contest.winner);
      const expectedWinner = normalizeName(expected.winner);

      expect(actualWinner).toBe(expectedWinner);
      expect(contest.numCandidates).toBe(expected.numCandidates);
      expect(contest.numRounds).toBe(expected.numRounds);
    },
  );
});
describe("Card Image Validation", () => {
  let index;

  beforeAll(async () => {
    const indexRaw = await fs.readFile(
      path.join(process.cwd(), "report_pipeline/reports/index.json"),
      "utf8",
    );
    index = JSON.parse(indexRaw);
  });

  test("all reports should have corresponding card images", async () => {
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

    const missingCards = [];

    for (const report of reports) {
      const reportPath = report.path;
      const outputPath = path.join(
        process.cwd(),
        `static/share/${reportPath}.png`,
      );

      try {
        await fs.access(outputPath);
      } catch {
        missingCards.push(outputPath);
      }
    }

    if (missingCards.length > 0) {
      const missingList = missingCards
        .map((p) => path.relative(process.cwd(), p))
        .join("\n  - ");
      throw new Error(
        `Missing ${missingCards.length} card image(s):\n  - ${missingList}\n\nRun 'npm run generate-images' to generate missing cards.`,
      );
    }

    expect(missingCards.length).toBe(0);
  });
});
