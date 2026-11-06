# The installed Margin.app's signing against the build's (sourced by
# scripts/safari.sh; tests/signing-check.test.js runs it with a stand-in for
# codesign). Safari keys an extension's state in each profile by its bundle id
# and team ("<bundle id> (<team>)", or "(UNSIGNED)" for an ad-hoc build), so
# a build signed by another team, or unsigned over a signed one, is a new
# extension to it: in every named profile (all but the default one) Margin's
# copy gets a new id and its spaces start fresh there. Margin.app carries a
# profile's spaces over to the new id when it has Full Disk Access and has
# read Safari's profiles before (DECISIONS.md "Margin 2: Safari reliability").
#
# installed_team APP     the TeamIdentifier codesign gives APP's extension
#                        ("not set" for an ad-hoc build; nothing if it can't say)
# confirm_signing DEST NEW YES
#                        NEW: the build's team, or "not set" (--unsigned). When
#                        DEST is installed and signed otherwise, a warning, then
#                        a question (y to go on), unless YES is true. 0: go on.

installed_team() {
  appex="$1/Contents/PlugIns/Margin Extension.appex"
  [ -d "$appex" ] || appex="$1"
  ${CODESIGN:-codesign} -dv "$appex" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -n 1
}

signed_as() {
  if [ "$1" = "not set" ]; then echo "unsigned (ad hoc)"; else echo "with team $1"; fi
}

confirm_signing() {
  [ -d "$1" ] || return 0
  installed=$(installed_team "$1")
  [ -n "$installed" ] || return 0
  [ "$installed" = "$2" ] && return 0
  cat >&2 <<WARN
warning: the installed Margin.app is signed $(signed_as "$installed"), and this build would be signed $(signed_as "$2").
Safari takes a build signed otherwise for another extension: in each named profile
(every one but the default) Margin gets a new id, so its spaces start fresh there.
Margin.app carries them over if it has Full Disk Access and read Safari's profiles
while the installed build ran; otherwise they stay with the old build's id.
WARN
  if [ "$3" = true ]; then
    echo "Going on (--yes)." >&2
    return 0
  fi
  printf 'Build and install it anyway? [y/N] ' >&2
  answer=""
  read -r answer || true
  case "$answer" in
    y | Y | yes | YES) return 0 ;;
    *) echo "Stopped: nothing was built or installed. (npm run safari -- --yes goes on without asking.)" >&2; return 1 ;;
  esac
}
