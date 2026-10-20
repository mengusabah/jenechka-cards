"""Deterministic, recorded quality decisions for the prebuilt vocabulary."""
import copy
import re
import unicodedata


def clean_card_text(text):
    """Remove annotations, including nested/fullwidth brackets, from study faces.

    The original sense, grammatical tags and dictionary spelling remain in the
    frozen source inputs. User-created or edited decks never pass through here.
    """
    openings = {"(": ")", "（": "）", "[": "]", "［": "］", "【": "】"}
    closing = set(openings.values())
    stack, result = [], []
    for char in unicodedata.normalize("NFC", text):
        if char in openings:
            stack.append(openings[char])
        elif char in closing:
            if stack and char == stack[-1]:
                stack.pop()
        elif not stack:
            result.append(char)
    return re.sub(r"\s+", " ", "".join(result)).strip(" \t;,")


def excluded_concept_reason(concept):
    meaning = concept["meaning"].strip().lower()
    # Alphabet names are valid dictionary senses but become misleading word
    # cards (notably Turkish ne -> English en, the name of the letter N).
    if re.search(r"\b(?:name (?:of|for) (?:the )?|(?:first|second|third|fourth|fifth) )?letter (?:of|in) (?:the )?.*(?:alphabet|script)", meaning):
        return "Alphabet-name sense, unsuitable for the word library."
    if re.search(r"\bname (?:of|for) (?:the )?(?:cyrillic )?letter\b", meaning):
        return "Alphabet-name sense, unsuitable for the word library."
    if re.match(r"^(?:abbreviation|acronym|initialism|misspelling|misconstruction|eye dialect|obsolete spelling|archaic spelling|nonstandard spelling|alternative spelling|inflection|conjugation|plural) of\b", meaning):
        return "Reference-only spelling/inflection record, not a standalone meaning."
    return None


def apply_reviews(concepts, asian_rows, russian_rows, reviews):
    """Apply exact-ID decisions; fail on source drift rather than guess."""
    audit = {"excludedConcepts": [], "excludedRecords": [], "appliedRules": [],
             "conceptOverrides": [], "emptyForms": [], "cleanedFaces": 0}
    excluded = {}
    asian = {row["id"]: row for row in asian_rows}
    russian = {row["id"]: row for row in russian_rows}
    for review in reviews:
        for row in review.get("excludedConcepts", []):
            key = row if isinstance(row, str) else row.get("conceptId", row.get("id"))
            excluded[key] = row.get("reason", "Reviewed exclusion") if isinstance(row, dict) else "Reviewed exclusion"
        for row in review.get("excludedRecords", []):
            key = row if isinstance(row, str) else row.get("conceptId", row.get("id"))
            excluded[key] = row.get("reason", "Reviewed exclusion") if isinstance(row, dict) else "Reviewed exclusion"
        for override in review.get("conceptOverrides", []):
            concept = concepts[override["conceptId"]]
            assert concept["pos"] == override["originalPartOfSpeech"], "Reviewed POS changed."
            concept["pos"] = override["partOfSpeech"]
            audit["conceptOverrides"].append(override)
        for rule in review.get("rules", []):
            key, language = rule["conceptId"], rule["language"]
            replacement = rule.get("replacementText")
            if key in concepts:
                concept = concepts[key]
                form = concept["forms"].get(language)
                # A previous independently recorded exclusion may remove it.
                if form is None:
                    continue
                original = rule.get("originalText", rule.get("sourceText"))
                if form["text"] != original:
                    # The small original form-review layer may already have
                    # made this exact correction.
                    if form["text"] == replacement:
                        continue
                    raise AssertionError(f"Reviewed form changed: {key}/{language}: {form['text']!r} != {original!r}")
                if replacement is None:
                    del concept["forms"][language]
                else:
                    new_form = copy.deepcopy(rule.get("replacementForm", form))
                    new_form["text"] = replacement
                    new_form.pop("studyText", None)
                    if "replacementTags" in rule:
                        new_form["tags"] = rule["replacementTags"]
                    if rule.get("clearSourceQualifier"):
                        new_form.pop("sourceQualifier", None)
                    provenance = rule.get("provenance", rule.get("replacementProvenance", rule.get("selection", "")))
                    if "editorial" in provenance:
                        new_form["editorialCorrection"] = True
                    concept["forms"][language] = new_form
            elif key in asian or key in russian:
                row = asian.get(key, russian.get(key))
                field = "gloss" if language == "en" else "lemma"
                assert row[field] == rule["originalText"], f"Reviewed dictionary row changed: {key}"
                if replacement is None:
                    excluded[key] = rule["reason"]
                else:
                    row[field] = replacement
                    if "replacementTags" in rule:
                        row["tags"] = rule["replacementTags"]
                    provenance = rule.get("provenance", rule.get("replacementProvenance", rule.get("selection", "")))
                    if "editorial" in provenance:
                        row["editorialCorrection"] = True
            else:
                raise AssertionError(f"Unknown reviewed ID: {key}")
            audit["appliedRules"].append({
                "conceptId": key, "language": language, "replacementText": replacement,
                "reason": rule["reason"],
            })
    for key, concept in concepts.items():
        reason = excluded.get(key) or excluded_concept_reason(concept)
        if reason:
            audit["excludedConcepts"].append({"conceptId": key, "reason": reason})
        for language, form in list(concept["forms"].items()):
            text = clean_card_text(form["text"])
            if not text:
                del concept["forms"][language]
                audit["emptyForms"].append({"conceptId": key, "language": language})
            elif text != form["text"] or form.get("studyText") or form.get("tags"):
                audit["cleanedFaces"] += 1
    excluded.update({row["conceptId"]: row["reason"] for row in audit["excludedConcepts"]})
    for row in [*asian_rows, *russian_rows]:
        if not clean_card_text(row["lemma"]) or not clean_card_text(row["gloss"]):
            excluded[row["id"]] = "No lexical content remains after annotation removal."
        if row["id"] in excluded:
            audit["excludedRecords"].append({"conceptId": row["id"], "reason": excluded[row["id"]]})
    return excluded, audit
