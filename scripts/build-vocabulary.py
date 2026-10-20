#!/usr/bin/env python3
"""Build compact static language files from attributed dictionary inputs.

No network or Python packages are required. Run from any directory:
    python3 scripts/build-vocabulary.py
    python3 scripts/build-vocabulary.py --check

Refresh input snapshots only with their individual fetch scripts and review the
result before rebuilding. Raw frequency tokens are not themselves flashcards.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import quote
from vocabulary_quality import clean_card_text, apply_reviews
from cefr_estimates import estimate, SOURCE as ESTIMATE_SOURCE
from pair_quality import apply_pair_corrections, clean_pair_meanings

ROOT = Path(__file__).resolve().parent.parent
INPUT = ROOT / "vocabulary/source-data"
OUTPUT = ROOT / "vocabulary/v1"
VERSION = "1"
MAX_FILE_BYTES = 12 * 1024 * 1024
COLLECTION_SIZE = 500


def read(name):
    return json.loads((INPUT / name).read_text(encoding="utf-8"))


def normalized(text, language):
    value = unicodedata.normalize("NFC", text).replace("\u0301", "")
    if language == "tr":
        value = value.replace("İ", "i").replace("I", "ı")
    value = value.lower()
    if language == "ar":
        # Optional Arabic vowel marks do not change the underlying word form.
        value = re.sub(r"[\u064b-\u065f\u0670]", "", value)
    return value


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"

def source_categories(concept):
    evidence = concept.get("evidence", {})
    if evidence.get("source") != "wiktionary-kaikki-expanded":
        return concept["categories"]
    # Some Kaikki translation tables are nested under a different dictionary
    # sense (e.g. a family grandfather under an archival-computing sense).
    # Nesting alone cannot establish semantic topic membership.
    clean = lambda value: re.sub(r"\W+", " ", value.casefold()).strip()
    heading = clean(concept["meaning"])
    if any(clean(gloss) == heading for group in evidence.get("sourceSenseGlosses", []) for gloss in group):
        return concept["categories"]
    return []


def study_text(form):
    return clean_card_text(form["text"])

def packed(language):
    """Intern repeated strings; keep the same lossless data model in the app."""
    strings, lookup = [], {}
    def s(value):
        if value not in lookup:
            lookup[value] = len(strings)
            strings.append(value)
        return lookup[value]
    def many(values):
        return [s(value) for value in values]
    entry_indices = {row["id"]: i for i, row in enumerate(language["entries"])}
    result = {
        "schema": 1, "version": VERSION, "language": language["language"], "packing": 1,
        "strings": strings,
        "entries": [[s(row["id"]), s(row["senseId"]), s(row["lemma"]), s(row["pos"]),
                     s(row["meaning"]), many(row.get("grammar", [])), many(row["sources"]),
                     s(row.get("studyText", row["lemma"])), s(row.get("attributionUrl", ""))]
                    for row in language["entries"]],
        "translations": [[s(row["senseId"]), s(row["text"]), many(row["sources"]),
                          s(row.get("attributionUrl", ""))] for row in language["translations"]],
        "frequency": [[entry_indices[row["entryId"]], row["rank"], s(row["source"])]
                      for row in language["frequency"]],
        "cefr": [[entry_indices[row["entryId"]], s(row["level"]), s(row["source"]), int(row.get("estimated", False))]
                 for row in language["cefr"]],
        "categories": [[entry_indices[row["entryId"]], s(row["categoryId"])]
                       for row in language["categories"]],
        "collections": [[entry_indices[row["entryId"]], row["collection"]]
                        for row in language["collections"]],
    }
    assert len(json_text(result).encode()) <= MAX_FILE_BYTES, "Partition language data before exceeding download budget."
    return result


def build():
    registry = re.findall(r"\{ code: '([^']+)', name: '([^']+)' \}", (ROOT / "languages.js").read_text())
    codes = [code for code, name in registry]
    lexicon, frequency, cefr = read("lexicon.json"), read("frequency.json"), read("cefr.json")
    expanded, european, asian, levels = (
        read("expanded-lexicon.json"), read("european.json"), read("asian.json"), read("levels.json"))
    expanded["concepts"].sort(key=lambda row: (
        row["evidence"].get("bulkLine", 0), row["evidence"].get("sourceSenseOrder", 0), row["id"]))
    editorial = read("editorial.json")
    concept_inputs = [lexicon, european, expanded, editorial]
    supplements = [read("topic-supplement.json"), read("context-supplement.json")]
    supplements.append(read("topic-expansion-reviewed.json"))
    all_concepts = {concept["id"]: concept for dataset in concept_inputs for concept in dataset["concepts"]}
    for rule in read("form-review.json")["rules"]:
        concept = all_concepts[rule["conceptId"]]
        form = concept["forms"][rule["language"]]
        assert form["text"] == rule["sourceText"], "Reviewed form changed; inspect the new source."
        assert concept["meaning"] == rule["evidence"]["meaning"]
        assert concept["pos"] == rule["evidence"]["pos"]
        assert concept["evidence"]["sha256"] == rule["evidence"]["sha256"]
        replacement = rule["replacement"]
        if replacement is None:
            del concept["forms"][rule["language"]]
        else:
            assert replacement in form.get("alternatives", []), "Replacement must be a literal source alternative."
            concept["forms"][rule["language"]] = replacement
    curated_categories = defaultdict(set)
    for supplement in supplements:
        for assignment in supplement["assignments"]:
            concept = all_concepts[assignment["conceptId"]]
            evidence = assignment.get("evidence", assignment)
            assert evidence.get("translationSense", evidence.get("meaning")) == concept["meaning"], "Topic sense changed; review again."
            assert evidence.get("partOfSpeech", evidence.get("pos")) == concept["pos"], "Topic POS changed; review again."
            curated_categories[concept["id"]].update(assignment["categories"])
    quality_reviews = [read(name) for name in (
        "quality-west.json", "quality-romance-ru.json", "quality-asian.json")]
    excluded, quality_audit = apply_reviews(all_concepts, asian["records"], cefr["russian"], quality_reviews)
    assert set(codes) == set(frequency["languages"]), "Frequency inputs differ from the shared language registry."
    files = {code: {
        "schema": 1, "version": VERSION, "language": code,
        "entries": [], "translations": [], "frequency": [], "cefr": [], "categories": [], "collections": [],
    } for code in codes}
    categories = list(lexicon["categories"])
    extra_topics = {
        "people": ("people", "People", "People and social relationships.", "traditional"),
        "study/work": ("study-work", "Study & Work", "Study and working life, grouped together by the Russian source.", "context"),
        "description": ("descriptions", "Describing Things", "Descriptive vocabulary and qualities.", "traditional"),
        "communication": ("communication", "Communication", "Speaking, writing, and social communication.", "context"),
        "mental experience": ("thoughts", "Thoughts & Feelings", "Thinking, understanding, and emotional experience.", "context"),
        "politics": ("society", "Society & Politics", "Social and political life.", "traditional"),
        "leisure": ("leisure", "Leisure Time", "Free time, entertainment, and leisure activities.", "context"),
        "home": ("home-life", "At Home", "Home life, domestic objects, and activities.", "context"),
        "measurement": ("measurement", "Measurement", "Quantities and ways of measuring.", "traditional"),
    }
    category_ids = {category["id"] for category in categories}
    for dataset in concept_inputs[1:]:
        for category in dataset["categories"]:
            if category["id"] not in category_ids:
                categories.append(category)
                category_ids.add(category["id"])
    for cid, name, description, kind in extra_topics.values():
        if cid not in category_ids:
            categories.append({"id": cid, "name": name, "description": description, "kind": kind})
            category_ids.add(cid)
    # Exact source-topic mapping, never word/substring matching.
    topic_map = {
        "food": "food-drinks", "time": "time", "health": "health",
        "weather": "weather", "transportation": "transportation",
        "clothing": "clothing", "shopping": "shopping", "travel": "airport",
        "animals/plants": "nature",
        **{topic: value[0] for topic, value in extra_topics.items()},
    }
    concept_ids = set()
    for concept in [concept for dataset in concept_inputs for concept in dataset["concepts"]]:
        if concept["id"] in excluded:
            continue
        assert concept["id"] not in concept_ids, "Duplicate concept ID"
        concept_ids.add(concept["id"])
        concept_categories = sorted(set(source_categories(concept)) | curated_categories[concept["id"]])
        assert all(cid in category_ids for cid in concept_categories)
        for code, form in concept["forms"].items():
            assert code in files, f"Unknown language: {code}"
            entry_id = f"{code}_c_{concept['id']}"
            lemma = clean_card_text(form["text"])
            sources = [concept.get("evidence", {}).get("source", lexicon["sources"][0]["id"])]
            if form.get("editorialCorrection"):
                sources.append("jenechka-editorial")
            attribution_url = concept["sourceUrl"] if sources[0] in {"ids", "jenechka-editorial"} else (
                "https://en.wiktionary.org/wiki/" + quote(concept["evidence"]["headword"].replace(" ", "_"), safe=""))
            entry = {
                "id": entry_id, "senseId": concept["id"], "lemma": lemma,
                "pos": concept["pos"], "meaning": concept["meaning"],
                "grammar": form.get("tags", []), "sources": sources,
                "sourceUrl": concept["sourceUrl"],
                "attributionUrl": attribution_url,
            }
            if form.get("estimatedLevel"):
                entry["editorialLevel"] = form["estimatedLevel"]
            if concept.get("frequencyPriority"):
                entry["frequencyPriority"] = True
            entry["studyText"] = study_text(form)
            files[code]["entries"].append(entry)
            files[code]["translations"].append({
                "senseId": concept["id"], "text": study_text(form), "sources": sources,
                "attributionUrl": attribution_url,
            })
            files[code]["categories"].extend(
                {"entryId": entry_id, "categoryId": cid} for cid in concept_categories
            )
    for row in asian["records"]:
        if row["id"] in excluded:
            continue
        code, sense_id = row["language"], row["id"]
        entry_id = code + "_d_" + sense_id
        page = row.get("attributionUrl", row.get("sourceUrl", ""))
        if not page and row["source"] in {"wiktionary-korean", "wiktionary-arabic"}:
            page = "https://en.wiktionary.org/wiki/" + quote(row["lemma"].replace(" ", "_"), safe="")
        answer = study_text({"text": row["lemma"], "tags": row.get("tags", [])})
        row_sources = [row["source"]] + (["jenechka-editorial"] if row.get("editorialCorrection") else [])
        files[code]["entries"].append({
            "id": entry_id, "senseId": sense_id, "lemma": clean_card_text(row["lemma"]), "pos": row["pos"],
            "meaning": row["gloss"], "grammar": row.get("tags", []), "sources": row_sources,
            "studyText": answer,
            "attributionUrl": page,
        })
        for language, text in [(code, answer), ("en", clean_card_text(row["gloss"]))]:
            files[language]["translations"].append({
                "senseId": sense_id, "text": text, "sources": row_sources, "attributionUrl": page,
            })
        for cid in row.get("categories", []):
            assert cid in category_ids
            files[code]["categories"].append({"entryId": entry_id, "categoryId": cid})
    for row in cefr["russian"]:
        if row["id"] in excluded:
            continue
        sense_id = row["id"]
        entry_id = "ru_s_" + row["id"].removeprefix("ru-smartool-")
        row_sources = ["smartool"] + (["jenechka-editorial"] if row.get("editorialCorrection") else [])
        files["ru"]["entries"].append({
            "id": entry_id, "senseId": sense_id, "lemma": clean_card_text(row["lemma"]), "pos": row["pos"],
            "meaning": row["gloss"], "grammar": [], "sources": row_sources,
        })
        files["ru"]["translations"].append({"senseId": sense_id, "text": clean_card_text(row["lemma"]), "sources": row_sources})
        # An English gloss is a translation/explanation, not an independently
        # classified English headword. It cannot acquire Russian ranks/levels.
        files["en"]["translations"].append({"senseId": sense_id, "text": clean_card_text(row["gloss"]), "sources": row_sources})
        files["ru"]["cefr"].append({"entryId": entry_id, "level": row["level"], "source": "smartool"})
        for topic in row["topics"]:
            assert topic in topic_map, f"Review this new source topic before importing: {topic}"
            files["ru"]["categories"].append({"entryId": entry_id, "categoryId": topic_map[topic]})

    pair_changed, pair_removed, pair_audit = apply_pair_corrections(files, INPUT / "pair-corrections.json")

    english_levels = defaultdict(set)
    english_level_sources = defaultdict(set)
    pos_map = {"intj": "interjection", "adj": "adjective", "adv": "adverb", "num": "number",
               "pron": "pronoun", "prep": "preposition", "conj": "conjunction", "det": "determiner"}
    for rows, source in [(cefr["english"], "cefrj"), (levels["english"], "octanove")]:
        for row in rows:
            key = (normalized(row["lemma"], "en"), row["pos"])
            english_levels[key].add(row["level"])
            english_level_sources[key].add(source)
    for entry in files["en"]["entries"]:
        key = (normalized(entry["lemma"], "en"), pos_map.get(entry["pos"], entry["pos"]))
        entry_levels = english_levels.get(key, set())
        if len(entry_levels) == 1:
            files["en"]["cefr"].append({"entryId": entry["id"], "level": next(iter(entry_levels)),
                                        "source": sorted(english_level_sources[key])[0]})

    native_ranks = {}
    for review in quality_reviews:
        for code, ranks in review.get("nativeRanks", {}).items():
            native_ranks.setdefault(code, {}).update(ranks)
    reviewed_levels = {}
    for name in ("cefr-reviewed-west.json", "cefr-reviewed-romance-ru.json", "cefr-reviewed-asian.json"):
        if not (INPUT / name).exists():
            continue
        for row in read(name)["assignments"]:
            key = (row["language"], row["conceptId"])
            assert key not in reviewed_levels, f"Duplicate reviewed level: {key}"
            reviewed_levels[key] = row
    frequency_preference, frequency_excluded = {}, set()
    for name in ("frequency-preferences-west.json", "frequency-preferences-romance-ru.json", "frequency-preferences-asian.json"):
        if not (INPUT / name).exists():
            continue
        review = read(name)
        for row in review.get("preferences", []):
            key = (row["language"], normalized(row["word"], row["language"]))
            assert key not in frequency_preference, f"Duplicate frequency preference: {key}"
            frequency_preference[key] = row["conceptId"]
        for row in review.get("excluded", []):
            frequency_excluded.add((row["language"], normalized(row["word"], row["language"])))
    estimate_methods = {}
    for code, language in files.items():
        ranks = {normalized(row["word"], code): row["rank"] for row in reversed(frequency["languages"][code])}
        classified = {row["entryId"] for row in language["cefr"]}
        topics = defaultdict(set)
        for row in language["categories"]:
            topics[row["entryId"]].add(row["categoryId"])
        methods = Counter()
        preferred_core = {}
        for entry in language["entries"]:
            if entry.get("frequencyPriority"):
                preferred_core.setdefault(normalized(entry["lemma"], code), entry["senseId"])
        # A sense chosen independently for the target language stays fixed
        # across translation languages; missing translations never justify
        # silently substituting another homonymous sense.
        for word, sense_id in preferred_core.items():
            frequency_preference[(code, word)] = sense_id
            frequency_excluded.discard((code, word))
        by_sense = {entry["senseId"]: entry for entry in language["entries"]}
        for (language_code, word), sense_id in list(frequency_preference.items()):
            if language_code != code:
                continue
            if (code, sense_id) in pair_removed:
                del frequency_preference[(code, word)]
                frequency_excluded.add((code, word))
                continue
            assert sense_id in by_sense, f"Preferred frequency sense no longer exists: {code}/{word}/{sense_id}"
            if normalized(by_sense[sense_id]["lemma"], code) != word and (code, by_sense[sense_id]["id"]) in pair_changed:
                # A new word keeps its own corpus rank. The old token cannot
                # silently fall back to another, unreviewed homonymous sense.
                del frequency_preference[(code, word)]
                frequency_excluded.add((code, word))
                continue
            assert normalized(by_sense[sense_id]["lemma"], code) == word, f"Preferred frequency form changed: {code}/{word}"
        for entry in language["entries"]:
            word = normalized(entry["lemma"], code)
            rank = ranks.get(word)
            selected_sense = frequency_preference.get((code, word))
            if rank and (code, word) not in frequency_excluded and (not selected_sense or selected_sense == entry["senseId"]):
                language["frequency"].append({"entryId": entry["id"], "rank": rank, "source": "frequencywords"})
            if entry["id"] not in classified:
                native_rank = native_ranks.get(code, {}).get(normalized(entry["lemma"], code), rank)
                reviewed = reviewed_levels.get((code, entry["senseId"]))
                if reviewed and (code, entry["id"]) in pair_changed:
                    reviewed = None
                if reviewed:
                    assert normalized(entry["lemma"], code) == normalized(reviewed["lemma"], code), f"Reviewed level spelling changed: {entry['id']}"
                    assert entry["meaning"] == reviewed["meaning"], f"Reviewed level meaning changed: {entry['id']}"
                    level, method = reviewed["level"], "individual-native-sense-review"
                elif entry.get("editorialLevel"):
                    level, method = entry["editorialLevel"], "original-native-vocabulary-editorial-level"
                else:
                    level, method = estimate(entry, code, native_rank, topics[entry["id"]])
                language["cefr"].append({
                    "entryId": entry["id"], "level": level, "source": ESTIMATE_SOURCE["id"], "estimated": True,
                })
                methods[method] += 1
        estimate_methods[code] = dict(methods)
        assert len(language["cefr"]) == len(language["entries"]), "Every target entry needs one study band."
        assert len({row["entryId"] for row in language["cefr"]}) == len(language["cefr"])
        assert len({entry["id"] for entry in language["entries"]}) == len(language["entries"])
        assert len({item["senseId"] for item in language["translations"]}) == len(language["translations"])
        # Smaller editable dictionary packs expose additional attested senses
        # without pretending they have topic, rank or CEFR classifications.
        ordered = sorted(language["entries"], key=lambda row: (normalized(row["lemma"], code), row["id"]))
        language["collections"] = [{"entryId": row["id"], "collection": i // COLLECTION_SIZE + 1}
                                   for i, row in enumerate(ordered)]

    if pair_audit:
        pair_audit["cleanedMeanings"] = clean_pair_meanings(files, INPUT / "pair-corrections.json")

    sources = (lexicon["sources"] + [frequency["source"]] + cefr["sources"] +
               levels["sources"] + european["sources"] + expanded["sources"] + asian["sources"] +
               editorial["sources"] + [ESTIMATE_SOURCE])
    # Detailed hashes and exact extraction decisions remain in source-data.
    # The browser only needs readable attribution and method information.
    source_fields = ["id", "name", "url", "license", "licenseUrl", "attribution", "methodology", "version"]
    runtime_sources = [{key: source[key] for key in source_fields if key in source} for source in sources]
    for source in runtime_sources:
        if source["id"] in {"wiktionary-kaikki", "wiktionary-kaikki-expanded"}:
            source["methodology"] += (
                " Additional topic/context assignments use individual dictionary-sense review by the coding assistant. "
                "This model-assisted semantic curation is recorded by exact concept ID, meaning and POS in "
                "source-data/topic-supplement.json and source-data/context-supplement.json; it is not native-speaker review."
            )
        if source["id"] == "wiktionary-kaikki-expanded":
            source["methodology"] += (
                " Raw parent-sense topic labels are not trusted by nesting alone: automatic topic assignment "
                "requires an exact normalized translation-heading/gloss match; other topics require individual sense review."
                " Reviewed corrections/exclusions are recorded in source-data/form-review.json and quality-*.json. "
                "Corrections distinguish same-sense source alternatives, notation cleanup and editorial repairs. "
                "All forms undergo structural screening; this does not certify every meaning as independently native-reviewed. "
                "Parenthetical annotations and readings are omitted from study faces while source metadata is retained."
            )
    runtime_sources[1]["methodology"] += (
        " Only dictionary-matched forms are used in this app. Original ranks are not renumbered. "
        "Matching ignores case, Russian stress marks, and optional Arabic vowel marks; it does not "
        "stem words, aggregate inflections, or transfer ranks between languages."
    )
    review_counts = {}
    for review in quality_reviews:
        counts = review.get("reviewedCounts", {})
        counts = counts.get("byLanguage", counts)
        for code in codes:
            value = counts.get(code, {})
            if isinstance(value, dict):
                value = value.get("total", value.get("primary", 0))
            review_counts[code] = review_counts.get(code, 0) + value
    catalog = {
        "schema": 1, "version": VERSION, "categories": categories, "sources": runtime_sources,
        "supportedPairs": [[source, target] for source in codes for target in codes
                           if source != target and "tr" in (source, target)
                           and source in {"tr", "en", "de", "es", "ru"}
                           and target in {"tr", "en", "de", "es", "ru"}],
        "collections": max((len(value["entries"]) + COLLECTION_SIZE - 1) // COLLECTION_SIZE for value in files.values()),
        "collectionSize": COLLECTION_SIZE,
        "coverage": {code: {
            "entries": len(value["entries"]), "translations": len(value["translations"]),
            "frequencyEntries": len(value["frequency"]),
            "cefr": dict(sorted(Counter(row["level"] for row in value["cefr"]).items())),
            "estimatedCefr": sum(row.get("estimated", False) for row in value["cefr"]),
        } for code, value in files.items()},
        "quality": {
            "reviewedForms": review_counts,
            "corrections": len(quality_audit["appliedRules"]),
            "excludedConcepts": len(quality_audit["excludedConcepts"]),
            "excludedDictionaryRecords": len(quality_audit["excludedRecords"]),
            "estimateMethods": estimate_methods,
            "frequencySensePreferences": len(frequency_preference),
            "excludedFrequencyForms": len(frequency_excluded),
            "pairReview": pair_audit,
        },
        "limitations": [
            "This is a partial dictionary-derived library, not a complete multilingual curriculum.",
            "Wiktionary translation senses were selected and filtered; not every form has independent native-speaker review.",
            "The shared dictionary POS describes the source concept, not independently verified target-language grammar.",
            "Frequency uses raw subtitle word forms, not lemma frequencies; unmatched tokens and missing translations are omitted without filling lower ranks.",
            "English CEFR-J/Octanove and Russian SMARTool labels are headword/POS classifications, not certified sense levels. Remaining labels are explicitly estimated using a native-language editorial rubric.",
            "Monolingual dictionary English glosses are translations only; no automatic translation, cross-dictionary sense guessing, or English fallback is used.",
        ],
    }
    return {"catalog.json": catalog, **{code + ".json": packed(value) for code, value in files.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify generated files without changing them")
    args = parser.parse_args()
    result = build()
    if not args.check:
        OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, value in result.items():
        text = json_text(value)
        path = OUTPUT / name
        if args.check:
            assert path.read_text(encoding="utf-8") == text, f"Stale generated file: {name}"
        else:
            path.write_text(text, encoding="utf-8")
    print(("Verified" if args.check else "Generated") + f" {len(result)} static vocabulary files.")
    print(json.dumps(result["catalog.json"]["coverage"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
