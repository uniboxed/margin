#!/bin/bash
# Margin's own log lines from the system log: Margin.app's (category shell),
# the extension's link events passed on by its handler (category extension),
# and the handler's own. Usage: scripts/margin-log.sh [minutes, default 30] [--stream]
set -euo pipefail
MIN="${1:-30}"
PRED='subsystem == "io.tirth.margin" OR (process == "Margin Extension" AND eventMessage BEGINSWITH "Margin:")'
if [ "${2:-}" = "--stream" ] || [ "$MIN" = "--stream" ]; then
  exec /usr/bin/log stream --style compact --predicate "$PRED"
fi
/usr/bin/log show --last "${MIN}m" --style compact --predicate "$PRED" | grep -v -E ' (e2e|link-server)\[' || true
