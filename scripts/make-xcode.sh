#!/bin/sh
# Regenerate the Safari Xcode project in xcode/ (git-ignored) and fix the
# bundle IDs. The converter capitalizes the app's ID from --app-name
# (io.tirth.Margin) while the extension keeps io.tirth.margin.Extension, and
# Xcode rejects an extension whose ID isn't prefixed by the app's.
# Wraps dist/safari/ (the Safari build; refresh it with `npm run build`).
set -eu
cd "$(dirname "$0")/.."

[ -f dist/safari/manifest.json ] || { echo "dist/safari/ is missing: run npm run build" >&2; exit 1; }

APP_ID=io.tirth.margin
EXT_ID="$APP_ID.Extension"

rm -rf xcode
xcrun safari-web-extension-converter dist/safari \
  --project-location xcode --app-name Margin --bundle-identifier "$APP_ID" \
  --macos-only --swift --no-open

PBXPROJ=$(find xcode -name project.pbxproj -path '*.xcodeproj/*' | head -n 1)
APP_ID="$APP_ID" perl -pi -e '
  s/(PRODUCT_BUNDLE_IDENTIFIER = )"?[^;"]*?(\.Extension)?"?;/$1 . $ENV{APP_ID} . ($2 ? ".Extension" : "") . ";"/ie
' "$PBXPROJ"

# Margin's own app code over the converter's template (app/safari/): the
# set-up window (ViewController.swift, SwiftUI in the storyboard's window) and
# the extension handler that passes the extension's reports on to it. SwiftUI
# as written needs macOS 14 (Safari 27 needs far newer anyway).
APP_DIR=$(dirname "$PBXPROJ")/..
cp app/safari/ViewController.swift "$APP_DIR/Margin/ViewController.swift"
cp app/safari/SafariWebExtensionHandler.swift "$APP_DIR/Margin Extension/SafariWebExtensionHandler.swift"
perl -pi -e 's/MACOSX_DEPLOYMENT_TARGET = (?:1[0-3]|[0-9])(?:\.\d+)?;/MACOSX_DEPLOYMENT_TARGET = 14.0;/' "$PBXPROJ"

# The container app looks up the extension by ID (e.g. ViewController.swift),
# the extension handler the app (SafariWebExtensionHandler.swift).
grep -rl 'extensionBundleIdentifier\|marginAppIdentifier' xcode --include='*.swift' | while read -r f; do
  EXT_ID="$EXT_ID" APP_ID="$APP_ID" perl -pi -e 's/(extensionBundleIdentifier\s*=\s*")[^"]*(")/$1$ENV{EXT_ID}$2/; s/(marginAppIdentifier\s*=\s*")[^"]*(")/$1$ENV{APP_ID}$2/' "$f"
done

echo
echo "Bundle IDs:"
grep -h 'PRODUCT_BUNDLE_IDENTIFIER' "$PBXPROJ" | sort -u | sed 's/^[[:space:]]*/  /'
grep -rh 'extensionBundleIdentifier =\|marginAppIdentifier =' xcode --include='*.swift' | sed 's/^[[:space:]]*/  /'
echo
echo "Open: open \"$(dirname "$PBXPROJ")\""
