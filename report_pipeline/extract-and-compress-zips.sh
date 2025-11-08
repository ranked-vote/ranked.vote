#!/bin/bash
set -e

# Extract ZIP files and compress directories into tar.xz archives
# This handles ZIP files that weren't properly archived yet
# Strategy:
# 1. Extract ZIP files in-place (so format readers can use extracted files)
# 2. Compress entire election directories into tar.xz archives

cd "$(dirname "$0")"

SOURCE_DIR="raw-data"
ARCHIVE_DIR="archives"

# Determine number of parallel jobs
if [[ "$OSTYPE" == "darwin"* ]]; then
    JOBS=$(sysctl -n hw.ncpu)
else
    JOBS=$(nproc)
fi

echo "=== Extract ZIP Files and Create Archives ==="
echo "Source: $SOURCE_DIR/"
echo "Target: $ARCHIVE_DIR/"
echo "Parallel jobs: $JOBS"
echo ""

# Function to extract a ZIP file in-place
extract_zip_inplace() {
    local zip_path="$1"
    local relative_path="${zip_path#$SOURCE_DIR/}"
    local parent_dir=$(dirname "$zip_path")
    
    echo "  [EXTRACT] $relative_path"
    
    # Extract ZIP file into its parent directory
    if unzip -q -o "$zip_path" -d "$parent_dir" 2>/dev/null; then
        echo "  [OK] Extracted to $parent_dir"
        return 0
    else
        echo "  [ERROR] Failed to extract $zip_path"
        return 1
    fi
}

# Function to compress an election directory (same as compress-to-archives.sh)
compress_election() {
    local source_path="$1"
    local relative_path="${source_path#$SOURCE_DIR/}"
    local parent_dir=$(dirname "$relative_path")
    local dir_name=$(basename "$source_path")

    # Create target directory
    mkdir -p "$ARCHIVE_DIR/$parent_dir"

    local archive_path="$ARCHIVE_DIR/$parent_dir/$dir_name.tar.xz"

    # Skip if already compressed and source hasn't changed
    if [ -f "$archive_path" ]; then
        if [ "$source_path" -nt "$archive_path" ]; then
            echo "  [UPDATE] $relative_path (source changed)"
        else
            return 0
        fi
    fi

    # Get size before
    local size_before=$(du -sh "$source_path" | cut -f1)

    echo "  [COMPRESS] $relative_path ($size_before)"

    # Create tar.xz archive with maximum compression
    if command -v pixz &> /dev/null; then
        tar -cf - -C "$SOURCE_DIR/$parent_dir" "$dir_name/" | pixz -9 > "$archive_path"
    else
        XZ_OPT="-9 -T0" tar -cJf "$archive_path" -C "$SOURCE_DIR/$parent_dir" "$dir_name/"
    fi

    local size_after=$(du -sh "$archive_path" | cut -f1)
    echo "  [DONE] $archive_path ($size_after)"

    # Verify archive
    if tar -tJf "$archive_path" > /dev/null 2>&1; then
        echo "  [OK] Verified"
    else
        echo "  [ERROR] Verification failed!"
        rm "$archive_path"
        return 1
    fi
}

export -f extract_zip_inplace
export -f compress_election
export SOURCE_DIR
export ARCHIVE_DIR

echo "Step 1: Extracting ZIP files in-place..."
echo ""

# Find all ZIP files
ZIP_FILES=($(find "$SOURCE_DIR" -name "*.zip" -type f | sort))

if [ ${#ZIP_FILES[@]} -gt 0 ]; then
    echo "Found ${#ZIP_FILES[@]} ZIP files to extract"
    echo ""
    
    # Extract each ZIP file
    for zip_file in "${ZIP_FILES[@]}"; do
        extract_zip_inplace "$zip_file"
    done
    
    echo ""
else
    echo "No ZIP files found (may already be extracted)"
    echo ""
fi

echo "Step 2: Finding election directories to compress..."
echo ""

# Collect election directories (same logic as compress-to-archives.sh)
ELECTION_DIRS=()

# San Francisco (2-level deep: sfo/year/month)
while IFS= read -r dir; do
    ELECTION_DIRS+=("$dir")
done < <(find "$SOURCE_DIR/us/ca/sfo" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort)

# Burlington VT (2-level deep: btv/year/month)
while IFS= read -r dir; do
    ELECTION_DIRS+=("$dir")
done < <(find "$SOURCE_DIR/us/vt/btv" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort)

# Alaska (2-level deep: ak/year/month)
while IFS= read -r dir; do
    ELECTION_DIRS+=("$dir")
done < <(find "$SOURCE_DIR/us/ak" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort)

# Alameda (3-level deep: alameda/year/month/election-dir)
while IFS= read -r dir; do
    ELECTION_DIRS+=("$dir")
done < <(find "$SOURCE_DIR/us/ca/alameda" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | sort)

echo "Found ${#ELECTION_DIRS[@]} election directories"
echo ""

echo "Step 3: Compressing directories..."
echo ""

# Compress in parallel
printf '%s\n' "${ELECTION_DIRS[@]}" | xargs -P "$JOBS" -I {} bash -c 'compress_election "$@"' _ {}

echo ""
echo "=== Complete ==="
echo ""
echo "Archives created in: $ARCHIVE_DIR/"
echo ""
echo "Next steps:"
echo "  1. Test extraction: tar -xJf archives/path/to/election.tar.xz -C raw-data/path/to/"
echo "  2. Verify reports still generate: ./report.sh"
echo "  3. Commit archives: git add archives/"
