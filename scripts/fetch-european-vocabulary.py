#!/usr/bin/env python3
"""Build a conservative, concept-aligned IDS vocabulary input.

Only the Python standard library is used. Downloads stay in a temporary cache;
the compact output contains the selected forms, provenance, and exclusions.
Run again with the same cached inputs to reproduce byte-identical JSON:
    python3 scripts/fetch-european-vocabulary.py

IDS is a comparative dictionary, not a CEFR curriculum. No CEFR levels or
frequency rankings are assigned by this script.
"""

import argparse
from collections import Counter, defaultdict
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import unicodedata
import urllib.request
import zipfile


ROOT = Path(__file__).resolve().parents[1]
IDS_VERSION = "v4.4"
IDS_COMMIT = "ef486e1656bf623e3f767b26b27c546a0a24efb4"
IDS_URL = "https://codeload.github.com/intercontinental-dictionary-series/ids/zip/refs/tags/v4.4"
IDS_SHA256 = "a0fa208cdb8361e61b129f4ffafe2c1761c7a5fb25342379e6178c0f83050010"
SPANISH_URL = "https://kaikki.org/dictionary/Spanish/kaikki.org-dictionary-Spanish.jsonl"
SPANISH_SHA256 = "c805cfb9f13c1769400d08e4a01bc4aeefb67775cbb36e2e4deb199e0af57b38"
LANGUAGES = {
    "170": ("it", "Italian"),
    "171": ("fr", "French"),
    "176": ("es", "Spanish"),
    "178": ("pt", "Portuguese"),
    "190": ("en", "English"),
    "191": ("nl", "Dutch"),
    "194": ("de", "German"),
}
CHAPTER_IDS = {
    "1": "ids-physical-world",
    "2": "ids-kinship",
    "3": "animals",
    "4": "ids-body",
    "5": "food-drinks",
    "6": "ids-clothing-grooming",
    "7": "ids-house",
    "8": "ids-agriculture-vegetation",
    "9": "ids-actions-technology",
    "10": "ids-motion",
    "11": "ids-possession",
    "12": "ids-spatial-relations",
    "13": "ids-quantity",
    "14": "time",
    "15": "ids-perception",
    "16": "ids-emotions-values",
    "17": "ids-cognition",
    "18": "communication",
    "19": "ids-society",
    "20": "ids-warfare-hunting",
    "21": "ids-law",
    "22": "ids-religion-belief",
}
REJECTED_DICTIONARY_TAGS = {
    "archaic", "obsolete", "dated", "historical", "rare", "nonstandard",
    "misspelling", "eye-dialect", "dialectal", "proscribed", "reconstruction",
}
# These are explicit, reviewed concept IDs from cldf/parameters.csv, not word
# substring matches or category guesses from a translated term. The source
# chapter remains available in evidence even when an existing app ID is reused.
EXTRA_CATEGORY_DEFINITIONS = {
    "family": ("Family & Relationships", "Family members and relationships.", "traditional"),
    "body": ("Body Parts", "Parts of the human body.", "traditional"),
    "health": ("Health", "Health, care, and illness.", "traditional"),
    "fruits": ("Fruits", "Fruit names and related vocabulary.", "traditional"),
    "vegetables": ("Vegetables", "Vegetables and edible plants.", "traditional"),
    "clothing": ("Clothing", "Clothes and things people wear.", "traditional"),
    "numbers": ("Numbers", "Number words.", "traditional"),
    "weather": ("Weather", "Weather and temperature.", "traditional"),
    "furniture": ("Furniture", "Furniture and household fixtures.", "traditional"),
    "household": ("Household Items", "Objects used around the home.", "traditional"),
    "school": ("School & Education", "Learning, teaching, and school life.", "traditional"),
    "professions": ("Professions", "Occupations and people at work.", "traditional"),
    "shopping": ("Shopping", "Buying, paying, and comparing prices.", "traditional"),
    "transportation": ("Transportation", "Vehicles and ways of travelling.", "traditional"),
    "emotions": ("Emotions", "Feelings and emotional states.", "traditional"),
    "gardening": ("Garden & Gardening", "Plants, tools, actions, and conditions in a garden.", "context"),
    "dining": ("Restaurant & Dining", "Food, tableware, actions, and expressions for dining.", "context"),
    "office": ("Work & Office", "Workplace objects, people, and activities.", "context"),
}
EXTRA_CATEGORY_CONCEPTS = {
    "family": """
        2-310 2-320 2-330 2-340 2-341 2-350 2-360 2-370 2-380 2-390
        2-410 2-420 2-430 2-440 2-444 2-445 2-450 2-454 2-455 2-456
        2-458 2-460 2-470 2-480 2-490 2-510 2-511 2-512 2-520 2-521
        2-522 2-530 2-540 2-550 2-560 2-570 2-610 2-611 2-620 2-621
        2-630 2-631 2-640 2-641 2-710 2-720 2-730 2-740 2-750 2-760
        2-770 2-810 2-820
    """,
    "body": """
        4-110 4-120 4-130 4-140 4-142 4-144 4-145 4-150 4-151 4-160
        4-162 4-190 4-191 4-200 4-201 4-202 4-203 4-204 4-205 4-207
        4-208 4-209 4-210 4-212 4-213 4-214 4-220 4-221 4-230 4-231
        4-240 4-250 4-260 4-270 4-271 4-272 4-280 4-281 4-290 4-300
        4-301 4-302 4-310 4-312 4-320 4-321 4-330 4-331 4-340 4-342
        4-344 4-350 4-351 4-352 4-360 4-370 4-371 4-372 4-380 4-400
        4-410 4-412 4-430 4-440 4-441 4-450 4-451 4-452 4-460 4-461
        4-462 4-463 4-464 4-470 4-490 4-492
    """,
    "health": """
        4-510 4-521 4-530 4-540 4-550 4-570 4-610 4-612 4-630 4-680
        4-690 4-720 4-730 4-732 4-740 4-750 4-751 4-810 4-820 4-830
        4-840 4-841 4-842 4-843 4-850 4-852 4-853 4-854 4-855 4-856
        4-857 4-858 4-860 4-870 4-880 4-890 4-910 4-912 4-940 4-950
        4-960 4-970 4-980 16-310
    """,
    "fruits": "5-710 5-750 5-760 5-780 8-820 8-830",
    "vegetables": "5-650 5-660 5-700 8-910 8-912 8-920 8-930 8-931 8-980",
    "clothing": """
        6-110 6-120 6-210 6-220 6-230 6-240 6-250 6-270 6-280 6-290
        6-350 6-380 6-390 6-410 6-411 6-420 6-430 6-440 6-450 6-460
        6-461 6-480 6-490 6-510 6-520 6-550 6-570 6-580 6-590 6-610
        6-620 6-630 6-710 6-720 6-730 6-740 6-750 6-760 6-770 6-780
    """,
    "numbers": """
        13-0 13-10 13-20 13-30 13-40 13-50 13-60 13-70 13-80 13-90
        13-100 13-101 13-102 13-103 13-104 13-105 13-106 13-107
        13-240 13-340 13-360 13-370 13-380 13-420 13-440
    """,
    "weather": """
        1-510 1-540 1-550 1-560 1-570 1-580 1-590 1-640 1-710
        1-720 1-730 1-740 1-750 1-760 1-770 1-780
    """,
    "furniture": "7-320 7-420 7-430 7-440 7-470",
    "household": """
        5-250 5-260 5-270 5-280 5-310 5-320 5-330 5-340 5-350 5-360
        5-370 5-380 5-390 5-391 6-820 6-910 6-920 6-930 6-940 6-950
        6-960 7-230 7-231 7-240 7-370 7-421 7-422 7-450 7-460
        9-240 9-380 9-760 9-770 9-771 9-790
    """,
    "school": "17-240 17-242 17-250 17-260 17-270 17-280 17-310 17-320 17-380 18-510 18-520 18-560 18-570 18-610",
    "professions": "3-180 4-870 6-130 6-540 7-610 8-110 9-430 9-600 9-710 9-820 11-840 17-270 18-670",
    "shopping": "11-430 11-440 11-610 11-620 11-630 11-640 11-650 11-660 11-810 11-820 11-830 11-840 11-850 11-860 11-870 11-880 11-890 11-920",
    "transportation": """
        10-360 10-370 10-650 10-660 10-710 10-720 10-740 10-750
        10-760 10-770 10-780 10-810 10-830 10-831 10-832 10-840
        10-850 10-851 10-852 10-860 10-870 10-880 10-890 10-910 10-920
    """,
    "emotions": """
        16-150 16-230 16-250 16-251 16-270 16-290 16-300 16-310
        16-320 16-330 16-340 16-350 16-370 16-380 16-390 16-410
        16-420 16-440 16-450 16-480 16-520 16-530 16-620 16-630
    """,
    "gardening": """
        1-212 1-214 1-215 1-310 1-420 5-123 5-124 5-125 5-650 5-660
        5-700 8-120 8-130 8-150 8-160 8-170 8-210 8-212 8-220 8-230
        8-240 8-250 8-260 8-270 8-310 8-311 8-320 8-330 8-410 8-510
        8-530 8-531 8-540 8-550 8-560 8-570 8-600 8-670 8-720 8-730
        8-740 8-750 8-760 8-930 8-931 8-940 8-970 8-980 9-220 9-221
        9-222 9-240 9-422
    """,
    "dining": """
        5-110 5-120 5-121 5-122 5-123 5-124 5-125 5-130 5-140
        5-150 5-180 5-181 5-210 5-220 5-230 5-240 5-260 5-270
        5-280 5-310 5-320 5-330 5-340 5-350 5-360 5-370 5-380
        5-390 5-410 5-420 5-430 5-440 5-450 5-510 5-610 5-630
        5-640 5-650 5-660 5-700 5-710 5-750 5-760 5-770 5-780
        5-790 5-810 5-820 5-821 5-840 5-850 5-860 5-880 5-890
        5-900 5-920 5-930 5-970 11-650 11-870 11-880 11-890 18-350
    """,
    "office": """
        7-210 7-430 7-440 7-470 9-120 11-770 11-780 11-790
        14-110 14-160 14-170 14-180 14-250 14-270 14-290 14-510
        14-530 14-610 17-380 18-210 18-310 18-320 18-510 18-520
        18-560 18-570 19-650
    """,
}
EXTRA_CATEGORY_CONCEPTS = {key: set(value.split()) for key, value in EXTRA_CATEGORY_CONCEPTS.items()}
# The CLDF German data capitalize these action forms as nouns. Two other
# German forms name a noun where the concept requires a property/action.
# Exclude the observed mismatches; do not invent corrected lexical entries.
REVIEWED_EXCLUSIONS = {
    ("de", "8-220"): "observed_case_or_pos_mismatch",   # dig -> Graben
    ("de", "8-531"): "observed_case_or_pos_mismatch",   # plant (vb) -> Pflanzen
    ("de", "9-750"): "observed_case_or_pos_mismatch",   # weave -> Flechten
    ("de", "10-852"): "observed_case_or_pos_mismatch",  # row (vb) -> Rudern
    ("de", "12-352"): "observed_case_or_pos_mismatch",  # pointed -> Spitze
    ("de", "17-440"): "observed_case_or_pos_mismatch",  # suspect -> Verdacht
}


def nfc(value):
    return unicodedata.normalize("NFC", value.strip())


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(cache, name, url, expected_hash, compressed=False):
    path = cache / name
    if not path.exists():
        headers = {"User-Agent": "JenechkaCards-open-lexical-data/1"}
        if compressed:
            headers["Accept-Encoding"] = "gzip"
        request = urllib.request.Request(url, headers=headers)
        temporary = path.with_suffix(path.suffix + ".partial")
        try:
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
                if compressed and response.headers.get("Content-Encoding") != "gzip":
                    raise ValueError("The Spanish snapshot is not the pinned gzip representation.")
                for block in iter(lambda: response.read(1024 * 1024), b""):
                    output.write(block)
            temporary.replace(path)
        finally:
            if temporary.exists():
                temporary.unlink()
    actual = sha256(path)
    if actual != expected_hash:
        raise ValueError(f"Upstream snapshot changed: {name}; expected {expected_hash}, got {actual}. Review before updating the pin.")
    return path


def csv_table(archive, name):
    prefix = "ids-4.4/"
    return list(csv.DictReader(io.StringIO(archive.read(prefix + name).decode("utf-8"))))


def safe_form(value):
    """Reject notation, reconstructed forms and IPA instead of transliterating."""
    if not value or len(value) > 120 or value.startswith("-") or value.endswith("-"):
        return False
    for char in value:
        if char in " -'’":
            continue
        if not (char.isalpha() or char.isdigit()):
            return False
        # This source uses ɲ in Spanish, and phonetic alphabets in other
        # varieties. Accept only Latin letters used in ordinary orthography.
        name = unicodedata.name(char, "")
        if char.isalpha() and ("LATIN" not in name or ord(char) >= 0x250):
            return False
    return True


def spanish_lemmas(path, candidates):
    """Exact, case-sensitive, accent-preserving matches to actual headwords.

    Form-of-only, misspelling-only, and obsolete-only entries do not validate a
    spelling. No English gloss, IPA spelling, or translated lookup is used.
    """
    matches = set()
    rejected = Counter()
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            entry = json.loads(line)
            word = nfc(entry.get("word", ""))
            if entry.get("lang_code") != "es" or word not in candidates:
                continue
            valid = False
            for sense in entry.get("senses", []):
                tags = set(entry.get("tags", [])) | set(sense.get("tags", []))
                if (sense.get("form_of") or "form-of" in tags or
                        tags & REJECTED_DICTIONARY_TAGS):
                    continue
                if sense.get("glosses") or sense.get("raw_glosses"):
                    valid = True
                    break
            if valid:
                matches.add(word)
            else:
                rejected[word] += 1
    return matches, {
        "candidateForms": len(candidates),
        "exactAcceptedHeadwords": len(matches),
        "notAccepted": sorted(candidates - matches),
    }


def explicit_pos(name):
    """Read only grammatical labels explicitly present in the IDS concept."""
    if re.search(r"\((?:vb|verb)(?:[ )])", name):
        return "verb"
    if "(noun)" in name:
        return "noun"
    if "(adj)" in name:
        return "adjective"
    if "(adv)" in name:
        return "adverb"
    return "unspecified"


def exclusion_reason(rows, language):
    values = {nfc(row["Value"]) for row in rows}
    comments = {nfc(row["Comment"]) for row in rows if row["Comment"].strip()}
    # CLDF Form removes parenthetical qualifiers; do not silently promote a
    # qualified/optional/archaic alternative to an unqualified learner term.
    if any("(" in value or ")" in value or "[" in value or "]" in value for value in values):
        return "parenthetical_source_qualification"
    # Dutch notes include respectively-mapped POS, archaic alternatives, and
    # usage restrictions. Spanish notes qualify regional alternatives.
    if language in {"nl", "es"} and comments:
        return "qualified_or_regional_source_note"
    # Ordinary German comments repeat the spelling. ## introduces a separate
    # annotation, including POS mismatches and restricted/archaic alternatives.
    if language == "de" and any("##" in value for value in comments):
        return "additional_german_source_annotation"
    return None


def build(archive_path, spanish_path):
    with zipfile.ZipFile(archive_path) as archive:
        parameters = csv_table(archive, "cldf/parameters.csv")
        chapters = csv_table(archive, "cldf/chapters.csv")
        language_rows = {row["ID"]: row for row in csv_table(archive, "cldf/languages.csv")}
        # The archive has 437k forms; retain only the seven selected modern
        # dictionaries, rather than allocating every language in memory.
        with archive.open("ids-4.4/cldf/forms.csv") as raw:
            all_rows = [row for row in csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"))
                        if row["Language_ID"] in LANGUAGES]
        metadata = json.loads(archive.read("ids-4.4/cldf/cldf-metadata.json"))
        assert metadata["dc:license"] == "https://creativecommons.org/licenses/by/4.0/"
        input_files = [{
            "name": name,
            "url": f"https://raw.githubusercontent.com/intercontinental-dictionary-series/ids/{IDS_COMMIT}/{name}",
            "sha256": hashlib.sha256(archive.read("ids-4.4/" + name)).hexdigest(),
            "bytes": len(archive.read("ids-4.4/" + name)),
        } for name in ["LICENSE", "cldf/forms.csv", "cldf/languages.csv", "cldf/parameters.csv", "cldf/chapters.csv"]]
    groups = defaultdict(list)
    parameter_ids = {parameter["ID"] for parameter in parameters}
    assert all(ids <= parameter_ids for ids in EXTRA_CATEGORY_CONCEPTS.values()), "Unknown manually mapped IDS concept"
    raw_counts = Counter()
    for row in all_rows:
        if row["Language_ID"] in LANGUAGES:
            language = LANGUAGES[row["Language_ID"]][0]
            groups[(row["Parameter_ID"], language)].append(row)
            raw_counts[language] += 1
    spanish_candidates = {nfc(row["Form"]) for (_, code), rows in groups.items()
                          if code == "es" for row in rows if safe_form(nfc(row["Form"]))}
    accepted_spanish, spelling_audit = spanish_lemmas(spanish_path, spanish_candidates)
    exclusions = defaultdict(Counter)
    examples = defaultdict(list)
    concepts = []
    for parameter in parameters:
        forms = {}
        source_evidence = {}
        for language_id, (code, language_name) in LANGUAGES.items():
            rows = groups.get((parameter["ID"], code), [])
            if not rows:
                exclusions[code]["no_source_entry"] += 1
                continue
            reason = REVIEWED_EXCLUSIONS.get((code, parameter["ID"])) or exclusion_reason(rows, code)
            if reason:
                exclusions[code][reason] += 1
                if len(examples[reason]) < 8:
                    examples[reason].append({"language": code, "concept": parameter["ID"], "value": nfc(rows[0]["Value"])})
                continue
            accepted = []
            seen = set()
            for row in rows:
                form = nfc(row["Form"])
                if not safe_form(form):
                    exclusions[code]["unsafe_or_phonetic_form"] += 1
                    continue
                if code == "es" and form not in accepted_spanish:
                    exclusions[code]["no_standard_spanish_headword_match"] += 1
                    continue
                if form in seen:
                    exclusions[code]["duplicate_source_form"] += 1
                    continue
                seen.add(form)
                accepted.append((form, row))
            if not accepted:
                continue
            # Choose the first attested source form deterministically. Additional
            # source synonyms are evidence, not automatically interchangeable
            # answers: some historical dictionaries mix register or gender.
            text, primary_row = accepted[0]
            forms[code] = {
                "text": text, "tags": [],
                "sourceLanguage": language_name,
                "sourceFormId": primary_row["ID"],
            }
            if code == "es":
                forms[code]["orthographyVerifiedBy"] = "kaikki-spanish-ids-validation"
            source_evidence[code] = {
                "sourceValue": nfc(primary_row["Value"]),
                "sourceComment": nfc(primary_row["Comment"]),
                "attestedAlternatives": [form for form, _ in accepted[1:]],
                "sourceFormIds": [row["ID"] for _, row in accepted],
                "transcription": primary_row["Transcriptions"],
            }
        if len(forms) < 2:
            exclusions["concepts"]["fewer_than_two_languages"] += 1
            continue
        chapter_id = parameter["ID"].split("-", 1)[0]
        concepts.append({
            "id": "ids-" + parameter["ID"],
            "meaning": nfc(parameter["Name"]),
            "pos": explicit_pos(parameter["Name"]),
            "categories": [CHAPTER_IDS[chapter_id], *[
                category for category, ids in EXTRA_CATEGORY_CONCEPTS.items()
                if parameter["ID"] in ids and category != CHAPTER_IDS[chapter_id]
            ]],
            "sourceUrl": "https://ids.clld.org/parameters/" + parameter["ID"],
            "forms": forms,
            "evidence": {
                "source": "ids",
                "parameterId": parameter["ID"],
                "concepticonId": parameter["Concepticon_ID"] or None,
                "concepticonGloss": parameter["Concepticon_Gloss"],
                "chapterId": chapter_id,
                "forms": source_evidence,
            },
        })
    authors = "; ".join(f"{name}: {language_rows[lid]['Authors']}"
                        for lid, (_, name) in LANGUAGES.items())
    sources = [{
        "id": "ids",
        "name": "Intercontinental Dictionary Series (IDS)",
        "url": "https://ids.clld.org/",
        "license": "CC-BY-4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": "Key, Mary Ritchie & Comrie, Bernard (eds.) 2023. The Intercontinental Dictionary Series. Leipzig: Max Planck Institute for Evolutionary Anthropology. "
                       "CLDF v4.4, DOI 10.5281/zenodo.23245041. Digitization: Robert Forkel, Christoph Rzymski, Hans-Jörg Bibiko and contributors. Dictionary authors: " + authors + ".",
        "methodology": "Concepts and semantic chapters copied from IDS. Existing equivalent animal/food/time/communication categories are reused; additional narrow and contextual categories use explicit, manually reviewed IDS concept IDs. "
                       "Current English, French, German, Italian, Portuguese and Dutch dictionaries; Spanish forms require an exact standard Spanish Wiktionary headword match. "
                       "One first accepted source form per language/concept is selected; additional synonyms remain research evidence and are not automatically presented as equivalent study answers. "
                       "Parenthetically qualified groups and usage/region/POS-qualified groups are omitted conservatively. NFC normalization preserves accents; no transliteration, translation generation, frequency or CEFR assignment. "
                       "Six observed German capitalization/POS mismatches are excluded explicitly rather than silently corrected. "
                       "Russian IDS uses Latin phonemic transcription with information loss and is excluded. POS is retained only where the source concept explicitly labels it; unspecified is not inferred. "
                       "IDS is a comparative dictionary with broad concept groupings and historical lexicographic origins, not an exhaustive modern learner curriculum or native-speaker review.",
        "version": IDS_VERSION + " / " + IDS_COMMIT,
        "files": [{"name": "ids-v4.4.zip", "url": IDS_URL, "sha256": IDS_SHA256, "bytes": archive_path.stat().st_size}, *input_files],
    }, {
        "id": "kaikki-spanish-ids-validation",
        "name": "Spanish Wiktionary headwords via Kaikki (IDS spelling validation)",
        "url": "https://kaikki.org/dictionary/Spanish/index.html",
        "license": "CC-BY-SA-4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
        "attribution": "Wiktionary contributors; extracted by Wiktextract/Kaikki (Tatu Ylonen and contributors). Used to check exact Spanish headword spellings against IDS candidates.",
        "methodology": "Exact NFC headword matching, preserving case and accents. At least one ordinary non-form-of sense must be present; entries supported only by obsolete, archaic, nonstandard or spelling-error senses are excluded. "
                       "No meanings or CEFR labels are transferred from this validation source and IPA is never converted to spelling.",
        "version": "Kaikki postprocessed Spanish, enwiktionary dump 2026-09-02; extraction 2026-10-03",
        "files": [{"name": "spanish-wiktionary.jsonl.gz", "url": SPANISH_URL, "sha256": SPANISH_SHA256,
                   "bytes": spanish_path.stat().st_size, "transport": "Accept-Encoding: gzip"}],
    }]
    result = {
        "sources": sources,
        "categories": [{
            "id": CHAPTER_IDS[row["ID"]],
            "name": row["Description"],
            "description": "Vocabulary aligned by meaning in the IDS source chapter “" + row["Description"] + "”.",
            "kind": "traditional",
        } for row in chapters] + [{
            "id": category, "name": name, "description": description, "kind": kind,
        } for category, (name, description, kind) in EXTRA_CATEGORY_DEFINITIONS.items()],
        "concepts": concepts,
        "levelRecords": [],
        "coverage": {
            "concepts": len(concepts),
            "formsByLanguage": dict(sorted(Counter(code for concept in concepts for code in concept["forms"]).items())),
            "sourceFormRowsByLanguage": dict(sorted(raw_counts.items())),
            "cefr": "No CEFR classifications are provided by IDS; none are inferred.",
            "excludedLanguages": {"ru": "IDS forms use Latin phonemic transcription; Russian orthography cannot safely be reconstructed."},
        },
        "excluded": {
            "countUnits": "no_source_entry and qualification/review reasons count language/concept groups; unsafe, duplicate, and no_headword_match reasons count source forms",
            "counts": {code: dict(sorted(counts.items())) for code, counts in sorted(exclusions.items())},
            "examples": dict(sorted(examples.items())),
            "spanishOrthography": spelling_audit,
        },
    }
    validate(result)
    return result


def validate(result):
    ids = set()
    category_ids = {category["id"] for category in result["categories"]}
    for concept in result["concepts"]:
        assert concept["id"] not in ids
        ids.add(concept["id"])
        assert len(concept["forms"]) >= 2
        assert set(concept["categories"]) <= category_ids
        for language, form in concept["forms"].items():
            assert language != "ru"
            assert safe_form(form["text"])
            assert form["text"] == nfc(form["text"])
            if language == "es":
                assert form["orthographyVerifiedBy"] == "kaikki-spanish-ids-validation"
    assert len(ids) > 1000
    assert all(count > 800 for count in result["coverage"]["formsByLanguage"].values())
    assert result["levelRecords"] == []


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path("/tmp/jenechka-ids-v4.4"))
    parser.add_argument("--output", type=Path, default=ROOT / "vocabulary/source-data/european.json")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    archive = download(args.cache, "ids-v4.4.zip", IDS_URL, IDS_SHA256)
    spanish = download(args.cache, "spanish-wiktionary.jsonl.gz", SPANISH_URL, SPANISH_SHA256, compressed=True)
    result = build(archive, spanish)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "bytes": args.output.stat().st_size, **result["coverage"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
