"""Apply adjudicated, sense-specific bilingual corrections after source cleaning.

Pair agents work from an immutable inventory. Their proposals are reconciled
separately; the reproducible build reads only the reviewed decision file.
"""
import json
import re


def apply_pair_corrections(files, path):
    if not path.exists():
        return set(), set(), {}
    review = json.loads(path.read_text(encoding="utf-8"))
    assert review["scope"] == "turkish-pairs"
    entries = {code: {row["senseId"]: row for row in value["entries"]} for code, value in files.items()}
    translations = {code: {row["senseId"]: row for row in value["translations"]} for code, value in files.items()}
    seen, changed, removed = set(), set(), set()
    for rule in review.get("exclusions", []):
        code, sense = rule["language"], rule["conceptId"]
        assert (code, sense) not in removed, "Duplicate pair exclusion"
        assert translations[code][sense]["text"] == rule["originalText"], "Excluded translation changed"
        removed.add((code, sense))
    for rule in review["corrections"]:
        code, sense = rule["language"], rule["conceptId"]
        key = code, sense
        assert key not in removed, f"Conflicting removal and replacement: {key}"
        assert key not in seen, f"Duplicate pair decision: {key}"
        seen.add(key)
        old, new = rule["originalText"], rule["replacementText"]
        assert old != new and new.strip() == new and new, f"Invalid pair correction: {key}"
        assert not re.search(r"[()\[\]（）［］【】]", new), f"Study annotation in pair correction: {key}"
        translation = translations[code][sense]
        assert translation["text"] == old, f"Pair review source changed: {key}: {translation['text']} != {old}"
        translation["text"] = new
        if "jenechka-editorial" not in translation["sources"]:
            translation["sources"] = translation["sources"] + ["jenechka-editorial"]
        entry = entries[code].get(sense)
        if entry:
            assert entry["lemma"] == old, f"Entry differs from pair translation: {key}"
            entry["lemma"] = entry["studyText"] = new
            # Old gender/register tags must not describe a different lexeme.
            entry["grammar"] = rule.get("grammar", [])
            entry.pop("editorialLevel", None)
            if "jenechka-editorial" not in entry["sources"]:
                entry["sources"] = entry["sources"] + ["jenechka-editorial"]
            changed.add((code, entry["id"]))
    for code, language in files.items():
        removed_ids = {row["id"] for row in language["entries"] if (code, row["senseId"]) in removed}
        language["entries"] = [row for row in language["entries"] if row["id"] not in removed_ids]
        language["translations"] = [row for row in language["translations"] if (code, row["senseId"]) not in removed]
        for field in ("frequency", "categories", "collections"):
            language[field] = [row for row in language[field] if row["entryId"] not in removed_ids]
        # Published headword levels cannot be transferred to a replacement.
        language["cefr"] = [row for row in language["cefr"] if (code, row["entryId"]) not in changed and row["entryId"] not in removed_ids]
    return changed, removed, {
        "snapshotSha256": review["snapshotSha256"],
        "pairs": review["pairs"],
        "corrections": len(seen),
        "excludedForms": len(removed),
    }


def clean_pair_meanings(files, path):
    if not path.exists():
        return 0
    review = json.loads(path.read_text(encoding="utf-8"))
    for rule in review.get("meaningCorrections", []):
        found = False
        for language in files.values():
            for entry in language["entries"]:
                if entry["senseId"] != rule["conceptId"]:
                    continue
                assert entry["meaning"] == rule["originalText"], "Reviewed meaning cleanup changed"
                entry["meaning"] = rule["replacementText"]
                if "jenechka-editorial" not in entry["sources"]:
                    entry["sources"] = entry["sources"] + ["jenechka-editorial"]
                found = True
        assert found, "Unknown meaning cleanup sense"
    return len(review.get("meaningCorrections", []))
