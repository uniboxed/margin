#!/bin/bash
# usage: fetch.sh path/in/repo ... -> saves to src/<basename>
D=/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-parity/src
for p in "$@"; do
  f="$D/$(basename "$p")"
  if [ ! -s "$f" ]; then
    code=$(curl -sS -o "$f" -w '%{http_code}' "https://raw.githubusercontent.com/WebKit/WebKit/main/$p")
    echo "$code $(wc -l < "$f") $p"
    [ "$code" != 200 ] && rm -f "$f"
  else echo "cached $p"; fi
done
