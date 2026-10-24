#!/usr/bin/env python3
"""Generate panel/font-language-coverage.json from the local fontconfig database.

The extension only needs a compact family -> language map. Fontconfig already
exposes the language coverage it derived from each font's cmap, so this script
avoids parsing every font binary at runtime.

Requires Linux + fontconfig (`fc-list`). The generated JSON is committed, so
other platforms still get coverage for common families through COMMON_LATIN.
"""

from __future__ import annotations

import json
import re
import subprocess
import unicodedata
from pathlib import Path

WANT = ["fr", "pt", "es", "de", "it", "nl", "pl", "tr", "ru", "ar", "fa", "ur", "he", "hi", "th", "vi", "id", "zh-Hans", "zh-Hant", "en", "ja", "ko"]
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "panel" / "font-language-coverage.json"

# Common families that may not be installed on the Linux host used to generate
# the database. These are broad Latin fonts; all support the four languages.
COMMON_LATIN = [
    "Arial",
    "Arial Narrow",
    "Helvetica",
    "Helvetica Neue",
    "Times New Roman",
    "Times",
    "Georgia",
    "Verdana",
    "Calibri",
    "Cambria",
    "Segoe UI",
    "SF Pro",
    "SF Pro Text",
    "Roboto",
    "Open Sans",
    "Lato",
    "Montserrat",
    "Inter",
]


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def main() -> None:
    try:
        raw = subprocess.check_output(
            ["fc-list", "--format=%{family}\t%{fullname}\t%{postscriptname}\t%{lang}\n"],
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"fc-list is required: {exc}")

    db: dict[str, set[str]] = {}
    faces = 0
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) != 4:
            continue
        family, fullname, postscript, langstr = parts
        tokens = set(langstr.split("|"))
        supported = []
        for lang in WANT:
            if lang == "zh-Hans":
                if any(token == "zh" or token in {"zh-cn", "zh-sg", "zh-my"} or token.startswith("zh-hans") for token in tokens):
                    supported.append(lang)
            elif lang == "zh-Hant":
                if any(token in {"zh-tw", "zh-hk", "zh-mo"} or token.startswith("zh-hant") for token in tokens):
                    supported.append(lang)
            elif lang in tokens:
                supported.append(lang)
        if not supported:
            continue
        faces += 1
        aliases = []
        for field in (family, fullname):
            aliases.extend(alias.strip() for alias in field.split(",") if alias.strip())
        aliases.append(postscript.strip())
        for alias in aliases:
            raw = alias.strip().lower()
            if raw:
                db.setdefault(raw, set()).update(supported)
            key = normalize(alias)
            if len(key) >= 3:
                db.setdefault(key, set()).update(supported)

    for family in COMMON_LATIN:
        key = normalize(family)
        if key:
            db.setdefault(key, set()).update(["en", "fr", "pt", "es", "de", "it", "nl", "pl", "tr", "ru"])

    out = {key: [lang for lang in WANT if lang in value] for key, value in sorted(db.items())}
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {OUT} ({len(out)} keys, {faces} font faces)")


if __name__ == "__main__":
    main()
