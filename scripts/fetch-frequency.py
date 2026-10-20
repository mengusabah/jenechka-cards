#!/usr/bin/env python3
"""Reproduce the pinned raw-token frequency input; no runtime dependency.

Run from any directory:
    python3 scripts/fetch-frequency.py
    python3 scripts/fetch-frequency.py --check

Only the first 1,000 lines of each source file are read. SHA-256 values cover
those exact UTF-8 bytes, including LF line endings, not the complete upstream
files. No raw downloads are saved. --check validates the local result offline.
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request


COMMIT = "525f9b560de45753a5ea01069454e72e9aa541c6"
LIMIT = 1000
BASE_URL = (
    "https://raw.githubusercontent.com/hermitdave/FrequencyWords/"
    + COMMIT
    + "/content/2018/"
)
OUTPUT = Path(__file__).resolve().parent.parent / "vocabulary/source-data/frequency.json"

# The language codes match the app. Chinese uses the upstream zh_cn dataset.
# Dictionary forms, translations, and CEFR classifications are separate inputs.
PREFIX_SHA256 = {
    "en": "f82063bc48fc4cc73f67fa9b88236618a4d8df58c67190b1a01c957e87d245c5",
    "tr": "1fd3712bc745c92e84a0f1ce6f7d16d4a96aca2d40cd9d21ceea213ac4174868",
    "de": "0152ffe34e24bcc6baf03f2a2b69490d45a6fff1636533937e39b131bb1acc4b",
    "es": "e9042b387b60452986364097aa1c4af12b8188e5472a73b6b506d1f15b5731e3",
    "fr": "a4c5776c9c8fc2a92bbcfd076a239659ebbf349af7e7a0138edac4318695e687",
    "it": "62513fd8630c32ce51ea81a74a706e440796c8cfffcd98c9e17d731d964ee37e",
    "ru": "412503feea6a28782f02cceab4e5c583f708d62f509e0594224ae277c776e455",
    "pt": "2bffbe902e3d8fcd02022fa63457f4a8683fca264a0da4e6f38e75d939ea6ecf",
    "zh": "005ad7ae1b15dd27651d29ac68ec88d4d0de296e5fdbc558dbf5993248fdb52e",
    "ja": "b135ba4748ce6a646df67fe3cadbfed820388978eaef53c3b873209d0ad5fa97",
    "ko": "4eec81b16a94beaff79ffe65010feaf8723da525cdb8ec57f729725b7f7c8b5c",
    "ar": "6af1f6c559dd45d8f50bf36acc3993a132017c68a52dc70e1c127be6e941d8db",
    "nl": "902f61046571356cc1228ddfdb3308639dbfff29b62cdec4a2b85c9f455a26df",
}


def source_url(language):
    code = "zh_cn" if language == "zh" else language
    filename = code + ("_full.txt" if language == "ja" else "_50k.txt")
    return BASE_URL + code + "/" + filename


def source_metadata():
    return {
        "id": "frequencywords",
        "name": "FrequencyWords — OpenSubtitles 2018",
        "url": "https://github.com/hermitdave/FrequencyWords/tree/" + COMMIT,
        "license": "CC BY-SA 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
        "attribution": (
            "FrequencyWords by Hermit Dave; derived from OPUS OpenSubtitles "
            "2018 and OpenSubtitles.org. Content is licensed CC BY-SA 4.0. "
            "Jenechka Cards extracts the first 1,000 original rows per language "
            "and converts them to JSON without changing their order or counts."
        ),
        "methodology": (
            "Original corpus token counts, not lemma or sense frequencies. "
            "rank is the one-based upstream row number. Punctuation, fragments, "
            "foreign words, and inflected forms are deliberately retained; "
            "nothing is filtered, normalized, lemmatized, or re-ranked here. "
            "Chinese uses zh_cn; Portuguese uses pt, not pt_br. These data do "
            "not establish CEFR levels or verified translations. A downstream "
            "lexicon match must preserve the original rank and report partial "
            "coverage instead of relabeling a subset as a complete Top N deck."
        ),
        "version": "2018@" + COMMIT,
        "corpusUrl": "http://opus.nlpl.eu/OpenSubtitles2018.php",
        "originalProjectUrl": "https://www.opensubtitles.org/",
        "inputHashScope": "Exact first 1000 UTF-8 lines, including LF line endings.",
    }


def fetch_language(language):
    chunks = []
    request = urllib.request.Request(
        source_url(language), headers={"User-Agent": "Jenechka-Cards-data-builder/1.0"}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        for rank in range(1, LIMIT + 1):
            line = response.readline(65537)
            if not line or len(line) > 65536 or not line.endswith(b"\n"):
                raise ValueError("%s: missing or oversized source row %s" % (language, rank))
            chunks.append(line)
    raw = b"".join(chunks)
    digest = hashlib.sha256(raw).hexdigest()
    if digest != PREFIX_SHA256[language]:
        raise ValueError("%s: upstream prefix SHA-256 mismatch" % language)
    rows = []
    for rank, raw_line in enumerate(chunks, start=1):
        word, count = raw_line.decode("utf-8").removesuffix("\n").rsplit(" ", 1)
        rows.append({"word": word, "rank": rank, "count": int(count)})
    return language, rows, {
        "url": source_url(language),
        "sha256": digest,
        "bytes": len(raw),
        "rows": LIMIT,
    }


def verify(data):
    source = data["source"]
    for key, value in source_metadata().items():
        if source.get(key) != value:
            raise ValueError("Unexpected source metadata: " + key)
    if set(data["languages"]) != set(PREFIX_SHA256) or set(source["inputs"]) != set(PREFIX_SHA256):
        raise ValueError("Expected exactly the 13 supported languages")
    for language, expected_hash in PREFIX_SHA256.items():
        rows = data["languages"][language]
        if len(rows) != LIMIT:
            raise ValueError("%s: expected %s rows" % (language, LIMIT))
        words = set()
        previous_count = None
        reconstructed = []
        for rank, row in enumerate(rows, start=1):
            word, count = row["word"], row["count"]
            if set(row) != {"word", "rank", "count"} or type(row["rank"]) is not int or row["rank"] != rank:
                raise ValueError("%s: invalid raw rank %s" % (language, rank))
            if not isinstance(word, str) or not word or word in words:
                raise ValueError("%s: missing or duplicate token at %s" % (language, rank))
            if type(count) is not int or count <= 0 or (previous_count is not None and count > previous_count):
                raise ValueError("%s: invalid count order at %s" % (language, rank))
            words.add(word)
            previous_count = count
            reconstructed.append(("%s %s\n" % (word, count)).encode("utf-8"))
        raw = b"".join(reconstructed)
        expected_input = {
            "url": source_url(language),
            "sha256": expected_hash,
            "bytes": len(raw),
            "rows": LIMIT,
        }
        if hashlib.sha256(raw).hexdigest() != expected_hash or source["inputs"][language] != expected_input:
            raise ValueError("%s: data do not reconstruct the pinned source prefix" % language)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT, help="Generated JSON path")
    parser.add_argument("--check", action="store_true", help="Validate the existing JSON without network or writes")
    args = parser.parse_args()
    if args.check:
        verify(json.loads(args.output.read_text(encoding="utf-8")))
        print("Verified: 13 languages, 13,000 original rows, all pinned SHA-256 values.")
        return
    data = {"source": source_metadata(), "languages": {}}
    data["source"]["inputs"] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for language, rows, metadata in pool.map(fetch_language, PREFIX_SHA256):
            data["languages"][language] = rows
            data["source"]["inputs"][language] = metadata
    verify(data)
    encoded = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=args.output.parent, suffix=".tmp", delete=False) as file:
            temporary = file.name
            file.write(encoded)
        os.replace(temporary, args.output)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    print("Wrote %s: 13 languages, 13,000 original rows, %s bytes." % (args.output, len(encoded)))


if __name__ == "__main__":
    main()
