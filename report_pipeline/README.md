# ranked.vote Report Pipeline

A TypeScript/Bun pipeline for processing and analyzing ranked-choice voting (RCV) election data. The pipeline converts raw ballot data from various formats into a normalized SQLite database used by the web application.

## Directory Structure

- `election-metadata/` - Election configuration JSON files (committed to git)
- `archives/` - Compressed raw ballot data (committed to git via Git LFS)
- `raw-data/` - Uncompressed working directory (gitignored, extracted from archives)
- `reports.sqlite3` - SQLite database with all report data (committed to git)

## Setup

1. Install dependencies:
   - [Bun](https://bun.sh/) (latest version)
   - Git LFS (for downloading compressed archives)

2. Clone the repository and install:

```bash
git clone https://github.com/ranked-vote/ranked.vote.git
cd ranked.vote
bun install
```

3. Extract election data from archives:

```bash
# From project root:
bun run report:extract

# Or from report_pipeline directory:
cd report_pipeline
./extract-from-archives.sh
```

This extracts compressed archives from `archives/` (managed by Git LFS) into the `raw-data/` working directory.

## Usage

### Running the Pipeline

The TypeScript pipeline processes raw ballot data end-to-end: reading raw files, parsing ballots, normalizing, running RCV tabulation, computing analysis, and writing results to SQLite.

```bash
# From project root:
bun scripts/preprocess.ts [metadata-dir] [raw-data-dir] [db-path]

# With defaults (recommended):
bun scripts/preprocess.ts
```

Default paths:
- `metadata-dir`: `report_pipeline/election-metadata`
- `raw-data-dir`: `report_pipeline/raw-data`
- `db-path`: `report_pipeline/reports.sqlite3`

You can skip specific formats with the `SKIP_FORMATS` environment variable:

```bash
SKIP_FORMATS=us_ny_nyc,us_me bun scripts/preprocess.ts
```

### Other Pipeline Scripts

- `bun scripts/init-database.ts` — Create the SQLite schema (called automatically by `preprocess.ts`)

## Pipeline Architecture

### Data Flow

```
Raw Data Files (raw-data/)
    ↓
Format Readers (scripts/pipeline/formats/)
    ↓
Raw Ballots (Choice[] per ballot — votes, undervotes, overvotes)
    ↓
Normalizers (scripts/pipeline/normalizers/)
    ↓
Normalized Ballots (ordered candidate IDs per ballot)
    ↓
RCV Tabulator (scripts/tabulate-rcv.ts)
    ↓
Round-by-round results and transfers
    ↓
Analysis (scripts/compute-rcv-analysis.ts)
    - Pairwise preferences (Condorcet matrix)
    - Smith set / Condorcet winner detection
    - First-alternate and first-final preferences
    - Ranking distribution
    ↓
SQLite Database (reports.sqlite3)
    ↓
Web Application (src/lib/server/db.ts)
```

### Key Source Files

| File | Purpose |
|---|---|
| `scripts/preprocess.ts` | Full pipeline entry point (raw data → SQLite) |
| `scripts/pipeline/formats/` | Format readers for each data source |
| `scripts/pipeline/normalizers/` | Ballot normalization strategies |
| `scripts/pipeline/types.ts` | Core type definitions |
| `scripts/tabulate-rcv.ts` | RCV tabulation engine |
| `scripts/compute-rcv-analysis.ts` | Post-tabulation analysis |
| `scripts/init-database.ts` | SQLite schema definition |

### Format Readers

Located in `scripts/pipeline/formats/`:

| Format | File | Description |
|---|---|---|
| `nist_sp_1500` | `nist-sp-1500.ts` | NIST SP 1500-103 standard (used by SF, Alameda, and others) |
| `us_ca_sfo` | `us-ca-sfo.ts` | San Francisco legacy format |
| `us_ny_nyc` | `us-ny-nyc.ts` | NYC Board of Elections (Excel-based) |
| `us_me` | `us-me.ts` | Maine state format (Excel-based) |
| `us_mn_mpls` | `us-mn-mpls.ts` | Minneapolis format |
| `us_vt_btv` | `us-vt-btv.ts` | Burlington, VT format |
| `dominion_rcr` | `dominion-rcr.ts` | Dominion RCV format (CSV) |
| `simple_json` | `simple-json.ts` | Simple JSON for testing and small elections |
| `preflib` | `preflib.ts` | PrefLib ordinal preference format (TOI/SOI) |

### Normalizers

Located in `scripts/pipeline/normalizers/`:

| Normalizer | Behavior |
|---|---|
| **simple** | Removes duplicate candidates, stops at first overvote, ignores undervotes. Used by most formats. |
| **maine** | Removes duplicates, exhausts ballot after two sequential undervotes, stops at first overvote. |
| **nyc** | Removes duplicates, stops at first overvote, filters out fully-inactive ballots. |

The normalizer is selected automatically based on the data format specified in the election metadata.

### SQLite Details

Pipeline scripts (`scripts/*.ts`) use Bun's built-in `bun:sqlite` for writing to the database. The SvelteKit web app uses `better-sqlite3` for reading, since Vite's SSR bundler does not handle `bun:sqlite` during prerendering.

The database (`reports.sqlite3`) contains these tables:

- **reports** — Election contest metadata, analysis results, and computed flags
- **candidates** — Candidate info per report (name, write-in status, vote counts)
- **rounds** — Tabulation rounds (threshold, continuing ballots)
- **allocations** — Vote allocations per candidate per round
- **transfers** — Vote transfers between candidates between rounds

## Adding Election Data

### 1. Prepare Election Metadata

Create or modify the jurisdiction metadata file in `election-metadata/` following this structure:

- US jurisdictions: `us/{state}/{city}.json` (e.g., `us/ca/sfo.json`)
- Other locations: `{country}/{region}/{city}.json`

The metadata file specifies:

- Data format (see format table above)
- Election date
- Offices and contests
- Loader parameters specific to the format

### 2. Prepare Raw Data

Create the corresponding directory structure in `raw-data/` matching your metadata path and add the raw ballot data files.

Example structure:

```text
raw-data/
└── us/
    └── ca/
        └── sfo/
            └── 2023/
                └── 11/
                    ├── mayor/
                    │   └── cvr.zip
                    └── supervisor/
                        └── cvr.zip
```

### 3. Process and Verify

```bash
# From project root:
bun scripts/preprocess.ts

# Run tests to validate results
bun test
```

### 4. Compress and Commit

```bash
cd report_pipeline
./compress-to-archives.sh

cd ..
git add report_pipeline/election-metadata/
git add report_pipeline/reports.sqlite3
git add report_pipeline/archives/
git commit -m "Add {jurisdiction} {date} election"
git push
```

Archives are managed by Git LFS and will be automatically handled when you push.

### NYC Data Ingestion Process

For NYC elections, follow this specific process:

1. **Download Data from NYC BOE**:
   - Visit the [NYC Board of Elections results page](https://www.vote.nyc/page/election-results-summary-2023)
   - Download the Excel files for the election (typically named like `2023P1V1_ELE.xlsx`, `2023P_CandidacyID_To_Name.xlsx`, etc.)

2. **Create Directory Structure**:

   ```bash
   mkdir -p raw-data/us/ny/nyc/2023/06
   ```

3. **Add Raw Data Files**:
   - Place all Excel files in `raw-data/us/ny/nyc/2023/06/`
   - Files typically include:
     - `2023P_CandidacyID_To_Name.xlsx` - Candidate mapping file
     - `2023P1V1_ELE.xlsx`, `2023P1V1_EAR.xlsx`, `2023P1V1_OTH.xlsx` - Round 1 data
     - `2023P2V1_ELE.xlsx`, `2023P2V1_EAR.xlsx`, `2023P2V1_OTH.xlsx` - Round 2 data
     - Additional rounds as needed

4. **Update Election Metadata**:
   - Edit `election-metadata/us/ny/nyc.json`
   - Add the new election entry with contest definitions and loader parameters

5. **Process Data**:

   ```bash
   # From project root:
   bun scripts/preprocess.ts
   ```

6. **Compress and Commit**:
   ```bash
   cd report_pipeline
   ./compress-to-archives.sh
   cd ..
   git add report_pipeline/archives/us/ny/nyc/2023/06/
   git add report_pipeline/reports.sqlite3
   git commit -m "Add NYC June 2023 election"
   git push
   ```

## Managing Archives

### Extracting Data

To extract compressed archives into the working directory:

```bash
./extract-from-archives.sh
```

This reads `.tar.xz` files from `archives/` and extracts them to `raw-data/`.

### Compressing Data

To compress raw data into archives for git:

```bash
./compress-to-archives.sh
```

This creates compressed `.tar.xz` files in `archives/` from `raw-data/`. The script:

- Only archives files referenced in election metadata
- Uses parallel compression for performance
- Skips files that haven't changed
- Excludes PDFs and other unnecessary files

Archives are managed by Git LFS and should be committed to the repository.

## Tests

Tests live in the project root `tests/` directory:

- `tests/normalizers.test.ts` — Unit tests for all three normalizers
- `tests/validate-db-flags.test.ts` — Regression test comparing SQLite DB flags against expected values
- `tests/validate-winners.test.mjs` — Validates winners in the database

Run tests with:

```bash
bun test
```

## Migration History

The pipeline was originally written in Rust. It was migrated to TypeScript/Bun in three stages:

1. **Stage 1** — Created a SQLite database and loader scripts to import Rust-generated JSON reports. Switched SvelteKit to read from SQLite instead of JSON files.
2. **Stage 2** — Ported the RCV tabulator, pairwise/Condorcet analysis, and report generation from Rust to TypeScript. Validated all 282 contests against Rust output.
3. **Stage 3** — Ported all format parsers (NIST, NYC, Maine, etc.) and normalizers from Rust to TypeScript. The full pipeline now runs end-to-end in TypeScript via `preprocess.ts`.

The Rust source code was removed after the migration was complete. It can be found in git history if needed.

## License

Website content and generated reports may be freely distributed with attribution under the CC-BY license.

## Contributing

This is an open source project. For more information about contributing, please see the [about page](https://ranked.vote/about).

## Author

Created and maintained by [Paul Butler](https://paulbutler.org) and [Felix Sargent](https://felixsargent.com).
