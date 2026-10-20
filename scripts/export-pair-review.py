#!/usr/bin/env python3
"""Freeze exact runtime inputs and export four Turkish bidirectional review inventories.

Review material stays in /tmp; editorial decisions belong in source-data.
This program inventories records. It does not perform semantic review.
"""
import argparse
from collections import defaultdict
from hashlib import sha256
from itertools import combinations
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path('/tmp/jenechka-pair-review')
PRIORITY = ['animals', 'fruits', 'vegetables', 'food-drinks', 'professions']
ACTIVE = {'tr', 'en', 'de', 'es', 'ru'}


def decode(path):
    data = json.loads(path.read_text())
    strings = data['strings']
    entries = {}
    by_index = []
    for row in data['entries']:
        entry = {'id': strings[row[1]], 'text': strings[row[7]],
                 'pos': strings[row[3]], 'meaning': strings[row[4]],
                 'grammar': [strings[i] for i in row[5]], 'categories': set(), 'ranks': []}
        entries[entry['id']] = entry
        by_index.append(entry)
    for entry, category in data['categories']:
        by_index[entry]['categories'].add(strings[category])
    for entry, rank, source in data['frequency']:
        by_index[entry]['ranks'].append(rank)
    translations = {strings[row[0]]: strings[row[1]] for row in data['translations']}
    return entries, translations


def prepare():
    registry = re.findall(r"\{ code: '([^']+)', name: '([^']+)' \}", (ROOT / 'languages.js').read_text())
    (CACHE / 'base').mkdir(parents=True, exist_ok=True)
    (CACHE / 'pairs').mkdir(exist_ok=True)
    manifest = CACHE / 'manifest.json'
    if manifest.exists():
        existing = json.loads(manifest.read_text())
        existing['pairs'] = [pair for pair in existing['pairs'] if 'tr' in pair['pair'] and set(pair['pair']) <= ACTIVE]
        existing['pairCount'] = len(existing['pairs'])
        existing['pairRecords'] = sum(pair['records'] for pair in existing['pairs'])
        manifest.write_text(json.dumps(existing, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps({k:v for k,v in existing.items() if k not in ['inputs','pairs']},indent=2))
        return
    datasets, hashes = {}, {}
    for code, name in registry:
        raw = (ROOT / f'vocabulary/v1/{code}.json').read_bytes()
        path = CACHE / f'base/{code}.json'
        path.write_bytes(raw)
        hashes[code] = sha256(raw).hexdigest()
        datasets[code] = decode(path)
    pairs = []
    for (a, a_name), (b, b_name) in combinations(registry, 2):
        if 'tr' not in (a, b) or not {a, b} <= ACTIVE:
            continue
        a_entries, a_trans = datasets[a]
        b_entries, b_trans = datasets[b]
        shared = (a_trans.keys() & b_trans.keys()) & (a_entries.keys() | b_entries.keys())
        rows = []
        for sense_id in shared:
            ea, eb = a_entries.get(sense_id), b_entries.get(sense_id)
            entry = ea or eb
            categories = sorted((ea or {}).get('categories', set()) | (eb or {}).get('categories', set()))
            rows.append({'id': sense_id, a: a_trans[sense_id], b: b_trans[sense_id],
                         'pos': entry['pos'], 'meaning': entry['meaning'], 'categories': categories,
                         'grammar': {code: e['grammar'] for code, e in [(a, ea), (b, eb)] if e and e['grammar']},
                         'directions': [f'{source}-{target}' for source, target, e in [(a,b,eb),(b,a,ea)] if e]})
        def order(row):
            priority = min([PRIORITY.index(c) for c in row['categories'] if c in PRIORITY] or [5 if row['categories'] else 6])
            return priority, ','.join(row['categories']), row[a].casefold(), row[b].casefold(), row['id']
        rows.sort(key=order)
        for index, row in enumerate(rows):
            row['row'] = index
        raw = ''.join(json.dumps(row, ensure_ascii=False, separators=(',', ':'))+'\n' for row in rows)
        key = f'{a}-{b}'
        path = CACHE / f'pairs/{key}.jsonl'
        path.write_text(raw)
        pairs.append({'pair': [a,b], 'names': [a_name,b_name], 'key': key, 'records': len(rows),
                      'categorized': sum(bool(row['categories']) for row in rows),
                      'sha256': sha256(raw.encode()).hexdigest(), 'inventory': str(path)})
    result = {'snapshotSha256': sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest(),
              'inputs': hashes, 'pairCount': len(pairs), 'pairRecords': sum(p['records'] for p in pairs), 'pairs': pairs}
    manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ['inputs','pairs']},indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--pair')
    parser.add_argument('--start', type=int, default=0)
    parser.add_argument('--limit', type=int, default=200)
    args = parser.parse_args()
    if args.prepare:
        prepare()
    elif args.pair:
        a,b = args.pair.split('-')
        if 'tr' not in (a, b) or not {a, b} <= ACTIVE:
            parser.error('Only Turkish paired with English, German, Spanish and Russian is currently in scope.')
        rows = [json.loads(line) for line in (CACHE/f'pairs/{args.pair}.jsonl').read_text().splitlines()]
        for row in rows[args.start:args.start+args.limit]:
            print(json.dumps([row['row'],row['id'],row[a],row[b],row['pos'],row['meaning'],row['categories'],row['grammar']],ensure_ascii=False,separators=(',',':')))
    else:
        parser.error('Choose --prepare or --pair.')
