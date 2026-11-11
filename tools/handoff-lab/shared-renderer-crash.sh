#!/bin/bash
# Root-serialized build only; default is a no-window/no-signal dry run.
set -euo pipefail
cd "$(dirname "$0")"
case "${1:---dry-run}" in
  --dry-run) exec python3 shared-renderer-crash.py --dry-run ;;
  --build)
    mkdir -p build
    sources=()
    while read -r folder; do
      case "$folder" in ''|'#'*) continue ;; esac
      sources+=(../../"$folder"/*.swift)
    done < ../../app/platforms/macos/swift-sources.txt
    node native-cover-fixture.mts arcadia > build/shared-renderer-crash-hello.json
    swiftc -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" -swift-version 5 -default-isolation MainActor \
      -enable-upcoming-feature InferIsolatedConformances \
      -enable-upcoming-feature NonisolatedNonsendingByDefault -parse-as-library \
      shared-renderer-crash.swift "${sources[@]}" -framework AppKit -framework WebKit \
      -o build/shared-renderer-crash
    codesign --force --sign - --options runtime build/shared-renderer-crash
    python3 shared-renderer-crash.py --stamp
    echo "Built only; no process crashed and no windows created."
    ;;
  --go) shift; exec python3 shared-renderer-crash.py --go "$@" ;;
  *) echo "Use --dry-run (default), root-serialized --build, or explicit owned/offscreen --go." >&2; exit 2 ;;
esac
