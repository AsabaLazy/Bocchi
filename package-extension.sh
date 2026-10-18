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
exclude_files = {'CHROMEWEBSTORE.md', 'README.md', 'CHANGELOG.md', 'skills-lock.json', '.DS_Store', 'Thumbs.db', '.env', '.gitignore', output}

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
