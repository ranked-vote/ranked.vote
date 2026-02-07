#!/usr/bin/env python3
"""
Convert Alameda County CVR CSV files to compact NIST SP 1500 JSON format.

This converts the sparse CSV format (columns for every candidate×rank) to the
more compact JSON format that only stores actual votes.

The output JSON is compatible with the existing parser and can be further
compressed with gzip for additional space savings.
"""

import csv
import json
import sys
import os
import re
from pathlib import Path
from collections import defaultdict
import argparse


def parse_candidate_manifest(manifest_path):
    """Load candidate manifest to get candidate IDs."""
    with open(manifest_path) as f:
        data = json.load(f)
    
    # Build lookup: (contest_id, normalized_name) -> candidate_id
    candidates = {}
    for c in data['List']:
        name = c['Description'].upper().strip()
        candidates[(c['ContestId'], name)] = c['Id']
    
    return candidates


def parse_contest_manifest(manifest_path):
    """Load contest manifest to get contest IDs and identify RCV contests."""
    with open(manifest_path) as f:
        data = json.load(f)
    
    # Build lookup: contest_description -> contest_id
    contests = {}
    for c in data['List']:
        if c.get('Id'):
            contests[c['Description']] = c['Id']
    
    return contests


def normalize_name(name):
    """Normalize candidate name for matching."""
    return name.upper().strip()


def process_csv_file(csv_path, candidates, contests, rcv_only=True):
    """
    Process a single CSV file and yield sessions in JSON format.
    
    Args:
        csv_path: Path to CSV file
        candidates: Dict mapping (contest_id, name) -> candidate_id
        contests: Dict mapping contest_description -> contest_id
        rcv_only: If True, only include RCV contests
    """
    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.reader(f)
        rows = []
        for i, row in enumerate(reader):
            rows.append(row)
            if i >= 3:
                break
        
        if len(rows) < 4:
            return
        
        election_row = rows[0]
        contests_row = rows[1]
        candidates_row = rows[2]
        headers_row = rows[3]
        
        # Build column mappings for contests we care about
        # col_idx -> (contest_id, candidate_id, rank)
        col_mapping = {}
        
        for col_idx, (contest_name, cand_str) in enumerate(zip(contests_row, candidates_row)):
            # Check if this is an RCV contest
            is_rcv = '(RCV)' in contest_name or 'Number of ranks' in contest_name
            if rcv_only and not is_rcv:
                continue
            
            # Find contest ID
            contest_id = None
            for desc, cid in contests.items():
                if desc in contest_name or contest_name in desc:
                    contest_id = cid
                    break
            
            if contest_id is None:
                continue
            
            # Parse candidate name and rank from "CANDIDATE NAME(rank)"
            if '(' in cand_str and cand_str.endswith(')'):
                paren_idx = cand_str.rfind('(')
                candidate_name = normalize_name(cand_str[:paren_idx])
                try:
                    rank = int(cand_str[paren_idx+1:-1])
                except ValueError:
                    continue
                
                # Find candidate ID
                candidate_id = candidates.get((contest_id, candidate_name))
                if candidate_id is None:
                    # Try write-in
                    if 'WRITE-IN' in candidate_name or candidate_name == 'WRITE-IN':
                        for (cid, name), candidate_id in candidates.items():
                            if cid == contest_id and 'WRITE' in name.upper():
                                break
                        else:
                            continue
                    else:
                        continue
                
                col_mapping[col_idx] = (contest_id, candidate_id, rank)
        
        # Find record ID column
        record_id_col = None
        tabulator_col = None
        batch_col = None
        for idx, header in enumerate(headers_row):
            if header == 'RecordId' or header == 'CvrNumber':
                record_id_col = idx
            elif header == 'TabulatorNum':
                tabulator_col = idx
            elif header == 'BatchId':
                batch_col = idx
        
        # Extract tabulator ID from filename if not in columns
        tabulator_id = 0
        filename = os.path.basename(csv_path)
        match = re.search(r'T(\d+)', filename)
        if match:
            tabulator_id = int(match.group(1))
        
        # Process ballot rows
        f.seek(0)
        reader = csv.reader(f)
        for _ in range(4):  # Skip header rows
            next(reader)
        
        for row_idx, row in enumerate(reader):
            # Get ballot metadata
            record_id = row_idx + 1
            if record_id_col and record_id_col < len(row):
                val = row[record_id_col].strip('="')
                if val:
                    record_id = val
            
            batch_id = 1
            if batch_col and batch_col < len(row):
                val = row[batch_col].strip('="')
                if val:
                    try:
                        batch_id = int(val)
                    except:
                        pass
            
            if tabulator_col and tabulator_col < len(row):
                val = row[tabulator_col].strip('="')
                if val:
                    try:
                        tabulator_id = int(val)
                    except:
                        pass
            
            # Collect marks by contest
            contest_marks = defaultdict(list)  # contest_id -> [(candidate_id, rank)]
            
            for col_idx, (contest_id, candidate_id, rank) in col_mapping.items():
                if col_idx < len(row):
                    val = row[col_idx].strip('="').strip()
                    if val and val != '0':
                        try:
                            if int(val) > 0:
                                contest_marks[contest_id].append((candidate_id, rank))
                        except:
                            pass
            
            # Skip ballots with no RCV votes
            if not contest_marks:
                continue
            
            # Build session object
            contests_list = []
            for contest_id, marks in contest_marks.items():
                marks.sort(key=lambda x: x[1])  # Sort by rank
                contests_list.append({
                    "Id": contest_id,
                    "Marks": [
                        {
                            "CandidateId": cid,
                            "Rank": rank,
                            "MarkDensity": 100,
                            "IsAmbiguous": False,
                            "IsVote": True
                        }
                        for cid, rank in marks
                    ]
                })
            
            yield {
                "TabulatorId": tabulator_id,
                "BatchId": batch_id,
                "RecordId": str(record_id),
                "CountingGroupId": 1,
                "Original": {
                    "PrecinctPortionId": 0,
                    "BallotTypeId": 0,
                    "IsCurrent": True,
                    "Contests": contests_list
                }
            }


def convert_directory(input_dir, output_path, rcv_only=True, compress=False):
    """Convert all CSV files in a directory to a single JSON file."""
    input_dir = Path(input_dir)
    
    # Load manifests
    candidate_manifest = input_dir / 'CandidateManifest.json'
    contest_manifest = input_dir / 'ContestManifest.json'
    
    if not candidate_manifest.exists():
        print(f"Error: CandidateManifest.json not found in {input_dir}")
        return False
    
    if not contest_manifest.exists():
        print(f"Error: ContestManifest.json not found in {input_dir}")
        return False
    
    candidates = parse_candidate_manifest(candidate_manifest)
    contests = parse_contest_manifest(contest_manifest)
    
    print(f"Loaded {len(candidates)} candidates and {len(contests)} contests")
    
    # Find all CSV files
    csv_files = sorted(input_dir.glob('CVR_Export_*.csv'))
    if not csv_files:
        print(f"No CVR_Export_*.csv files found in {input_dir}")
        return False
    
    print(f"Found {len(csv_files)} CSV files to process")
    
    # Process and collect all sessions
    all_sessions = []
    for i, csv_path in enumerate(csv_files, 1):
        print(f"Processing {csv_path.name} ({i}/{len(csv_files)})...")
        count = 0
        for session in process_csv_file(csv_path, candidates, contests, rcv_only):
            all_sessions.append(session)
            count += 1
        print(f"  -> {count} ballots with RCV votes")
    
    print(f"\nTotal sessions: {len(all_sessions)}")
    
    # Build output JSON
    output = {
        "Version": "5.10.50.85",
        "ElectionId": "November 8 2022 General Election",
        "Sessions": all_sessions
    }
    
    # Write output
    output_path = Path(output_path)
    if compress or output_path.suffix == '.gz':
        import gzip
        with gzip.open(output_path, 'wt', encoding='utf-8') as f:
            json.dump(output, f, separators=(',', ':'))
    else:
        with open(output_path, 'w') as f:
            json.dump(output, f, separators=(',', ':'))
    
    print(f"\nWritten to {output_path}")
    print(f"Output size: {output_path.stat().st_size / 1024 / 1024:.1f} MB")
    
    return True


def main():
    parser = argparse.ArgumentParser(description='Convert CVR CSV files to compact JSON format')
    parser.add_argument('input_dir', help='Directory containing CSV files and manifests')
    parser.add_argument('output', help='Output JSON file path (use .json.gz for compression)')
    parser.add_argument('--all-contests', action='store_true', 
                        help='Include all contests, not just RCV')
    parser.add_argument('--compress', action='store_true',
                        help='Compress output with gzip')
    
    args = parser.parse_args()
    
    success = convert_directory(
        args.input_dir,
        args.output,
        rcv_only=not args.all_contests,
        compress=args.compress
    )
    
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
