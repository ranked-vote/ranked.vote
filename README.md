# ranked.vote

A static site and data pipeline for publishing ranked-choice voting (RCV) election reports.

- **Web UI**: SvelteKit (Svelte 5) app in `src/` that renders reports from a SQLite database
- **Data pipeline**: TypeScript/Bun scripts in `scripts/` that parse raw ballot data, run RCV tabulation, and write results to SQLite

## Prerequisites

- [Bun](https://bun.sh/) (latest version)
- **Git LFS** for downloading election data archives

## First-Time Setup

### 1. Install Git LFS

**macOS:**
```bash
brew install git-lfs
git lfs install
```

**Linux:**
```bash
sudo apt-get install git-lfs
git lfs install
```

See [GIT-LFS-SETUP.md](GIT-LFS-SETUP.md) for detailed instructions.

### 2. Clone and Extract Data

```bash
# Clone repository (Git LFS will automatically download archives)
git clone https://github.com/ranked-vote/ranked.vote.git
cd ranked.vote

# Extract election data archives to working directory
bun run report:extract

# This creates raw-data/ from the compressed archives/
# Time: ~5-10 minutes for 12 GB of data
```

### 3. Install and Run

```bash
# Install dependencies
bun install

# Start dev server
bun run dev

# Open http://localhost:3000
```

The app reads report data from `report_pipeline/reports.sqlite3` via the `RANKED_VOTE_DB` environment variable (set automatically in the dev and build scripts).

## Quick Start (without election data)

If you only want to view existing reports without raw data:

```bash
bun install
bun run dev
# open http://localhost:3000
```

## Scripts

### Web Development
- `bun run dev`: start SvelteKit dev server (with `RANKED_VOTE_DB` set automatically)
- `bun run build`: build static site to `build/` directory
- `bun run preview`: preview the built site locally
- `bun run check`: run Svelte type checking

### Pipeline & Report Generation
- `bun run report` (or `bun scripts/preprocess.ts`): full pipeline — reads raw data, parses ballots, normalizes, tabulates, and writes results to SQLite
- `bun run report:extract`: extract election data from archives to `raw-data/`

### Card Image Generation
- `bun run generate-images`: generate share images (automatically starts/stops dev server if needed)
  - Processes images in parallel (default: 5 concurrent, set `CONCURRENCY` env var to adjust)
  - Skips unchanged images (only regenerates when source data is newer than PNG)
- Card image validation is included in the test suite (`bun test`)

## Build

```bash
bun install
bun run build
# output: build/
```

The build script automatically sets `RANKED_VOTE_DB` to `report_pipeline/reports.sqlite3`.

## Deployment

Deploys are handled by GitHub Pages via `.github/workflows/deploy-rcv-report.yml`:

- On push to `main`/`master`, CI installs dependencies, builds, and publishes `build/` to Pages

## Working with Election Data

### Data Directory Structure

```
report_pipeline/
├── archives/          # Compressed data (committed to git via LFS)
│   └── us/ca/alameda/2024/11/
│       └── nov-05-general.tar.xz
├── election-metadata/ # Election configuration JSON (committed to git)
│   └── us/ca/alameda.json
├── raw-data/          # Uncompressed working data (gitignored)
│   └── us/ca/alameda/2024/11/
│       └── nov-05-general/
│           ├── CvrExport_*.json
│           └── *Manifest.json
└── reports.sqlite3    # Generated report database (committed to git)
```

### Adding New Election Data

1. **Add data to `raw-data/`**
   ```bash
   cd report_pipeline
   mkdir -p raw-data/us/ca/alameda/2025/06
   cp -r /path/to/new-data raw-data/us/ca/alameda/2025/06/
   ```

2. **Add or update election metadata** in `election-metadata/` (e.g. `us/ca/alameda.json`)

3. **Run the pipeline**
   ```bash
   # From project root:
   bun scripts/preprocess.ts
   ```

4. **Compress for git**
   ```bash
   cd report_pipeline
   ./compress-to-archives.sh
   # Creates archives/ from raw-data/ (~33:1 compression)
   ```

5. **Commit archives and database (not raw-data)**
   ```bash
   cd ..
   git add report_pipeline/archives/us/ca/alameda/2025/06/
   git add report_pipeline/election-metadata/us/ca/alameda.json
   git add report_pipeline/reports.sqlite3
   git add static/share/us/ca/alameda/2025/06/
   git commit -m "Add Alameda June 2025 election"
   git push
   ```

See [DATA-WORKFLOW.md](report_pipeline/DATA-WORKFLOW.md) for complete documentation.

## Project Structure

- `src/`: SvelteKit app (Svelte 5 components, routes, server-side DB access)
  - `src/lib/server/db.ts`: SQLite database access layer
- `scripts/`: TypeScript pipeline and utilities
  - `scripts/preprocess.ts`: Full pipeline (raw data → SQLite)
  - `scripts/pipeline/formats/`: Format readers (NIST SP 1500, NYC, Maine, etc.)
  - `scripts/pipeline/normalizers/`: Ballot normalizers (simple, Maine, NYC)
  - `scripts/tabulate-rcv.ts`: RCV tabulation engine
  - `scripts/compute-rcv-analysis.ts`: Analysis (pairwise, Condorcet, Smith set, etc.)
  - `scripts/init-database.ts`: SQLite schema
- `static/`: static assets copied to build
  - `static/share/`: Generated card images for social media sharing (committed)
- `report_pipeline/`: Election data and configuration
  - `election-metadata/`: Election configuration JSON files (committed)
  - `archives/`: Compressed election data (git LFS, committed)
  - `raw-data/`: Uncompressed working data (gitignored)
  - `reports.sqlite3`: SQLite database with all report data (committed)
- `tests/`: Pipeline and data validation tests
- `build/`: static site build output (gitignored)

## Documentation

- [GIT-LFS-SETUP.md](GIT-LFS-SETUP.md) - Complete Git LFS setup and troubleshooting
- [DATA-WORKFLOW.md](report_pipeline/DATA-WORKFLOW.md) - Data management workflow
- [report_pipeline/README.md](report_pipeline/README.md) - Pipeline details and format reference

## Common Tasks

```bash
# First time: Extract election data
bun run report:extract

# View reports in browser
bun install && bun run dev

# Run the full pipeline (raw data → SQLite)
bun scripts/preprocess.ts

# Generate/update share images
bun run generate-images

# Run tests
bun test

# Add new election data
cd report_pipeline
cp -r /source raw-data/us/ca/alameda/2025/06/
# Edit election-metadata/us/ca/alameda.json
cd ..
bun scripts/preprocess.ts   # Generate reports
bun run generate-images     # Generate share images
cd report_pipeline
./compress-to-archives.sh
cd ..
git add report_pipeline/archives/ report_pipeline/reports.sqlite3 static/share/
```

## Troubleshooting

**"Pointer file" errors:**
- You need Git LFS installed: `brew install git-lfs && git lfs install`
- Pull LFS files: `git lfs pull`

**"No such file" in raw-data/:**
- Extract archives: `bun run report:extract`

**Slow clone:**
- Archives are large (~360 MB). Be patient or use: `GIT_LFS_SKIP_SMUDGE=1 git clone ...`

See [GIT-LFS-SETUP.md](GIT-LFS-SETUP.md) for more help.

## License

Website content and generated reports may be freely distributed with attribution under CC-BY.
