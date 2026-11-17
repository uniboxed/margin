#!/bin/bash
# The real-screen suite (README.md; docs/HOSTING-CORE.md): npm run test:screen [-- options].
# Builds Chameleon's copies (apps/Chameleon/build.sh) and the suite (suite/*.swift), prints the whole plan, then runs each
# part in its own process under a hard 10-minute limit: past it the part is stopped (SIGTERM: it puts everything back
# itself; if it doesn't end within 60 s, it's killed and `--restore` puts the Mac back from its state file). Each part
# refuses to start unless the Mac has been idle 180 s and isn't locked, and stops at the first sign of the person.
# NEVER in CI: it needs the real screen, and nobody at the Mac.
#   run.sh [--dry-run] [--real-apps] [--part <name>] [--margin /path/to/Margin.app] [--front level|order] [--restore]
#   --dry-run    the plan only (every part's scenarios and steps, what it touches): nothing is touched
#   --real-apps  adds the part with the person's own apps (RealApps.swift's list; off by default)
#   --part       one part only (core, behaviours-1…, real-apps)
#   --margin     the built Margin.app (default: xcode/build/Build/Products/Release/Margin.app, scripts/safari.sh's)
#   --restore    puts the Mac back from the state file of a part that was killed (nothing else)
# Logs: build/logs/<time>-<part>.log, a summary of every part at the end. Exit 0: every part passed.
set -u
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$PATH"
HERE="$PWD"
ROOT="$(cd ../.. && pwd)"
BUILD="${MARGIN_SCREEN_BUILD:-$HERE/build}"
MARGIN="$ROOT/xcode/build/Build/Products/Release/Margin.app"
DRY=0 RESTORE=0 ONLY=""
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --margin) MARGIN="$2"; shift 2 ;;
    --part) ONLY="$2"; shift 2 ;;
    --front) PASS+=(--front "$2"); shift 2 ;;
    --real-apps) PASS+=(--real-apps); shift ;;
    --dry-run) DRY=1; shift ;;
    --restore) RESTORE=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (run.sh --help)" >&2; exit 64 ;;
  esac
done
mkdir -p "$BUILD/logs"
apps/Chameleon/build.sh 3 "$BUILD/apps" || exit 1
SUITE_BIN="$BUILD/screen-suite"
if [ ! -x "$SUITE_BIN" ] || [ -n "$(find suite apps/Chameleon/Switches.swift -name '*.swift' -newer "$SUITE_BIN" 2>/dev/null)" ]; then
  swiftc -O -swift-version 5 suite/*.swift apps/Chameleon/Switches.swift -o "$SUITE_BIN" || exit 1
fi
SUITE=("$SUITE_BIN" --build "$BUILD" --apps "$BUILD/apps" --margin "$MARGIN" ${PASS[@]+"${PASS[@]}"})
if [ "$RESTORE" = 1 ]; then exec "${SUITE[@]}" --restore; fi
# What it will do, first.
"${SUITE[@]}" --dry-run ${ONLY:+--part "$ONLY"}
[ "$DRY" = 1 ] && exit 0
PARTS=$("${SUITE[@]}" --list-parts)
[ -n "$ONLY" ] && PARTS=$(echo "$PARTS" | grep -x "$ONLY")
[ -z "$PARTS" ] && { echo "no such part: $ONLY" >&2; exit 64; }
status=0
SUMMARIES=()
for part in $PARTS; do
  log="$BUILD/logs/$(date +%Y%m%d-%H%M%S)-$part.log"
  echo "== part $part: $log"
  "${SUITE[@]}" --part "$part" > "$log" 2>&1 &
  pid=$!
  for _ in $(seq 1 600); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then
    echo "part $part still running after 10 min: stopped (it puts everything back)" | tee -a "$log"
    kill -TERM "$pid"
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; echo "killed: putting the Mac back from its state file" | tee -a "$log"; "${SUITE[@]}" --restore >> "$log" 2>&1; fi
    code=99
  else
    wait "$pid"; code=$?
  fi
  line=$(grep "SUMMARY:" "$log" | tail -1)
  echo "   exit $code ${line:-$(tail -1 "$log")}"
  SUMMARIES+=("$part (exit $code): ${line:-$(tail -1 "$log")}")
  [ "$code" = 0 ] || status=1
  # Refused (in use or locked), stopped by the person, aborted: no further part.
  case "$code" in 3|6|7|64|99) echo "stopping: part $part ended with $code"; break ;; esac
done
echo "== summary"
for s in "${SUMMARIES[@]}"; do echo "  $s"; done
exit $status
