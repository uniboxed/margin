#!/bin/bash
# (re)start the test server (ports 8931/8932); named wkserver.mjs so other agents' "server.mjs" kill patterns don't hit it
cd "$(dirname "$0")"
for pid in $(pgrep -x node); do if tr '\0' ' ' < /proc/$pid/cmdline | grep -q wkserver; then kill $pid; fi; done
(nohup node wkserver.mjs > server.log 2>&1 &)
sleep 1; cat server.log
