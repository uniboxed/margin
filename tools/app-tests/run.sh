#!/bin/bash
# Margin.app's shell (app/shell/), tested with no browser: npm run test:app.
#   unit: tests.swift, the shell's logic on its own (no window, no link)
#   e2e:  e2e.swift, the real link, shell and overlays (off screen, in an
#         accessory app that never activates) against a stand-in for the
#         extension (fake-extension.mjs, Node), and a picture of the overlay
#         drawing Arcadia (MARGIN_APP_SHOT, default build/overlay.png)
# Built with swiftc as the app target builds it (Swift 5, main actor by
# default), no XCTest. Exits 1 if a check failed. Nothing shows on screen and
# nothing reaches Safari. ./run.sh [unit|e2e|all] (default all).
set -u
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

status=0
if [ "$WHAT" = unit ] || [ "$WHAT" = all ]; then
  build tests tests.swift "${SHELL_SOURCES[@]}"
  "$BUILD/tests" || status=1
fi
if [ "$WHAT" = e2e ] || [ "$WHAT" = all ]; then
  [ -f ../../dist/app/overlay.js ] || { echo "dist/app/ is missing: run npm run build" >&2; exit 1; }
  build e2e e2e.swift "${SHELL_SOURCES[@]}"
  MARGIN_APP_ROOT="$PWD/../../dist/app" MARGIN_FAKE_EXTENSION="$PWD/fake-extension.mjs" MARGIN_NODE="$NODE" \
    MARGIN_APP_SHOT="${MARGIN_APP_SHOT:-$BUILD/overlay.png}" "$BUILD/e2e" || status=1
fi
exit $status
