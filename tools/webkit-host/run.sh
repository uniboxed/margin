#!/bin/bash
# Runs a scenario (scenarios.mjs) on the WebKit host against Margin's Safari
# build: ./run.sh <scenario> | ./run.sh all | ./run.sh path/to/scenario.json
# Exits 1 if a check failed. Nothing shows on screen. Run `npm run build` first.
# Several runs can go at once with their own MARGIN_HOST_PORT (default 47811)
# and MARGIN_HOST_BUILD (default build/); MARGIN_HOST_TIMEOUT: seconds per run.
set -u
cd "$(dirname "$0")"
BUILD="${MARGIN_HOST_BUILD:-$PWD/build}" # absolute: WebKit loads the extension from a file URL
PORT="${MARGIN_HOST_PORT:-47811}"
export MARGIN_HOST_PORT=$PORT
NODE=$(command -v node || echo /opt/homebrew/bin/node)
mkdir -p "$BUILD"

# The host program, rebuilt when host.swift changes.
if [ ! -x "$BUILD/host" ] || [ host.swift -nt "$BUILD/host" ]; then
  swiftc -O host.swift -o "$BUILD/host" || exit 1
fi

# A test copy of dist/safari whose console output goes to the page server
# (hook.js, prepended to the background and content bundles).
rm -rf "$BUILD/ext" && cp -R ../../dist/safari "$BUILD/ext"
for f in background.bundle.js content/content.bundle.js; do
  sed "s/__PORT__/$PORT/" hook.js | cat - "$BUILD/ext/$f" > "$BUILD/ext/$f.tmp" && mv "$BUILD/ext/$f.tmp" "$BUILD/ext/$f"
done

run_one() {
  local name=$1 status
  if [[ "$name" == *.json ]]; then
    cp "$name" "$BUILD/scenario.json" && name=scenario
  else
    "$NODE" scenarios.mjs "$name" > "$BUILD/$name.json" || return 2
  fi
  "$NODE" server.mjs > "$BUILD/server.log" 2>&1 &
  local server=$!
  sleep 0.5
  "$BUILD/host" "$BUILD/ext" "http://127.0.0.1:$PORT" "$BUILD/$name.json" > "$BUILD/host.log" 2>&1
  status=$?
  kill "$server" 2>/dev/null
  echo "=== $name"
  cat "$BUILD/host.log"
  echo "--- Margin's console"
  grep -v "server on" "$BUILD/server.log"
  return $status
}

if [ "${1:-}" = all ]; then
  failed=0
  for name in $("$NODE" -e "import('./scenarios.mjs').then((m) => console.log(Object.keys(m.SCENARIOS).join(' ')))"); do
    run_one "$name" || failed=1
  done
  exit $failed
fi
run_one "${1:?usage: run.sh <scenario>|all}"
