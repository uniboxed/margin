#!/bin/bash
# Re-runs every UX-parity check; raw JSON lines go to results.jsonl
cd "$(dirname "$0")"; : > results.jsonl
r() { env "$@" DISPLAY=:99 timeout 60 /usr/bin/python3.12 run.py $ARGS 2>&1 | grep '^{"test' >> results.jsonl; }
for m in top shell; do
  for t in autofocus textfrag ads navapi otherext ctrlclick close sjis; do ARGS="$m $t 1" r X=1; done
  for pc in 0 1; do ARGS="$m restore $pc" r X=1; done
  ARGS="$m login 1 hidden" r X=1
  for st in 0 1; do ARGS="$m bu 1" r STAY=$st; done
done
ARGS="shell login 1 typed" r X=1
for m in top shell; do ARGS="$m flash 1" r GAP=1500 SIDEBAR=1; ARGS="$m flash 1" r GAP=0 CSS=800 SIDEBAR=1; ARGS="$m flash 1" r GAP=200 SIDEBAR=1; done
ARGS="shell flash 1" r GAP=1500 SIDEBAR=0; ARGS="shell flash 1" r GAP=0 CSS=800 SIDEBAR=0
ARGS="shell flash 1" r GAP=1500 SIDEBAR=1 HOLD=1; ARGS="shell flash 1" r GAP=0 CSS=800 SIDEBAR=1 HOLD=1
echo DONE >> results.jsonl
