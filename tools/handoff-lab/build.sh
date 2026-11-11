#!/bin/bash
# Builds the handoff lab (tools/handoff-lab/lab.swift) into build/handoff-lab. It only compiles:
# nothing runs, nothing shows on screen. Running the lab is README.md's runbook.
#
# The lab is compiled with Margin.app's own files for the private calls and the steps built on
# them, so a gate run tests what ships, not a copy: PrivateCalls.swift (the launch check and the
# SkyLight wrappers), Freezer.swift (the freezer and its watchdog), SpaceReads.swift (the Space
# reads and the bridge), BridgeParker.swift (the parker and the cross-process self-test), and
# what those need (Diagnostics, WindowServer, ProfileSwitch's clock and the switch's notices, LinkMessage's
# JSON, Handoff and WindowMatcher's window keys, Parking's registry and the data files it sits beside: DataStore,
# DataSet, Chunks; DevHooks, the dev-only hook's state).
# BridgeParker.swift and Parking.swift end with an `extension Shell` (the launch hooks), and the lab
# has no Shell: those blocks are left out of copies in build/. If another file starts to need the
# shell, this build fails and says which name is missing.
#
# Settings: the app target's (Swift 5, main actor by default), so the shared files compile here
# exactly as they do in the app. The binary is signed ad hoc with the hardened runtime, as
# Margin.app is (gate G1's lab half runs hardened too).
#   ./build.sh            build (only when a source changed)
#   ./build.sh --force    build again
set -u
cd "$(dirname "$0")"
BUILD="$PWD/build"
mkdir -p "$BUILD"
SHELL_DIR=../../app/platforms/macos/shell
PRIVATE_DIR=../../app/platforms/macos/private
SHARED=("$PRIVATE_DIR/PrivateCalls.swift" "$SHELL_DIR/Diagnostics.swift" "$PRIVATE_DIR/Freezer.swift" "$PRIVATE_DIR/SpaceReads.swift"
  "$PRIVATE_DIR/LiveCoverSpace.swift"
  "$SHELL_DIR/HandoffCover.swift"
  "$SHELL_DIR/WindowServer.swift" "$SHELL_DIR/ProfileSwitch.swift" "$SHELL_DIR/LinkMessage.swift" "$SHELL_DIR/Handoff.swift" "$SHELL_DIR/WindowMatcher.swift"
  "$SHELL_DIR/Parking.swift" "$SHELL_DIR/DataStore.swift" "$SHELL_DIR/DataSet.swift" "$SHELL_DIR/Chunks.swift" "../../app/engines/webkit/safari/DevHooks.swift")
PARKER="$PRIVATE_DIR/BridgeParker.swift"
FLAGS=(-swift-version 5 -default-isolation MainActor -enable-upcoming-feature InferIsolatedConformances -enable-upcoming-feature NonisolatedNonsendingByDefault -parse-as-library)

for f in lab.swift "${SHARED[@]}" "$PARKER"; do
  [ -f "$f" ] || { echo "build.sh: $f is missing" >&2; exit 1; }
done

OUT="$BUILD/handoff-lab"
if [ "${1:-}" != "--force" ] && [ -x "$OUT" ] && [ -z "$(find lab.swift "${SHARED[@]}" "$PARKER" -newer "$OUT" 2>/dev/null)" ]; then
  echo "build/handoff-lab is up to date"
  exit 0
fi

# Each shared file without its `extension Shell { … }` blocks (from that line to the next line
# that is a lone closing brace): copies in build/lab-src/, the app's files untouched.
rm -rf "$BUILD/lab-src" && mkdir -p "$BUILD/lab-src"
LAB_SOURCES=()
for f in "${SHARED[@]}" "$PARKER"; do
  copy="$BUILD/lab-src/$(basename "$f")"
  awk '/^extension Shell[ {:]/ { skip = 1 } !skip { print } skip && /^}/ { skip = 0 }' "$f" > "$copy"
  if grep -q '^extension Shell' "$copy"; then
    echo "build.sh: couldn't leave $(basename "$f")'s extension Shell out" >&2; exit 1
  fi
  LAB_SOURCES+=("$copy")
done

swiftc "${FLAGS[@]}" lab.swift "${LAB_SOURCES[@]}" \
  -framework ScreenCaptureKit -framework WebKit -o "$OUT" || exit 1
codesign --force --sign - --options runtime "$OUT" 2>/dev/null || echo "build.sh: not signed (codesign failed): the lab still runs, without the hardened runtime" >&2
echo "built build/handoff-lab"
