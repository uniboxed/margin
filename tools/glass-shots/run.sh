#!/bin/bash
# Pictures of a theme with macOS's real materials (Liquid Glass; any theme's Edit Theme Color), with nothing on screen.
#   tools/glass-shots/run.sh [out dir] [theme id]      (default: <tmp>/margin-glass-shots, liquid-glass)
# For each state (sidebar, palette, menu, editor, notice, launcher, loading: the page card while an item opens,
# starting: the theme before its first data, and picker: Edit Theme Color open, its glass), in light and dark, in two
# spaces: the window server's picture of an off-screen window (shot.swift), <out>/glass-<state>-<space>-<mode>.png
# at 1512 × 982 (2× where the Mac has a Retina display), and the material layers' boxes, checked: none past the
# window's sides, none larger than the largest panel the theme draws. Needs macOS 26 or later (older: the plain look,
# said so). Never part of `npm run gate`: it needs a window server, and a person to look at the pictures.
set -eu
cd "$(dirname "$0")"
OUT="${1:-${TMPDIR:-/tmp}/margin-glass-shots}"
THEME="${2:-liquid-glass}"
NODE="${NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
mkdir -p build "$OUT"
if [ ! -x build/shot ] || [ shot.swift -nt build/shot ]; then swiftc -O -suppress-warnings shot.swift -o build/shot; fi
PAGES="$(mktemp -d)"
trap 'rm -rf "$PAGES"' EXIT
"$NODE" pages.mts "$PAGES" "$THEME" >/dev/null
status=0
for state in sidebar palette menu editor notice launcher loading starting picker; do
  for look in work-light studio-dark personal-light; do
    name="$state-$look"
    log="$(build/shot "$PAGES/$name.html" --size 1512x982 --"${look##*-}" --best --layers --capture "$OUT/glass-$name.png")"
    layers="$(echo "$log" | sed -n 's/^material layers: //p')"
    # A layer past the window's sides, or wider than the command bar (680): something reaches past a glass element's
    # box. (Above or below the window is fine: the lit tab scrolled out of its list keeps its layer there, undrawn.)
    wide="$(echo "$log" | awk '/^  [0-9-]/ { split($1, at, ","); split($2, wh, "×"); if (at[1] < 0 || at[1] + wh[1] > 1512 || wh[1] > 680 || wh[2] > 982) print }')"
    if [ -n "$wide" ]; then echo "FAIL $name: a material layer larger than its element:"; echo "$wide"; status=1
    elif [ "${layers:-0}" = 0 ]; then echo "note $name: no material layer (the plain look: macOS before 26, or the theme uses none)"
    else echo "ok   $name: $layers material layers, each within its element's box"; fi
  done
done
echo "pictures in $OUT"
exit $status
