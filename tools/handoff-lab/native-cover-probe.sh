#!/bin/bash
# No-argument/default is a fixed, window-free dry run. Builds are root-serialized.
set -euo pipefail
cd "$(dirname "$0")"
case "${1:---dry-run}" in
  --dry-run)
    exec python3 native-cover-run.py --dry-run
    ;;
  --build)
    mkdir -p build
    sources=()
    while read -r folder; do
      case "$folder" in ''|'#'*) continue ;; esac
      sources+=(../../"$folder"/*.swift)
    done < ../../app/platforms/macos/swift-sources.txt
    node native-cover-fixture.mts > build/native-cover-hello.json
    swiftc -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" -swift-version 5 -default-isolation MainActor \
      -enable-upcoming-feature InferIsolatedConformances \
      -enable-upcoming-feature NonisolatedNonsendingByDefault -parse-as-library \
      native-cover-probe.swift "${sources[@]}" -framework AppKit -framework WebKit \
      -o build/native-cover-probe
    codesign --force --sign - --options runtime build/native-cover-probe
    python3 native-cover-run.py --stamp
    echo "Built only. No corner panel or private write ran."
    ;;
  --go)
    shift
    exec python3 native-cover-run.py --go "$@"
    ;;
  *)
    echo "Use --dry-run (default), --build (root-serialized only), or --go --approved-corner --mode MODE after approval." >&2
    exit 2
    ;;
esac
