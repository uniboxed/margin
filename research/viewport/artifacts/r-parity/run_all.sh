#!/bin/bash
# Re-runs every WebKitGTK parity test; output -> out/results.txt
cd /tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-parity
P="env DISPLAY=:99 timeout 120 /usr/bin/python3.12"
{
echo "# WebKitGTK $(/usr/bin/python3.12 -c "import gi;gi.require_version('WebKit2','4.1');from gi.repository import WebKit2 as W;print(W.get_major_version(),W.get_minor_version(),W.get_micro_version())" 2>/dev/null)  $(date -u)"
for m in top nofocus focus; do echo "## t_focus.py $m"; $P t_focus.py $m; done
for m in top shell; do echo "## t_perms.py $m"; $P t_perms.py $m; done
echo "## t_perms.py shell (no allowfullscreen attr)"; $P t_perms.py shell "data-x=1" | grep "static\|fullscreen"
echo "## t_perms.py shell (allow=... 'none')"; $P t_perms.py shell "allow=\"fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'\"" | head -8
echo "## t_storage.py (default policy)"; $P t_storage.py
echo "## t_storage.py itp + NO_THIRD_PARTY"; $P t_storage.py itp
for c in find zoom selectall beforeunload download post fetchmeta; do echo "## t_ui.py $c"; $P t_ui.py $c; done
echo "## t_chrome1.py (title/theme-color/favicon, fresh profile each)"
for u in /page /shell "/shell?copy=1" "/shell?p_copyearly=1"; do $P t_chrome1.py "$u"; done
echo "## t_print.py (main-frame print to PDF)"
$P t_print.py /page top
$P t_print.py /shell shell
$P t_print.py /shell shell-printcss "const s=document.createElement('style');s.textContent='@media print{#side{display:none} #f{position:static;width:100%;height:100%}}';document.head.appendChild(s);1"
$P t_print.py /shell shell-tall-iframe "const s=document.createElement('style');s.textContent='@media print{html,body{overflow:visible!important;height:auto!important} #side{display:none} #f{position:static!important;width:100%!important;display:block}}';document.head.appendChild(s); __f.style.height=__f.contentDocument.documentElement.scrollHeight+'px'; 1"
echo "## t_loading.py"; $P t_loading.py
echo "## t_popup.py"; $P t_popup.py
echo "## t_swclients.py"; $P t_swclients.py
} 2>&1 | grep -v "libEGL\|^$" > out/results.txt
