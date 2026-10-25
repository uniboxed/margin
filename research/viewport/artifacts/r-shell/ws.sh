#!/bin/bash
# usage: ws.sh PORT command...   (starts the test server for the duration of the command)
D=/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-shell
PORT=$1; shift
node $D/server.mjs $PORT > $D/server-$PORT.log 2>&1 &
SP=$!
for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:$PORT/clear && break; sleep 0.1; done
"$@"
kill $SP 2>/dev/null
