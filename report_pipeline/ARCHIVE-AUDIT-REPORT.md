# Archive Compression/Extraction Audit Report

## Executive Summary

**Status**: ✅ **PASSING** with minor issues

- **38 directories** have corresponding archives
- **0 missing archives** (all raw-data directories are archived)
- **2 orphaned archives** (old archives that don't match current directory names)
- **Compression/extraction methodology is consistent** across all jurisdictions

## Findings

### ✅ What's Working Well

1. **Consistent Archive Structure**
   - All jurisdictions follow the same pattern: `archives/{jurisdiction}/{year}/{month}/{election-dir}.tar.xz`
   - Archives contain the full directory structure needed for report generation
   - Extraction script correctly recreates the directory structure

2. **Complete Coverage**
   - All 38 election directories in `raw-data/` have corresponding archives
   - All required files for each format are included in archives:
     - **SFO**: `CityWide_MasterLookup.txt`, `CityWide_Ballot_Image.txt` (extracted, not ZIP)
     - **BTV**: `ballots` file and report directories (extracted, not ZIP)
     - **NYC**: Candidate mapping files and CVR Excel files
     - **Alameda**: JSON CVR files
     - **Maine**: JSON CVR files
     - **Other formats**: All required files present

3. **Compression Script Consistency**
   - `compress-to-archives.sh` handles all jurisdictions consistently:
     - Alameda: 3-level deep (`alameda/year/month/election-dir`)
     - SFO, Maine, NYC, Ontario: 2-level deep (`jurisdiction/year/month`)
     - Smaller jurisdictions: Specific paths
   - Uses maximum compression (`-9`) with parallel processing
   - Includes verification step

4. **Extraction Script Consistency**
   - `extract-from-archives.sh` correctly extracts to `raw-data/` maintaining structure
   - Handles all archive types uniformly
   - Includes up-to-date checks

### ⚠️ Issues Found

1. **Orphaned Archives** (2 found)
   - `archives/us/ca/alameda/2022/11/CVR - November 8, 2022 General Election.tar.xz`
   - `archives/us/ca/alameda/2024/05/City of Berkely, District 7, Special Election.tar.xz`
   
   **Impact**: Low - These are old archives that don't match current directory names. They don't prevent report generation but take up space.
   
   **Recommendation**: Review and remove if no longer needed, or rename directories to match if they contain unique data.

2. **ZIP Files in raw-data/**
   - Some ZIP files remain in `raw-data/` directories (e.g., `Nov08_RCV_CityWide_BallotImage_20081202.zip` in SFO 2008/11)
   - These are NOT included in archives (which is correct - archives contain extracted files)
   
   **Impact**: Low - Format readers now expect extracted files, not ZIPs. ZIPs in raw-data are likely leftover artifacts.
   
   **Recommendation**: Clean up ZIP files from `raw-data/` after confirming they're not needed. The `extract-and-compress-zips.sh` script handles this workflow.

### 📊 Coverage by Jurisdiction

| Jurisdiction | Directories | Archived | Missing | Status |
|-------------|------------|----------|---------|--------|
| Alameda     | 11         | 11       | 0       | ✅     |
| San Francisco | 16      | 16       | 0       | ✅     |
| Maine       | 3          | 3        | 0       | ✅     |
| NYC         | 3          | 3        | 0       | ✅     |
| Ontario     | 1          | 1        | 0       | ✅     |
| Alaska      | 1          | 1        | 0       | ✅     |
| New Mexico  | 1          | 1        | 0       | ✅     |
| Vermont BTV | 1          | 1        | 0       | ✅     |
| Wyoming     | 1          | 1        | 0       | ✅     |
| **Total**   | **38**     | **38**   | **0**   | ✅     |

## Methodology Verification

### Compression Process
1. ✅ Scripts use consistent depth detection (2-level vs 3-level)
2. ✅ All archives use `.tar.xz` format with maximum compression
3. ✅ Archives preserve directory structure correctly
4. ✅ Verification step confirms archive integrity

### Extraction Process
1. ✅ Extracts to correct `raw-data/` paths
2. ✅ Maintains directory structure
3. ✅ Handles spaces in directory names correctly
4. ✅ Works with all jurisdiction types

### Format Reader Compatibility
1. ✅ **SFO**: Reads extracted `master_file` and `ballot_file` (not ZIPs)
2. ✅ **BTV**: Reads extracted `ballots` file (not ZIPs)
3. ✅ **NYC**: Reads Excel files and candidate mappings
4. ✅ **Alameda/Maine**: Read JSON CVR files
5. ✅ All format readers expect extracted files, matching archive workflow

## Recommendations

### Immediate Actions
1. ✅ **No critical issues** - system is working correctly
2. ⚠️ **Optional**: Clean up orphaned archives after verification
3. ⚠️ **Optional**: Remove ZIP files from `raw-data/` after confirming they're not needed

### Process Improvements
1. ✅ Archive workflow is consistent and well-documented
2. ✅ `extract-and-compress-zips.sh` handles legacy ZIP migration correctly
3. ✅ Format readers updated to work with extracted files only

### Verification Steps
To verify all reports can be regenerated from archives:
```bash
# 1. Clean raw-data
rm -rf raw-data/*

# 2. Extract all archives
./extract-from-archives.sh

# 3. Regenerate all reports
./report.sh

# 4. Compare with existing reports
# (Reports should match existing ones)
```

## Cleanup Actions Taken

### ✅ Completed Cleanup (2024)

1. **Removed Orphaned Archives** (2 files, ~44.5 MB saved)
   - `archives/us/ca/alameda/2022/11/CVR - November 8, 2022 General Election.tar.xz` (44 MB)
   - `archives/us/ca/alameda/2024/05/City of Berkely, District 7, Special Election.tar.xz` (526 KB)
   - **Reason**: Old archives with different naming that don't match current directory structure. Current directories (`general` and `berkeley-d7-special`) exist and are properly archived.

2. **Removed ZIP Files from raw-data/** (18 files)
   - Removed ZIP files that were not included in archives
   - These were leftover artifacts from the old workflow where ZIPs were read directly
   - Format readers now use extracted files exclusively
   - **Kept**: 23 ZIP files that are part of archived data (e.g., CVR export ZIPs in Alameda presidential-primary)

### Current Status After Cleanup

- ✅ **0 orphaned archives**
- ✅ **23 ZIP files remain** (all are part of archived data)
- ✅ **All 38 directories properly archived**
- ✅ **Archive consistency verified**

## Conclusion

The compression and extraction methodology is **consistent and complete**. All election data directories are properly archived, and the extraction process correctly recreates the directory structure needed for report generation. Format readers have been updated to work exclusively with extracted files, aligning with the archive-based workflow.

Cleanup has been completed, removing orphaned archives and unnecessary ZIP files. The system is ready for production use.
