#!/bin/bash
# Margin.app's shell (app/platforms/macos/shell/), tested with no browser: npm run test:app.
#   unit: each app folder's own tests/ (app/platforms/macos/shell/tests/, app/platforms/macos/private/tests/,
#         app/engines/webkit/safari/tests/): tests.swift and data-tests.swift, the shell's logic on its own (no
#         window, no link), the lasting data's merge (tests/fixtures/data-merge/), its files (in a temporary folder)
#         and its messages; a browser's profiles (profiles-tests.swift: the order, the names' file); Safari's profile
#         names read from stand-ins for Safari's files (safari-profiles-tests.swift); macOS's private calls' launch
#         check and wrappers against a fake resolver
#         (private-calls-tests.swift); the dev-only test hook against a fake world (devhooks-tests.swift); the user
#         themes' store and what the picker chose, read (theme-tests.swift, in a temporary folder); the app's own
#         spaces (library-tests.swift: margin-core's library object, its files and the import in temporary folders); the host engine on a stand-in window manager (host-tests.swift), the library, the
#         engine and the Safari copies joined (hosted-tests.swift), Margin's own window (margin-window-tests.swift),
#         installed apps (apps-tests.swift), Chrome's and Edge's relay (relay-tests.swift)
#   e2e:  e2e.swift, the harness (a stand-in for the extension: fake-extension.mts, Node; scripted apps and keys);
#         e2e-data.swift, the lasting data over the real link, in a temporary folder (never
#         ~/Library/Application Support/Margin); e2e-link.swift, requests to a stalled copy (the fake's stall and lose
#         modes) ending on evidence only; e2e-hosted.swift, Margin's own window off every display with the real
#         page: its page area published, the pointer through it, the menu's New Tab opening the palette, its sidebar,
#         full screen, resize; and e2e-glue.swift, the hosted parts joined: the library's first run, an app and a web
#         item picked, the host engine on a stand-in window manager given the page area from the tiles, the copy's
#         newWindow and hostShow
# Built with swiftc as the app target builds it (Swift 5, main actor by default), no XCTest. Exits 1 if a check
# failed. Nothing shows on screen and nothing reaches Safari. ./run.sh [unit|e2e|all] (default all).
# MARGIN_APP_TESTS is set for every binary here: macOS's private calls refuse to
# run under it (PrivateCalls.swift), so no test calls one or freezes the screen.
set -u
export MARGIN_APP_TESTS=1
cd "$(dirname "$0")"
BUILD="${MARGIN_APP_TESTS_BUILD:-$PWD/build}"
mkdir -p "$BUILD"
# Margin.app's Swift: every *.swift of each folder app/platforms/macos/swift-sources.txt lists (as the app's Xcode target has it).
# Their unit checks: each such folder's own tests/ (app/platforms/macos/shell/tests/, app/platforms/macos/private/tests/,
# app/engines/webkit/safari/tests/: never in the app, which takes each folder's own *.swift only).
SHELL_SOURCES=()
UNIT_TESTS=()
while read -r folder; do
  case "$folder" in ''|'#'*) continue ;; esac
  SHELL_SOURCES+=(../../"$folder"/*.swift)
  for t in ../../"$folder"/tests/*.swift; do [ -f "$t" ] && UNIT_TESTS+=("$t"); done
done < ../../app/platforms/macos/swift-sources.txt
# The stand-in for Safari's folder, for the unit checks and the end-to-end ones.
FAKE_SAFARI=../../app/engines/webkit/safari/tests/fake-safari.swift
# Chameleon's switches (tools/screen-tests/apps/Chameleon): the unit checks' stand-in world plays them (behaviour-world.swift).
CHAMELEON_SWITCHES=../screen-tests/apps/Chameleon/Switches.swift
# The hosting core (app/platforms/macos/ffi, Rust: margin-core's host module) the shell links through `import MarginCore`:
# built for this Mac (scripts/build-core.sh host), its module map's `link` line linking it.
CORE_LIB=$(sh ../../scripts/build-core.sh host) || exit 1
CORE=(-I ../../app/platforms/macos/ffi/include -L "$CORE_LIB")
FLAGS=(-swift-version 5 -default-isolation MainActor -enable-upcoming-feature InferIsolatedConformances -enable-upcoming-feature NonisolatedNonsendingByDefault "${CORE[@]}")
# Compiled on every core (batch mode): about 4x faster than one job.
JOBS=(-j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)")
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
WHAT="${1:-all}"

# dist/app (scripts/build.ts), the page the checks load and read (the built-in themes' packages): built when missing or
# older than any of its sources (the code, and the themes' CSS, HTML and JSON), before the unit checks and before the
# end-to-end checks, either of which may run alone.
app_page() {
  local page="$PWD/../../dist/app/overlay.js"
  if [ ! -f "$page" ] || [ -n "$(find ../../app/shared ../../extension \( -name '*.ts' -o -name '*.css' -o -name '*.html' -o -name '*.json' \) -newer "$page" 2>/dev/null | head -1)" ]; then
    "$NODE" ../../scripts/build.ts >/dev/null || exit 1
  fi
}

build() { # name sources...
  local name="$1"; shift
  if [ ! -x "$BUILD/$name" ] || [ -n "$(find "$@" -newer "$BUILD/$name" 2>/dev/null)" ]; then
    swiftc "${FLAGS[@]}" "${JOBS[@]}" "$@" -o "$BUILD/$name" || exit 1
  elif [ "$CORE_LIB/libmargin_ffi.a" -nt "$BUILD/$name" ]; then
    swiftc "${FLAGS[@]}" "${JOBS[@]}" "$@" -o "$BUILD/$name" || exit 1
  fi
}

# The app's own code with the settings its Xcode target has (scripts/make-xcode.sh;
# Approachable Concurrency, main actor by default, member import visibility):
# any warning fails here, before it shows up in npm run safari's build.
XCODE_FLAGS=(-swift-version 5 -default-isolation MainActor
  -enable-upcoming-feature InferIsolatedConformances -enable-upcoming-feature NonisolatedNonsendingByDefault
  -enable-upcoming-feature DisableOutwardActorInference -enable-upcoming-feature GlobalActorIsolatedTypesUsability
  -enable-upcoming-feature InferSendableFromCaptures -enable-upcoming-feature MemberImportVisibility "${CORE[@]}")
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
  warnings "the app" "${XCODE_FLAGS[@]}" ../../app/platforms/macos/startup/AppDelegate.swift ../../app/platforms/macos/startup/ViewController.swift "${SHELL_SOURCES[@]}"
  warnings "the extension handler" -swift-version 5 ../../app/engines/webkit/safari/handler/SafariWebExtensionHandler.swift
  # margin-helper (app/platforms/macos/helper/): no warnings (a main.swift: not a library), then started off screen
  # by stand-ins for a browser and Margin.app (helper-test.sh).
  helper_warns=$(swiftc -typecheck -swift-version 5 ../../app/platforms/macos/helper/main.swift 2>&1 | grep -E "(warning|error):" || true)
  if [ -n "$helper_warns" ]; then echo "FAIL margin-helper: the build would warn:"; echo "$helper_warns" | head -20; status=1
  else echo "ok   margin-helper: no compiler warnings"; fi
  ./helper-test.sh || status=1
  # Chrome's and Edge's connector (app/shared/connector/, Rust), built as scripts/safari.sh builds it.
  CARGO="${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}"
  "$CARGO" build -q --release -p margin-connector --manifest-path ../../Cargo.toml || exit 1
  CONNECTOR="$(cd ../.. && pwd)/target/release/margin-connector"
  app_page
  build tests "${UNIT_TESTS[@]}" "$CHAMELEON_SWITCHES" "${SHELL_SOURCES[@]}"
  MARGIN_DATA_VECTORS="$PWD/../../tests/fixtures/data-merge" MARGIN_LIBRARY_VECTORS="$PWD/../../tests/fixtures/library" MARGIN_LINK_VECTORS="$PWD/../../tests/fixtures/link-protocol.json" MARGIN_CONNECTOR_BIN="$CONNECTOR" "$BUILD/tests" || status=1
fi
if [ "$WHAT" = e2e ] || [ "$WHAT" = all ]; then
  app_page
  build e2e e2e.swift e2e-data.swift e2e-link.swift e2e-hosted.swift e2e-glue.swift e2e-split.swift e2e-resilience.swift e2e-themes.swift "$FAKE_SAFARI" "${SHELL_SOURCES[@]}"
  MARGIN_APP_ROOT="$PWD/../../dist/app" MARGIN_FAKE_EXTENSION="$PWD/fake-extension.mts" MARGIN_NODE="$NODE" "$BUILD/e2e" || status=1
fi
exit $status
