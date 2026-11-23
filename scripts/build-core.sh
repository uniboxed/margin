#!/bin/sh
# margin-ffi (app/platforms/macos/ffi/: margin-core's hosting core behind a C interface) as the static library Margin.app's
# Swift links through `import MarginCore` (app/platforms/macos/ffi/include/module.modulemap's `link "margin_ffi"`).
#   sh scripts/build-core.sh            both kinds of Mac (macOS 14 or later), lipo'd: what scripts/safari.sh links
#   sh scripts/build-core.sh host       this Mac's only: what tools/app-tests/run.sh links (faster)
# Prints the folder that holds libmargin_ffi.a.
set -e
cd "$(dirname "$0")/.."
CARGO="${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}"
if [ "${1:-universal}" = host ]; then
  MACOSX_DEPLOYMENT_TARGET=14.0 "$CARGO" build -q --release --locked -p margin-ffi
  echo "$PWD/target/release"
  exit 0
fi
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  MACOSX_DEPLOYMENT_TARGET=14.0 "$CARGO" build -q --release --locked -p margin-ffi --target "$target"
done
OUT=target/universal-apple-darwin/release
mkdir -p "$OUT"
lipo -create target/aarch64-apple-darwin/release/libmargin_ffi.a target/x86_64-apple-darwin/release/libmargin_ffi.a -output "$OUT/libmargin_ffi.a"
echo "$PWD/$OUT"
