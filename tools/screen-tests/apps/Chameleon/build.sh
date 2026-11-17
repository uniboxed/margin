#!/bin/bash
# Builds Chameleon (tools/screen-tests/apps/Chameleon) and makes N copies of it with their own bundle ids and names,
# signed ad hoc, into a build folder (never /Applications or ~/Applications: the suite copies them into ~/Applications
# for a run and removes them after). Then checks each switch is read: the binary's `--describe` with each switch as a
# launch argument (no window, no window-server connection: it exits before AppKit's application starts).
#   build.sh [N (default 3)] [out folder (default tools/screen-tests/build/apps)]
# Copy i: "Margin Chameleon i.app", bundle id test.margin.chameleon.i, executable Chameleon.
set -eu
cd "$(dirname "$0")"
N="${1:-3}"
OUT="${2:-$PWD/../../build/apps}"
mkdir -p "$OUT"
BIN="$OUT/Chameleon"
if [ ! -x "$BIN" ] || [ -n "$(find Switches.swift main.swift -newer "$BIN" 2>/dev/null)" ]; then
  swiftc -O -swift-version 5 Switches.swift main.swift -o "$BIN"
fi
for i in $(seq 1 "$N"); do
  APP="$OUT/Margin Chameleon $i.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS"
  cp "$BIN" "$APP/Contents/MacOS/Chameleon"
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>test.margin.chameleon.$i</string>
<key>CFBundleExecutable</key><string>Chameleon</string>
<key>CFBundleName</key><string>Chameleon $i</string>
<key>CFBundleDisplayName</key><string>Margin Chameleon $i</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
  codesign --force --sign - "$APP" >/dev/null 2>&1
done
# Each switch read and named as on (the binary on its own: `--describe` exits before NSApplication).
fails=0
while IFS='|' read -r key value want; do
  [ -z "$key" ] && continue
  got=$("$BIN" --describe "-$key" "$value" 2>&1 || true)
  case "$got" in *"$want"*) ;; *) echo "FAIL chameleon switch $key $value: $got (wanted $want)"; fails=$((fails + 1)) ;; esac
done <<'CASES'
ChameleonRestore|2:fullscreen|restore=2:fullscreen:system
ChameleonRestore|3:both:code|restore=3:both:code
ChameleonWindowless|YES|windowless=YES
ChameleonWindowless|close:8|windowless=close:8
ChameleonAutoTerminate|system|autoTerminate=system
ChameleonAutoTerminate|attempt:5|autoTerminate=attempt:5
ChameleonAutoTerminate|quit:3|autoTerminate=quit:3
ChameleonDialogMain|YES|dialogMain=YES
ChameleonOrdersOut|untilActive|ordersOut=untilActive
ChameleonOrdersOut|after:3|ordersOut=after:3
ChameleonOrdersOut|every:4|ordersOut=every:4
ChameleonReplacesWindow|every:4|replacesWindow=every:4
ChameleonReplacesWindow|twin|replacesWindow=twin
ChameleonAxBusy|2.5|axBusy=2.5
ChameleonStrip|fullscreen|strip=fullscreen
ChameleonStrip|linger|strip=linger
ChameleonStrip|at:6,for:5|strip=at:6,for:5
ChameleonAuxiliary|settings|auxiliary=settings
ChameleonAuxiliary|sidebar,at:6,for:5|auxiliary=sidebar,at:6,for:5
ChameleonAuxiliary|300x200+40+60,borderless|auxiliary=300x200+40+60,borderless
ChameleonNoFullScreen|YES|noFullScreen=YES
ChameleonFixedSize|YES|fixedSize=400x300
ChameleonFixedSize|320x480|fixedSize=320x480
ChameleonExtraWindow|menu|extraWindow=menu
ChameleonExtraWindow|at:7|extraWindow=at:7
ChameleonAxBusy|soon|unread axBusy=soon
CASES
[ "$fails" -eq 0 ] && echo "ok   chameleon: $N copies in $OUT, every switch read" || { echo "chameleon: $fails switch check(s) failed"; exit 1; }
