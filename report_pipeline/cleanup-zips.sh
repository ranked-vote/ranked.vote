#!/bin/bash
set -e

# Cleanup script to remove ZIP files from raw-data that aren't in archives
# Format readers now use extracted files, so ZIP files are no longer needed

cd "$(dirname "$0")"

SOURCE_DIR="raw-data"
ARCHIVE_DIR="archives"

echo "=== ZIP File Cleanup ==="
echo "Removing ZIP files from $SOURCE_DIR/ that aren't in archives"
echo ""

REMOVED_COUNT=0
KEPT_COUNT=0

# Find all ZIP files
while IFS= read -r zipfile; do
    zipname=$(basename "$zipfile")
    reldir=$(dirname "${zipfile#$SOURCE_DIR/}")
    
    # Check if this ZIP is in any archive
    found=false
    for archive in "$ARCHIVE_DIR/${reldir}"*.tar.xz; do
        if [ -f "$archive" ]; then
            if tar -tJf "$archive" 2>/dev/null | grep -qF "$zipname"; then
                found=true
                break
            fi
        fi
    done
    
    if [ "$found" = "false" ]; then
        echo "  Removing: ${zipfile#$SOURCE_DIR/}"
        rm -v "$zipfile"
        REMOVED_COUNT=$((REMOVED_COUNT + 1))
    else
        echo "  Keeping: ${zipfile#$SOURCE_DIR/} (in archive)"
        KEPT_COUNT=$((KEPT_COUNT + 1))
    fi
done < <(find "$SOURCE_DIR" -name "*.zip" -type f | sort)

echo ""
echo "=== Summary ==="
echo "Removed: $REMOVED_COUNT ZIP files"
echo "Kept: $KEPT_COUNT ZIP files (in archives)"
echo ""
