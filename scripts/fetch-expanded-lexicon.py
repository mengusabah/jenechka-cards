#!/usr/bin/env python3
"""Extract a reproducible, sense-aligned multilingual subset of Wiktionary.

The single bulk gzip stays outside the repository. Download integrity is pinned;
no web service is used by the app. Each concept is one explicit translation table,
with its original English POS and etymology. This is dictionary data, not a new
CEFR classification or a machine translation.
"""

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ID = "wiktionary-kaikki-expanded"
BULK_URL = "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz"
BULK_BYTES = 523331798
BULK_SHA256 = "6d40e0067718aeb3321db30297761ca803838390627111a29a5426fee4557faf"
EXTRACTED_ON = "2026-10-03"
DUMP_DATE = "2026-09-02"
SOURCE_ORDER_NOTICE = ("bulkLine is the original 1-based JSONL record number. "
                       "sourceSenseOrder is the 0-based first encounter of eligible explicit translation headings, "
                       "reading entry-level translations then nested senses in original array order. "
                       "This is source encounter order, not a frequency ranking of meanings.")
LANGUAGES = {
    "tr": {"Turkish"}, "de": {"German"}, "es": {"Spanish"},
    "fr": {"French"}, "it": {"Italian"}, "ru": {"Russian"},
    "pt": {"Portuguese"}, "zh": {"Chinese Mandarin", "Mandarin", "Chinese"},
    "ja": {"Japanese"}, "ko": {"Korean"}, "ar": {"Arabic", "Standard Arabic"},
    "nl": {"Dutch"},
}
PARTS_OF_SPEECH = {
    "noun", "verb", "adj", "adv", "pron", "det", "article", "num",
    "prep", "postp", "conj", "intj", "particle", "phrase", "prep_phrase",
}
ALLOWED_TAGS = {
    "masculine", "feminine", "neuter", "common-gender", "singular",
    "singulative", "collective", "countable", "uncountable", "plural",
    "perfective", "imperfective", "transitive", "intransitive",
    "reflexive", "formal", "informal", "polite", "honorific",
    "Brazil", "Portugal", "Spain", "Latin-America", "indefinite", "definite",
    "general",
}
REGIONAL_TAGS = {"Brazil", "Portugal", "Spain", "Latin-America"}
REGISTER_TAGS = {"formal", "informal", "polite", "honorific"}
UNSUITABLE_SENSE_TAGS = {
    "archaic", "obsolete", "dated", "historical", "nonstandard", "dialectal",
    "rare", "vulgar", "offensive", "derogatory", "ethnic-slur",
    "abbreviation", "alt-of", "form-of", "misspelling", "romanization",
}
# Apply these only to a source sense explicitly associated with the translation
# table. Do not infer categories from arbitrary substrings in an English gloss.
TOPIC_CATEGORIES = {
    "agriculture": "agriculture", "horticulture": "gardening",
    "gardening": "gardening", "food": "food-drinks", "foods": "food-drinks",
    "beverages": "food-drinks", "cooking": "food-drinks", "culinary": "food-drinks",
    "clothing": "clothing", "anatomy": "body", "meteorology": "weather",
    "computing": "technology", "computer-science": "technology",
    "education": "school", "school": "school", "medicine": "health",
    "sports": "sports", "sport": "sports", "furniture": "furniture",
    "transportation": "transportation", "transport": "transportation",
    "shopping": "shopping", "music": "hobbies", "games": "hobbies",
}


def normalized(text, language):
    text = unicodedata.normalize("NFC", text).replace("\u0301", "")
    if language == "tr":
        text = text.replace("İ", "i").replace("I", "ı")
    text = text.lower()
    return re.sub(r"[\u064b-\u065f\u0670]", "", text) if language == "ar" else text


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_bulk(path, download):
    if not path.exists():
        if not download:
            raise ValueError(f"Missing {path}; pass --download or --input-gzip.")
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(path.suffix + ".partial")
        request = urllib.request.Request(BULK_URL, headers={
            "User-Agent": "JenechkaCardsVocabularyBuilder/1.0 (open educational vocabulary)",
        })
        with urllib.request.urlopen(request, timeout=60) as source, partial.open("wb") as output:
            total = 0
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                total += len(chunk)
                if total > BULK_BYTES:
                    raise ValueError("Upstream snapshot grew; review and explicitly repin before downloading it.")
                output.write(chunk)
        if partial.stat().st_size != BULK_BYTES or file_hash(partial) != BULK_SHA256:
            raise ValueError("Upstream snapshot changed; the pinned bulk checksum does not match.")
        partial.replace(path)
    if path.stat().st_size != BULK_BYTES or file_hash(path) != BULK_SHA256:
        raise ValueError("Bulk source checksum does not match the pinned snapshot.")


def word_url(word):
    return ("https://kaikki.org/dictionary/English/meaning/"
            + urllib.parse.quote(word[0], safe="") + "/"
            + urllib.parse.quote(word[:2], safe="") + "/"
            + urllib.parse.quote(word, safe="") + ".jsonl")


def translation_language(item):
    code = item.get("code", item.get("lang_code"))
    code = "zh" if code == "cmn" else code
    return code if code in LANGUAGES and item.get("lang") in LANGUAGES[code] else None


def make_form(item, language, stats):
    tags = item.get("tags", [])
    if set(tags) - ALLOWED_TAGS or item.get("raw_tags"):
        stats["translationExcludedRegisterDialectOrUnknownTag"] += 1
        return None
    original = item.get("word", "").strip()
    if not original or len(original) > 100 or re.search(r"[{}\[\]~*|]|\.\.\.|…|^[-=]", original):
        stats["translationExcludedMalformedOrAnnotated"] += 1
        return None
    text = original
    # This is an explicitly present pair of Chinese orthographies, not a generated
    # conversion. Keep the original paired source spelling alongside the choice.
    variants = [part.strip() for part in text.split("/")]
    if language == "zh" and len(variants) == 2 and all(variants):
        text = variants[1]
    elif "/" in text or "(" in text or ")" in text:
        stats["translationExcludedMalformedOrAnnotated"] += 1
        return None
    if language in {"ar", "ru", "zh", "ko", "ja"} and re.search(r"[A-Za-z]", text):
        stats["translationExcludedUnexpectedLatinAnnotation"] += 1
        return None
    if language == "ko" and not re.search(r"[가-힣]", text):
        stats["translationExcludedNonHangul"] += 1
        return None
    form = {"text": text, "tags": tags, "sourceLanguage": item["lang"]}
    if text != original:
        form["sourceText"] = original
    if item.get("roman"):
        form["romanization"] = item["roman"]
    if item.get("english"):
        form["sourceQualifier"] = item["english"]
    return form


def matching_senses(record, meaning):
    # Wiktextract translation headings may be abbreviated glosses. An exact
    # heading↔gloss or heading↔sense-id association is required for category tags.
    return [sense for sense in record.get("senses", [])
            if meaning in sense.get("glosses", [])
            or meaning in sense.get("raw_glosses", [])
            or meaning == sense.get("senseid")
            or (isinstance(sense.get("senseid"), list) and meaning in sense["senseid"])]


def extraction(path):
    cefr_path = ROOT / "vocabulary/source-data/cefr.json"
    frequency_path = ROOT / "vocabulary/source-data/frequency.json"
    seed_path = ROOT / "vocabulary/source-data/lexicon.json"
    levels_path = ROOT / "vocabulary/source-data/levels.json"
    cefr = json.loads(cefr_path.read_text(encoding="utf-8"))
    frequency = json.loads(frequency_path.read_text(encoding="utf-8"))
    seed = json.loads(seed_path.read_text(encoding="utf-8"))
    headwords = {normalized(row["lemma"], "en") for row in cefr["english"]}
    if not levels_path.exists():
        raise ValueError("Missing levels.json; build the open supplemental English level data first.")
    levels = json.loads(levels_path.read_text(encoding="utf-8"))
    headwords.update(normalized(row["lemma"], "en") for row in levels["english"])
    headwords.update(normalized(row["word"], "en") for row in frequency["languages"]["en"])
    ranks = {
        language: {normalized(row["word"], language): row["rank"]
                   for row in reversed(rows)}
        for language, rows in frequency["languages"].items()
    }
    seed_keys = {(row["forms"]["en"]["text"], row["pos"], row["meaning"])
                 for row in seed["concepts"]}
    stats = Counter()
    concepts = {}
    with gzip.open(path, "rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            stats["sourceRecords"] += 1
            record = json.loads(raw)
            word, pos = record.get("word", ""), record.get("pos", "")
            if record.get("lang_code") != "en" or pos not in PARTS_OF_SPEECH:
                continue
            if not word or len(word) > 100 or re.search(r"[{}\[\]|]|\.\.\.|…", word):
                continue
            tables = defaultdict(lambda: defaultdict(list))
            parents = defaultdict(set)
            containers = [(-1, record.get("translations", []))]
            containers.extend((index, sense.get("translations", []))
                              for index, sense in enumerate(record.get("senses", [])))
            for parent_index, translations in containers:
                for item in translations:
                    language = translation_language(item)
                    meaning = item.get("sense", "").strip()
                    if not language or not meaning:
                        continue
                    form = make_form(item, language, stats)
                    if form:
                        tables[meaning][language].append(form)
                        parents[meaning].add(parent_index)
            for source_sense_order, (meaning, languages) in enumerate(tables.items()):
                stats["eligibleTranslationTables"] += 1
                if (word, pos, meaning) in seed_keys:
                    stats["excludedExistingReviewedConcepts"] += 1
                    continue
                direct_parents = [record["senses"][index]
                                  for index in sorted(parents[meaning]) if index >= 0]
                senses = direct_parents or matching_senses(record, meaning)
                if senses and all(set(sense.get("tags", [])) & UNSUITABLE_SENSE_TAGS for sense in senses):
                    stats["excludedNonstandardSourceSenses"] += 1
                    continue
                selected_by = []
                if normalized(word, "en") in headwords:
                    selected_by.append("English source headword or top-1000 raw token")
                matched_languages = [
                    language for language, forms in languages.items()
                    if any(normalized(form["text"], language) in ranks[language] for form in forms)
                ]
                if matched_languages:
                    selected_by.append("Exact top-1000 native token: " + ",".join(sorted(matched_languages)))
                if not selected_by:
                    continue
                etymology = str(record.get("etymology_number", ""))
                etymology_digest = hashlib.sha256(record.get("etymology_text", "").encode()).hexdigest()
                identity = [word, pos, etymology, etymology_digest, meaning]
                concept_id = "bulk-" + hashlib.sha256(encode(identity)).hexdigest()[:24]
                if concept_id in concepts:
                    stats["duplicateExactTableRecords"] += 1
                    # Never merge different source records merely because the
                    # visible heading is identical. The first exact identity is
                    # stable and its line hash remains independently verifiable.
                    continue
                forms = {"en": {"text": word, "tags": [], "studyText": f"{word} ({meaning})"}}
                for language, candidates in languages.items():
                    seen = set()
                    unique_candidates = []
                    for candidate in candidates:
                        key = encode(candidate)
                        if key not in seen:
                            unique_candidates.append(candidate)
                            seen.add(key)
                    # Choose within this exact sense only. Native corpus rank is
                    # a tie-breaker for standard equivalents, not an English rank
                    # transferred to the translation.
                    ordered = sorted(unique_candidates, key=lambda form: (
                        bool(set(form["tags"]) & REGIONAL_TAGS),
                        bool(set(form["tags"]) & REGISTER_TAGS),
                        bool(form.get("sourceQualifier")),
                        ranks[language].get(normalized(form["text"], language), 1001),
                    ))
                    forms[language] = dict(ordered[0])
                    if len(ordered) > 1:
                        forms[language]["alternatives"] = ordered[1:]
                source_topics = sorted({topic for sense in senses for topic in sense.get("topics", [])})
                source_categories = sorted({
                    category if isinstance(category, str) else category.get("name", "")
                    for sense in senses for category in sense.get("categories", [])
                } - {""})
                categories = sorted({TOPIC_CATEGORIES[topic] for topic in source_topics if topic in TOPIC_CATEGORIES})
                concepts[concept_id] = {
                    "id": concept_id, "meaning": meaning, "pos": pos,
                    "categories": categories, "sourceUrl": word_url(word), "forms": forms,
                    "evidence": {
                        "headword": word, "partOfSpeech": pos, "translationSense": meaning,
                        "etymologyNumber": etymology, "etymologySha256": etymology_digest,
                        "source": SOURCE_ID, "sha256": hashlib.sha256(raw).hexdigest(),
                        "bulkLine": line_number, "selectedBy": selected_by,
                        "sourceTopics": source_topics, "sourceCategories": source_categories,
                        "sourceSenseGlosses": [sense.get("glosses", []) for sense in senses],
                        "categoryAssociation": ("source-parent-sense"
                                                if direct_parents else
                                                "exact-gloss-or-sense-id"
                                                if senses else "unassigned"),
                        "sourceSenseOrder": source_sense_order,
                    },
                }
            if line_number % 200000 == 0:
                print(f"Scanned {line_number:,} source records; retained {len(concepts):,} senses", file=sys.stderr, flush=True)
    rows = sorted(concepts.values(), key=lambda row: row["id"])
    stats["concepts"] = len(rows)
    stats["conceptsWithAll13Languages"] = sum(len(row["forms"]) == 13 for row in rows)
    stats["conceptsWithAtLeast10Languages"] = sum(len(row["forms"]) >= 10 for row in rows)
    stats["conceptsWithExplicitCategories"] = sum(bool(row["categories"]) for row in rows)
    by_language = {code: sum(code in row["forms"] for row in rows) for code in ["en", *LANGUAGES]}
    input_hashes = {path.name: file_hash(path) for path in (cefr_path, frequency_path, seed_path, levels_path)}
    return {
        "sources": [{
            "id": SOURCE_ID, "name": "English Wiktionary sense-aligned translation tables via Kaikki/Wiktextract",
            "url": "https://kaikki.org/dictionary/English/index.html",
            "license": "CC-BY-SA-4.0", "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
            "attribution": "Wiktionary contributors; extracted by Wiktextract/Kaikki (Tatu Ylonen and contributors). Subset extraction, standard-language filtering, equivalent selection and English sense labels by Jenechka Cards.",
            "methodology": "A concept retains one explicit English POS/etymology/translation-table meaning. Both entry-level and nested sense-level translations are read. Selection uses existing English source headword inventories (CEFR-J and the supplemental levels.json) or exact target-language top-1000 native token matches; it does not assign CEFR or transfer frequency ranks. Foreign forms are literal source translations in that exact table. Standard-language/register filters reject unknown tags, dialects, malformed annotations and unexpected script. Equivalent selection within one table prefers unqualified standard forms, then the equivalent's own-language original corpus rank, then source order. Selected tags and other eligible variants remain in the source artifact. English study sides include the exact translation heading to distinguish senses. Categories use topics of explicit parent source senses (categoryAssociation=source-parent-sense), or an exact translation heading-to-gloss/sense-id match (exact-gloss-or-sense-id); otherwise they are unassigned. Parent-sense associations are Kaikki postprocessing, not a new human disambiguation claim. Existing hand-reviewed sense keys are omitted. The shared English source POS is not independently verified as the grammatical class of every translation. No SMARTool links are inferred. Automatically extracted dictionary data, not native-speaker reviewed.",
            "version": f"Kaikki extraction {EXTRACTED_ON}; enwiktionary dump {DUMP_DATE}",
            "bulkUrl": BULK_URL, "bulkBytes": BULK_BYTES, "bulkSha256": BULK_SHA256,
            "inputSha256": input_hashes,
            "sourceOrder": SOURCE_ORDER_NOTICE,
        }],
        "categories": seed["categories"],
        "statistics": {**dict(sorted(stats.items())), "byLanguage": by_language},
        "concepts": rows,
    }


def validate_output(data):
    assert data["sources"][0]["bulkSha256"] == BULK_SHA256
    rows = data["concepts"]
    assert len({row["id"] for row in rows}) == len(rows)
    allowed_categories = {row["id"] for row in data["categories"]}
    for row in rows:
        assert row["meaning"] and row["pos"] in PARTS_OF_SPEECH
        assert row["forms"]["en"]["text"] == row["evidence"]["headword"]
        assert len(row["forms"]) >= 2 and set(row["forms"]) <= {"en", *LANGUAGES}
        assert set(row["categories"]) <= allowed_categories
        assert row["evidence"]["source"] == SOURCE_ID
        assert re.fullmatch(r"[0-9a-f]{64}", row["evidence"]["sha256"])
        assert row["evidence"]["bulkLine"] > 0
        if "sourceSenseOrder" in row["evidence"]:
            assert isinstance(row["evidence"]["sourceSenseOrder"], int) and row["evidence"]["sourceSenseOrder"] >= 0
        assert row["forms"]["en"]["studyText"] == f'{row["forms"]["en"]["text"]} ({row["meaning"]})'
        for code, form in row["forms"].items():
            assert isinstance(form["text"], str) and form["text"].strip()
            if code != "en":
                assert set(form["tags"]) <= ALLOWED_TAGS
                assert form["sourceLanguage"] in LANGUAGES[code]
    assert data["statistics"]["concepts"] == len(rows)
    assert data["statistics"]["byLanguage"] == {
        code: sum(code in row["forms"] for row in rows) for code in ["en", *LANGUAGES]
    }

def verify_source(data, path, add_source_order=False):
    """Independently verify every retained spelling against its pinned raw line."""
    pending = defaultdict(list)
    for row in data["concepts"]:
        pending[row["evidence"]["bulkLine"]].append(row)
    verified = 0
    with gzip.open(path, "rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            if line_number not in pending:
                continue
            record = json.loads(raw)
            translations = list(record.get("translations", []))
            for sense in record.get("senses", []):
                translations.extend(sense.get("translations", []))
            source_order = {}
            for item in translations:
                language = translation_language(item)
                meaning = item.get("sense", "").strip()
                if language and meaning and make_form(item, language, Counter()):
                    source_order.setdefault(meaning, len(source_order))
            for concept in pending.pop(line_number):
                assert hashlib.sha256(raw).hexdigest() == concept["evidence"]["sha256"]
                assert record["word"] == concept["forms"]["en"]["text"]
                assert record["pos"] == concept["pos"]
                if add_source_order:
                    concept["evidence"]["sourceSenseOrder"] = source_order[concept["meaning"]]
                if "sourceSenseOrder" in concept["evidence"]:
                    assert concept["evidence"]["sourceSenseOrder"] == source_order[concept["meaning"]]
                source_forms = {
                    (translation_language(item), item.get("word", "").strip(),
                     tuple(item.get("tags", [])), item.get("roman", ""), item.get("english", ""))
                    for item in translations if item.get("sense", "").strip() == concept["meaning"]
                }
                for language, selected in concept["forms"].items():
                    if language == "en":
                        continue
                    for form in [selected, *selected.get("alternatives", [])]:
                        original = form.get("sourceText", form["text"])
                        key = (language, original, tuple(form["tags"]),
                               form.get("romanization", ""), form.get("sourceQualifier", ""))
                        assert key in source_forms, (concept["id"], language, original)
                        if original != form["text"]:
                            assert language == "zh" and form["text"] in [part.strip() for part in original.split("/")]
                verified += 1
            if not pending:
                break
    assert not pending
    print(f"Verified {verified:,} retained concepts and every selected/alternative foreign spelling against pinned source lines.",
          file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-gzip", type=Path, default=Path("/tmp/jenechka-expanded-English-2026-10-03.jsonl.gz"))
    parser.add_argument("--output", type=Path, default=ROOT / "vocabulary/source-data/expanded-lexicon.json")
    parser.add_argument("--download", action="store_true", help="Download the pinned 523 MB bulk snapshot if absent.")
    parser.add_argument("--check", action="store_true", help="Validate the frozen JSON without network or bulk data.")
    parser.add_argument("--verify-source", action="store_true", help="Verify every retained spelling directly against the pinned bulk source.")
    parser.add_argument("--add-source-order", action="store_true", help="Add original table encounter ordinals from referenced bulk lines, preserving all existing records.")
    args = parser.parse_args()
    if args.check or args.verify_source or args.add_source_order:
        original = args.output.read_bytes()
        data = json.loads(original)
        if args.check:
            assert original == encode(data), "Source JSON is not in deterministic compact serialization."
    else:
        ensure_bulk(args.input_gzip, args.download)
        data = extraction(args.input_gzip)
        validate_output(data)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(".json.partial")
        temporary.write_bytes(encode(data))
        temporary.replace(args.output)
    validate_output(data)
    if args.verify_source or args.add_source_order:
        ensure_bulk(args.input_gzip, args.download)
        verify_source(data, args.input_gzip, args.add_source_order)
        if args.add_source_order:
            data["sources"][0]["sourceOrder"] = SOURCE_ORDER_NOTICE
            temporary = args.output.with_suffix(".json.partial")
            temporary.write_bytes(encode(data))
            temporary.replace(args.output)
    print(json.dumps({**data["statistics"], "bytes": args.output.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
