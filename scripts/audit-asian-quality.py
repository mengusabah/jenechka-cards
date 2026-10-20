#!/usr/bin/env python3
"""Check every Asian input form and validate the frozen editorial decisions.

This is a reproducible structural/provenance audit, not native certification.
It never changes source dictionaries or applies new frequency-only corrections.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import unicodedata


ROOT = Path(__file__).resolve().parents[1]
LANGUAGES = ("zh", "ja", "ko", "ar")
SCRIPTS = {
    "zh": re.compile(r"[\u3400-\u9fff\U00020000-\U0002ebef]"),
    "ja": re.compile(r"[\u3040-\u30ff\u3400-\u9fff\U00020000-\U0002ebef〇]"),
    "ko": re.compile(r"[가-힣]"),
    "ar": re.compile(r"[\u0621-\u064a]"),
}
SOURCE_FILES = ("lexicon", "european", "expanded-lexicon")
REGISTER = {
    "archaic", "obsolete", "dated", "rare", "uncommon", "dialectal",
    "historical", "North-Korea", "Classical",
}
SELECTIONS = {
    "source-attested-alternative", "editorial-correction",
    "source-form-extract", "source-gloss-extract", "form-exclusion",
}


def normalized(text, language):
    text = unicodedata.normalize("NFC", text).casefold().strip()
    if language == "ar":
        text = "".join(
            char for char in unicodedata.normalize("NFD", text)
            if unicodedata.category(char) != "Mn" or char in "\u0654\u0655"
        )
        text = unicodedata.normalize("NFC", text).replace("\u0640", "")
    return text


def without_annotations(text):
    previous = None
    while previous != text:
        previous = text
        text = re.sub(r"\([^()]*\)|\[[^\[\]]*\]|（[^（）]*）", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def screen_form(text, language, tags):
    flags = []
    if not SCRIPTS[language].search(text):
        flags.append("no-expected-native-script")
    if re.search(r"[()\[\]{};]", text):
        flags.append("delimiters-or-annotations")
    if len(text) > 40:
        flags.append("long-native-form")
    if set(tags) & REGISTER:
        flags.append("nonmodern-or-regional-register")
    return flags


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache", type=Path,
        default=Path("/tmp/jenechka-asian-vocabulary"),
        help="Optional original frequency snapshots for exact rank verification.",
    )
    args = parser.parse_args()
    concepts = {}
    primary_counts = Counter()
    all_flags = Counter()
    encountered = {language: set() for language in LANGUAGES}
    for name in SOURCE_FILES:
        data = json.loads((ROOT / f"vocabulary/source-data/{name}.json").read_text())
        for concept in data["concepts"]:
            assert concept["id"] not in concepts, f"Duplicate ID {concept['id']}"
            concepts[concept["id"]] = concept
            for language in LANGUAGES:
                if language not in concept["forms"]:
                    continue
                form = concept["forms"][language]
                primary_counts[language] += 1
                all_flags.update(screen_form(form["text"], language, form.get("tags", [])))
                assert concept["pos"] and concept["meaning"], concept["id"]
                if language == "ko" and concept["pos"] == "verb":
                    if not form["text"].endswith("다"):
                        all_flags["korean-verb-needs-form-review"] += 1
                if language == "ja" and concept["pos"] == "verb":
                    if re.fullmatch(r"[\u3400-\u9fff\u30a0-\u30ffー]+", form["text"]):
                        all_flags["japanese-verb-needs-form-review"] += 1
                for alternative in [form] + form.get("alternatives", []):
                    encountered[language].add(normalized(alternative["text"], language))

    asian_source = json.loads((ROOT / "vocabulary/source-data/asian.json").read_text())
    records = {record["id"]: record for record in asian_source["records"]}
    assert len(records) == len(asian_source["records"]), "Duplicate Asian IDs"
    asian_counts = Counter()
    for record in records.values():
        language = record["language"]
        asian_counts[language] += 1
        encountered[language].add(normalized(record["lemma"], language))
        all_flags.update(screen_form(
            record["lemma"], language, record.get("tags", [])
        ))
        assert record["pos"] and record["source"] and record["gloss"], record["id"]
        clean = without_annotations(record["gloss"])
        if not clean:
            all_flags["empty-gloss-after-annotation-removal"] += 1
        if len(clean) > 80 or len(clean.split()) > 12:
            all_flags["long-gloss-needs-semantic-review"] += 1
        if record["pos"] == "unknown":
            all_flags["POS-not-supplied-by-source"] += 1

    quality_path = ROOT / "vocabulary/source-data/quality-asian.json"
    quality = json.loads(quality_path.read_text())
    assert quality["languages"] == list(LANGUAGES)
    for language in LANGUAGES:
        assert quality["reviewedCounts"][language] == {
            "multilingualForms": primary_counts[language],
            "asianRecords": asian_counts[language],
            "total": primary_counts[language] + asian_counts[language],
        }, f"Coverage count drift for {language}"
    for source in quality["inputs"]:
        actual = hashlib.sha256((ROOT / source["path"]).read_bytes()).hexdigest()
        assert source["sha256"] == actual, f"Input snapshot changed: {source['path']}"

    seen_rules = set()
    rule_counts = Counter()
    for rule in quality["rules"]:
        concept_id, language = rule["conceptId"], rule["language"]
        key = (concept_id, language)
        assert key not in seen_rules, f"Duplicate rule {key}"
        seen_rules.add(key)
        assert rule["selection"] in SELECTIONS and rule["reason"], key
        if concept_id in concepts:
            concept = concepts[concept_id]
            form = concept["forms"][language]
            assert form["text"] == rule["originalText"], f"Stale original {key}"
            if rule["selection"] == "source-attested-alternative":
                alternatives = [
                    alternative for alternative in form.get("alternatives", [])
                    if alternative["text"] == rule["replacementText"]
                ]
                assert alternatives, f"Unattested source alternative {key}"
                assert rule["replacementTags"] == alternatives[0].get("tags", []), key
        else:
            assert concept_id in records, f"Unknown rule record {key}"
            record = records[concept_id]
            assert language in ("en", record["language"]), key
            original = record["gloss"] if language == "en" else record["lemma"]
            assert rule["originalText"] == original, f"Stale Asian original {key}"
        replacement = rule["replacementText"]
        assert replacement is None or (
            isinstance(replacement, str) and replacement.strip()
        ), key
        if replacement is not None and language in LANGUAGES:
            assert SCRIPTS[language].search(replacement), f"Wrong script {key}"
            assert not re.search(r"[()\[\]{};]", replacement), key
            encountered[language].add(normalized(replacement, language))
        rule_counts[language] += 1

    seen_exclusions = set()
    for exclusion in quality["excludedConcepts"]:
        concept_id = exclusion["conceptId"]
        assert concept_id not in seen_exclusions, concept_id
        seen_exclusions.add(concept_id)
        assert concept_id in records and exclusion["reason"], concept_id
        assert records[concept_id]["gloss"] == exclusion["originalGloss"], concept_id
        assert records[concept_id]["lemma"] == exclusion["originalText"], concept_id
        assert not any(key[0] == concept_id for key in seen_rules), concept_id

    cache_verified = []
    for evidence in quality["frequencyEvidence"]:
        language = evidence["language"]
        assert evidence["url"] == asian_source["inputs"][f"{language}-frequency.txt"]["url"]
        assert evidence["sha256"] == asian_source["inputs"][f"{language}-frequency.txt"]["sha256"]
        ranks = quality["nativeRanks"][language]
        assert ranks.keys() <= encountered[language], f"Unencountered rank in {language}"
        assert all(isinstance(rank, int) and rank > 0 for rank in ranks.values())
        path = args.cache / f"{language}-frequency.txt"
        if path.exists():
            assert hashlib.sha256(path.read_bytes()).hexdigest() == evidence["sha256"]
            expected = {}
            for rank, line in enumerate(path.read_text().splitlines(), 1):
                word = normalized(line.rsplit(" ", 1)[0], language)
                if word in encountered[language]:
                    expected.setdefault(word, rank)
            assert ranks == expected, f"Original rank/encountered-form mismatch: {language}"
            cache_verified.append(language)

    # Regression anchors ensure common neutral translations are not replaced by
    # more frequent but wrong-sense/register alternatives.
    replacement_by_key = {
        (rule["conceptId"], rule["language"]): rule["replacementText"]
        for rule in quality["rules"]
    }
    assert ("bulk-05139e27c0a2ce2feabb8ae1", "ja") not in replacement_by_key
    assert replacement_by_key["bulk-94c090f20706b07f1f825cdf", "ko"] == "고객"
    assert replacement_by_key["bulk-045fd7f9352af4efdc25dfb8", "ar"] == "حَلَّ"
    assert replacement_by_key["bulk-6c4e909992901bb5b0b07aef", "ko"] == "팁을 주다"
    assert ("jmdict:1552910:e007dce8c02b" not in seen_exclusions), (
        "The physical noun particle is not a grammar-only gloss"
    )
    assert "jmdict:1160790:7483fb7826e3" not in seen_exclusions, (
        "A secondary prefix label must not remove the standalone number one"
    )
    for record_id in (
        "wiktionary-korean:en-있어-ko-verb-CNKCxjtn",
        "wiktionary-korean:en-하고-ko-verb-rIAe9ky7",
        "wiktionary-arabic:en-لي-ar-verb-EmP4ggZz",
    ):
        assert record_id in seen_exclusions, (
            "Grammar-only or malformed records must not become lexical cards"
        )
    assert replacement_by_key[
        "wiktionary-arabic:en-سوف-ar-particle-1F6jeDqm", "en"
    ] == "will"
    assert replacement_by_key["bulk-8ac1061749fc4e75aca7ec21", "ja"] == "力積", (
        "Physical impulse must not be confused with ordinary impact"
    )
    reviewed_levels = json.loads((
        ROOT / "vocabulary/source-data/cefr-reviewed-asian.json"
    ).read_text())
    level_keys = set()
    for assignment in reviewed_levels["assignments"]:
        key = (assignment["conceptId"], assignment["language"])
        assert key not in level_keys, f"Duplicate native level review: {key}"
        level_keys.add(key)
        concept = concepts[key[0]]
        text = replacement_by_key.get(key, concept["forms"][key[1]]["text"])
        assert text == assignment["lemma"], f"Reviewed native lemma changed: {key}"
        assert concept["meaning"] == assignment["meaning"], key
        assert assignment["level"] in {"C1", "C2"} and assignment["reason"], key

    preferences = json.loads((
        ROOT / "vocabulary/source-data/frequency-preferences-asian.json"
    ).read_text())
    frequency = json.loads((
        ROOT / "vocabulary/source-data/frequency.json"
    ).read_text())["languages"]
    corpus_forms = {
        language: {normalized(row["word"], language) for row in frequency[language]}
        for language in LANGUAGES
    }
    preference_keys = set()
    for field in ("preferences", "excluded"):
        for decision in preferences[field]:
            language = decision["language"]
            word = normalized(decision["word"], language)
            key = (language, word)
            assert key not in preference_keys, f"Conflicting frequency choice: {key}"
            preference_keys.add(key)
            assert word in corpus_forms[language] and decision["reason"], key
            if field == "excluded":
                continue
            concept_id = decision["conceptId"]
            assert concept_id not in seen_exclusions, key
            if concept_id in concepts:
                original = concepts[concept_id]["forms"][language]["text"]
            else:
                assert records[concept_id]["language"] == language, key
                original = records[concept_id]["lemma"]
            text = replacement_by_key.get((concept_id, language), original)
            assert text and normalized(without_annotations(text), language) == word, (
                f"Preferred frequency sense no longer has this native form: {key}"
            )
    print(f"Screened {sum(primary_counts.values()):,} multilingual forms and "
          f"{sum(asian_counts.values()):,} Asian dictionary records.")
    print("Review flags:", json.dumps(dict(sorted(all_flags.items()))))
    print("Validated explicit rules:", json.dumps(dict(sorted(rule_counts.items()))))
    print(f"Validated {len(seen_exclusions)} reviewed exclusions.")
    print("Native ranks:", json.dumps({
        language: len(quality["nativeRanks"][language]) for language in LANGUAGES
    }))
    print("Verified cached source ranks:", ", ".join(cache_verified) or "cache unavailable")
    print(f"Validated {len(level_keys)} exact native level estimates and "
          f"{len(preference_keys)} explicit frequency decisions.")
    print("All input identity, full-coverage, rule, source-alternative and rank checks passed.")


if __name__ == "__main__":
    main()
