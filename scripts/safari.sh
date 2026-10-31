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
set -eu
cd "$(dirname "$0")/.."

APP_ID=io.tirth.margin
DEST="$HOME/Applications/Margin.app"
DERIVED="$PWD/xcode/build"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

UNSIGNED=false
[ "${1:-}" = "--unsigned" ] && UNSIGNED=true

npm run build
# The project again when what makes it isn't what it was made from: the app's
# code (app/safari/) or this script's partner (make-xcode.sh) changed, or
# another branch made it (its project can list files this one doesn't have).
# dist/ is copied in by each build, so it needs no new project. xcode/.team stays.
MADE_FROM="xcode/.made-from"
FROM=$(find app/safari scripts/make-xcode.sh -type f | LC_ALL=C sort | xargs shasum | shasum | cut -d' ' -f1)
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

# Over the installed copy (same app, same extension: Safari takes it as an update).
FIRST=true
[ -d "$DEST" ] && FIRST=false
mkdir -p "$HOME/Applications"
rm -rf "$DEST.new" && ditto "$BUILT" "$DEST.new"
rm -rf "$DEST" && mv "$DEST.new" "$DEST"
# The build's own copy goes (it would be a second Margin.app on the Mac; the
# build folder keeps what makes the next build quick).
"$LSREGISTER" -u "$BUILT" 2>/dev/null || true
rm -rf "$BUILT"
"$LSREGISTER" -f -R "$DEST"
# Safari lists Margin only once the system has the extension. Its record can
# be dropped seconds after it's added (the copies unregistered above are
# handled late, even after it was listed), so it's added again whenever it's
# gone, until the system has kept listing this copy for 5 seconds.
APPEX="$DEST/Contents/PlugIns/Margin Extension.appex"
REGISTERED=false
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
