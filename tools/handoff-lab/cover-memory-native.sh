#!/bin/bash
# Default is window-free and does not build. --build must be root-serialized.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 cover-memory-native.py "$@"
