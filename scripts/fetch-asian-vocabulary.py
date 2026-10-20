#!/usr/bin/env python3
"""Freeze actual ZH/JA/KO/AR dictionary senses selected by corpus lemma matches.

Source downloads stay in /tmp. Dictionary glosses are English definitions, not
independent English lexical entries and not permission to pivot arbitrary senses.
No proficiency levels, translations, lemmata, or frequency ranks are generated.
"""

import argparse
import collections
import concurrent.futures
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
LANGUAGES = ('zh', 'ja', 'ko', 'ar')
INPUTS = {
    'cedict.gz': 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
    'jmdict.gz': 'https://www.edrdg.org/pub/Nihongo/JMdict_e.gz',
    'ko.jsonl.gz': 'https://kaikki.org/dictionary/Korean/kaikki.org-dictionary-Korean.jsonl',
    'ar.jsonl.gz': 'https://kaikki.org/dictionary/Arabic/kaikki.org-dictionary-Arabic.jsonl',
}
SOURCE_IDS = {'zh': 'cc-cedict', 'ja': 'jmdict', 'ko': 'wiktionary-korean', 'ar': 'wiktionary-arabic'}
ALLOWED_POS = {'noun', 'verb', 'adj', 'adv', 'pron', 'det', 'num', 'conj', 'prep',
               'postp', 'particle', 'intj', 'phrase', 'counter'}
EXCLUDED_TAGS = {
    'form-of', 'alt-of', 'no-gloss', 'hanja', 'morpheme', 'obsolete', 'archaic',
    'dated', 'historical', 'rare', 'uncommon', 'dialectal', 'nonstandard',
    'misspelling', 'error-lua-exec', 'Classical', 'North-Korea', 'Gyeongsang',
    'Jeolla', 'Gangwon', 'Yukjin', 'Hamgyong', 'Yanbian', 'Northern',
    'Egypt', 'Yemen', 'Morocco', 'Iraq', 'al-Andalus',
}
TOPIC_CATEGORIES = {
    'agriculture': ['agriculture', 'gardening'],
    'horticulture': ['agriculture', 'gardening'],
    'gardening': ['gardening'],
    'botany': ['nature', 'gardening'],
    'zoology': ['animals'],
    'ornithology': ['animals'],
    'entomology': ['animals'],
    'food': ['food-drinks', 'dining'],
    'cooking': ['food-drinks', 'dining'],
    'cuisine': ['food-drinks', 'dining'],
    'beverages': ['food-drinks', 'dining'],
    'anatomy': ['body', 'health'],
    'medicine': ['health'],
    'clothing': ['clothing'],
    'weather': ['weather'],
    'meteorology': ['weather'],
    'transport': ['transportation'],
    'transportation': ['transportation'],
    'aviation': ['transportation', 'airport'],
    'railways': ['transportation'],
    'computing': ['technology', 'office'],
    'electronics': ['technology'],
    'education': ['school'],
    'sports': ['sports'],
    'music': ['hobbies'],
    'business': ['office'],
    'finance': ['shopping', 'office'],
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def normalized(word, language):
    word = unicodedata.normalize('NFC', word).casefold().strip()
    if language == 'ar':
        word = ''.join(ch for ch in unicodedata.normalize('NFD', word)
                       if unicodedata.category(ch) != 'Mn' or ch in '\u0654\u0655')
        word = unicodedata.normalize('NFC', word).replace('\u0640', '')
    return word


def valid_word(word, language):
    if not word or len(word) > 60 or any(c in word for c in '{}[]\n'):
        return False
    scripts = {'zh': r'[\u3400-\u9fff]', 'ja': r'[\u3040-\u30ff\u3400-\u9fff]',
               'ko': r'[가-힣]', 'ar': r'[\u0621-\u064a]'}
    return bool(re.search(scripts[language], word)) and not re.search(r'[A-Za-z0-9]', word)


def fetch(name, url, cache, refresh=False):
    destination = cache / name
    if refresh or not destination.exists():
        request = urllib.request.Request(url, headers={
            'Accept-Encoding': 'gzip',
            'User-Agent': 'JenechkaCardsVocabularyBuilder/1.0 (open dictionary extract)',
        })
        temporary = destination.with_suffix(destination.suffix + '.part')
        total = 0
        with urllib.request.urlopen(request, timeout=90) as response, temporary.open('wb') as stream:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 100_000_000:
                    raise ValueError(f'{name}: download exceeds 100 MB compressed limit')
                stream.write(chunk)
        if name.endswith('.gz') and temporary.read_bytes()[:2] != b'\x1f\x8b':
            raise ValueError(f'{name}: expected a gzip source snapshot')
        temporary.replace(destination)
    data = destination.read_bytes()
    return {'url': url, 'sha256': sha(data), 'bytes': len(data)}


def frequencies(path, language):
    result = {}
    for rank, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        word, count = line.rsplit(' ', 1)
        key = normalized(word, language)
        if key not in result:
            result[key] = {'word': word, 'rank': rank, 'count': int(count), 'source': 'frequencywords'}
    return result


def category_ids(topics):
    return sorted({category for topic in topics for category in TOPIC_CATEGORIES.get(topic.lower(), [])})


def record(language, lemma, pos, gloss, source_key, rank, tags=None, reading=None, categories=None):
    value = {
        'id': SOURCE_IDS[language] + ':' + source_key,
        'language': language, 'lemma': lemma, 'pos': pos, 'gloss': gloss,
        'source': SOURCE_IDS[language],
    }
    if rank:
        value['frequencyMatch'] = {'word': rank['word'], 'rank': rank['rank'], 'source': 'frequencywords'}
    if tags:
        value['tags'] = sorted(set(tags))
    if reading:
        value['reading'] = reading
    if categories:
        value['categories'] = categories
    return value


def cedict_gloss_tags(gloss):
    """Keep lexical definitions, excluding explicitly marked nonmodern/references.

    The source's parenthetical annotations, not inferred POS or English meaning,
    drive these decisions. Return None for excluded definitions.
    """
    if (not gloss or len(gloss) > 220 or
        re.match(r'^(?:CL:|see |see also |(?:old |euphemistic )?variant of |surname |abbr\. for |also written |erhua variant of |used (?:only |mainly |mostly )?in |Taiwan pr\.|also pr\.)', gloss, re.I) or
        re.match(r'^\(bound form\)', gloss, re.I) or
        re.search(r'\((?:archaic|literary|dialect|dialectal|obsolete)(?:[.,; )]|$)', gloss, re.I) or
        re.match(r'^dialectal equivalent of ', gloss, re.I)):
        return None
    flags = {
        '(coll.)': 'colloquial', '(slang)': 'slang', '(fig.)': 'figuratively',
        '(Tw)': 'Taiwan', '(formal)': 'formal', '(polite)': 'polite',
        '(derog.)': 'derogatory', '(vulgar)': 'vulgar',
    }
    return [tag for annotation, tag in flags.items() if annotation in gloss]


def cedict(cache, ranks):
    pattern = re.compile(r'^(\S+) (\S+) \[([^\]]+)\] /(.*)/$')
    with gzip.open(cache / 'cedict.gz', 'rt', encoding='utf-8') as stream:
        for line in stream:
            match = pattern.match(line.rstrip())
            if not match:
                continue
            traditional, simplified, reading, definitions = match.groups()
            # A capitalized pinyin syllable marks a proper name in CC-CEDICT.
            if not valid_word(simplified, 'zh') or re.search('[A-Z]', reading):
                continue
            rank = ranks.get(normalized(simplified, 'zh'))
            if not rank:
                continue
            for gloss in definitions.split('/'):
                tags = cedict_gloss_tags(gloss)
                if tags is None:
                    continue
                key = sha((traditional + '\0' + simplified + '\0' + reading + '\0' + gloss).encode())[:20]
                yield record('zh', simplified, 'unknown', gloss, key, rank, tags=tags, reading=reading)


def jmdict_pos(descriptions):
    for description in descriptions:
        if description.startswith(('noun', 'nouns')): return 'noun'
        if 'verb' in description and 'adverb' not in description: return 'verb'
        if 'adjective' in description: return 'adj'
        if description.startswith('adverb'): return 'adv'
        if description == 'pronoun': return 'pron'
        if description == 'conjunction': return 'conj'
        if description == 'particle': return 'particle'
        if description.startswith('interjection'): return 'intj'
        if description == 'numeric': return 'num'
        if description == 'counter': return 'counter'
        if description.startswith('expressions'): return 'phrase'
    return 'unknown'


def jmdict(cache, ranks):
    excluded = {'archaic', 'obsolete term', 'rare term', 'historical term',
                'dated term', 'poetical term', 'abbreviation'}
    with gzip.open(cache / 'jmdict.gz', 'rb') as stream:
        for _, entry in ET.iterparse(stream, events=['end']):
            if entry.tag != 'entry':
                continue
            entry_id = entry.findtext('ent_seq')
            kanji = []
            priorities = {}
            for element in entry.findall('k_ele'):
                if not any(any(term in (tag.text or '') for term in ['out-dated', 'irregular', 'search-only'])
                           for tag in element.findall('ke_inf')):
                    word = element.findtext('keb')
                    kanji.append(word)
                    priorities[word] = [tag.text for tag in element.findall('ke_pri')]
            readings = {element.findtext('reb'): element for element in entry.findall('r_ele')
                        if not any(any(term in (tag.text or '') for term in ['out-dated', 'search-only'])
                                   for tag in element.findall('re_inf'))}
            for word, element in readings.items():
                priorities[word] = [tag.text for tag in element.findall('re_pri')]
            primary = set(kanji[:1] + list(readings)[:1])
            inherited_pos = []
            for sense in entry.findall('sense'):
                descriptions = [tag.text for tag in sense.findall('pos')] or inherited_pos
                inherited_pos = descriptions
                pos = jmdict_pos(descriptions)
                if pos == 'unknown':
                    continue
                misc = [tag.text for tag in sense.findall('misc')]
                if set(misc) & excluded or sense.findall('dial'):
                    continue
                restrict_kanji = {tag.text for tag in sense.findall('stagk')}
                restrict_reading = {tag.text for tag in sense.findall('stagr')}
                spellings = [word for word in kanji
                             if (not restrict_kanji or word in restrict_kanji)
                             and (word in primary or priorities[word] or word in restrict_kanji)]
                for word, element in readings.items():
                    if word not in primary and not priorities[word] and word not in restrict_reading:
                        continue
                    if restrict_reading and word not in restrict_reading:
                        continue
                    read_restrictions = {tag.text for tag in element.findall('re_restr')}
                    if restrict_kanji and not (read_restrictions & restrict_kanji):
                        continue
                    spellings.append(word)
                matching = [(ranks[normalized(word, 'ja')], word) for word in spellings
                            if valid_word(word, 'ja') and normalized(word, 'ja') in ranks]
                common = [word for word in spellings
                          if set(priorities[word]) & {'ichi1', 'news1', 'spec1', 'gai1'}]
                if matching:
                    rank, lemma = min(matching, key=lambda pair: pair[0]['rank'])
                elif common and pos in {'verb', 'adj', 'adv'}:
                    rank, lemma = None, common[0]
                else:
                    continue
                if pos == 'noun' and re.fullmatch(r'[\u3040-\u309f]', lemma) and not priorities[lemma]:
                    # A bare kana letter without a lexical priority annotation is
                    # generally an alphabet/character entry, not a learner word.
                    continue
                glosses = [tag.text for tag in sense.findall('gloss')
                           if tag.get('{http://www.w3.org/XML/1998/namespace}lang', 'eng') == 'eng'
                           and tag.text]
                gloss = '; '.join(glosses)
                if not gloss or len(gloss) > 220:
                    continue
                fields = [tag.text for tag in sense.findall('field')]
                tags = descriptions + misc + fields + [tag.text for tag in sense.findall('s_inf')]
                key = entry_id + ':' + sha((gloss + '\0' + '|'.join(descriptions)).encode())[:12]
                reading = lemma if lemma in readings else next(iter(sorted(restrict_reading)), None) or next(
                    (word for word, element in readings.items()
                     if not element.findall('re_restr') or lemma in [tag.text for tag in element.findall('re_restr')]),
                    None)
                item = record('ja', lemma, pos, gloss, key, rank,
                              tags=tags, reading=reading, categories=category_ids(fields))
                if not rank:
                    item['dictionaryPriority'] = priorities[lemma]
                yield item
            entry.clear()


def wiktionary(cache, language, ranks):
    with gzip.open(cache / (language + '.jsonl.gz'), 'rt', encoding='utf-8') as stream:
        for line in stream:
            entry = json.loads(line)
            word, pos = entry.get('word', ''), entry.get('pos', '')
            if entry.get('lang_code') != language or pos not in ALLOWED_POS or not valid_word(word, language):
                continue
            rank = ranks.get(normalized(word, language))
            if not rank:
                continue
            forms = entry.get('forms', [])
            canonical = next((form for form in forms
                              if 'canonical' in form.get('tags', [])
                              and normalized(form.get('form', ''), language) == normalized(word, language)), None)
            lemma = canonical['form'] if canonical else word
            reading = next((form['form'] for form in forms if 'romanization' in form.get('tags', [])), None)
            for sense in entry.get('senses', []):
                tags = set(entry.get('tags', []) + sense.get('tags', []))
                if canonical:
                    tags.update(tag for tag in canonical.get('tags', []) if tag != 'canonical')
                if tags & EXCLUDED_TAGS or sense.get('form_of') or sense.get('alt_of'):
                    continue
                gloss = ' — '.join(sense.get('glosses', []))
                if not gloss or len(gloss) > 220 or re.search(r'\{\{|\}\}|Lua error|^RFV', gloss):
                    continue
                if re.match(r'^(?:allomorph|topic-marked form|inflection|conjugation|contraction|elative degree) of ', gloss):
                    continue
                topics = sense.get('topics', [])
                # Category paths are source annotations; no gloss keyword inference.
                yield record(language, lemma, pos, gloss,
                             sense.get('id') or sha((word + '\0' + pos + '\0' + gloss).encode())[:20],
                             rank, tags=list(tags) + topics, reading=reading,
                             categories=category_ids(topics))


def select(records, language, lemma_limit, senses_per_lemma):
    grouped = collections.defaultdict(list)
    seen = set()
    for item in records:
        key = (item['lemma'], item['pos'], item['gloss'])
        if key in seen:
            continue
        seen.add(key)
        grouped[normalized(item['lemma'], language)].append(item)
    ranked = [key for key in grouped if any('frequencyMatch' in item for item in grouped[key])]
    keys = sorted(ranked, key=lambda key: (min(item.get('frequencyMatch', {}).get('rank', 10**9)
                                            for item in grouped[key]), key))
    result = []
    for key in keys[:lemma_limit]:
        # Original dictionary sense order is preserved, never presented as sense frequency.
        values = sorted(grouped[key], key=lambda item: bool(set(item.get('tags', [])) &
                        {'literary', 'poetic', 'figuratively', 'colloquial', 'slang', 'offensive', 'vulgar'}))
        result.extend(values[:senses_per_lemma])
    if language == 'ja':
        selected_keys = set(keys[:lemma_limit])
        for pos, limit in [('verb', 150), ('adj', 100), ('adv', 50)]:
            common = [key for key in grouped if key not in selected_keys and
                      any(item['pos'] == pos and item.get('dictionaryPriority') for item in grouped[key])]
            for key in common[:limit]:
                result.extend([item for item in grouped[key] if item['pos'] == pos][:senses_per_lemma])
                selected_keys.add(key)
    return result


def self_test(records):
    """Regression checks for learner-facing defects found during source review."""
    assert cedict_gloss_tags('used in 嗎啡|吗啡[ma3 fei1]') is None
    assert cedict_gloss_tags('smile (archaic)') is None
    assert cedict_gloss_tags('(bound form) to demand; to coerce') is None
    assert cedict_gloss_tags('euphemistic variant of 屄[bi1]') is None
    assert cedict_gloss_tags('(coll.) what?') == ['colloquial']
    assert cedict_gloss_tags('(question particle for "yes-no" questions)') == []
    assert cedict_gloss_tags('(sentence-final particle) used in questions to link back to prior discourse') == []
    chinese = collections.defaultdict(list)
    for row in records:
        if row['language'] == 'zh':
            assert cedict_gloss_tags(row['gloss']) is not None
            chinese[row['lemma']].append(row)
    if '吗' in chinese:
        assert chinese['吗'][0]['reading'] == 'ma5', 'Prefer the ordinary question-particle sense of 吗'
        assert 'yes-no' in chinese['吗'][0]['gloss']
        assert all(row['reading'] != 'ma3' for row in chinese['吗'])
    if '听' in chinese:
        assert chinese['听'][0]['reading'] == 'ting1', 'Do not teach the archaic yin3 reading as listen'
        assert all(row['reading'] != 'yin3' for row in chinese['听'])
    assert len({row['id'] for row in records}) == len(records)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path('/tmp/jenechka-asian-vocabulary'))
    parser.add_argument('--output', type=Path, default=ROOT / 'vocabulary/source-data/asian.json')
    parser.add_argument('--lemmas-per-language', type=int, default=1800)
    parser.add_argument('--senses-per-lemma', type=int, default=2)
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--self-test', action='store_true', help='Check the frozen output and source-selection regressions without downloading.')
    args = parser.parse_args()
    if args.self_test:
        data = json.loads(args.output.read_text(encoding='utf-8'))
        self_test(data['records'])
        print('Asian vocabulary source-selection regression checks passed.')
        return
    if args.lemmas_per_language < 1 or args.senses_per_lemma < 1:
        raise ValueError('Selection limits must be positive.')
    args.cache.mkdir(parents=True, exist_ok=True)
    frequency_source = json.loads((ROOT / 'vocabulary/source-data/frequency.json').read_text())['source']
    inputs = {**INPUTS, **{lang + '-frequency.txt': frequency_source['inputs'][lang]['url'] for lang in LANGUAGES}}
    previous = json.loads(args.output.read_text()) if args.output.exists() else {}
    old_hashes = {name: data['sha256'] for name, data in previous.get('inputs', {}).items()}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        hashes = dict(zip(inputs, executor.map(lambda item: fetch(*item, args.cache, args.refresh), inputs.items())))
    if not args.refresh:
        changed = [name for name, data in hashes.items() if name in old_hashes and data['sha256'] != old_hashes[name]]
        if changed:
            raise ValueError('Frozen dictionary snapshots changed: ' + ', '.join(changed) + '. Review with --refresh.')
    rank_maps = {lang: frequencies(args.cache / (lang + '-frequency.txt'), lang) for lang in LANGUAGES}
    generators = {'zh': cedict(args.cache, rank_maps['zh']), 'ja': jmdict(args.cache, rank_maps['ja']),
                  'ko': wiktionary(args.cache, 'ko', rank_maps['ko']),
                  'ar': wiktionary(args.cache, 'ar', rank_maps['ar'])}
    records = [item for lang in LANGUAGES for item in select(
        generators[lang], lang, args.lemmas_per_language, args.senses_per_lemma)]
    self_test(records)
    ids = [item['id'] for item in records]
    if len(set(ids)) != len(ids):
        raise ValueError('Duplicate source sense IDs; review extraction')
    common_method = (
        'Dictionary-derived English glosses are definitions, not independently sourced English entries. '
        'Corpus selection uses real dictionary lemmata with exact NFC/casefold token matches; '
        'Arabic matching additionally removes vowel marks and tatweel while retaining hamza. '
        'Original FrequencyWords token ranks are preserved, never treated as sense or lemma frequencies. '
        f'At most {args.lemmas_per_language} matched lemmata per language and {args.senses_per_lemma} senses per lemma, preferring unmarked usage over literary/colloquial/slang tags. '
        'Japanese additionally includes at most 150 verbs, 100 adjectives, and 50 adverbs with explicit JMdict common-priority codes and no invented frequency match. '
        'No inferred CEFR/HSK/JLPT/TOPIK levels or machine translations. Not native-speaker reviewed. '
        'English gloss identity alone does not establish equivalence with another dictionary sense.'
    )
    today = previous.get('retrievedOn') if previous and not args.refresh else None
    today = today or datetime.date.today().isoformat()
    sources = [
        {'id': 'cc-cedict', 'name': 'CC-CEDICT Chinese–English Dictionary',
         'url': 'https://www.mdbg.net/chinese/dictionary?page=cedict',
         'license': 'CC-BY-SA-4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by-sa/4.0/',
         'attribution': 'CC-CEDICT contributors, published by MDBG; original CEDICT by Paul Andrew Denisowski.',
         'methodology': common_method + ' Simplified forms and individual slash-delimited glosses copied from CC-CEDICT. Proper names, reference-only/used-in glosses, bound forms, explicitly archaic/literary/dialectal definitions, classifier lists, and long definitions excluded. Source register annotations are preserved as tags. CC-CEDICT does not provide POS; unknown is retained rather than guessed.',
         'version': today + '; input SHA-256 recorded', 'input': 'cedict.gz'},
        {'id': 'jmdict', 'name': 'JMdict Japanese–English Dictionary',
         'url': 'https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project',
         'license': 'CC-BY-SA-4.0', 'licenseUrl': 'https://www.edrdg.org/edrdg/licence.html',
         'attribution': 'JMdict: James William Breen and the Electronic Dictionary Research and Development Group; dictionary contributors.',
         'methodology': common_method + ' English senses, POS, restrictions, readings, and usage tags come from JMdict. Only primary or priority-marked source spellings, or explicit sense restrictions, are eligible; honor spelling/reading restrictions and exclude dated/dialectal senses, affixes, and abbreviations. POS is reduced from the source descriptions; full descriptions remain in tags.',
         'version': today + '; input SHA-256 recorded', 'input': 'jmdict.gz',
         'documentationUrl': 'https://www.edrdg.org/jmdict/edict_doc.html'},
    ]
    for language, name in [('ko', 'Korean'), ('ar', 'Arabic')]:
        sources.append({
            'id': SOURCE_IDS[language], 'name': name + ' Wiktionary entries via Kaikki/Wiktextract',
            'url': 'https://kaikki.org/dictionary/' + name + '/index.html',
            'license': 'CC-BY-SA-4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by-sa/4.0/',
            'attribution': 'Wiktionary contributors; extracted by Wiktextract/Kaikki (Tatu Ylonen and contributors).',
            'methodology': common_method + ' Exact English glosses, source POS, sense IDs, and tags are retained. Inflection-only, alternative-only, obsolete, dialectal, and nonlexical records are excluded. Topic assignments use explicit dictionary topics, never gloss keyword matching. Arabic dictionary canonical vocalization is retained when available.',
            'version': 'Snapshot retrieved ' + today + '; exact input SHA-256 recorded',
            'input': language + '.jsonl.gz',
        })
    output = {'sources': sources, 'retrievedOn': today, 'inputs': hashes,
              'selection': {'frequencySource': frequency_source['url'], 'lemmasPerLanguage': args.lemmas_per_language,
                            'sensesPerLemma': args.senses_per_lemma, 'levels': 'No validated level dataset included'},
              'records': records}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(json.dumps({'bytes': args.output.stat().st_size, 'languages': {
        lang: {'records': sum(item['language'] == lang for item in records),
               'lemmas': len({normalized(item['lemma'], lang) for item in records if item['language'] == lang}),
               'top1000Tokens': len({item['frequencyMatch']['word'] for item in records
                                     if item['language'] == lang and item.get('frequencyMatch', {}).get('rank', 10**9) <= 1000})}
        for lang in LANGUAGES}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
