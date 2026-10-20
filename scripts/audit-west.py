#!/usr/bin/env python3
"""Audit all EN/TR/DE/NL forms and validate explicit reviewed corrections.

No dictionary is edited. Every primary and alternative form receives structural,
script, metadata/POS, sense-presence and register checks. These checks cannot
certify the semantic accuracy of every translation; individually reviewed
decisions are kept separately in quality-west.json.
"""

import argparse
import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "vocabulary" / "source-data"
LANGUAGES = ("en", "tr", "de", "nl")
SOURCES = ("lexicon.json", "european.json", "expanded-lexicon.json")
OUTPUT = DATA / "quality-west.json"
DEFAULT_CACHE = Path("/tmp/jenechka-west-frequency")
POS = {
    "noun", "verb", "adj", "adv", "prep", "prep_phrase", "intj", "pron",
    "conj", "det", "phrase", "num", "particle", "article", "postp",
    "name", "unspecified",
}
REGISTERS = re.compile(
    r"\b(?:archaic|obsolete|obsolescent|dated|dialectal|literary|poetic)\b", re.I
)
LETTER_NAME = re.compile(
    r"^name of (?:the )?(?:Cyrillic |Latin |Greek )?letter\b", re.I
)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normalize(text, language):
    text = unicodedata.normalize("NFC", text).replace("\u0301", "")
    if language == "tr":
        text = text.replace("İ", "i").replace("I", "ı")
    return text.lower()


def dictionaries():
    concepts = {}
    inputs = []
    for name in SOURCES:
        path = DATA / name
        source = load(path)
        inputs.append({"path": name, "sha256": digest(path)})
        for concept in source["concepts"]:
            assert concept["id"] not in concepts, concept["id"]
            concepts[concept["id"]] = concept
    return concepts, inputs


def variants(concept, language):
    form = concept["forms"].get(language)
    if form is None:
        return
    yield "primary", form
    for alternative in form.get("alternatives", []):
        yield "alternative", alternative
    # IDS stores alternative spellings in source evidence, not in form objects.
    evidence = concept.get("evidence", {}).get("forms", {}).get(language, {})
    for alternative in evidence.get("attestedAlternatives", []):
        if isinstance(alternative, str):
            yield "source-evidence-alternative", {"text": alternative, "tags": []}
        elif isinstance(alternative, dict) and alternative.get("text"):
            yield "source-evidence-alternative", alternative


def form_flags(concept, language, form):
    flags = []
    text = form.get("text")
    if not isinstance(text, str) or not text.strip():
        return ["missing-or-empty-text"]
    if any(unicodedata.category(char) == "Cc" for char in text):
        flags.append("control-character")
    if any(
        char.isalpha() and not unicodedata.name(char, "").startswith("LATIN")
        for char in text
    ):
        flags.append("non-latin-letter")
    if re.search(r"[{}<>\[\]]|https?://", text):
        flags.append("markup-or-url")
    if language in ("de", "nl") and re.search(r"(?<!\w)[mf](?!\w)", text):
        flags.append("possible-leaked-gender-marker")
    if language in ("de", "nl") and text == "n" and not LETTER_NAME.search(concept["meaning"]):
        flags.append("possible-leaked-gender-marker")
    tags = form.get("tags", [])
    if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
        flags.append("invalid-grammar-tags")
    if REGISTERS.search(" ".join(tags) + " " + str(form.get("sourceQualifier", ""))):
        flags.append("restricted-register")
    if concept.get("pos") not in POS:
        flags.append("invalid-part-of-speech")
    if not isinstance(concept.get("meaning"), str) or not concept["meaning"].strip():
        flags.append("missing-translation-heading")
    if language == "de" and concept["pos"] == "noun" and text.isalpha() and text[0].islower():
        flags.append("noun-capitalization-or-cross-pos-review")
    return flags


def audit(concepts):
    counts = {language: Counter() for language in LANGUAGES}
    findings = []
    for concept in concepts.values():
        for language in LANGUAGES:
            for kind, form in variants(concept, language):
                counts[language][kind] += 1
                flags = form_flags(concept, language, form)
                counts[language]["structurallyFlagged"] += bool(flags)
                if flags:
                    findings.append({
                        "conceptId": concept["id"],
                        "language": language,
                        "kind": kind,
                        "text": form["text"],
                        "flags": flags,
                    })
    return {language: dict(sorted(value.items())) for language, value in counts.items()}, findings


def native_ranks(concepts, cache, rules=()):
    provenance = load(cache / "inputs.json")
    frequency = {}
    for entry in provenance:
        language = entry["language"]
        assert language in LANGUAGES
        path = cache / (language + ".txt")
        assert digest(path) == entry["sha256"], f"Frequency hash mismatch: {language}"
        ranks = {}
        for rank, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            word, count = line.rsplit(" ", 1)
            assert int(count) > 0
            ranks.setdefault(normalize(word, language), rank)
        frequency[language] = ranks
    assert set(frequency) == set(LANGUAGES)
    result = {language: {} for language in LANGUAGES}
    for concept in concepts.values():
        for language in LANGUAGES:
            for _, form in variants(concept, language):
                word = normalize(form["text"], language)
                if word in frequency[language]:
                    result[language][word] = frequency[language][word]
    # Editorial replacement vocabulary also needs target-language evidence.
    for rule in rules:
        language = rule["language"]
        if rule["replacementText"] is not None:
            word = normalize(rule["replacementText"], language)
            if word in frequency[language]:
                result[language][word] = frequency[language][word]
    return {language: dict(sorted(value.items())) for language, value in result.items()}, provenance


def validate(data, concepts, inputs, cache):
    assert data["languages"] == list(LANGUAGES)
    assert data["inputs"] == inputs, "Source dictionaries changed; rerun the complete audit."
    counts, findings = audit(concepts)
    assert data["reviewedCounts"] == counts, "Coverage counts are stale."
    assert data["systematicFindings"] == findings, "Systematic findings are stale."
    seen = set()
    for rule in data["rules"]:
        key = (rule["conceptId"], rule["language"])
        assert key not in seen, f"Duplicate rule: {key}"
        seen.add(key)
        concept = concepts[key[0]]
        original = concept["forms"][key[1]]
        assert rule["originalText"] == original["text"], key
        assert rule["meaning"] == concept["meaning"], key
        assert rule["partOfSpeech"] == concept["pos"], key
        replacement = rule["replacementText"]
        assert replacement is None or isinstance(replacement, str) and replacement.strip(), key
        if replacement is not None:
            assert replacement != original["text"], key
            assert rule["replacementForm"]["text"] == replacement, key
            hard_flags = set(form_flags(concept, key[1], rule["replacementForm"])) - {
                "noun-capitalization-or-cross-pos-review",
            }
            assert not hard_flags, (key, hard_flags)
        if rule["provenance"] == "dictionary-attested-alternative":
            assert rule["replacementForm"] in original.get("alternatives", []), key
        else:
            assert rule["provenance"] == "app-editorial-correction", key
    overrides = set()
    for override in data["conceptOverrides"]:
        concept = concepts[override["conceptId"]]
        assert concept["id"] not in overrides
        overrides.add(concept["id"])
        assert override["originalPartOfSpeech"] == concept["pos"]
        assert override["meaning"] == concept["meaning"]
        assert override["partOfSpeech"] in POS
        assert override["partOfSpeech"] != concept["pos"]
    for excluded in data["excludedConcepts"]:
        concept = concepts[excluded["conceptId"]]
        assert excluded["meaning"] == concept["meaning"], excluded["conceptId"]
        if excluded["method"] == "explicit-dictionary-heading":
            assert LETTER_NAME.search(concept["meaning"]), excluded["conceptId"]
        else:
            assert excluded["method"] == "individual-sense-review-by-coding-assistant"
            assert excluded["sourceUrl"] == concept["sourceUrl"], excluded["conceptId"]
    for finding in data["alternativeFindings"]:
        concept = concepts[finding["conceptId"]]
        alternatives = concept["forms"][finding["language"]].get("alternatives", [])
        assert any(form["text"] == finding["text"] for form in alternatives)
    ranks, provenance = native_ranks(concepts, cache, data["rules"])
    assert ranks == data["nativeRanks"], "Native frequency matches changed."
    assert provenance == data["frequencySource"]["inputs"]
    return {
        "sourceConcepts": len(concepts),
        "primaryFormsScanned": sum(row.get("primary", 0) for row in counts.values()),
        "alternativeFormsScanned": sum(
            row.get("alternative", 0) + row.get("source-evidence-alternative", 0)
            for row in counts.values()
        ),
        "reviewedCorrections": len(data["rules"]),
        "partOfSpeechCorrections": len(data["conceptOverrides"]),
        "letterNameConceptsExcluded": sum(
            entry["method"] == "explicit-dictionary-heading"
            for entry in data["excludedConcepts"]
        ),
        "semanticallyMismatchedConceptsExcluded": sum(
            entry["method"] == "individual-sense-review-by-coding-assistant"
            for entry in data["excludedConcepts"]
        ),
        "nativeRankMatches": {language: len(value) for language, value in ranks.items()},
        "limitation": "Systematic coverage is complete; semantic review is limited to the explicitly recorded individual decisions.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=OUTPUT)
    parser.add_argument("--frequency-cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--check", action="store_true", help="Validate all explicit review decisions.")
    parser.add_argument("--scan", action="store_true", help="Print complete systematic scan counts and findings.")
    args = parser.parse_args()
    concepts, inputs = dictionaries()
    if args.scan:
        counts, findings = audit(concepts)
        print(json.dumps({"reviewedCounts": counts, "findings": findings}, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(validate(load(args.input), concepts, inputs, args.frequency_cache), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
