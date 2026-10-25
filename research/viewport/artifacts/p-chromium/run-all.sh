#!/bin/sh
# Same-origin iframe-shell prototype: re-run everything.
#   cd /tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/p-chromium
#   ./run-all.sh                 # T1..T13 in Chromium + the WebKitGTK T7 probe   (~4 min)
#   node run.mjs T1 T5           # selected Chromium tests only (server is started by run.mjs)
#   T8_RUNS=9 node run.mjs T8    # more timing samples
#   HEADFUL=1 DISPLAY=:99 node run.mjs T1   # headful Chromium on the X server
# Results: results/<T>.json (+ PNG screenshots), results/run-all.stdout.txt, results/T7-webkitgtk.txt
# Versions measured: Playwright 1.63.0 / Chrome for Testing 153.0.8010.12, WebKitGTK 2.52.6. Chromium part: real unpacked MV3 extension (ext/) in Playwright's Chromium.
# WebKitGTK part: content-rule-list modify-headers probe for T7 (needs DISPLAY=:99 X server).
set -e
cd "$(dirname "$0")"
node run.mjs "$@" 2>run.stderr.log | tee results/run-all.stdout.txt
if [ $# -eq 0 ] || echo "$*" | grep -q T7; then
  node server.mjs > /dev/null 2>&1 &
  SRV=$!
  sleep 1
  curl -sS "http://localhost:8921/__log?clear=1" > /dev/null
  DISPLAY=${DISPLAY:-:99} sh wk/run-wk.sh | tee results/T7-webkitgtk.txt
  kill $SRV
fi
