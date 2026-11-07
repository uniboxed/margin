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
set -eu
cd "$(dirname "$0")/.."

APP_ID=io.tirth.margin
DEST="$HOME/Applications/Margin.app"
DERIVED="$PWD/xcode/build"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

UNSIGNED=false
YES=false
for arg in "$@"; do
  case "$arg" in
    --unsigned) UNSIGNED=true ;;
    --yes) YES=true ;;
  esac
done

npm run build
# The project again when what makes it isn't what it was made from: the app's
# code (app/safari/) or this script's partner (make-xcode.sh) changed, or
# another branch made it (its project can list files this one doesn't have),
# or dist/safari/ or app/shell/ has a file more or less: the project lists each
# of their files (a new one isn't copied or built into the app until the
# project is made again: the sleep page, 2026-11-04, sent tabs to a page the
# app didn't have). What's in those files is copied in or built by each
# build, so changes there need no new project. xcode/.team stays.
MADE_FROM="xcode/.made-from"
FROM=$({ find app/safari scripts/make-xcode.sh scripts/xcode-add-sources.py -type f | LC_ALL=C sort | xargs shasum; (cd dist/safari && find . -type f | LC_ALL=C sort); (cd app/shell && find . -name '*.swift' | LC_ALL=C sort); } | shasum | cut -d' ' -f1)
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
. scripts/signing-check.sh
if [ "$UNSIGNED" = true ]; then NEW_TEAM="not set"; else NEW_TEAM="$TEAM"; fi
confirm_signing "$DEST" "$NEW_TEAM" "$YES" || exit 1

if [ "$UNSIGNED" = true ]; then
  SIGN="CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO DEVELOPMENT_TEAM="
  echo "Building unsigned (Safari turns it off at each launch)."
else
  SIGN="DEVELOPMENT_TEAM=$TEAM CODE_SIGN_STYLE=Automatic"
  echo "Signing with team $TEAM."
fi

# shellcheck disable=SC2086
xcodebuild -project xcode/Margin/Margin.xcodeproj -scheme Margin -configuration Release \
  -derivedDataPath "$DERIVED" -allowProvisioningUpdates -quiet $SIGN build
BUILT="$DERIVED/Build/Products/Release/Margin.app"

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
