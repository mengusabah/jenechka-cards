#!/usr/bin/env python3
"""Freeze the openly licensed Octanove English C1/C2 headword/POS supplement."""
import csv
import hashlib
import io
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
COMMIT = "d4e45b75b38f27b30dfc5c44d8c571aec7e7092f"
URL = f"https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/{COMMIT}/octanove-vocabulary-profile-c1c2-1.0.csv"
SHA256 = "18c33a407f2f89f7b8de9671c6d45fe3ea0bce45e7d2d7dcaab48d73e0f7b380"

def main():
    raw = urllib.request.urlopen(URL, timeout=120).read()
    assert hashlib.sha256(raw).hexdigest() == SHA256
    rows = []
    seen = set()
    for row in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
        key = (row["headword"].strip(), row["pos"].strip(), row["CEFR"].strip())
        assert key[2] in {"C1", "C2"}
        if key in seen:
            continue
        seen.add(key)
        rows.append(dict(zip(["lemma", "pos", "level"], key)))
    source = {
        "id": "octanove", "name": "Octanove English Vocabulary Profile C1–C2 1.0",
        "url": "https://github.com/openlanguageprofiles/olp-en-cefrj",
        "license": "CC-BY-SA-4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
        "attribution": "Octanove Labs; distributed by Open Language Profiles.",
        "methodology": "Source-assigned English C1/C2 headword and part-of-speech classifications, joined only to exact English dictionary lemma/POS matches. Conflicting levels and unmatched POS are omitted. These are the publisher's supplementary classifications, not official CEFR certification of individual dictionary senses. No classification is transferred to translations or other languages.",
        "version": "1.0; repository " + COMMIT,
        "inputUrl": URL, "sha256": SHA256,
    }
    value = {"sources": [source], "english": rows}
    (ROOT / "vocabulary/source-data/levels.json").write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {len(rows)} source-assigned English C1/C2 rows.")

if __name__ == "__main__":
    main()
