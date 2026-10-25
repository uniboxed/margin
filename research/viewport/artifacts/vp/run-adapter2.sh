#!/bin/sh
# Run adapter2.html in Chromium and WebKitGTK; both print the page title (JSON results).
D=$(dirname "$0")
node "$D/title-chromium.mjs" "file://$D/adapter2.html"
echo "webkit: $(DISPLAY=:99 /usr/bin/python3.12 "$D/wktitle.py" "file://$D/adapter2.html" 2>/dev/null)"
