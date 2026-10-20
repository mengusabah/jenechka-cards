#!/usr/bin/env python3
"""Fetch and filter attributed CEFR inputs; Python standard library only.

Run: python3 scripts/fetch-cefr.py
Only vocabulary/source-data/cefr.json is written. Source bytes are verified and
processed in memory. No vocabulary, translation, or CEFR label is generated.
"""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import unicodedata
import urllib.request
from xml.etree import ElementTree as ET
import zipfile


LEVELS = ('A1', 'A2', 'B1', 'B2')
LEVEL_ORDER = {level: index for index, level in enumerate(LEVELS)}
ENGLISH_URL = 'https://www.cefr-j.org/data/CEFRJ_wordlist_ver1.6.zip'
ENGLISH_SHA256 = 'c837d2c00ab8954ed8db48e79afd8ef37099570295fec36950dbf9322303a37a'
RUSSIAN_COMMIT = 'c20223c008c278c9399d8442f52948fae9c82c1c'
RUSSIAN_BASE = f'https://raw.githubusercontent.com/smartool/data-rus-eng/{RUSSIAN_COMMIT}/'
XLSX_NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL_NS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
RUSSIAN_LEMMA = re.compile(r'[А-Яа-яЁё]+(?:[ -][А-Яа-яЁё]+)*\Z')
EDITORIAL_MARKER = re.compile(r'\b(?:deleted?|todo|fixme)\b', re.IGNORECASE)


def text(value):
    return unicodedata.normalize('NFC', ' '.join(str(value or '').split()))


def russian_lemma(value):
    # Remove only the stress accent. NFD + NFC retains ё and й orthography.
    return unicodedata.normalize('NFC', unicodedata.normalize('NFD', text(value)).replace('\u0301', ''))


def fetch(item):
    name, url = item
    request = urllib.request.Request(url, headers={'User-Agent': 'Jenechka-Cards-CEFR-import/1'})
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = response.read(10_000_001)
    if len(payload) > 10_000_000:
        raise ValueError(f'{name}: unexpected source size')
    return name, payload


def csv_rows(payload):
    return list(csv.DictReader(io.StringIO(payload.decode('utf-8-sig'), newline='')))


def xlsx_rows(payload, wanted_sheets):
    with zipfile.ZipFile(io.BytesIO(payload)) as outer:
        names = [name for name in outer.namelist() if name.endswith('.xlsx')]
        if len(names) != 1:
            raise ValueError('Expected exactly one official workbook')
        workbook_bytes = outer.read(names[0])
    result = {}
    with zipfile.ZipFile(io.BytesIO(workbook_bytes)) as book:
        strings = []
        if 'xl/sharedStrings.xml' in book.namelist():
            shared = ET.fromstring(book.read('xl/sharedStrings.xml'))
            strings = [''.join(item.itertext()) for item in shared]
        relationships = ET.fromstring(book.read('xl/_rels/workbook.xml.rels'))
        targets = {item.attrib['Id']: item.attrib['Target'] for item in relationships}
        workbook = ET.fromstring(book.read('xl/workbook.xml'))
        for sheet in workbook.findall('s:sheets/s:sheet', XLSX_NS):
            name = sheet.attrib['name']
            if name not in wanted_sheets:
                continue
            target = targets[sheet.attrib[REL_NS]]
            path = target.lstrip('/') if target.startswith('/') else str(PurePosixPath('xl') / target)
            xml = ET.fromstring(book.read(path))
            table = []
            for row in xml.findall('s:sheetData/s:row', XLSX_NS):
                values = {}
                for cell in row.findall('s:c', XLSX_NS):
                    letters = re.match(r'[A-Z]+', cell.attrib['r']).group()
                    column = 0
                    for letter in letters:
                        column = column * 26 + ord(letter) - ord('A') + 1
                    node = cell.find('s:v', XLSX_NS)
                    value = node.text if node is not None else ''
                    if cell.attrib.get('t') == 's':
                        value = strings[int(value)]
                    elif cell.attrib.get('t') == 'inlineStr':
                        value = ''.join(cell.find('s:is', XLSX_NS).itertext())
                    values[column - 1] = text(value)
                table.append([values.get(index, '') for index in range(6)])
            header = table[0]
            if header[:3] != ['headword', 'pos', 'CEFR']:
                raise ValueError(f'Unexpected columns in {name}: {header}')
            result[name] = [dict(zip(header, row)) for row in table[1:] if any(row)]
    if set(result) != set(wanted_sheets):
        raise ValueError('The official ALL and ALL_sep sheets are required')
    return result


class Audit:
    def __init__(self):
        self.row_reasons = Counter()
        self.entry_reasons = Counter()
        self.examples = defaultdict(list)

    def reject(self, reason, example, unit='row'):
        counter = self.row_reasons if unit == 'row' else self.entry_reasons
        counter[reason] += 1
        if len(self.examples[reason]) < 8:
            self.examples[reason].append(example)

    def summary(self, **fields):
        return {
            **fields,
            'excludedRowsByReason': dict(sorted(self.row_reasons.items())),
            'excludedEntriesByReason': dict(sorted(self.entry_reasons.items())),
            'examplesByReason': dict(sorted(self.examples.items())),
        }


def english_entries(payload):
    if hashlib.sha256(payload).hexdigest() != ENGLISH_SHA256:
        raise ValueError('Official CEFR-J archive changed; review the new source before updating its pinned hash')
    tables = xlsx_rows(payload, ('ALL', 'ALL_sep'))
    separate = {(row['headword'], row['pos'], row['CEFR']) for row in tables['ALL_sep']}
    audit = Audit()
    candidates = defaultdict(set)
    occurrences = Counter()
    split_rows = 0
    unsplit_slashes = []
    for row in tables['ALL']:
        lemma, pos, level = row['headword'], row['pos'], row['CEFR']
        if not lemma or not pos or level not in LEVELS:
            audit.reject('invalid_source_fields', row)
            continue
        forms = [lemma]
        if '/' in lemma:
            alternatives = [text(part) for part in lemma.split('/')]
            if all((form, pos, level) in separate for form in alternatives):
                forms = alternatives
                split_rows += 1
            else:
                # Do not guess expansions of compounds or undocumented variants.
                unsplit_slashes.append(lemma)
        for form in forms:
            candidates[(form, pos)].add(level)
            occurrences[(form, pos, level)] += 1
    entries = []
    for (lemma, pos), levels in sorted(candidates.items()):
        if len(levels) != 1:
            audit.reject('ambiguous_lemma_pos_level', {'lemma': lemma, 'pos': pos, 'levels': sorted(levels)}, 'entry')
            continue
        entries.append({'lemma': lemma, 'pos': pos, 'level': next(iter(levels))})
    entries.sort(key=lambda item: (LEVEL_ORDER[item['level']], item['lemma'], item['pos']))
    return entries, audit.summary(
        inputRows=len(tables['ALL']),
        outputEntries=len(entries),
        outputEntriesByLevel=dict(sorted(Counter(item['level'] for item in entries).items())),
        documentedAlternativeRowsSplit=split_rows,
        retainedUnexpandedSlashEntries=unsplit_slashes,
        duplicateExpandedRowsCollapsed=sum(count - 1 for count in occurrences.values()),
    )


def russian_pos(value):
    value = text(value)
    if re.fullmatch(r'N(?:\.(?:Masc|Fem|Neut))?\.(?:Anim|Inan)', value):
        return 'noun'
    return {'A': 'adjective', 'V': 'verb'}.get(value)


def russian_entries(payloads):
    topic_rows = csv_rows(payloads['SMARTool_data_Topics.csv'])
    topic_map = {text(row['Topic']): text(row['User language translation']) for row in topic_rows}
    if any(not key or not value for key, value in topic_map.items()):
        raise ValueError('Invalid topic translation in pinned SMARTool input')
    audit = Audit()
    groups = {}
    input_rows = 0
    accepted_rows = 0
    extra_empty_columns = 0
    for file_level in LEVELS:
        filename = f'SMARTool_data_{file_level}.csv'
        rows = csv_rows(payloads[filename])
        required = {'Target language lemma', 'POS', 'User language gloss', 'Level', 'Topic(s)'}
        if not rows or not required.issubset(rows[0]):
            raise ValueError(f'Unexpected columns in {filename}')
        for line, row in enumerate(rows, start=2):
            input_rows += 1
            lemma = russian_lemma(row['Target language lemma'])
            gloss = text(row['User language gloss'])
            level = text(row['Level'])
            pos = russian_pos(row['POS'])
            example = {'file': filename, 'line': line, 'lemma': lemma, 'gloss': gloss, 'level': level}
            reason = None
            if EDITORIAL_MARKER.search(lemma) or EDITORIAL_MARKER.search(gloss):
                reason = 'annotation_artifact'
            elif not lemma:
                reason = 'empty_lemma'
            elif not RUSSIAN_LEMMA.fullmatch(lemma):
                reason = 'nonlexical_or_ambiguous_lemma'
            elif not level:
                reason = 'empty_level'
            elif level != file_level:
                reason = 'filename_level_conflict'
            elif not gloss:
                reason = 'empty_gloss'
            elif not pos:
                reason = 'unknown_part_of_speech'
            elif any(text(value) for value in (row.get(None) or [])):
                reason = 'nonempty_extra_csv_columns'
            elif text(row.get('')):
                # Unnamed columns hold annotators' internal comments, not vocabulary.
                reason = 'pending_editorial_annotation'
            elif any(character in gloss for character in '<>{}[]'):
                reason = 'annotation_in_gloss'
            elif not re.search(r'[A-Za-z]', gloss):
                reason = 'non_english_gloss'
            if reason:
                audit.reject(reason, example)
                continue
            source_topics = [text(value) for value in (row['Topic(s)'] or '').split(',') if text(value) not in ('', '_')]
            unknown_topics = sorted(set(source_topics).difference(topic_map))
            if unknown_topics:
                audit.reject('unknown_topic', {**example, 'topics': unknown_topics})
                continue
            if row.get(None):
                extra_empty_columns += 1
            key = (lemma, pos, gloss)
            group = groups.setdefault(key, {'levels': set(), 'topics': set(), 'rows': 0})
            group['levels'].add(level)
            group['topics'].update(topic_map[topic] for topic in source_topics)
            group['rows'] += 1
            accepted_rows += 1
    entries = []
    ambiguous_rows = 0
    for (lemma, pos, gloss), group in sorted(groups.items()):
        if len(group['levels']) != 1:
            ambiguous_rows += group['rows']
            audit.reject('conflicting_levels_for_lemma_pos_gloss', {
                'lemma': lemma, 'pos': pos, 'gloss': gloss,
                'levels': sorted(group['levels']), 'exampleRows': group['rows'],
            }, 'entry')
            continue
        identity = json.dumps([lemma, pos, gloss], ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        entries.append({
            'id': 'ru-smartool-' + hashlib.sha256(identity).hexdigest()[:20],
            'lemma': lemma,
            'pos': pos,
            'gloss': gloss,
            'level': next(iter(group['levels'])),
            'topics': sorted(group['topics']),
        })
    entries.sort(key=lambda item: (LEVEL_ORDER[item['level']], item['lemma'], item['pos'], item['gloss']))
    return entries, audit.summary(
        inputRows=input_rows,
        acceptedExampleRows=accepted_rows,
        outputEntries=len(entries),
        outputEntriesByLevel=dict(sorted(Counter(item['level'] for item in entries).items())),
        exampleRowsExcludedForConflictingLevels=ambiguous_rows,
        repeatedExampleRowsCollapsed=accepted_rows - ambiguous_rows - len(entries),
        harmlessEmptyExtraColumns=extra_empty_columns,
        topicLabels=sorted(set(topic_map.values())),
    )


def build():
    urls = {'CEFRJ_wordlist_ver1.6.zip': ENGLISH_URL}
    urls.update({f'SMARTool_data_{level}.csv': RUSSIAN_BASE + f'SMARTool_data_{level}.csv' for level in LEVELS})
    urls['SMARTool_data_Topics.csv'] = RUSSIAN_BASE + 'SMARTool_data_Topics.csv'
    with ThreadPoolExecutor(max_workers=4) as pool:
        payloads = dict(pool.map(fetch, urls.items()))
    english, english_audit = english_entries(payloads['CEFRJ_wordlist_ver1.6.zip'])
    russian, russian_audit = russian_entries(payloads)
    files = [{
        'name': name, 'url': urls[name], 'sha256': hashlib.sha256(payloads[name]).hexdigest(),
        'bytes': len(payloads[name]),
    } for name in urls]
    data = {
        'sources': [
            {
                'id': 'cefrj',
                'name': 'CEFR-J Wordlist Version 1.6',
                'url': 'https://www.cefr-j.org/download.html',
                'license': 'CEFR-J attribution permission; research, educational and commercial use permitted',
                'licenseUrl': 'https://www.cefr-j.org/download.html',
                'attribution': 'The CEFR-J Wordlist Version 1.6. Compiled by Yukio Tono, Tokyo University of Foreign Studies. Copyright Tono Laboratory, TUFS. Retrieved from https://www.cefr-j.org/data/CEFRJ_wordlist_ver1.6.zip on 20/10/2026. Normalized and filtered for Jenechka Cards; source labels retained.',
                'methodology': 'English textbook corpora graded by CEFR-J, supplemented against the English Vocabulary Profile. Classification is for headword and part of speech, not individually verified senses. Use ALL; split slash alternatives only when every resulting form is explicitly present with the same POS and level in the official ALL_sep sheet. Exclude conflicting lemma/POS levels. No level is inferred from frequency or transferred to another language.',
                'version': '1.6 (2020-03-24)',
                'files': files[:1],
            },
            {
                'id': 'smartool',
                'name': 'SMARTool data for English-speaking learners of Russian',
                'url': 'https://github.com/smartool/data-rus-eng',
                'license': 'CC-BY-4.0',
                'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
                'attribution': 'SMARTool dataset by Radovan Bast, Laura A. Janda, Mikhail Kopotev, Olga Lyashevskaya, James D. McDonald, Tore Nesset, Ekaterina Rakhilina, Svetlana Sokolova, Evgeniia Sudarikova, Francis M. Tyers, Valentina Zhukova, and Elizaveta Kibisova. https://doi.org/10.18710/QNAPNE. CC BY 4.0. Source CSVs normalized, grouped and filtered for Jenechka Cards; no endorsement implied.',
                'methodology': 'Russian lexemes selected from textbooks and CEFR lexical minima by experienced teachers at three universities. Retain supplied A1-B2 labels and English glosses, which may contain alternatives or usage context; do not claim these are separately validated sense-level CEFR annotations. Exclude missing fields, editorial artifacts, file/row level conflicts and any lemma/POS/gloss combination with conflicting levels. Group repeated wordform/example rows by normalized lemma, coarse POS and exact normalized gloss. Remove combining acute stress marks but preserve ё and й. Map N.* to noun, A to adjective and V to verb. Topics are exact English labels from the pinned source Topics.csv; composite labels remain composite. Never reuse Russian CEFR labels for English.',
                'version': RUSSIAN_COMMIT,
                'files': files[1:],
            },
        ],
        'english': english,
        'russian': russian,
        'excluded': {'english': english_audit, 'russian': russian_audit},
    }
    validate(data)
    return data


def validate(data):
    assert all(item['level'] in LEVELS for group in ('english', 'russian') for item in data[group])
    assert len({(item['lemma'], item['pos']) for item in data['english']}) == len(data['english'])
    assert len({item['id'] for item in data['russian']}) == len(data['russian'])
    assert len({(item['lemma'], item['pos'], item['gloss']) for item in data['russian']}) == len(data['russian'])
    assert all(item['gloss'] and '\u0301' not in item['lemma'] for item in data['russian'])
    assert russian_lemma('учёба') == 'учёба' and russian_lemma('ча\u0301й') == 'чай'
    assert any('ё' in item['lemma'] for item in data['russian'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'vocabulary/source-data/cefr.json')
    arguments = parser.parse_args()
    data = build()
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({
        'output': str(arguments.output),
        'english': data['excluded']['english'],
        'russian': data['excluded']['russian'],
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
