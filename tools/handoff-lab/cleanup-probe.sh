#!/bin/bash
# Build by default. --go runs only this probe's owned, verified off-screen panels.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
swiftc -swift-version 5 -default-isolation MainActor \
  -enable-upcoming-feature InferIsolatedConformances -enable-upcoming-feature NonisolatedNonsendingByDefault \
  -parse-as-library cleanup-probe.swift ../../app/platforms/macos/private/CoverPresentation.swift \
  build/lab-src/*.swift -framework AppKit -framework WebKit -o build/cleanup-probe
if [ "${1:-}" = "--go" ]; then build/cleanup-probe; else echo "built only; --go runs owned off-screen component checks"; fi
