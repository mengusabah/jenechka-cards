#!/usr/bin/env python3
"""Validate pair reviews, report disagreements, and write adjudicated decisions.

This does not review translations. Only explicitly recorded agent decisions and
human/model adjudications are accepted. Frozen inventories remain in /tmp.
"""
import argparse
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'vocabulary/source-data'
CACHE = Path('/tmp/jenechka-pair-review')


def main(write=False):
    status_path = DATA / 'pair-review-status.json'
    status = json.loads(status_path.read_text())
    resolution_path = DATA / 'pair-review-resolutions.json'
    resolutions = json.loads(resolution_path.read_text()) if resolution_path.exists() else {'decisions': []}
    resolved = {(row['language'], row['conceptId']): row for row in resolutions['decisions']}
    exclusions = {(row['language'], row['conceptId']): row for row in resolutions.get('approvedExclusions', [])}
    assert len(resolved) == len(resolutions['decisions']), 'Duplicate adjudication'
    proposals = defaultdict(list)
    pair_counts, errors, all_inventory = [], [], {}
    for pair in status['pairs']:
        raw = (CACHE / f"pairs/{pair['key']}.jsonl").read_bytes()
        assert sha256(raw).hexdigest() == pair['sha256'], 'Frozen inventory changed'
        inventory = {row['id']: row for row in map(json.loads, raw.decode().splitlines())}
        for sense, row in inventory.items():
            for code in pair['pair']:
                all_inventory[(code, sense)] = row[code]
        path = DATA / f"pair-reviews/{pair['key']}.json"
        if not path.exists():
            pair_counts.append({'pair': pair['pair'], 'reviewed': 0, 'total': len(inventory), 'corrections': 0})
            continue
        review = json.loads(path.read_text())
        assert review['pair'] == pair['pair']
        reviewed = set(review['reviewedSenseIds'])
        assert len(reviewed) == len(review['reviewedSenseIds']), f"Duplicate reviewed ID: {pair['key']}"
        assert reviewed <= inventory.keys(), f"Unknown reviewed ID: {pair['key']}"
        for row in review.get('exclusions', []):
            code, sense = row['language'], row['conceptId']
            assert code in pair['pair'] and sense in reviewed, f"Unreviewed exclusion: {sense}"
            assert inventory[sense][code] == row['originalText'], f"Excluded original changed: {sense}"
            if (code, sense) not in exclusions:
                errors.append({'pair': pair['key'], 'exclusionRequiresAdjudication': row})
            else:
                assert exclusions[(code, sense)]['originalText'] == row['originalText']
        seen = set()
        for row in review['corrections']:
            code, sense = row['language'], row['conceptId']
            assert code in pair['pair'] and sense in reviewed, f"Unreviewed correction: {pair['key']}/{sense}"
            assert inventory[sense][code] == row['originalText'], f"Changed original: {pair['key']}/{sense}/{code}"
            assert isinstance(row['replacementText'], str) and row['replacementText'].strip(), f"Empty correction: {sense}"
            if row['replacementText'] == row['originalText']:
                continue
            key = code, sense
            if key in seen:
                errors.append({'pair': pair['key'], 'duplicateCorrection': key})
            seen.add(key)
            proposals[key].append({**row, 'pair': pair['key']})
        count = {'pair': pair['pair'], 'reviewed': len(reviewed), 'total': len(inventory), 'corrections': len(seen)}
        pair_counts.append(count)
        pair['reviewed'] = len(reviewed)
        pair['corrections'] = len(seen)
        pair['status'] = 'reviewed' if len(reviewed) == len(inventory) else 'in_progress'
    for key, row in exclusions.items():
        assert all_inventory.get(key) == row['originalText'], f"Unknown excluded original: {key}"
    for row in resolutions.get('additionalCorrections', []):
        key = row['language'], row['conceptId']
        assert all_inventory.get(key) == row['originalText'], f"Unknown editorial original: {key}"
        proposals[key].append({**row, 'pair': 'editorial-adjudication'})
    conflicts, decisions = [], []
    for key, rows in sorted(proposals.items()):
        if key in exclusions:
            continue
        choices = sorted({row['replacementText'] for row in rows})
        resolution = resolved.get(key)
        if len(choices) > 1 and resolution is None:
            conflicts.append({'language': key[0], 'conceptId': key[1], 'originalText': rows[0]['originalText'],
                              'proposals': [{'pair': row['pair'], 'text': row['replacementText'], 'reason': row['reason']} for row in rows]})
            continue
        if resolution is not None:
            if resolution.get('replacementText') is None:
                continue
            replacement = resolution['replacementText']
            reason = resolution['reason']
        else:
            replacement = rows[0]['replacementText']
            reason = rows[0]['reason']
        if replacement == rows[0]['originalText']:
            continue
        decision = {'language': key[0], 'conceptId': key[1], 'originalText': rows[0]['originalText'],
                    'replacementText': replacement, 'reason': reason, 'reviewPairs': sorted({row['pair'] for row in rows})}
        evidence = sorted({url for row in rows for url in row.get('evidenceUrls', [])})
        if evidence:
            decision['evidenceUrls'] = evidence
        decisions.append(decision)
    report = {'pairs': pair_counts, 'corrections': len(decisions), 'unresolved': len(conflicts), 'errors': errors}
    report['excludedForms'] = len(exclusions)
    (CACHE / 'conflicts.json').write_text(json.dumps(conflicts, ensure_ascii=False, indent=2)+'\n')
    (CACHE / 'reconciliation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if write:
        assert not conflicts and not errors, 'Resolve every conflict/error before applying decisions'
        assert all(row['reviewed'] == row['total'] for row in pair_counts), 'Every requested pair must be fully inspected'
        result = {'scope': 'turkish-pairs', 'snapshotSha256': status['snapshotSha256'],
                  'pairs': pair_counts, 'corrections': decisions, 'exclusions': list(exclusions.values()),
                  'meaningCorrections': resolutions.get('meaningCorrections', [])}
        (DATA / 'pair-corrections.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    main(parser.parse_args().write)
