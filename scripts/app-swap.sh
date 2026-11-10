# Putting a new Margin.app in place of the installed one (sourced by
# scripts/safari.sh; tests/app-swap.test.ts runs it against a stand-in in a
# temporary folder). The caller defines three steps first:
#   register_app DEST   the new copy made known to the system (lsregister, pluginkit)
#   safari_running      true while Safari runs
#   open_app DEST       the new copy started in the background
#
# swap_app NEW DEST:
#  1. The Margin.app processes running from DEST's executable are noted
#     (pgrep -x Margin, each one's executable path checked: never the build
#     folder's copy, nor Xcode's).
#  2. The old copy out of the way in one step (a rename), the new one in its
#     place (another), and the new one registered. Deleted in place, file by
#     file, Safari could read the extension half gone: its files no longer
#     matching their signature, it turned Margin off and blocked it
#     (WKWebExtensionErrorDomain 3, "Disabling and blocking extension",
#     real Safari, 2026-11-04).
#  3. Only then the noted processes are sent a SIGTERM (Margin.app quits as
#     when it's quit: the copies are told goodbye), waited for up to
#     MARGIN_QUIT_WAIT seconds (5), and any left are killed. Quit after the
#     swap, anything that starts Margin.app meanwhile (the extension handler,
#     as a copy asks for its link) starts the new build. Left running, the
#     old process went on answering the copies with links Safari refused
#     (SFErrorDomain 1), and the handler, seeing it, never started the new
#     one (real runs of 2026-11-05).
#  4. Only once they're gone, the old copy is deleted.
#  5. If one was running and Safari is, and nothing has started the new build
#     within MARGIN_START_WAIT seconds (2), it's started in the background
#     (open -g, never -j: a hidden Margin.app's overlays never show).

# The pids of the Margin.app processes whose executable is DEST's, one a line.
margin_running() {
  exe="$1/Contents/MacOS/Margin"
  for pid in $(pgrep -x Margin 2>/dev/null); do
    [ "$(ps -o comm= -p "$pid" 2>/dev/null)" = "$exe" ] && echo "$pid"
  done
  return 0
}

alive() { kill -0 "$1" 2>/dev/null; }

# quit_margin PID...: a SIGTERM, up to MARGIN_QUIT_WAIT seconds for each to
# end, then a SIGKILL for any left.
quit_margin() {
  [ $# -gt 0 ] || return 0
  for pid in "$@"; do
    if kill -TERM "$pid" 2>/dev/null; then echo "quit the running Margin.app (pid $pid)"; else echo "the running Margin.app (pid $pid) had already quit"; fi
  done
  tries=$(( ${MARGIN_QUIT_WAIT:-5} * 10 ))
  while [ "$tries" -gt 0 ]; do
    left=""
    for pid in "$@"; do alive "$pid" && left="$left $pid"; done
    [ -z "$left" ] && return 0
    sleep 0.1
    tries=$((tries - 1))
  done
  for pid in "$@"; do
    if alive "$pid"; then
      kill -KILL "$pid" 2>/dev/null && echo "Margin.app (pid $pid) didn't quit in ${MARGIN_QUIT_WAIT:-5} s: killed"
    fi
  done
  # Gone before its bundle is: a moment for the kill to land.
  tries=20
  while [ "$tries" -gt 0 ]; do
    left=""
    for pid in "$@"; do alive "$pid" && left="$left $pid"; done
    [ -z "$left" ] && return 0
    sleep 0.1
    tries=$((tries - 1))
  done
  return 0
}

# A Margin.app running from DEST that isn't one of the pids given.
margin_started() {
  dest=$1
  shift
  for pid in $(margin_running "$dest"); do
    case " $* " in *" $pid "*) ;; *) return 0 ;; esac
  done
  return 1
}

swap_app() {
  new=$1
  dest=$2
  # shellcheck disable=SC2046
  set -- $(margin_running "$dest")
  [ -d "$dest" ] && mv "$dest" "$dest.old"
  mv "$new" "$dest"
  register_app "$dest"
  quit_margin "$@"
  rm -rf "$dest.old"
  if [ $# -gt 0 ] && safari_running; then
    tries=$(( ${MARGIN_START_WAIT:-2} * 10 ))
    while [ "$tries" -gt 0 ]; do
      if margin_started "$dest" "$@"; then
        echo "the new Margin.app was started for Safari"
        return 0
      fi
      sleep 0.1
      tries=$((tries - 1))
    done
    open_app "$dest" && echo "started the new Margin.app in the background"
  elif [ $# -gt 0 ] && command -v open_watch >/dev/null 2>&1; then
    # Running with no Safari (waiting for a browser to open, as a login item): the new one waits the same way.
    open_watch "$dest" && echo "started the new Margin.app, waiting for a browser to open"
  fi
  return 0
}
