# rcv.report

A static site and data pipeline for publishing ranked-choice voting (RCV) election reports.

- Web UI: SvelteKit (Svelte 5) app in `src/` that renders published reports
- Data pipeline: Rust project in `report_pipeline/` that normalizes raw data and generates `report.json`

## Prerequisites

- Node.js 18+ (matches CI) and npm
- Rust (stable) if you need to regenerate reports
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
git clone https://github.com/fsargent/rcv.report.git
cd rcv.report

# Extract election data archives to working directory
npm run report:extract

# This creates raw-data/ from the compressed archives/
# Time: ~5-10 minutes for 12 GB of data
```

### 3. Install and Run

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Open http://localhost:3000
```

The app reads report data from `report_pipeline/reports` via the `RANKED_VOTE_REPORTS` environment variable (set automatically in the dev script).

## Quick Start (without election data)

If you only want to view existing reports without raw data:

```bash
npm install
npm run dev
# open http://localhost:3000
```

## Scripts

### Web Development
- `npm run dev`: start SvelteKit dev server (with `RANKED_VOTE_REPORTS` set automatically)
- `npm run build`: build static site to `build/` directory
- `npm run preview`: preview the built site locally
- `npm run check`: run Svelte type checking

### Report Generation
- `npm run report`: generate reports (automatically generates card images after reports are created)
- `npm run report:sync`: sync election metadata with raw data files
- `npm run report:extract`: extract election data from archives to raw-data directory

### Card Image Generation
- `npm run generate-images`: generate share images (automatically starts/stops dev server if needed)
  - Processes images in parallel (default: 5 concurrent, set `CONCURRENCY` env var to adjust)
  - Skips unchanged images (only regenerates if report.json is newer than PNG)
- Card image validation is included in the test suite (`npm test`)

## Build

```bash
npm install
npm run build
# output: build/
```

The build script automatically sets `RANKED_VOTE_REPORTS` to `report_pipeline/reports`.

## Deployment

Deploys are handled by GitHub Pages via `.github/workflows/deploy-rcv-report.yml`:

- On push to `main`/`master`, CI installs dependencies, builds, and publishes `build/` to Pages
- CI sets `RANKED_VOTE_REPORTS` to `${{ github.workspace }}/report_pipeline/reports`

## Working with Election Data

### Data Directory Structure

```
report_pipeline/
├── archives/          # Compressed data (committed to git via LFS)
│   └── us/ca/alameda/2024/11/
│       └── nov-05-general.tar.xz
├── raw-data/          # Uncompressed working data (gitignored)
│   └── us/ca/alameda/2024/11/
│       └── nov-05-general/
│           ├── CvrExport_*.json
│           └── *Manifest.json
└── reports/           # Generated reports (committed to git)
```

### Adding New Election Data

1. **Add data to `raw-data/`**
   ```bash
   cd report_pipeline
   mkdir -p raw-data/us/ca/alameda/2025/06
   cp -r /path/to/new-data raw-data/us/ca/alameda/2025/06/
   ```

2. **Generate reports with Rust pipeline**
   ```bash
   # From project root (recommended):
   npm run report

   # Or from report_pipeline directory:
   cd report_pipeline
   ./report.sh  # See report_pipeline/README.md for details
   ```

   Note: `npm run report` automatically generates card images after reports are created.

3. **Compress for git**
   ```bash
   ./compress-to-archives.sh
   # Creates archives/ from raw-data/ (~33:1 compression)
   ```

4. **Commit archives and generated files (not raw-data)**
   ```bash
   cd ..
   git add report_pipeline/archives/us/ca/alameda/2025/06/
   git add report_pipeline/reports/us/ca/alameda/2025/06/
   git add static/share/us/ca/alameda/2025/06/
   git commit -m "Add Alameda June 2025 election"
   git push
   ```

See [DATA-WORKFLOW.md](report_pipeline/DATA-WORKFLOW.md) for complete documentation.

## Project Structure

- `src/`: SvelteKit app (Svelte 5 components, routes, API endpoints)
- `static/`: static assets copied to build
  - `static/share/`: Generated card images for social media sharing (committed)
- `report_pipeline/`: Rust data processing and report generation
  - `archives/`: Compressed election data (git LFS, committed)
  - `raw-data/`: Uncompressed working data (gitignored)
  - `reports/`: Generated JSON reports (committed)
- `build/`: static site build output (gitignored)
- `.svelte-kit/`: SvelteKit build cache (gitignored)

## Documentation

- [GIT-LFS-SETUP.md](GIT-LFS-SETUP.md) - Complete Git LFS setup and troubleshooting
- [DATA-WORKFLOW.md](report_pipeline/DATA-WORKFLOW.md) - Data management workflow
- [report_pipeline/README.md](report_pipeline/README.md) - Rust pipeline details

## Common Tasks

```bash
# First time: Extract election data
npm run report:extract

# View reports in browser
npm install && npm run dev

# Generate reports and card images
npm run report

# Generate/update share images
npm run generate-images

# Run tests (includes card image validation)
npm test

# Add new election data
cd report_pipeline
cp -r /source raw-data/us/ca/alameda/2025/06/
npm run report:sync  # Sync metadata
npm run report       # Generate reports and images
./compress-to-archives.sh
git add archives/ reports/ static/share/

# Update election data
# Edit files in raw-data/
cd report_pipeline
npm run report:sync  # Sync metadata
npm run report       # Regenerate reports and images
npm run generate-images  # Regenerate share images
./compress-to-archives.sh  # Detects changes and recompresses
git add archives/ reports/ static/share/
```

## Troubleshooting

**"Pointer file" errors:**
- You need Git LFS installed: `brew install git-lfs && git lfs install`
- Pull LFS files: `git lfs pull`

**"No such file" in raw-data/:**
- Extract archives: `npm run report:extract`

**Slow clone:**
- Archives are large (~360 MB). Be patient or use: `GIT_LFS_SKIP_SMUDGE=1 git clone ...`

See [GIT-LFS-SETUP.md](GIT-LFS-SETUP.md) for more help.

## License

Website content and generated reports may be freely distributed with attribution under CC-BY.
