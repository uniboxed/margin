#!/bin/sh
# Regenerate the Safari Xcode project in xcode/ (git-ignored) and fix the
# bundle IDs. The converter capitalizes the app's ID from --app-name
# (io.tirth.Margin) while the extension keeps io.tirth.margin.Extension, and
# Xcode rejects an extension whose ID isn't prefixed by the app's.
# Wraps dist/webkit/ (the Safari build; refresh it with `npm run build`), and
# gives the app its shell (app/macos/shell/: the link to the extension, the overlays
# around the browser's windows) and the overlays' page (dist/app/).
# Kept from before: xcode/.team (the team scripts/safari.sh signs with) and
# xcode/build (its build folder); the rest is made again.
set -eu
cd "$(dirname "$0")/.."

[ -f dist/webkit/manifest.json ] || { echo "dist/webkit/ is missing: run npm run build" >&2; exit 1; }
[ -f dist/app/overlay.html ] || { echo "dist/app/ is missing: run npm run build" >&2; exit 1; }

APP_ID=io.tirth.margin
EXT_ID="$APP_ID.Extension"

if [ -d xcode ]; then
  find xcode -mindepth 1 -maxdepth 1 ! -name .team ! -name build -exec rm -rf {} +
fi
xcrun safari-web-extension-converter dist/webkit \
  --project-location xcode --app-name Margin --bundle-identifier "$APP_ID" \
  --macos-only --swift --no-open

# Xcode 27.2's converter makes a project.xcproj (Xcode's own format, the
# settings once per target); before it, a project.pbxproj (once per target and
# configuration). The edits below are written for both.
PROJECT=$(find xcode -path '*.xcodeproj/project.*' \( -name project.xcproj -o -name project.pbxproj \) | head -n 1)
[ -n "$PROJECT" ] || { echo "make-xcode.sh: the converter made no project" >&2; exit 1; }
case "$PROJECT" in *.xcproj) EACH=1 ;; *) EACH=2 ;; esac
APP_ID="$APP_ID" perl -pi -e '
  s/(PRODUCT_BUNDLE_IDENTIFIER = )"?[^;"]*?(\.Extension)?"?;/$1 . $ENV{APP_ID} . ($2 ? ".Extension" : "") . ";"/ie;
  s/("PRODUCT_BUNDLE_IDENTIFIER": ")[^"]*?(\.Extension)?"/$1 . $ENV{APP_ID} . ($2 ? ".Extension" : "") . "\""/ie;
' "$PROJECT"

# The app (not the extension) without the App Sandbox (Developer ID, PLAN.md
# §6): it listens on 127.0.0.1 for the extension's link and, later, writes
# Chrome's and Edge's native-messaging host files. The extension keeps its
# sandbox (Safari requires it). The sandbox's own settings go with it, and the
# app links what the shell uses.
APP_ID="$APP_ID" perl -0pi -e '
  s{((?:buildSettings = |"build-settings": )\{.*?\n[\t ]*\})}{
    my $b = $1;
    if ($b =~ /PRODUCT_BUNDLE_IDENTIFIER"?(?: = |: ")\Q$ENV{APP_ID}\E[;"]/) {
      $b =~ s/(ENABLE_APP_SANDBOX"?(?: = |: "))YES/${1}NO/;
      # No Dock icon at launch (an agent app): started by the extension handler
      # for a link, it never flashes one; AppDelegate.swift gives it one while
      # the set-up window is open.
      $b =~ s/(\n([\t ]*)("?)INFOPLIST_KEY_NSPrincipalClass\3( = |: ")NSApplication("?)([;,]))/$1\n$2$3INFOPLIST_KEY_LSUIElement$3$4YES$5$6/
        unless $b =~ /LSUIElement/;
      $b =~ s/\n[\t ]*"?ENABLE_(?:USER_SELECTED_FILES|OUTGOING_NETWORK_CONNECTIONS)"?(?: = |: )[^\n]*//g;
      $b =~ s/(\n([\t ]*)("?)WebKit\3,\n)/$1$2"-framework",\n$2$3ApplicationServices$3,\n$2"-framework",\n$2$3Network$3,\n$2"-framework",\n$2$3ServiceManagement$3,\n/
        unless $b =~ /ServiceManagement/;
    }
    $b
  }gse
' "$PROJECT"
# The app's settings without (each configuration's, in a pbxproj), the extension's with.
count() { grep -Ec "$1" "$PROJECT" || true; }
[ "$(count 'ENABLE_APP_SANDBOX"?( = |: ")NO')" = $EACH ] && [ "$(count 'ENABLE_APP_SANDBOX"?( = |: ")YES')" = $EACH ] \
  && [ "$(count 'ENABLE_USER_SELECTED_FILES')" = $EACH ] && [ "$(count 'ENABLE_OUTGOING_NETWORK_CONNECTIONS')" = 0 ] \
  && [ "$(count 'ServiceManagement"?,')" = $EACH ] && [ "$(count 'INFOPLIST_KEY_LSUIElement"?( = |: ")YES')" = $EACH ] \
  || { echo "make-xcode.sh: the app's sandbox settings didn't come out as expected (has the converter's project changed?)" >&2; exit 1; }

# Margin's own app code over the converter's template (app/macos/startup/): the app
# (AppDelegate.swift: no Dock icon while its window is closed, and the shell),
# the set-up window (ViewController.swift, SwiftUI in the storyboard's window)
# and the extension handler that passes the extension's reports and link
# requests on to it. SwiftUI as written needs macOS 14 (Safari 27 needs far
# newer anyway). The shell's code and page are added to the app where they are
# in the repo (scripts/xcode-add-sources.py).
APP_DIR=$(dirname "$PROJECT")/..
cp app/macos/startup/AppDelegate.swift "$APP_DIR/Margin/AppDelegate.swift"
cp app/macos/startup/ViewController.swift "$APP_DIR/Margin/ViewController.swift"
cp app/engines/webkit/safari/handler/SafariWebExtensionHandler.swift "$APP_DIR/Margin Extension/SafariWebExtensionHandler.swift"
perl -pi -e 's/(MACOSX_DEPLOYMENT_TARGET"?(?: = |: "))(?:1[0-3]|[0-9])(?:\.\d+)?\b/${1}14.0/' "$PROJECT"
python3 scripts/xcode-add-sources.py "$PROJECT" .

# The container app looks up the extension by ID (e.g. ViewController.swift),
# the extension handler the app (SafariWebExtensionHandler.swift).
grep -rl 'extensionBundleIdentifier\|marginAppIdentifier' "$APP_DIR" --include='*.swift' | while read -r f; do
  EXT_ID="$EXT_ID" APP_ID="$APP_ID" perl -pi -e 's/(extensionBundleIdentifier\s*=\s*")[^"]*(")/$1$ENV{EXT_ID}$2/; s/(marginAppIdentifier\s*=\s*")[^"]*(")/$1$ENV{APP_ID}$2/' "$f"
done

echo
echo "Bundle IDs:"
grep -h 'PRODUCT_BUNDLE_IDENTIFIER' "$PROJECT" | sort -u | sed 's/^[[:space:]]*/  /'
grep -rh 'extensionBundleIdentifier =\|marginAppIdentifier =' "$APP_DIR" --include='*.swift' | sed 's/^[[:space:]]*/  /'
echo "App Sandbox: the app off, the extension on."
echo
echo "Open: open \"$(dirname "$PROJECT")\""
