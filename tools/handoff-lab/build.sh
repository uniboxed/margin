#!/bin/bash
# Builds the handoff lab (tools/handoff-lab/lab.swift) into build/handoff-lab. It only compiles:
# nothing runs, nothing shows on screen. Running the lab is README.md's runbook.
#
# The lab is compiled with Margin.app's own files for the private calls and the steps built on
# them, so a gate run tests what ships, not a copy: PrivateCalls.swift (the launch check and the
# SkyLight wrappers), Freezer.swift (the freezer and its watchdog), SpaceReads.swift (the Space
# reads and the bridge), BridgeParker.swift (the parker and the cross-process self-test), and
# what those need (Diagnostics, WindowServer, ProfileSwitch's clock, LinkMessage's JSON).
# BridgeParker.swift ends with an `extension Shell` (the self-test's launch hook), and the lab has
# no Shell: that one block is left out of a copy in build/. If another file starts to need the
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
SHELL_DIR=../../app/macos/shell
PRIVATE_DIR=../../app/macos/private
SHARED=("$PRIVATE_DIR/PrivateCalls.swift" "$SHELL_DIR/Diagnostics.swift" "$PRIVATE_DIR/Freezer.swift" "$PRIVATE_DIR/SpaceReads.swift"
  "$SHELL_DIR/WindowServer.swift" "$SHELL_DIR/ProfileSwitch.swift" "$SHELL_DIR/LinkMessage.swift")
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

# BridgeParker.swift without its `extension Shell { … }` block (from that line to the next line
# that is a lone closing brace).
awk '/^extension Shell[ {]/ { skip = 1 } !skip { print } skip && /^}/ { skip = 0 }' "$PARKER" > "$BUILD/BridgeParker-lab.swift"
if grep -q '^extension Shell' "$BUILD/BridgeParker-lab.swift"; then
  echo "build.sh: couldn't leave BridgeParker.swift's extension Shell out" >&2; exit 1
fi

swiftc "${FLAGS[@]}" lab.swift "${SHARED[@]}" "$BUILD/BridgeParker-lab.swift" \
  -framework ScreenCaptureKit -framework WebKit -o "$OUT" || exit 1
codesign --force --sign - --options runtime "$OUT" 2>/dev/null || echo "build.sh: not signed (codesign failed): the lab still runs, without the hardened runtime" >&2
echo "built build/handoff-lab"
