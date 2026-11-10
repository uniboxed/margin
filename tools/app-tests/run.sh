#!/bin/bash
# Margin.app's shell (app/macos/shell/), tested with no browser: npm run test:app.
#   unit: each app folder's own tests/ (app/macos/shell/tests/, app/macos/private/tests/,
#         app/engines/webkit/safari/tests/): tests.swift, data-tests.swift and
#         window-tests.swift, the shell's logic on its own (no
#         window, no link), the lasting data's merge (tests/fixtures/data-merge/),
#         its files (in a temporary folder) and its messages; spaces across
#         profiles (profiles-tests.swift: the order, the names' file, the
#         cross-profile switch against a fake world and clock); Safari's profile
#         names and iCloud Tabs read from stand-ins for Safari's files
#         (safari-profiles-tests.swift, cloud-tabs-tests.swift); macOS's private calls'
#         launch check and wrappers against a fake resolver (private-calls-tests.swift);
#         the handoff's freezer on a fake clock and fake functions (handoff-tests.swift);
#         the Space reads, the parker and its cross-process self-test against a fake
#         world and a stand-in child, nothing spawned, and the parking registry with its crash
#         marker in a temporary folder (parking-tests.swift); the switch's setting in
#         browser.json and its notices by kind (handoff-ui-tests.swift); the dev-only test hook
#         against a fake world, and no title or address in the switch's lines (devhooks-tests.swift);
#         the user themes' store and what the picker chose, read (theme-tests.swift, in a temporary folder)
#   e2e:  e2e.swift, the real link, shell and overlays (off screen, in an
#         accessory app that never activates) against a stand-in for the
#         extension (fake-extension.mts, Node), and a picture of the overlay
#         drawing Arcadia (MARGIN_APP_SHOT, default build/overlay.png); then
#         e2e-data.swift, the lasting data over the real link, in a temporary
#         folder (never ~/Library/Application Support/Margin); and e2e-profiles.swift,
#         two profiles' copies and the app driving a switch between them with
#         stand-in windows, the close-based one with the handoff's gate off, then
#         the handoff with stand-ins for macOS's Spaces, the parker and the freeze
#         (parking, showing, the keys mid-switch, a wake, a parked window used, a
#         dialog, the shown window closed, a crash's marker, quit); and e2e-windows.swift, which window is which with
#         two profiles and several same-bounds windows, Spaces played by
#         on-screen flags and the copies' focus flags lagging; and e2e-keyboard.swift,
#         the overlay's keyboard and its page's focus through shows, put-aways and relinks;
#         e2e-overlays.swift, overlays through a window closing, a link dropping and Safari's
#         own sidebar sliding in; and e2e-cloud.swift, iCloud Tabs from a stand-in for
#         Safari's file drawn live in the overlay; and e2e-themes.swift, a theme the overlay
#         can't draw replaced by Arcadia, and said
# window-tests.swift's randomized runs take WINDOW_RUNS (default 300),
# WINDOW_LAG (the flags' lag, default 1.2 s) and WINDOW_SEED (one run, printed).
# Built with swiftc as the app target builds it (Swift 5, main actor by
# default), no XCTest. Exits 1 if a check failed. Nothing shows on screen and
# nothing reaches Safari. ./run.sh [unit|e2e|all] (default all).
# MARGIN_APP_TESTS is set for every binary here: macOS's private calls refuse to
# run under it (PrivateCalls.swift), so no test calls one or freezes the screen.
set -u
export MARGIN_APP_TESTS=1
cd "$(dirname "$0")"
BUILD="${MARGIN_APP_TESTS_BUILD:-$PWD/build}"
mkdir -p "$BUILD"
# Margin.app's Swift: every *.swift of each folder app/macos/swift-sources.txt lists (as the app's Xcode target has it).
# Their unit checks: each such folder's own tests/ (app/macos/shell/tests/, app/macos/private/tests/,
# app/engines/webkit/safari/tests/: never in the app, which takes each folder's own *.swift only).
SHELL_SOURCES=()
UNIT_TESTS=()
while read -r folder; do
  case "$folder" in ''|'#'*) continue ;; esac
  SHELL_SOURCES+=(../../"$folder"/*.swift)
  for t in ../../"$folder"/tests/*.swift; do [ -f "$t" ] && UNIT_TESTS+=("$t"); done
done < ../../app/macos/swift-sources.txt
# The stand-in for Safari's folder, for the unit checks and the end-to-end ones.
FAKE_SAFARI=../../app/engines/webkit/safari/tests/fake-safari.swift
FLAGS=(-swift-version 5 -default-isolation MainActor -enable-upcoming-feature InferIsolatedConformances -enable-upcoming-feature NonisolatedNonsendingByDefault)
# Compiled on every core (batch mode): about 4x faster than one job.
JOBS=(-j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)")
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
WHAT="${1:-all}"

build() { # name sources...
  local name="$1"; shift
  if [ ! -x "$BUILD/$name" ] || [ -n "$(find "$@" -newer "$BUILD/$name" 2>/dev/null)" ]; then
    swiftc "${FLAGS[@]}" "${JOBS[@]}" "$@" -o "$BUILD/$name" || exit 1
  fi
}

# The app's own code with the settings its Xcode target has (scripts/make-xcode.sh;
# Approachable Concurrency, main actor by default, member import visibility):
# any warning fails here, before it shows up in npm run safari's build.
XCODE_FLAGS=(-swift-version 5 -default-isolation MainActor
  -enable-upcoming-feature InferIsolatedConformances -enable-upcoming-feature NonisolatedNonsendingByDefault
  -enable-upcoming-feature DisableOutwardActorInference -enable-upcoming-feature GlobalActorIsolatedTypesUsability
  -enable-upcoming-feature InferSendableFromCaptures -enable-upcoming-feature MemberImportVisibility)
warnings() { # label flags... -- sources...
  local label="$1"; shift
  local out
  out=$(swiftc -typecheck -parse-as-library "${JOBS[@]}" "$@" 2>&1 | grep -E "(warning|error):" || true)
  if [ -n "$out" ]; then
    echo "FAIL $label: the Xcode build would warn:"; echo "$out" | head -20; status=1
  else
    echo "ok   $label: no compiler warnings with the Xcode target's settings"
  fi
}

status=0
if [ "$WHAT" = unit ] || [ "$WHAT" = all ]; then
  warnings "the app" "${XCODE_FLAGS[@]}" ../../app/macos/startup/AppDelegate.swift ../../app/macos/startup/ViewController.swift "${SHELL_SOURCES[@]}"
  warnings "the extension handler" -swift-version 5 ../../app/engines/webkit/safari/handler/SafariWebExtensionHandler.swift
  # Chrome's and Edge's connector (app/shared/connector/, Rust), built as scripts/safari.sh builds it.
  CARGO="${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}"
  "$CARGO" build -q --release -p margin-connector --manifest-path ../../Cargo.toml || exit 1
  CONNECTOR="$(cd ../.. && pwd)/target/release/margin-connector"
  build tests "${UNIT_TESTS[@]}" "${SHELL_SOURCES[@]}"
  MARGIN_DATA_VECTORS="$PWD/../../tests/fixtures/data-merge" MARGIN_CONNECTOR_BIN="$CONNECTOR" "$BUILD/tests" || status=1
fi
if [ "$WHAT" = e2e ] || [ "$WHAT" = all ]; then
  [ -f ../../dist/app/overlay.js ] || { echo "dist/app/ is missing: run npm run build" >&2; exit 1; }
  build e2e e2e.swift e2e-data.swift e2e-profiles.swift e2e-windows.swift e2e-keyboard.swift e2e-overlays.swift e2e-cloud.swift e2e-themes.swift "$FAKE_SAFARI" "${SHELL_SOURCES[@]}"
  MARGIN_APP_ROOT="$PWD/../../dist/app" MARGIN_FAKE_EXTENSION="$PWD/fake-extension.mts" MARGIN_NODE="$NODE" \
    MARGIN_APP_SHOT="${MARGIN_APP_SHOT:-$BUILD/overlay.png}" "$BUILD/e2e" || status=1
fi
exit $status
