#!/bin/bash
set -e

# Compress election data from raw-data/ to archives/
# This allows us to:
# - Keep raw-data/ as uncompressed working directory (gitignored)
# - Commit archives/ to git with compressed tar.xz files
# Uses parallel compression with all CPU cores

cd "$(dirname "$0")"

SOURCE_DIR="raw-data"
ARCHIVE_DIR="archives"

# Determine number of parallel jobs (CPU cores)
if [[ $OSTYPE == "darwin"* ]]; then
	JOBS=$(sysctl -n hw.ncpu)
else
	JOBS=$(nproc)
fi

echo "=== Election Data Compression ==="
echo "Source: $SOURCE_DIR/ (working directory)"
echo "Target: $ARCHIVE_DIR/ (for git)"
echo "Parallel jobs: $JOBS"
echo ""

# Create archives directory structure
mkdir -p "$ARCHIVE_DIR"

# Function to compress an election directory using only files from metadata
compress_election() {
	local target_path="$1"

	# Read file list from mapping file
	local file_list=""
	local archive_entire_dir=false

	while IFS='|' read -r dir filename; do
		if [ "$dir" = "$target_path" ]; then
			if [ "$filename" = "*" ]; then
				# Special marker: archive entire directory
				archive_entire_dir=true
				break
			else
				if [ -z "$file_list" ]; then
					file_list="$filename"
				else
					file_list="$file_list|$filename"
				fi
			fi
		fi
	done <"$TEMP_MAPPING"

	if [ "$archive_entire_dir" = false ] && [ -z "$file_list" ]; then
		echo "  [SKIP] $target_path (no files in metadata)"
		return 0
	fi

	local relative_path="${target_path#$SOURCE_DIR/}"
	local parent_dir=$(dirname "$relative_path")
	local dir_name=$(basename "$target_path")

	# Create target directory
	mkdir -p "$ARCHIVE_DIR/$parent_dir"

	local archive_path="$ARCHIVE_DIR/$parent_dir/$dir_name.tar.xz"

	# Check if archive exists and if any source files are newer
	local needs_update=false
	if [ -f "$archive_path" ]; then
		if [ "$archive_entire_dir" = true ]; then
			# Check if any file in directory is newer than archive
			if find "$target_path" -type f ! -name "*.pdf" ! -name ".*" -newer "$archive_path" 2>/dev/null | head -1 | grep -q .; then
				needs_update=true
			fi
		else
			# Check if any source file is newer than archive
			IFS='|' read -ra FILES <<<"$file_list"
			for filename in "${FILES[@]}"; do
				file_path="$target_path/$filename"
				if [ -f "$file_path" ] && [ "$file_path" -nt "$archive_path" ]; then
					needs_update=true
					break
				fi
			done
		fi

		if [ "$needs_update" = false ]; then
			return 0
		fi
		echo "  [UPDATE] $relative_path (source changed)"
	fi

	# Calculate size before
	local size_before=0
	local file_count=0

	if [ "$archive_entire_dir" = true ]; then
		# Count all non-PDF files in directory
		while IFS= read -r file_path; do
			size_before=$((size_before + $(stat -f%z "$file_path" 2>/dev/null || stat -c%s "$file_path" 2>/dev/null || echo 0)))
			file_count=$((file_count + 1))
		done < <(find "$target_path" -type f ! -name "*.pdf" ! -name ".*" 2>/dev/null)
	else
		IFS='|' read -ra FILES <<<"$file_list"
		file_count=${#FILES[@]}
		for filename in "${FILES[@]}"; do
			file_path="$target_path/$filename"
			if [ -f "$file_path" ]; then
				size_before=$((size_before + $(stat -f%z "$file_path" 2>/dev/null || stat -c%s "$file_path" 2>/dev/null || echo 0)))
			fi
		done
	fi

	size_before_human=$(numfmt --to=iec-i --suffix=B "$size_before" 2>/dev/null || echo "${size_before}B")

	echo "  [START] $relative_path ($size_before_human, $file_count files)"

	# Create tar.xz archive
	if [ "$archive_entire_dir" = true ]; then
		# Archive entire directory excluding PDFs
		if command -v pixz &>/dev/null; then
			tar -cf - --exclude="*.pdf" -C "$SOURCE_DIR/$parent_dir" "$dir_name/" | pixz -9 >"$archive_path"
		else
			XZ_OPT="-9 -T0" tar -cJf "$archive_path" --exclude="*.pdf" -C "$SOURCE_DIR/$parent_dir" "$dir_name/"
		fi
	else
		# Archive only specific files
		local tar_files=()
		IFS='|' read -ra FILES <<<"$file_list"
		for filename in "${FILES[@]}"; do
			if [ -f "$target_path/$filename" ]; then
				tar_files+=("$dir_name/$filename")
			fi
		done

		if [ ${#tar_files[@]} -eq 0 ]; then
			echo "  [SKIP] $relative_path (no files found)"
			return 0
		fi

		if command -v pixz &>/dev/null; then
			tar -cf - -C "$SOURCE_DIR/$parent_dir" "${tar_files[@]}" | pixz -9 >"$archive_path"
		else
			XZ_OPT="-9 -T0" tar -cJf "$archive_path" -C "$SOURCE_DIR/$parent_dir" "${tar_files[@]}"
		fi
	fi

	local size_after=$(du -sh "$archive_path" | cut -f1)
	echo "  [DONE] $archive_path ($size_after)"

	# Verify archive
	if tar -tJf "$archive_path" >/dev/null 2>&1; then
		echo "  [OK] Verified"
	else
		echo "  [ERROR] Verification failed!"
		rm "$archive_path"
		return 1
	fi
}

export SOURCE_DIR
export ARCHIVE_DIR

echo "Step 1: Reading election metadata to determine files to archive..."
echo ""

# Use metadata files to determine which files actually need to be archived
# This ensures we only archive files that are actually used, excluding PDFs and other unnecessary files
META_DIR="election-metadata"

# Create a temporary file to store election directory -> files mapping
# (bash associative arrays can't be exported to subshells)
TEMP_MAPPING=$(mktemp)
trap "rm -f $TEMP_MAPPING" EXIT

# Read all metadata files and extract file lists
while IFS= read -r meta_file; do
	# Extract jurisdiction path from metadata
	jurisdiction_path=$(jq -r '.path' "$meta_file" 2>/dev/null)
	if [ -z "$jurisdiction_path" ] || [ "$jurisdiction_path" = "null" ]; then
		continue
	fi

	# Process each election in the metadata
	jq -c '.elections | to_entries[]' "$meta_file" 2>/dev/null | while IFS= read -r election_entry; do
		election_key=$(echo "$election_entry" | jq -r '.key')
		election_data=$(echo "$election_entry" | jq -r '.value')

		# Construct the election directory path
		election_dir="$SOURCE_DIR/$jurisdiction_path/$election_key"

		# Check if election has explicit files list
		files_count=$(echo "$election_data" | jq '.files | length')

		if [ "$files_count" -gt 0 ]; then
			# Use explicit files list
			echo "$election_data" | jq -r '.files | keys[]' | while IFS= read -r filename; do
				file_path="$election_dir/$filename"
				if [ -f "$file_path" ]; then
					echo "$election_dir|$filename" >>"$TEMP_MAPPING"
				fi
			done
		else
			# No explicit files - check loaderParams for directory references
			# For NIST format, look for "cvr" parameter
			cvr_dir=$(echo "$election_data" | jq -r '.contests[0].loaderParams.cvr // empty' 2>/dev/null)
			if [ -n "$cvr_dir" ] && [ "$cvr_dir" != "null" ]; then
				# Archive the entire CVR directory (excluding PDFs)
				# Handle "." as current directory
				if [[ ${cvr_dir} == "." ]]; then
					cvr_path="${election_dir}"
				else
					cvr_path="$election_dir/$cvr_dir"
				fi
				if [ -d "$cvr_path" ]; then
					# Mark this directory for archiving
					echo "$cvr_path|*" >>"$TEMP_MAPPING"
				fi
			else
				# Check for "file" parameter (like Minneapolis)
				file_param=$(echo "$election_data" | jq -r '.contests[0].loaderParams.file // empty' 2>/dev/null)
				if [ -n "$file_param" ] && [ "$file_param" != "null" ]; then
					file_path="$election_dir/$file_param"
					if [ -f "$file_path" ]; then
						echo "$election_dir|$file_param" >>"$TEMP_MAPPING"
					fi
				fi
				# Note: No fallback - only archive what's explicitly in metadata
			fi
		fi
	done
done < <(find "$META_DIR" -name "*.json" -type f 2>/dev/null | sort)

# Extract unique election directories from mapping file
ELECTION_DIRS=($(cut -d'|' -f1 "$TEMP_MAPPING" | sort -u))

# Export the mapping file path for use in compress_election function
export TEMP_MAPPING

echo "Found ${#ELECTION_DIRS[@]} elections to process"
echo ""
echo "Step 2: Compressing in parallel (using $JOBS cores)..."
echo ""

# Export compress_election function for parallel execution
export -f compress_election

# Use parallel compression with xargs
printf '%s\n' "${ELECTION_DIRS[@]}" | xargs -P "$JOBS" -I {} bash -c 'compress_election "$@"' _ {}

echo ""

echo "=== Compression Complete ==="
echo ""
echo "Archives directory structure:"
tree -h "$ARCHIVE_DIR" -L 4
echo ""
echo "Archive summary:"
find "$ARCHIVE_DIR" -name "*.tar.xz" -exec du -h {} \; | sort -h | tail -20
echo ""
echo "Total compressed size:"
du -sh "$ARCHIVE_DIR"
echo ""
echo "Original size (raw-data):"
du -sh "$SOURCE_DIR"
echo ""
echo "Next steps:"
echo "  1. Add archives/ to git: git add archives/"
echo "  2. Keep raw-data/ in .gitignore"
echo "  3. To extract: tar -xJf archives/path/to/election.tar.xz -C raw-data/path/to/"
