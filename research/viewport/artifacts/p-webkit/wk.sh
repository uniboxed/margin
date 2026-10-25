#!/bin/bash
# wrapper: ./wk.sh SCENARIO [run.py args...]
export DISPLAY=:99 GDK_CORE_DEVICE_EVENTS=1 NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
cd "$(dirname "$0")"
timeout 120 /usr/bin/python3.12 -W ignore run.py "$@" 2>&1 | grep -v -E 'libEGL|DRI3'
