#!/bin/sh
# Build Margin for Safari, sign it with your Apple Developer team, and install
# it as ~/Applications/Margin.app, registered with Safari: `npm run safari`.
# Signed, Safari keeps it on (and its data) across relaunches, and a new build
# over it is an update: no removing the old one, nothing to turn on again.
# (Unsigned, Safari turns it off at every launch and needs "Allow Unsigned
# Extensions" again.)
#
# The team: MARGIN_TEAM, else xcode/.team (one line, the team ID), else the
# first team Xcode knows (Xcode → Settings → Accounts: add your Apple ID; a
# free Personal Team works). `--unsigned`: build anyway, ad-hoc signed.
# Signed otherwise than the installed copy (another team, or --unsigned over
# a signed one), it warns that named profiles' spaces start fresh and asks
# first (scripts/signing-check.sh); `--yes` goes on without asking.
#
# `--no-install`: build and sign only, install nothing; the last line printed is
# the built Margin.app's path (the release workflow, .github/workflows/release.yml).
# MARGIN_SIGN_IDENTITY (a Developer ID Application identity in the keychain, with
# MARGIN_TEAM): signed with it instead of the team's automatic signing, with
# secure timestamps, as notarization needs.
set -eu
cd "$(dirname "$0")/.."

APP_ID=io.tirth.margin
DEST="$HOME/Applications/Margin.app"
DERIVED="$PWD/xcode/build"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

UNSIGNED=false
YES=false
INSTALL=true
for arg in "$@"; do
  case "$arg" in
    --unsigned) UNSIGNED=true ;;
    --yes) YES=true ;;
    --no-install) INSTALL=false ;;
  esac
done
IDENTITY_NAME="${MARGIN_SIGN_IDENTITY:-}"
# Secure timestamps for a Developer ID build (notarization refuses a signature without one); none otherwise.
if [ -n "$IDENTITY_NAME" ] && [ "$UNSIGNED" = false ]; then TIMESTAMP=--timestamp; else TIMESTAMP=--timestamp=none; fi

npm run build
# The project again when what makes it isn't what it was made from: the app's
# code (app/platforms/macos/startup/) or this script's partner (make-xcode.sh) changed, or
# another branch made it (its project can list files this one doesn't have),
# or dist/webkit/ or one of the app's Swift folders has a file more or less: the project lists each
# of their files (a new one isn't copied or built into the app until the
# project is made again: the sleep page, 2026-11-04, sent tabs to a page the
# app didn't have). What's in those files is copied in or built by each
# build, so changes there need no new project. xcode/.team stays.
MADE_FROM="xcode/.made-from"
# (The app's Swift folders: app/platforms/macos/swift-sources.txt, each folder's own *.swift.)
SWIFT_FOLDERS=$(grep -v '^#' app/platforms/macos/swift-sources.txt | sed '/^$/d')
FROM=$({ find app/platforms/macos/startup app/engines/webkit/safari/handler app/platforms/macos/swift-sources.txt scripts/make-xcode.sh scripts/xcode-add-sources.py -type f | LC_ALL=C sort | xargs shasum; (cd dist/webkit && find . -type f | LC_ALL=C sort); for d in $SWIFT_FOLDERS; do find "$d" -maxdepth 1 -name '*.swift'; done | LC_ALL=C sort; } | shasum | cut -d' ' -f1)
if [ ! -d xcode/Margin/Margin.xcodeproj ] || [ "$(cat "$MADE_FROM" 2>/dev/null)" != "$FROM" ]; then
  sh scripts/make-xcode.sh
  echo "$FROM" > "$MADE_FROM"
fi

TEAM="${MARGIN_TEAM:-}"
[ -z "$TEAM" ] && [ -f xcode/.team ] && TEAM=$(tr -d '[:space:]' < xcode/.team)
if [ -z "$TEAM" ]; then
  TEAM=$(defaults export com.apple.dt.Xcode - 2>/dev/null | python3 -c '
import plistlib, sys
try:
    teams = plistlib.loads(sys.stdin.buffer.read()).get("IDEProvisioningTeamByIdentifier", {})
except Exception:
    teams = {}
ids = [t.get("teamID") for account in teams.values() for t in account if t.get("teamID")]
print(ids[0] if ids else "")
' 2>/dev/null || true)
fi
if [ -z "$TEAM" ] && [ "$UNSIGNED" = false ]; then
  cat >&2 <<'EOF'
No Apple Developer team to sign with. Once: open Xcode → Settings → Accounts,
add your Apple ID (a free Personal Team is enough), then run this again.
(Or put the team ID in xcode/.team, or MARGIN_TEAM=XXXXXXXXXX npm run safari;
`npm run safari -- --unsigned` builds unsigned, turned off at each launch.)
EOF
  exit 1
fi

# The installed copy signed otherwise: its named profiles' spaces would start fresh. Asked first.
if [ "$INSTALL" = true ]; then
  . scripts/signing-check.sh
  if [ "$UNSIGNED" = true ]; then NEW_TEAM="not set"; else NEW_TEAM="$TEAM"; fi
  confirm_signing "$DEST" "$NEW_TEAM" "$YES" || exit 1
fi

if [ "$UNSIGNED" = true ]; then
  SIGN="CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO DEVELOPMENT_TEAM="
  echo "Building unsigned (Safari turns it off at each launch)."
elif [ -n "$IDENTITY_NAME" ]; then
  # (No get-task-allow: Xcode adds it unless told not to, and notarization refuses a build that has it.)
  SIGN="DEVELOPMENT_TEAM=$TEAM CODE_SIGN_STYLE=Manual OTHER_CODE_SIGN_FLAGS=--timestamp CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO"
  echo "Signing with $IDENTITY_NAME (team $TEAM)."
else
  SIGN="DEVELOPMENT_TEAM=$TEAM CODE_SIGN_STYLE=Automatic"
  echo "Signing with team $TEAM."
fi

# shellcheck disable=SC2086
if [ -n "$IDENTITY_NAME" ] && [ "$UNSIGNED" = false ]; then
  xcodebuild -project xcode/Margin/Margin.xcodeproj -scheme Margin -configuration Release \
    -derivedDataPath "$DERIVED" -quiet $SIGN CODE_SIGN_IDENTITY="$IDENTITY_NAME" build
else
  xcodebuild -project xcode/Margin/Margin.xcodeproj -scheme Margin -configuration Release \
    -derivedDataPath "$DERIVED" -allowProvisioningUpdates -quiet $SIGN build
fi
BUILT="$DERIVED/Build/Products/Release/Margin.app"
# Chrome's and Edge's connector (app/shared/connector/, Rust; docs/PROTOCOL.md "Transport (Chrome and Edge, on the
# Mac)"): built for both kinds of Mac into Contents/Helpers with the app's version in it, signed as Margin's
# connector (io.tirth.margin.connector) with the identity the app was signed with, and the app signed again around
# it, its own settings kept. Margin.app lets only that connector in (app/platforms/macos/shell/RelayLink.swift). Before
# anything is installed: a failure here leaves the installed copy as it was.
HELPERS="$BUILT/Contents/Helpers"
CARGO="${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}"
APP_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$BUILT/Contents/Info.plist")
mkdir -p "$HELPERS"
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  MARGIN_APP_VERSION="$APP_VERSION" MACOSX_DEPLOYMENT_TARGET=14.0 "$CARGO" build -q --release --locked -p margin-connector --target "$target"
done
rm -f "$HELPERS/margin-relay"
lipo -create target/aarch64-apple-darwin/release/margin-connector target/x86_64-apple-darwin/release/margin-connector -output "$HELPERS/margin-connector"
# margin-helper (app/platforms/macos/helper/): the login agent that starts Margin.app as a browser opens, about
# 2.5 MB, for both kinds of Mac, and its launch agent's file where SMAppService.agent looks (AppDelegate.swift).
mkdir -p "$DERIVED/helper" "$BUILT/Contents/Library/LaunchAgents"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos14.0" app/platforms/macos/helper/main.swift -o "$DERIVED/helper/margin-helper-$arch"
done
lipo -create "$DERIVED/helper/margin-helper-arm64" "$DERIVED/helper/margin-helper-x86_64" -output "$HELPERS/margin-helper"
cp app/platforms/macos/helper/io.tirth.margin.helper.plist "$BUILT/Contents/Library/LaunchAgents/"
if [ "$UNSIGNED" = true ]; then
  IDENTITY=-
else
  AUTHORITY=$(codesign -dvv "$BUILT" 2>&1 | sed -n 's/^Authority=//p' | head -1)
  IDENTITY=$(security find-identity -v -p codesigning | grep -F "\"$AUTHORITY\"" | head -1 | awk '{print $2}')
  if [ -z "$IDENTITY" ]; then
    echo "No signing identity named \"$AUTHORITY\" (the app's) to sign the connector with." >&2
    exit 1
  fi
fi
codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP" --identifier io.tirth.margin.connector "$HELPERS/margin-connector"
codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP" --identifier io.tirth.margin.helper "$HELPERS/margin-helper"
codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP" --preserve-metadata=identifier,entitlements,requirements,flags "$BUILT"
codesign --verify --strict "$BUILT"
if [ "$INSTALL" = false ]; then
  # Not left known to the system: a second registered Margin.app (this one, unsigned or signed otherwise) makes
  # Safari take the installed one for another app's and refuse its messages (SFErrorDomain 1, 2026-11-09).
  "$LSREGISTER" -u "$BUILT" 2>/dev/null || true
  echo "Built (not installed):"
  echo "$BUILT"
  exit 0
fi

# Over the installed copy (same app, same extension: Safari takes it as an
# update), by scripts/app-swap.sh: the new copy in place of the old one and
# registered, then the Margin.app that was running from it quit, and only
# then the old copy deleted; the new one started if Safari is running and
# nothing started it.
. scripts/app-swap.sh
FIRST=true
[ -d "$DEST" ] && FIRST=false
mkdir -p "$HOME/Applications"
rm -rf "$DEST.new" "$DEST.old" && ditto "$BUILT" "$DEST.new"
REGISTERED=false
register_app() {
  "$LSREGISTER" -u "$1.old" 2>/dev/null || true
  # The build's own copy goes (it would be a second Margin.app on the Mac; the
  # build folder keeps what makes the next build quick).
  "$LSREGISTER" -u "$BUILT" 2>/dev/null || true
  rm -rf "$BUILT"
  "$LSREGISTER" -f -R "$1"
  # Safari lists Margin only once the system has the extension. Its record can
  # be dropped seconds after it's added (the copies unregistered above are
  # handled late, even after it was listed), so it's added again whenever it's
  # gone, until the system has kept listing this copy for 5 seconds.
  APPEX="$1/Contents/PlugIns/Margin Extension.appex"
  KEPT=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if pluginkit -m -v -i io.tirth.margin.Extension 2>/dev/null | grep -qF "$APPEX"; then
      KEPT=$((KEPT + 1))
      if [ "$KEPT" -ge 10 ]; then
        REGISTERED=true
        break
      fi
    else
      KEPT=0
      pluginkit -a "$APPEX"
    fi
    sleep 0.5
  done
}
safari_running() { pgrep -x Safari >/dev/null 2>&1; }
# In the background, never hidden (-j): a hidden Margin.app's overlays never show.
open_app() { open -g "$1" --args --background; }
# Waiting for a browser to open (no shell until then): the login item's way.
open_watch() { open -g "$1" --args --background --watch; }
swap_app "$DEST.new" "$DEST"
[ "$REGISTERED" = true ] || echo "warning: the system doesn't list Margin's extension; open $DEST once so Safari sees it." >&2
# Only this copy: one Xcode left elsewhere (its own build folder) would be a
# second Margin in Safari, with storage of its own.
"$LSREGISTER" -dump 2>/dev/null | sed -n 's/^path: *\(.*Margin\.app\) (0x[0-9a-f]*)$/\1/p' | sort -u | while read -r other; do
  case "$other" in "$DEST" | *.Trash*) ;; *DerivedData*|"$DERIVED"/*) "$LSREGISTER" -u "$other" && echo "Unregistered another copy: $other" ;; esac
done

echo
if [ "$FIRST" = true ]; then
  echo "Installed $DEST. Once: Safari → Settings → Extensions, turn Margin on and allow it on every website."
  open "$DEST" # its set-up window; it also makes Safari see the extension
else
  echo "Updated $DEST. Safari loads the new version (pages open now get it as they're shown)."
fi
