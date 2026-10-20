#!/usr/bin/env python3
"""Validate individually reviewed topic assignments against their exact source.

This offline audit does not assign topics, translate words, or estimate levels.
It checks the explicit review artifact rather than applying keyword rules.
"""

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "vocabulary" / "source-data"


def read_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def validate(path):
    taxonomy = read_json(SOURCE_DIR / "lexicon.json")
    source = read_json(SOURCE_DIR / "expanded-lexicon.json")
    data = read_json(path)
    categories = {entry["id"]: entry for entry in taxonomy["categories"]}
    concepts = {entry["id"]: entry for entry in source["concepts"]}
    source_ids = {entry["id"] for entry in source["sources"]}
    assert data["version"] == 1, "Unknown review artifact version"
    assert isinstance(data["methodology"], str) and data["methodology"].strip()
    assert set(data["sources"]) <= source_ids, "Unknown source identifier"
    assert isinstance(data["assignments"], list) and data["assignments"]

    seen = set()
    topic_counts = Counter()
    language_counts = Counter()
    all_languages_count = 0
    category_language_counts = {}
    for assignment in data["assignments"]:
        concept_id = assignment["conceptId"]
        assert concept_id not in seen, f"Duplicate concept: {concept_id}"
        seen.add(concept_id)
        assert concept_id in concepts, f"Missing source concept: {concept_id}"
        concept = concepts[concept_id]
        assigned = assignment["categories"]
        assert assigned and len(assigned) == len(set(assigned)), concept_id
        assert set(assigned) <= categories.keys(), f"Unknown category: {concept_id}"
        assert all(categories[cat]["kind"] == "traditional" for cat in assigned)
        evidence = assignment["evidence"]
        expected = {
            "headword": concept["forms"]["en"]["text"],
            "partOfSpeech": concept["pos"],
            "translationSense": concept["meaning"],
            "source": concept["evidence"]["source"],
            "sourceUrl": concept["sourceUrl"],
            "sha256": concept["evidence"]["sha256"],
            "bulkLine": concept["evidence"]["bulkLine"],
            "sourceSenseOrder": concept["evidence"]["sourceSenseOrder"],
            "method": "individual-sense-review",
        }
        assert evidence == expected, f"Changed or incomplete evidence: {concept_id}"
        assert re.fullmatch(r"[a-f0-9]{64}", evidence["sha256"]), concept_id
        parsed_url = urlparse(evidence["sourceUrl"])
        assert parsed_url.scheme == "https" and parsed_url.hostname == "kaikki.org"
        topic_counts.update(assigned)
        language_counts.update(concept["forms"].keys())
        all_languages_count += len(concept["forms"]) == 13
        for category in assigned:
            category_language_counts.setdefault(category, Counter()).update(
                concept["forms"].keys()
            )

    assert [entry["conceptId"] for entry in data["assignments"]] == sorted(seen)
    return {
        "assignments": len(seen),
        "all13Languages": all_languages_count,
        "categories": dict(sorted(topic_counts.items())),
        "languageCoverage": dict(sorted(language_counts.items())),
        "categoryLanguageCoverage": {
            category: dict(sorted(counts.items()))
            for category, counts in sorted(category_language_counts.items())
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=SOURCE_DIR / "topic-supplement.json",
        help="Explicit, individually reviewed assignments to validate",
    )
    args = parser.parse_args()
    print(json.dumps(validate(args.input), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
