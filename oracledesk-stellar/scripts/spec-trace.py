#!/usr/bin/env python3
"""
Specification Traceability Checker for OracleDesk Protocol

Scans specification files in docs/spec/ and test files in contracts/*/src/
to verify that every clause (AUTH, PRE, POST, EVT, ERR, INV) is either:
  1. Covered by at least one test (annotated with // spec: <ID>)
  2. Explicitly marked UNTESTED(#issue-number)

Exit code 0 if all clauses are covered or marked UNTESTED.
Exit code 1 if any clause has no coverage and no UNTESTED mark.
"""

import os
import re
import sys
from pathlib import Path
from collections import defaultdict

# Pattern to match spec clause IDs in documentation
CLAUSE_PATTERN = re.compile(r'\b([A-Z]{2,3})-([A-Z0-9_-]+)-([A-Z]{3,4})-(\d+)\b')

# Pattern to match test annotations (// spec: ID1, ID2, ...)
TEST_ANNOTATION_PATTERN = re.compile(r'//\s*spec:\s*([A-Z0-9_,\s-]+)')

# Pattern to match UNTESTED markers
UNTESTED_PATTERN = re.compile(r'UNTESTED\(#(\d+)\)')

def find_all_clauses(spec_dir: Path) -> set:
    """Extract all clause IDs from specification files."""
    clauses = set()

    for spec_file in spec_dir.glob('*.md'):
        if spec_file.name == 'conventions.md' or spec_file.name == 'traceability.md':
            continue

        with open(spec_file, 'r') as f:
            content = f.read()
            matches = CLAUSE_PATTERN.findall(content)
            for match in matches:
                contract, func, kind, num = match
                clause_id = f"{contract}-{func}-{kind}-{num}"
                clauses.add(clause_id)

    return clauses

def find_test_coverage(contracts_dir: Path) -> dict:
    """Extract test annotations from Rust test files.

    Returns a dict: {clause_id -> [test_path::test_name, ...]}
    """
    coverage = defaultdict(list)

    # Scan contract test files
    for rust_file in contracts_dir.rglob('*.rs'):
        try:
            with open(rust_file, 'r') as f:
                content = f.read()

                # Find all test functions
                test_pattern = re.compile(r'#\[test\]\s*\n\s*fn\s+([a-z_]+)\s*\(')
                tests = test_pattern.finditer(content)

                for test_match in tests:
                    test_name = test_match.group(1)
                    # Look back from test function for annotation comment
                    start_pos = test_match.start()

                    # Scan backwards to find any spec annotations before this test
                    scan_start = max(0, start_pos - 500)
                    scan_text = content[scan_start:start_pos]

                    # Find most recent spec annotation(s)
                    for anno_match in TEST_ANNOTATION_PATTERN.finditer(scan_text):
                        ids_str = anno_match.group(1)
                        # Parse comma-separated IDs
                        clause_ids = [id.strip() for id in ids_str.split(',')]

                        for clause_id in clause_ids:
                            # Skip UNTESTED markers in this list
                            if 'UNTESTED' in clause_id:
                                continue
                            test_path = f"{rust_file.relative_to(contracts_dir.parent)}::{test_name}"
                            coverage[clause_id].append(test_path)
        except Exception as e:
            print(f"Warning: Error reading {rust_file}: {e}", file=sys.stderr)

    return dict(coverage)

def find_untested_marks(contracts_dir: Path, spec_dir: Path) -> dict:
    """Find UNTESTED markers in spec files.

    Returns a dict: {clause_id -> issue_number}
    """
    untested = {}

    # Scan spec files for UNTESTED marks
    for spec_file in spec_dir.glob('*.md'):
        if spec_file.name == 'conventions.md' or spec_file.name == 'traceability.md':
            continue

        with open(spec_file, 'r') as f:
            content = f.read()

            # Find clause IDs followed by UNTESTED marks
            for match in CLAUSE_PATTERN.finditer(content):
                contract, func, kind, num = match.groups()
                clause_id = f"{contract}-{func}-{kind}-{num}"

                # Check if this clause has UNTESTED marker nearby (within 200 chars)
                match_end = match.end()
                nearby = content[match_end:match_end + 200]

                untested_match = UNTESTED_PATTERN.search(nearby)
                if untested_match:
                    issue_num = untested_match.group(1)
                    untested[clause_id] = issue_num

    return untested

def main():
    """Main function."""
    # Resolve from this script's location (oracledesk-stellar/scripts/), so the
    # check works from the repo root or from oracledesk-stellar/ alike.
    project_root = Path(__file__).resolve().parent.parent
    spec_dir = project_root / 'docs' / 'spec'
    contracts_dir = project_root / 'contracts'

    if not spec_dir.exists():
        print(f"Error: Spec directory not found: {spec_dir}", file=sys.stderr)
        return 1

    if not contracts_dir.exists():
        print(f"Error: Contracts directory not found: {contracts_dir}", file=sys.stderr)
        return 1

    print("=" * 70)
    print("OracleDesk Specification Traceability Check")
    print("=" * 70)

    # Find all specification clauses
    clauses = find_all_clauses(spec_dir)
    print(f"\n✓ Found {len(clauses)} specification clauses")

    # Find test coverage
    coverage = find_test_coverage(contracts_dir)
    print(f"✓ Found {len(coverage)} covered clauses")

    # Find UNTESTED marks
    untested = find_untested_marks(contracts_dir, spec_dir)
    print(f"✓ Found {len(untested)} explicitly untested clauses")

    # Analyze coverage
    uncovered = []
    covered_or_marked = 0

    print("\n" + "-" * 70)
    print("Coverage Analysis:")
    print("-" * 70)

    for clause_id in sorted(clauses):
        is_covered = clause_id in coverage
        is_marked = clause_id in untested

        if is_covered:
            tests = coverage[clause_id]
            print(f"✓ {clause_id:30s} → {len(tests)} test(s)")
            covered_or_marked += 1
        elif is_marked:
            issue = untested[clause_id]
            print(f"⊗ {clause_id:30s} → UNTESTED(#{issue})")
            covered_or_marked += 1
        else:
            print(f"✗ {clause_id:30s} → NO COVERAGE")
            uncovered.append(clause_id)

    # Summary
    print("\n" + "=" * 70)
    print("Summary:")
    print("=" * 70)
    print(f"Total clauses:         {len(clauses)}")
    print(f"Covered:               {len(coverage)}")
    print(f"Explicitly untested:   {len(untested)}")
    print(f"Missing coverage:      {len(uncovered)}")

    if uncovered:
        print(f"\n❌ {len(uncovered)} clause(s) need coverage or UNTESTED marks:")
        for clause_id in uncovered:
            print(f"   - {clause_id}")
        return 1
    else:
        print(f"\n✅ All {len(clauses)} clauses are covered or marked untested!")
        return 0

if __name__ == '__main__':
    sys.exit(main())
