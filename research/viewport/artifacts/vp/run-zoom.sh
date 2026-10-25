#!/bin/sh
# Compare push vs zoom-to-fit in Chromium and WebKitGTK.
D=$(dirname "$0")
node "$D/run-zoom.mjs" "$D"
for m in push zoom; do
  echo "webkit $m: $(DISPLAY=:99 /usr/bin/python3.12 "$D/wktitle.py" "file://$D/zoomfit.html?mode=$m" 2>/dev/null)"
done
