#!/bin/bash
# Re-run the whole WebKitGTK 2.52 iframe-shell test matrix.
#   needs: Xvfb on :99, /usr/bin/python3.12 with gi (Gtk 3.0, WebKit2 4.1), node, pdfinfo/pdftotext (poppler-utils)
#   usage: ./run-all.sh            -> results in out/*.jsonl (cleared first), console log in out/run-all.log
#          /usr/bin/python3.12 summarize-all.py > out/summary.txt   -> compact digest of all results
# Single scenario: ./wk.sh SCENARIO [--world margin|main] [--cfg JSON] [--no-shell] [--rules FILE]
#                  [--feature NavigationAPI=0] [--param k=v] [--size WxH] [--no-page-cache] [--out FILE]
# Files: wkserver.mjs (test site, ports 8931/8932), shell.js (top-frame content script), frame.js (all-frames part),
#        run.py (harness), scenarios.py (T1..T11 + extras), rules/*.json (content rule lists), *sum.py (pretty printers)
cd "$(dirname "$0")"
mkdir -p out tmp
rm -f out/*.jsonl out/*.pdf
./restart-server.sh
R() { local name=$1; shift; echo "=== $name: $*"; ./wk.sh "$@" --out "out/$name.jsonl"; }
SB='allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-top-navigation-by-user-activation allow-pointer-lock allow-presentation allow-storage-access-by-user-activation'
{
R smoke smoke
# T1 viewport
R T1 T1
R T1 T1base --no-shell
R T1 T1base --no-shell --size 732x584
R T1 T1 --world main
# T2 cookies
R T2 T2
R T2 T2x
# T3 same-origin navigation + URL/title sync
R T3 T3
R T3 T3 --world main
R NAV NAVSPA --no-shell
R NAV NAV
# T4 back/forward
R T4 T4 --param how=ui
R T4 T4 --param how=js
R BF BF --no-shell --param shell=0
R BF BF --param shell=1
R BF BF2
R BF BF2 --no-page-cache --param pc=0
R BF BFC --no-shell --param q=?__noshell=1
R BF BFC
R BF BFSKIP
R BF BFSKIP --param click=js
R BF-topmode T4 --cfg '{"histMode":"top"}' --param how=ui
R BF-topmode BF2 --cfg '{"histMode":"top"}'
R BF-topmode BFSKIP --cfg '{"histMode":"top"}'
R BF-topmode BFSKIP --cfg '{"histMode":"top"}' --param click=js
R BF-topmode BFSKIP2 --cfg '{"histMode":"top"}' --param pre=0
R BF-topmode BFSKIP2 --cfg '{"histMode":"top"}' --param pre=1
R BF BFSKIP2 --param pre=0
# T5 cross-origin escapes
for w in lX lO assign form lR lRD; do R T5 T5 --param which=$w --timeout 30000; done
R T5 T5dbg --param which=lRD --param wait=2500
for w in lX assign; do R T5-nonavapi T5 --feature NavigationAPI=0 --param which=$w --timeout 30000; done
# T6 frame busting
R T6 T6
R T6 T6 --cfg '{"navapi":false}'
R T6 T6 --feature NavigationAPI=0
R T6 T6 --feature NavigationAPI=0 --cfg "{\"navapi\":false,\"sandbox\":\"$SB\"}"
R T6 DUMP --param url='http://localhost:8931/p/A?owasp=1' --param wait=2000 --cfg '{"hiddenCheck":false}'
R T6 DUMP --param url='http://localhost:8931/p/A?owasp=1' --param wait=2000
# T7 framing headers
for q in 'xfo=SAMEORIGIN' 'fa=self' 'xfo=SAMEORIGIN&fa=self' 'xfo=DENY' 'fa=none'; do R T7 T7 --param "q=$q"; done
for r in xfo-remove xfo-set-allow response-only; do for q in 'xfo=DENY' 'fa=none'; do R T7-rules T7 --rules rules/$r.json --param "q=$q"; done; done
R T7-rules T7 --rules rules/req-top.json --param 'q=xfo=SAMEORIGIN'
R T7-rules T8 --no-shell --rules rules/control-block.json --param 'q=__noshell=1'
R T7-rules T8 --no-shell --rules rules/redirect.json --param 'q=__noshell=1'
R T7 T7 --param "q=tcsp=frame-src%20https://other.example"
R T7 T7 --world main --param "q=tcsp=frame-src%20https://other.example"
R T7 DUMP --param url="http://localhost:8931/p/A?tcsp=frame-src%20https://other.example" --param wait=150
R T7-dump-deny DUMP --param url='http://localhost:8931/p/A?xfo=DENY' --param wait=1500
# T8 top-level page scripts + cost of the double fetch
R T8 T8 --no-shell --param q=__noshell=1
R T8 T8
R T8 T8 --world main
R T8 T8 --cfg '{"stop":false}'
R T8-cache T8 --param q=cache=600
R T8 T8 --param 'q=big=300&linkpreload=1'
R T8 T8 --no-shell --param 'q=big=300&linkpreload=1&__noshell=1'
for d in 0 300; do R T8 T8timing --no-shell --param base=1 --param n=7 --param delay=$d; R T8 T8timing --param n=7 --param delay=$d; done
# T9 keyboard / focus
R T9 T9base --no-shell
R T9 T9
R T9 T9 --cfg '{"refocus":true}'
R T9 T9 --cfg '{"focus":"none"}'
R T9 T9 --cfg '{"focus":"element"}'
R T9 T9af --no-shell --param base=1
R T9 T9af
# T10 target=_top / _blank
R T10 T10
R T10 T10 --cfg '{"navapi":false}'
# extras: find-in-page, printing, fullscreen, isolated worlds, POST
R T11 T11 --no-shell --param base=1
R T11 T11
R PRINT PRINT --no-shell --param base=1
R PRINT PRINT --cfg '{"printFix":false}' --param tag=nofix
R PRINT PRINT
R FS FS
R ISO ISO
R POST POSTIN
R POST POSTFRAME
R REF REF
# page CSP vs the shell's own styles/iframe (the shell lives inside the page's document, so the page's CSP applies to it)
for q in "tcsp=style-src%20%27none%27" "tcsp=default-src%20%27self%27" "x=1"; do R CSPPROBE CSPPROBE --no-shell --param "q=$q"; done
for q in "tcsp=style-src%20%27none%27" "tcsp=default-src%20%27self%27" "tcsp=default-src%20%27none%27" "tcsp=frame-src%20%27none%27"; do R CSPSTYLE CSPSTYLE --param "q=$q"; done
for q in "tcsp=style-src%20%27none%27" "tcsp=default-src%20%27self%27"; do R CSPSTYLE CSPSTYLE --cfg '{"styleMode":"adopted"}' --param "q=$q"; done
} 2>&1 | tee out/run-all.log
