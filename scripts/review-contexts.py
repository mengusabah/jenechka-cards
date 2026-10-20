#!/usr/bin/env python3
"""Audit the individually reviewed context assignments without modifying data."""

import json
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ALLOWED_CONTEXTS = {
    "gardening", "dining", "office", "airport", "school", "shopping", "everyday"
}


def main():
    source = json.loads(
        (ROOT / "vocabulary/source-data/expanded-lexicon.json").read_text()
    )
    supplement = json.loads(
        (ROOT / "vocabulary/source-data/context-supplement.json").read_text()
    )
    concepts = {concept["id"]: concept for concept in source["concepts"]}
    categories = {category["id"] for category in source["categories"]}
    assignments = supplement["assignments"]
    assert assignments, "The context supplement must contain reviewed assignments"
    assert "Individual-sense review" in supplement["methodology"]
    assert "model-assisted" in supplement["methodology"]
    seen = set()
    language_coverage = Counter()
    context_coverage = Counter()
    minimum_languages = 13

    for assignment in assignments:
        concept_id = assignment["conceptId"]
        assert concept_id not in seen, f"Duplicate concept: {concept_id}"
        seen.add(concept_id)
        assert concept_id in concepts, f"Unknown concept: {concept_id}"
        concept = concepts[concept_id]
        evidence = concept["evidence"]
        for field, expected in (
            ("headword", evidence["headword"]),
            ("meaning", concept["meaning"]),
            ("pos", concept["pos"]),
        ):
            assert assignment[field] == expected, (
                f"{concept_id}: {field} differs from the reviewed dictionary record"
            )
        assert assignment["meaning"] == evidence["translationSense"], (
            f"{concept_id}: heading no longer matches the source translation sense"
        )
        assert assignment["pos"] == evidence["partOfSpeech"], (
            f"{concept_id}: POS no longer matches the source part of speech"
        )
        assigned_categories = assignment["categories"]
        assert assigned_categories, f"No context assigned: {concept_id}"
        assert len(assigned_categories) == len(set(assigned_categories)), (
            f"Repeated context: {concept_id}"
        )
        assert set(assigned_categories) <= categories & ALLOWED_CONTEXTS, (
            f"Unknown or out-of-scope category: {concept_id}"
        )
        assert "tr" in concept["forms"], (
            f"{concept_id}: reviewed Turkish form is no longer present"
        )
        assert len(concept["forms"]) >= 8, (
            f"{concept_id}: source no longer meets minimum language coverage"
        )
        assert concept["sourceUrl"] and evidence["sha256"], (
            f"{concept_id}: missing source provenance"
        )
        language_coverage.update(concept["forms"].keys())
        context_coverage.update(assigned_categories)
        minimum_languages = min(minimum_languages, len(concept["forms"]))

    # Regression checks protect distinctions that a headword-wide rule would lose.
    # Each assertion describes a reviewed semantic decision, not a lexical pattern.
    by_id = {assignment["conceptId"]: assignment for assignment in assignments}
    required = {
        "bulk-a7773a25fadbb24b65b1ed39": ("gardening", "exterior covering of a tree"),
        "bulk-c8640e6de047c275bf8f894e": ("gardening", "unwanted plant"),
        "bulk-3fd45009ab07873ed483aa80": (
            "gardening", "a container used to carry and dispense water for plants"
        ),
        "bulk-cea3667903d1e797e6ff6ce6": ("airport", "journey made by an aircraft"),
        "bulk-f32b77fc2687138745877269": ("airport", "airport building"),
        "bulk-61731ba993b603ce013f715b": ("airport", "airplane"),
        "bulk-c2c3d687f36ebc3028d7e343": ("dining", "specific type of food"),
        "bulk-7a4a50b16e7f614402fdae7a": (
            "shopping", "to give something back to its original holder or owner"
        ),
        "bulk-866c197b5bbceef56e5fd34a": (
            "office", "computing: to write a file to a storage medium"
        ),
    }
    for concept_id, (category, meaning) in required.items():
        assert concept_id in by_id, f"Missing reviewed anchor: {concept_id}"
        assert category in by_id[concept_id]["categories"]
        assert by_id[concept_id]["meaning"] == meaning

    excluded = {
        "bulk-4a52438a75258d5d81f12eca",  # weed: marijuana
        "bulk-3b980d029d9fc2772061960b",  # water: to urinate
        "bulk-138bb2e14e598084695b14bc",  # plane: tree
        "bulk-18a0aa8ee616b15b690aa2ac",  # plane: geometrical surface
        "bulk-80b254903a8c68efbbb09c32",  # flight: fleeing
        "bulk-e8dfbc2bf7ebcd49199161fa",  # dish/vessel: incorrect primary Turkish
        "bulk-68a9ca01adf31566a5d1024d",  # vegetable/food: incorrect primary Turkish
        "bulk-acc7e432ecb2f15bec8f0632",  # refund/noun: Turkish verb mismatch
    }
    assert not seen & excluded, f"Excluded sense reintroduced: {seen & excluded}"

    print(f"Audited {len(assignments)} unique individual-sense assignments.")
    print("Contexts:", json.dumps(dict(sorted(context_coverage.items()))))
    print("Language coverage:", json.dumps(dict(sorted(language_coverage.items()))))
    print(f"Minimum language coverage per concept: {minimum_languages}")
    print("Exact source metadata, provenance, scope and homonym checks passed.")


if __name__ == "__main__":
    main()
