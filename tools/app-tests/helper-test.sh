#!/bin/bash
# margin-helper (app/platforms/macos/helper/), tested off screen: a stand-in browser and a stand-in Margin.app
# (background-only apps with test ids: nothing shown, nothing of the real Margin or Safari touched). The helper
# must start "Margin" when the "browser" opens, and at once when it's open already; and stay small.
set -u
cd "$(dirname "$0")"
BUILD="${MARGIN_APP_TESTS_BUILD:-$PWD/build}/helper-test"
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
rm -rf "$BUILD" && mkdir -p "$BUILD"
swiftc -O -swift-version 5 ../../app/platforms/macos/helper/main.swift -o "$BUILD/margin-helper" || exit 1
fail=0
check() { if [ "$2" = true ]; then echo "ok   helper: $1"; else echo "FAIL helper: $1 ${3:-}"; fail=1; fi; }

# A background-only app: `id`, and a script for its executable.
stub() { # dir id script [LSUIElement: an accessory app, whose launch macOS announces]
  mkdir -p "$1/Contents/MacOS"
  cat > "$1/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>$2</string><key>CFBundleExecutable</key><string>run</string>
<key>CFBundlePackageType</key><string>APPL</string><key>${4:-LSBackgroundOnly}</key><true/></dict></plist>
PL
  printf '#!/bin/sh\n%s\n' "$3" > "$1/Contents/MacOS/run"
  chmod +x "$1/Contents/MacOS/run"
}
MARK="$BUILD/margin-started"
stub "$BUILD/Margin.app" com.unibox.margin.test.app "echo \"\$@\" >> '$MARK'; sleep 2"
stub "$BUILD/Browser.app" com.unibox.margin.test.browser "" LSUIElement
# (The "browser" a real Cocoa app: macOS announces a launch only once the app checks in. An accessory app, no
# window, gone in 4 s.)
printf 'import AppKit\nNSApplication.shared.setActivationPolicy(.accessory)\nDispatchQueue.main.asyncAfter(deadline: .now() + 4) { exit(0) }\nNSApplication.shared.run()\n' > "$BUILD/browser.swift"
rm -f "$BUILD/Browser.app/Contents/MacOS/run"
swiftc -O "$BUILD/browser.swift" -o "$BUILD/Browser.app/Contents/MacOS/run" || exit 1
export MARGIN_HELPER_APP="$BUILD/Margin.app" MARGIN_HELPER_BROWSERS=com.unibox.margin.test.browser

# 1. No browser yet: nothing started; then the browser opens: Margin.app started, with --background.
"$BUILD/margin-helper" 2> "$BUILD/helper.log" &
HELPER=$!
sleep 1
check "no browser: Margin.app not started" "$([ ! -e "$MARK" ] && echo true || echo false)"
open -g "$BUILD/Browser.app"
for _ in $(seq 1 50); do [ -s "$MARK" ] && break; sleep 0.1; done
check "a browser opens: Margin.app started, in the background" "$(grep -qx -- "--background" "$MARK" 2>/dev/null && echo true || echo false)" "$(cat "$MARK" 2>/dev/null)"
RSS=$(ps -o rss= -p $HELPER | tr -d ' ')
check "small: $((RSS / 1024)) MB resident" "$([ "${RSS:-999999}" -lt 30000 ] && echo true || echo false)"
kill $HELPER 2>/dev/null; wait $HELPER 2>/dev/null

# 2. The browser open as the helper starts: Margin.app started at once. (The first case's stand-ins ended first: a
# Margin.app running already is never started again.)
pkill -f "$BUILD/Margin.app/Contents/MacOS/run" 2>/dev/null; pkill -f "$BUILD/Browser.app/Contents/MacOS/run" 2>/dev/null
# (Until the system's list of running apps has them gone too: it lags a moment behind a process's end, and the
# helper, rightly, never starts a Margin.app that list still has.)
for _ in $(seq 1 50); do pgrep -f "$BUILD/(Margin|Browser).app/Contents/MacOS/run" >/dev/null || lsappinfo list 2>/dev/null | grep -q "com.unibox.margin.test.app" || break; sleep 0.1; done
rm -f "$MARK"
open -g "$BUILD/Browser.app"; sleep 0.5
"$BUILD/margin-helper" 2>> "$BUILD/helper.log" &
HELPER=$!
for _ in $(seq 1 30); do [ -s "$MARK" ] && break; sleep 0.1; done
check "a browser open already: Margin.app started at once" "$([ -s "$MARK" ] && echo true || echo false)"
kill $HELPER 2>/dev/null; wait $HELPER 2>/dev/null

# 3. As launchd starts it: from /, its argv[0] the agent's path relative to the bundle, nothing set (2026-11-10: it took
# argv[0] for its path and quit, again and again). It finds its Margin.app and keeps running.
mkdir -p "$BUILD/Margin.app/Contents/Helpers" && cp "$BUILD/margin-helper" "$BUILD/Margin.app/Contents/Helpers/margin-helper"
(cd / && unset MARGIN_HELPER_APP MARGIN_HELPER_BROWSERS && exec -a Contents/Helpers/margin-helper "$BUILD/Margin.app/Contents/Helpers/margin-helper") 2>> "$BUILD/helper.log" &
HELPER=$!
sleep 1
check "started as launchd does (a relative path): finds its Margin.app and runs" "$(kill -0 $HELPER 2>/dev/null && echo true || echo false)" "$(tail -2 "$BUILD/helper.log")"
kill $HELPER 2>/dev/null; wait $HELPER 2>/dev/null

# The stand-ins forgotten by the system again.
pkill -f "$BUILD/Browser.app/Contents/MacOS/run" 2>/dev/null; pkill -f "$BUILD/Margin.app/Contents/MacOS/run" 2>/dev/null
"$LSR" -u "$BUILD/Margin.app" 2>/dev/null; "$LSR" -u "$BUILD/Browser.app" 2>/dev/null
exit $fail
