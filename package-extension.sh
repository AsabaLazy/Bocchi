#!/bin/bash
# package-extension.sh — Creates a clean ZIP for Chrome Web Store submission

set -e

EXTENSION_NAME="bocchi-privacy-shield"
VERSION=$(node -p "require('./manifest.json').version")
OUTPUT="${EXTENSION_NAME}-v${VERSION}.zip"

# Remove old package
rm -f "$OUTPUT"

if command -v zip >/dev/null 2>&1; then
  zip -r "$OUTPUT" . \
    -x ".git/*" \
    -x ".agents/*" \
    -x "node_modules/*" \
    -x "_metadata/*" \
    -x "tests/*" \
    -x "__tests__/*" \
    -x "store-assets/*" \
    -x ".*" \
    -x "*.env" \
    -x "*.map" \
    -x "*.test.*" \
    -x "*.spec.*" \
    -x "*.zip" \
    -x "*.sh" \
    -x "package.json" \
    -x "CHROMEWEBSTORE.md" \
    -x "README.md" \
    -x "CHANGELOG.md" \
    -x "skills-lock.json" \
    -x "docs/*"
elif command -v python3 >/dev/null 2>&1; then
  python3 - <<EOF
import os, zipfile, json

manifest = json.load(open('manifest.json'))
version = manifest.get('version', '1.0.0')
output = f"bocchi-privacy-shield-v{version}.zip"

exclude_dirs = {'node_modules', 'tests', '__tests__', 'store-assets', '_metadata', '.agents', '.git', 'docs'}
exclude_files = {'CHROMEWEBSTORE.md', 'README.md', 'CHANGELOG.md', 'skills-lock.json', 'package.json', '.DS_Store', 'Thumbs.db', '.env', '.gitignore', output}

with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in exclude_dirs]
        for f in files:
            if f.startswith('.') or f.endswith(('.sh', '.map', '.test.js', '.spec.js', '.zip')) or f in exclude_files:
                continue
            full_path = os.path.join(root, f)
            arcname = os.path.relpath(full_path, '.')
            zf.write(full_path, arcname)
EOF
else
  echo "Error: Neither 'zip' nor 'python3' is available to package the extension."
  exit 1
fi

if [ -f "$OUTPUT" ]; then
  echo "Successfully packaged: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
else
  echo "Packaging failed: $OUTPUT not found."
  exit 1
fi

# ---------------------------------------------------------------------------
# PACKAGING VERIFY — regression assertions on the store zip contents.
# Background: v1.0.0 leaked docs/ARCHITECTURE.md into the store zip (fixed in
# v1.0.1). These assertions fail the build with details if that ever recurs.
# ---------------------------------------------------------------------------

# One entry per line. zipinfo -1 is the most stable listing form; unzip -Z1 is
# the same listing bundled with unzip, used as fallback.
if command -v zipinfo >/dev/null 2>&1; then
  ZIP_LISTING=$(zipinfo -1 "$OUTPUT")
elif command -v unzip >/dev/null 2>&1; then
  ZIP_LISTING=$(unzip -Z1 "$OUTPUT")
else
  echo "PACKAGING VERIFY FAILED: 'zipinfo' or 'unzip' required to inspect $OUTPUT"
  exit 1
fi

# File entries only: the `zip` branch also records directory entries (trailing
# "/"), which are not shipped files and must not affect the count in C.
FILE_ENTRIES=$(printf '%s\n' "$ZIP_LISTING" | grep -vx '.*/') || true
FILE_COUNT=$(printf '%s\n' "$FILE_ENTRIES" | grep -c .) || true

VERIFY_ERRORS=""

# Assertion A — no docs/ entries (direct regression guard for the v1.0.0 leak).
LEAK_DOCS=$(printf '%s\n' "$ZIP_LISTING" | grep -xE 'docs(/.*)?') || true
if [ -n "$LEAK_DOCS" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- [A] docs/ must not be packaged, found:
$LEAK_DOCS"
fi

# Assertion B — tests/, VCS files, package manifests and markdown stay out.
# The current build ships no *.md at all (README/CHANGELOG/CHROMEWEBSTORE are
# excluded by name and docs/ by directory), so a blanket *.md ban matches the
# script's intent.
LEAK_B=$(printf '%s\n' "$ZIP_LISTING" \
  | grep -xE 'tests(/.*)?|\.git(/.*)?|(^|.*/)\.gitignore|(^|.*/)package\.json|.*\.md') || true
if [ -n "$LEAK_B" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- [B] forbidden entries (tests/, .git/, .gitignore, package.json, *.md) found:
$LEAK_B"
fi

# Assertion C — the zip must contain exactly the expected shipped files.
# Expected set (known-good store build bocchi-privacy-shield-v1.0.1.zip):
#   manifest.json, background/service_worker.js, content/bridge.js,
#   content/stealth_engine.js, icons/icon-{16,48,128}.png,
#   panel/panel.{html,css,js}, popup/popup.{html,css,js}, rules/cyt_rules.json
#   => 14 files. Update this constant only when the shipped set intentionally
#   changes.
EXPECTED_FILE_COUNT=14
if [ "$FILE_COUNT" -ne "$EXPECTED_FILE_COUNT" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- [C] expected $EXPECTED_FILE_COUNT files in the zip, found $FILE_COUNT:
$FILE_ENTRIES"
fi

# Assertion D — version in the zip filename must equal manifest.json's version.
MANIFEST_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' manifest.json | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
ZIP_VERSION=$(printf '%s\n' "$OUTPUT" | sed -n 's/.*-v\([0-9][0-9]*\(\.[0-9][0-9]*\)*\)\.zip$/\1/p')
if [ -z "$MANIFEST_VERSION" ] || [ "$ZIP_VERSION" != "$MANIFEST_VERSION" ]; then
  VERIFY_ERRORS="$VERIFY_ERRORS
- [D] version mismatch: zip filename says 'v$ZIP_VERSION', manifest.json says '$MANIFEST_VERSION'"
fi

if [ -n "$VERIFY_ERRORS" ]; then
  echo "PACKAGING VERIFY FAILED:$VERIFY_ERRORS"
  exit 1
fi

echo "PACKAGING VERIFY OK ($FILE_COUNT files, v$MANIFEST_VERSION)"
