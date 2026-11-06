#!/bin/bash
# Margin.app's shell (app/shell/), tested with no browser: npm run test:app.
#   unit: tests.swift, data-tests.swift and window-tests.swift, the shell's logic on its own (no
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
#         against a fake world, and no title or address in the switch's lines (devhooks-tests.swift)
#   e2e:  e2e.swift, the real link, shell and overlays (off screen, in an
#         accessory app that never activates) against a stand-in for the
#         extension (fake-extension.mjs, Node), and a picture of the overlay
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
#         Safari's file drawn live in the overlay
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
SHELL_SOURCES=(../../app/shell/*.swift)
FLAGS=(-swift-version 5 -default-isolation MainActor -enable-upcoming-feature InferIsolatedConformances -enable-upcoming-feature NonisolatedNonsendingByDefault)
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
WHAT="${1:-all}"

build() { # name sources...
  local name="$1"; shift
  if [ ! -x "$BUILD/$name" ] || [ -n "$(find "$@" -newer "$BUILD/$name" 2>/dev/null)" ]; then
    swiftc "${FLAGS[@]}" "$@" -o "$BUILD/$name" || exit 1
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
  out=$(swiftc -typecheck -parse-as-library "$@" 2>&1 | grep -E "(warning|error):" || true)
  if [ -n "$out" ]; then
    echo "FAIL $label: the Xcode build would warn:"; echo "$out" | head -20; status=1
  else
    echo "ok   $label: no compiler warnings with the Xcode target's settings"
  fi
}

status=0
if [ "$WHAT" = unit ] || [ "$WHAT" = all ]; then
  warnings "the app" "${XCODE_FLAGS[@]}" ../../app/safari/AppDelegate.swift ../../app/safari/ViewController.swift "${SHELL_SOURCES[@]}"
  warnings "the extension handler" -swift-version 5 ../../app/safari/SafariWebExtensionHandler.swift
  build tests tests.swift data-tests.swift profiles-tests.swift safari-profiles-tests.swift cloud-tabs-tests.swift fake-safari.swift window-tests.swift private-calls-tests.swift handoff-tests.swift parking-tests.swift handoff-ui-tests.swift devhooks-tests.swift "${SHELL_SOURCES[@]}"
  MARGIN_DATA_VECTORS="$PWD/../../tests/fixtures/data-merge" "$BUILD/tests" || status=1
fi
if [ "$WHAT" = e2e ] || [ "$WHAT" = all ]; then
  [ -f ../../dist/app/overlay.js ] || { echo "dist/app/ is missing: run npm run build" >&2; exit 1; }
  build e2e e2e.swift e2e-data.swift e2e-profiles.swift e2e-windows.swift e2e-keyboard.swift e2e-overlays.swift e2e-cloud.swift fake-safari.swift "${SHELL_SOURCES[@]}"
  MARGIN_APP_ROOT="$PWD/../../dist/app" MARGIN_FAKE_EXTENSION="$PWD/fake-extension.mjs" MARGIN_NODE="$NODE" \
    MARGIN_APP_SHOT="${MARGIN_APP_SHOT:-$BUILD/overlay.png}" "$BUILD/e2e" || status=1
fi
exit $status
