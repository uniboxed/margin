#!/bin/bash
# Real helper processes and AppKit splash, over a stand-in browser off every display. The test mode refuses
# any on-screen frame. No real browser is opened, activated, read or quit. Also measures the resident helper
# before, during and after its child: adding a splash must not connect the long-lived process to AppKit.
set -eu
cd "$(dirname "$0")"
HELPER_BIN="${1:?helper executable}"
BUILD="${MARGIN_APP_TESTS_BUILD:-$PWD/build}/helper-splash-test-$$"
mkdir -p "$BUILD/Browser.app/Contents/MacOS"
BUILD=$(cd "$BUILD" && pwd -P)
fail=0
TEST_BROWSER_ID="com.unibox.margin.test.splash-browser.$$"
check() { if [ "$2" = true ]; then echo "ok   helper splash: $1"; else echo "FAIL helper splash: $1 ${3:-}"; fail=1; fi; }
cat > "$BUILD/Browser.app/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$TEST_BROWSER_ID</string>
<key>CFBundleExecutable</key><string>run</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/></dict></plist>
PL
cat > "$BUILD/browser.swift" <<'SWIFT'
import AppKit
NSApplication.shared.setActivationPolicy(.accessory)
let window = NSPanel(contentRect: NSRect(x: -20000, y: -20000, width: 1000, height: 700), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
window.orderFront(nil)
NSApplication.shared.run()
SWIFT
cat > "$BUILD/notify.swift" <<'SWIFT'
import Foundation
import CoreGraphics
let pid = CommandLine.arguments[2]
let center = DistributedNotificationCenter.default()
let ready = Notification.Name("com.unibox.margin.startup.ready")
func post() {
    let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let window = list.first { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.stringValue == pid && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }
    var number = (window?[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 1
    if CommandLine.arguments[1] == "other-window" { number += 1 }
    center.postNotificationName(ready, object: "\(pid):\(number)", userInfo: nil, deliverImmediately: true)
}
if CommandLine.arguments[1] == "respond" {
    let token = center.addObserver(forName: Notification.Name("com.unibox.margin.startup.query"), object: pid, queue: .main) { _ in post() }
    post() // deliberately before the child exists
    withExtendedLifetime(token) { RunLoop.main.run(until: Date().addingTimeInterval(4)) }
} else { post(); RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
SWIFT
swiftc -O "$BUILD/browser.swift" -o "$BUILD/Browser.app/Contents/MacOS/run"
swiftc -O "$BUILD/notify.swift" -o "$BUILD/notify"
BROWSER=""; CHILD=""; RESIDENT=""; RESPONDER=""
cleanup() {
  for pid in "$CHILD" "$BROWSER" "$RESIDENT" "$RESPONDER"; do [ -z "$pid" ] || kill "$pid" 2>/dev/null || true; done
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$BUILD/Browser.app" 2>/dev/null || true
}
trap cleanup EXIT
export MARGIN_HELPER_SPLASH_TEST=1
export MARGIN_HELPER_SPLASH_SHOT="$BUILD/splash.png"
export MARGIN_HELPER_BROWSERS="$TEST_BROWSER_ID"
# An app with a deliberately missing executable: launch can fail, but the helper must remain small and its
# splash must release the window. Give it its own bundle identity; a wholly missing bundle falls back to the
# real Margin's identity, making the test skip startup whenever the person's Margin.app is already running.
# No app-start marker or real installation is touched.
mkdir -p "$BUILD/Missing.app/Contents"
cat > "$BUILD/Missing.app/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.unibox.margin.test.missing-app.$$</string>
<key>CFBundleExecutable</key><string>missing</string><key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PL
export MARGIN_HELPER_APP="$BUILD/Missing.app"
"$HELPER_BIN" 2> "$BUILD/resident.log" & RESIDENT=$!
sleep 0.5
BEFORE=$(ps -o rss= -p "$RESIDENT" | tr -d ' ')
for _ in $(seq 1 50); do grep -q 'watching for browser launches' "$BUILD/resident.log" && break; sleep 0.1; done
cpu() { ps -o time= -p "$RESIDENT" | awk -F '[:.]' '{print $1 * 6000 + $2 * 100 + $3}'; }
CPU_BEFORE=$(cpu)
sleep 1
CPU_AFTER=$(cpu)
check "idle CPU: $(((CPU_AFTER - CPU_BEFORE) * 10)) ms over one second" "$([ $((CPU_AFTER - CPU_BEFORE)) -le 2 ] && echo true || echo false)"
open -n -g "$BUILD/Browser.app"
for _ in $(seq 1 50); do BROWSER=$(pgrep -f "^$BUILD/Browser.app/Contents/MacOS/run$" || true); [ -n "$BROWSER" ] && break; sleep 0.1; done
[ -n "$BROWSER" ] || { check "off-screen browser started" false; exit 1; }
for _ in $(seq 1 50); do grep -q 'splash shown' "$BUILD/resident.log" && break; sleep 0.1; done
check "helper launches a visible off-screen splash without waiting for the app" "$(grep -q 'splash shown' "$BUILD/resident.log" && echo true || echo false)" "$(cat "$BUILD/resident.log")"
grep -q 'splash shown' "$BUILD/resident.log" || exit 1
CHILD=$(pgrep -P "$RESIDENT" -f -- '--splash' || true)
DURING=$(ps -o rss= -p "$RESIDENT" | tr -d ' ')
CHILD_RSS=$([ -z "$CHILD" ] || ps -o rss= -p "$CHILD" | tr -d ' ')
echo "  memory: resident before $BEFORE KB, with splash $DURING KB; temporary splash ${CHILD_RSS:-0} KB"
check "resident stays below 20 MB while the child draws" "$([ "$DURING" -lt 20000 ] && echo true || echo false)"
"$BUILD/notify" post "$BROWSER"
for _ in $(seq 1 30); do [ -z "$CHILD" ] || kill -0 "$CHILD" 2>/dev/null || break; sleep 0.1; done
check "app's drawn message ends the child" "$([ -n "$CHILD" ] && ! kill -0 "$CHILD" 2>/dev/null && echo true || echo false)"
CHILD=""
AFTER=$(ps -o rss= -p "$RESIDENT" | tr -d ' ')
check "resident remains small afterwards ($AFTER KB)" "$([ "$AFTER" -lt 20000 ] && echo true || echo false)"
if [ -n "${MARGIN_HELPER_BASELINE:-}" ]; then
  "$MARGIN_HELPER_BASELINE" 2> "$BUILD/baseline.log" & BASELINE=$!
  sleep 0.5
  BASELINE_RSS=$(ps -o rss= -p "$BASELINE" | tr -d ' ')
  echo "  same-session baseline: old helper after app launch $BASELINE_RSS KB; new $AFTER KB"
  kill "$BASELINE"; wait "$BASELINE" 2>/dev/null || true
fi
kill "$RESIDENT"; wait "$RESIDENT" 2>/dev/null || true; RESIDENT=""

# An event for another browser must not dismiss this splash; a late listener must query the app, and the
# hard timeout and browser quit must independently clean up. Each process draws only over our fake window.
"$HELPER_BIN" --splash "$BROWSER" 2> "$BUILD/timeout.log" & CHILD=$!
sleep 0.5
"$BUILD/notify" post "999999"
check "another browser's ready message is ignored" "$(kill -0 "$CHILD" 2>/dev/null && echo true || echo false)"
"$BUILD/notify" other-window "$BROWSER"
check "another window of the same browser cannot dismiss the card" "$(kill -0 "$CHILD" 2>/dev/null && echo true || echo false)"
wait "$CHILD" || fail=1; CHILD=""
check "no app ready: child exits at its six-second limit" "$(grep -q 'splash ended: timeout' "$BUILD/timeout.log" && echo true || echo false)"
"$BUILD/notify" respond "$BROWSER" & RESPONDER=$!
sleep 0.2
"$HELPER_BIN" --splash "$BROWSER" 2> "$BUILD/late.log" & CHILD=$!
for _ in $(seq 1 20); do kill -0 "$CHILD" 2>/dev/null || break; sleep 0.1; done
check "app ready before child started: query closes it promptly" "$(! kill -0 "$CHILD" 2>/dev/null && echo true || echo false)"
wait "$CHILD" || fail=1; CHILD=""
kill "$RESPONDER" 2>/dev/null || true; wait "$RESPONDER" 2>/dev/null || true; RESPONDER=""
"$HELPER_BIN" --splash "$BROWSER" 2> "$BUILD/quit.log" & CHILD=$!
sleep 0.5
kill "$BROWSER"; wait "$BROWSER" 2>/dev/null || true; BROWSER=""
for _ in $(seq 1 30); do kill -0 "$CHILD" 2>/dev/null || break; sleep 0.1; done
check "browser quit ends the splash" "$(! kill -0 "$CHILD" 2>/dev/null && echo true || echo false)"
wait "$CHILD" || fail=1; CHILD=""
exit "$fail"
