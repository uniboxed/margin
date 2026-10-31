#!/bin/sh
# Regenerate the Safari Xcode project in xcode/ (git-ignored) and fix the
# bundle IDs. The converter capitalizes the app's ID from --app-name
# (io.tirth.Margin) while the extension keeps io.tirth.margin.Extension, and
# Xcode rejects an extension whose ID isn't prefixed by the app's.
# Wraps dist/safari/ (the Safari build; refresh it with `npm run build`).
# Kept from before: xcode/.team (the team scripts/safari.sh signs with) and
# xcode/build (its build folder); the rest is made again.
set -eu
cd "$(dirname "$0")/.."

[ -f dist/safari/manifest.json ] || { echo "dist/safari/ is missing: run npm run build" >&2; exit 1; }

APP_ID=io.tirth.margin
EXT_ID="$APP_ID.Extension"

if [ -d xcode ]; then
  find xcode -mindepth 1 -maxdepth 1 ! -name .team ! -name build -exec rm -rf {} +
fi
xcrun safari-web-extension-converter dist/safari \
  --project-location xcode --app-name Margin --bundle-identifier "$APP_ID" \
  --macos-only --swift --no-open

# Xcode 27.2's converter makes a project.xcproj (Xcode's own format, the
# settings once per target); before it, a project.pbxproj (once per target and
# configuration). The edits below are written for both.
PROJECT=$(find xcode -path '*.xcodeproj/project.*' \( -name project.xcproj -o -name project.pbxproj \) | head -n 1)
[ -n "$PROJECT" ] || { echo "make-xcode.sh: the converter made no project" >&2; exit 1; }
APP_ID="$APP_ID" perl -pi -e '
  s/(PRODUCT_BUNDLE_IDENTIFIER = )"?[^;"]*?(\.Extension)?"?;/$1 . $ENV{APP_ID} . ($2 ? ".Extension" : "") . ";"/ie;
  s/("PRODUCT_BUNDLE_IDENTIFIER": ")[^"]*?(\.Extension)?"/$1 . $ENV{APP_ID} . ($2 ? ".Extension" : "") . "\""/ie;
' "$PROJECT"

# Margin's own app code over the converter's template (app/safari/): the
# set-up window (ViewController.swift, SwiftUI in the storyboard's window) and
# the extension handler that passes the extension's reports on to it. SwiftUI
# as written needs macOS 14 (Safari 27 needs far newer anyway).
APP_DIR=$(dirname "$PROJECT")/..
cp app/safari/ViewController.swift "$APP_DIR/Margin/ViewController.swift"
cp app/safari/SafariWebExtensionHandler.swift "$APP_DIR/Margin Extension/SafariWebExtensionHandler.swift"
perl -pi -e 's/(MACOSX_DEPLOYMENT_TARGET"?(?: = |: "))(?:1[0-3]|[0-9])(?:\.\d+)?\b/${1}14.0/' "$PROJECT"

# The container app looks up the extension by ID (e.g. ViewController.swift),
# the extension handler the app (SafariWebExtensionHandler.swift).
grep -rl 'extensionBundleIdentifier\|marginAppIdentifier' "$APP_DIR" --include='*.swift' | while read -r f; do
  EXT_ID="$EXT_ID" APP_ID="$APP_ID" perl -pi -e 's/(extensionBundleIdentifier\s*=\s*")[^"]*(")/$1$ENV{EXT_ID}$2/; s/(marginAppIdentifier\s*=\s*")[^"]*(")/$1$ENV{APP_ID}$2/' "$f"
done

echo
echo "Bundle IDs:"
grep -h 'PRODUCT_BUNDLE_IDENTIFIER' "$PROJECT" | sort -u | sed 's/^[[:space:]]*/  /'
grep -rh 'extensionBundleIdentifier =\|marginAppIdentifier =' "$APP_DIR" --include='*.swift' | sed 's/^[[:space:]]*/  /'
echo
echo "Open: open \"$(dirname "$PROJECT")\""
