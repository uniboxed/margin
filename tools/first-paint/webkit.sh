#!/bin/bash
# Every first-paint scenario (fp-*) on the WebKit host (tools/webkit-host, off
# screen), then their summary (webkit-summary.mjs). Run `npm run build` first.
# Usage: tools/first-paint/webkit.sh [out dir] [rounds] [name filter]
set -u
cd "$(dirname "$0")"
OUT="${1:-${TMPDIR:-/tmp}/margin-fp-webkit}"
ROUNDS="${2:-1}"
FILTER="${3:-}"
NODE=$(command -v node || echo /opt/homebrew/bin/node)
mkdir -p "$OUT"
NAMES=$("$NODE" -e "import('../webkit-host/scenarios.mjs').then((m) => console.log(Object.keys(m.SCENARIOS).filter((k) => k.startsWith('fp-') && k.includes('$FILTER')).join(' ')))")
for round in $(seq 1 "$ROUNDS"); do
  for name in $NAMES; do
    ../webkit-host/run.sh "$name" > "$OUT/$name-$round.log" 2>&1
  done
done
"$NODE" webkit-summary.mjs "$OUT"/fp-*.log
