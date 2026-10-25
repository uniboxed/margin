#!/bin/bash
# usage: wk-matrix.sh [rules.json]  -- runs S1..S4 in WebKitGTK, optionally with a content rule list
cd "$(dirname "$0")"
V=http://127.0.0.1:8871; EVIL=http://127.0.0.1:8872; ATT=http://localhost:8871; AD=http://localhost:8872
enc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"; }
T=""; A=""; for n in ${NAMES:-deny same fanone faself both}; do T="$T,$V/t/$n"; A="$A,$AD/ad?f=$(enc $V/t/$n)"; done; T=${T#,}; A=${A#,}
RULES=(); [ -n "$1" ] && RULES=(--rules "$1")
for s in "S1_shell_sameOrigin $V/shell?f=$(enc "$T")" "S2_crossSiteAttacker $ATT/shell?f=$(enc "$T")" "S3_sameSiteOtherOrigin $EVIL/shell?f=$(enc "$T")" "S4_3pFrameInsideVictimTop $V/shell?f=$(enc "$A")"; do
  set -- $s
  out=$(DISPLAY=:99 WAIT=3500 timeout 60 /usr/bin/python3.12 wkframe.py "$2" "${RULES[@]}" 2>/dev/null | tail -1)
  echo "$1 $(echo "$out" | python3 -c "
import sys,json,re
d=json.loads(sys.stdin.read()); t=d['title']
try:
  o=json.loads(t); o={re.sub(r'.*%2Ft%2F','',k):v.split('@')[0] for k,v in o.items() if k!='_violations'}
except Exception as e: o=t
print('filter=',d['filter'],o)")"
done
