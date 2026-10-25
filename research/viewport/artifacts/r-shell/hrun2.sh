#!/bin/bash
D=/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-shell
for u in "/p?mode=tsrcdoc2&tag=h4" "/p?mode=tsrcdoc2&tag=h5&pagenav=1&interceptnav=1"; do
  DISPLAY=:99 /usr/bin/python3.12 -I $D/wkrun.py http://127.0.0.1:$1 "$u" 2>/dev/null
done
