#!/bin/sh
# Regenerate the Safari Xcode project in xcode/ (git-ignored) and fix the
# bundle IDs. The converter capitalizes the app's ID from --app-name
# (io.tirth.Margin) while the extension keeps io.tirth.margin.Extension, and
# Xcode rejects an extension whose ID isn't prefixed by the app's.
set -eu
cd "$(dirname "$0")/.."

APP_ID=io.tirth.margin
EXT_ID="$APP_ID.Extension"

rm -rf xcode
xcrun safari-web-extension-converter extension \
  --project-location xcode --app-name Margin --bundle-identifier "$APP_ID" \
  --macos-only --swift --no-open

PBXPROJ=$(find xcode -name project.pbxproj -path '*.xcodeproj/*' | head -n 1)
APP_ID="$APP_ID" perl -pi -e '
  s/(PRODUCT_BUNDLE_IDENTIFIER = )"?[^;"]*?(\.Extension)?"?;/$1 . $ENV{APP_ID} . ($2 ? ".Extension" : "") . ";"/ie
' "$PBXPROJ"

# The container app looks up the extension by ID (e.g. ViewController.swift).
grep -rl 'extensionBundleIdentifier' xcode --include='*.swift' | while read -r f; do
  EXT_ID="$EXT_ID" perl -pi -e 's/(extensionBundleIdentifier\s*=\s*")[^"]*(")/$1$ENV{EXT_ID}$2/' "$f"
done

echo
echo "Bundle IDs:"
grep -h 'PRODUCT_BUNDLE_IDENTIFIER' "$PBXPROJ" | sort -u | sed 's/^[[:space:]]*/  /'
grep -rh 'extensionBundleIdentifier' xcode --include='*.swift' | sed 's/^[[:space:]]*/  /'
echo
echo "Open: open \"$(dirname "$PBXPROJ")\""
