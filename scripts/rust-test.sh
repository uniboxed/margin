#!/bin/sh
# npm run test:rust: the Rust workspace (Cargo.toml at the root: app/shared/core, app/shared/connector,
# app/platforms/windows, app/engines/chromium): formatted, no clippy warnings, every test, and the Windows targets
# compile-checked from here when rustup has them (x86_64-pc-windows-msvc, aarch64-pc-windows-msvc).
set -e
cd "$(dirname "$0")/.."
PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --all --check
cargo clippy -q --workspace --all-targets --locked -- -D warnings
cargo test -q --workspace --locked
installed=$(rustup target list --installed 2>/dev/null || true)
for target in x86_64-pc-windows-msvc aarch64-pc-windows-msvc; do
  if echo "$installed" | grep -qx "$target"; then
    cargo clippy -q --workspace --all-targets --locked --target "$target" -- -D warnings
    echo "ok   $target: compiles, no clippy warnings"
  else
    echo "skip $target: not installed (rustup target add $target)"
  fi
done
