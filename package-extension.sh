#!/bin/bash
# package-extension.sh — Creates a clean ZIP for distribution.
#
# The shipped file set is an explicit allowlist (not "everything except ..."),
# so a new test/doc/asset cannot leak into the distribution zip merely because
# it was not added to an exclusion list. The same list drives the zip branch,
# the python fallback and the post-build verification.

set -euo pipefail

EXTENSION_NAME="bocchi"

# Exact shipped-file allowlist. Update this list (and nothing else) when the
# runtime bundle intentionally changes. panel/font-language-coverage.json is a
# runtime asset used by the panel and MUST stay packaged.
EXPECTED_FILES=(
  "manifest.json"
  "background/service_worker.js"
  "content/bridge.js"
  "content/stealth_engine.js"
  "icons/icon-16.png"
  "icons/icon-48.png"
  "icons/icon-128.png"
  "panel/panel.html"
  "panel/panel.css"
  "panel/panel.js"
  "panel/world-map.js"
  "panel/city-names.json"
  "panel/font-language-coverage.json"
  "popup/popup.html"
  "popup/popup.css"
  "popup/popup.js"
  "rules/cyt_rules.json"
)
EXPECTED_FILE_COUNT=${#EXPECTED_FILES[@]}

VERIFY_ERRORS=""

# ---------------------------------------------------------------------------
# Pre-build version consistency: manifest.json, package.json and the newest
# CHANGELOG heading must all agree. Deriving the output name from manifest and
# then "verifying" it against itself (the old assertion D) proved nothing.
# ---------------------------------------------------------------------------
MANIFEST_VERSION=$(node -p "require('./manifest.json').version")
PACKAGE_VERSION=$(node -p "require('./package.json').version")
CHANGELOG_VERSION=$(sed -n 's/^##[[:space:]]*\([0-9][0-9]*\(\.[0-9][0-9]*\)*\).*/\1/p' CHANGELOG.md | head -n 1)

if [ -z "$MANIFEST_VERSION" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- manifest.json has no version"
fi
if [ -z "$PACKAGE_VERSION" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- package.json has no version"
fi
if [ -z "$CHANGELOG_VERSION" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- CHANGELOG.md has no '## <version>' heading"
fi
if [ -n "$MANIFEST_VERSION" ] && [ "$MANIFEST_VERSION" != "$PACKAGE_VERSION" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- version mismatch: manifest.json=$MANIFEST_VERSION, package.json=$PACKAGE_VERSION"
fi
if [ -n "$MANIFEST_VERSION" ] && [ "$MANIFEST_VERSION" != "$CHANGELOG_VERSION" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- version mismatch: manifest.json=$MANIFEST_VERSION, CHANGELOG.md=$CHANGELOG_VERSION"
fi

# Every allowlisted file must exist before we build anything.
MISSING_FILES=""
for file in "${EXPECTED_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    MISSING_FILES="$MISSING_FILES
  $file"
  fi
done
if [ -n "$MISSING_FILES" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- allowlisted files missing:$MISSING_FILES"
fi

if [ -n "$VERIFY_ERRORS" ]; then
  echo "PACKAGING PREFLIGHT FAILED:$VERIFY_ERRORS"
  exit 1
fi

OUTPUT="${EXTENSION_NAME}-v${MANIFEST_VERSION}.zip"
rm -f "$OUTPUT"

# ---------------------------------------------------------------------------
# Build. Both branches write exactly EXPECTED_FILES, in the same order.
# ---------------------------------------------------------------------------
if command -v zip >/dev/null 2>&1; then
  zip -q -X "$OUTPUT" "${EXPECTED_FILES[@]}"
elif command -v python3 >/dev/null 2>&1; then
  EXPECTED_FILES_NL=$(printf '%s\n' "${EXPECTED_FILES[@]}")
  OUTPUT="$OUTPUT" EXPECTED_FILES_NL="$EXPECTED_FILES_NL" python3 - <<'PY'
import os
import zipfile

output = os.environ["OUTPUT"]
files = [line for line in os.environ["EXPECTED_FILES_NL"].splitlines() if line]

with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
    for name in files:
        zf.write(name, name)
PY
else
  echo "Error: Neither 'zip' nor 'python3' is available to package the extension."
  exit 1
fi

if [ ! -f "$OUTPUT" ]; then
  echo "Packaging failed: $OUTPUT not found."
  exit 1
fi

# ---------------------------------------------------------------------------
# Post-build verification: the archive must contain EXACTLY the allowlist.
# Comparing the full sorted file set (not just a count) catches both leaked
# files and silently dropped runtime assets.
# ---------------------------------------------------------------------------
if command -v zipinfo >/dev/null 2>&1; then
  ZIP_LISTING=$(zipinfo -1 "$OUTPUT")
elif command -v unzip >/dev/null 2>&1; then
  ZIP_LISTING=$(unzip -Z1 "$OUTPUT")
else
  echo "PACKAGING VERIFY FAILED: 'zipinfo' or 'unzip' required to inspect $OUTPUT"
  exit 1
fi

# File entries only (defensive: versions of zip can record directory entries).
FILE_ENTRIES=$(printf '%s\n' "$ZIP_LISTING" | grep -vx '.*/' || true)
FILE_COUNT=$(printf '%s\n' "$FILE_ENTRIES" | grep -c . || true)

ACTUAL_SORTED=$(printf '%s\n' "$FILE_ENTRIES" | sed '/^$/d' | sort)
EXPECTED_SORTED=$(printf '%s\n' "${EXPECTED_FILES[@]}" | sort)

if [ "$ACTUAL_SORTED" != "$EXPECTED_SORTED" ]; then
  MISSING_FROM_ZIP=$(comm -23 <(printf '%s\n' "$EXPECTED_SORTED") <(printf '%s\n' "$ACTUAL_SORTED") || true)
  UNEXPECTED_IN_ZIP=$(comm -13 <(printf '%s\n' "$EXPECTED_SORTED") <(printf '%s\n' "$ACTUAL_SORTED") || true)
  if [ -n "$MISSING_FROM_ZIP" ]; then
    VERIFY_ERRORS="$VERIFY_ERRORS
- missing from zip:
$MISSING_FROM_ZIP"
  fi
  if [ -n "$UNEXPECTED_IN_ZIP" ]; then
    VERIFY_ERRORS="$VERIFY_ERRORS
- unexpected entries in zip:
$UNEXPECTED_IN_ZIP"
  fi
  VERIFY_ERRORS="$VERIFY_ERRORS
- expected $EXPECTED_FILE_COUNT files, found $FILE_COUNT"
fi

# The archive filename must carry the validated manifest version.
ZIP_VERSION=$(printf '%s\n' "$OUTPUT" | sed -n 's/.*-v\([0-9][0-9]*\(\.[0-9][0-9]*\)*\)\.zip$/\1/p')
if [ -z "$ZIP_VERSION" ] || [ "$ZIP_VERSION" != "$MANIFEST_VERSION" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- output filename version '$ZIP_VERSION' != manifest.json version '$MANIFEST_VERSION'"
fi

if [ -n "$VERIFY_ERRORS" ]; then
  echo "PACKAGING VERIFY FAILED:$VERIFY_ERRORS"
  exit 1
fi

echo "Successfully packaged: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "PACKAGING VERIFY OK ($FILE_COUNT files, v$MANIFEST_VERSION)"
