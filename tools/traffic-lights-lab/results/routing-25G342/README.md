# Button configuration and AX relationship routing

macOS 26.7.3 / 25G342, arm64. Native external traffic-light hiding remains unestablished.
The main report's final section explains the evidence and architecture decision.

- `config-summary.json`: bounded inventory of 3,566 selected AppKit methods/blocks; 192 direct
  AppConfig reads in 138 methods, 191 with a nearby literal materialization. These are not exhaustive
  branch argument values, a complete call graph or a proof that no configuration exists.
- `config-read-summary.json`, `lifecycle-calls.json`, `static.txt`: compact read inventory and 24
  original static excerpts. No three-button startup hide consumer established in reviewed paths.
- `selectors.jsonl`: read-only runtime ABI checks, including absence of historical
  `_setButtonsShown:` and `_setButtonHidingView:` on NSThemeFrame.
- `observations.json`: completed run 3 with noisy bundle inventories omitted; raw log retained.
- `pixel-checks.json`: independent whole-window PNG comparison. Owner AX reference overrides
  rotate reported locations but leave every native pixel/hit state unchanged. Foreign relationship
  writes return zero while non-settable and leave both metadata and pixels unchanged. Native-view
  hide positive control changes 516 pixels and makes all three controls hidden/non-hit; restores.
- `process-cleanup.json`, `window-cleanup.json`: all three fixture PIDs/window IDs absent.
- `sha256.json`: source/binary/raw-capture hashes. AppKit dump/constant-map hashes in config summary.

Failed runs 1/2 stop at the owner metadata control before any foreign writes. AX identities and
then role/subrole fingerprints prove unsuitable because AppKit wraps overrides as AXUnknown objects.
Run 3 uses distinct position/size matches, explicitly not native identity. All attempts, source/binary
versions, PNGs, raw logs and full configuration contexts remain local under
`test-results/traffic-lights-routing-2026-11-16/`. Earlier offline inventory drafts remain there too.

Reproduction (compile first, await successful completion, then run dry before the visible run):

```sh
clang -c -Wall -Wextra -Werror tools/traffic-lights-lab/wire-clip.c -o /tmp/margin-routing-wire.o
swiftc -warnings-as-errors tools/traffic-lights-lab/deeper.swift /tmp/margin-routing-wire.o -o /tmp/margin-routing
/tmp/margin-routing --ax-relations --output /absolute/new/run
/tmp/margin-routing --ax-relations --run --output /absolute/new/run > /absolute/new/run.jsonl
clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit tools/traffic-lights-lab/native-strings.m -o /tmp/margin-routing-strings
/tmp/margin-routing-strings
/tmp/margin-routing-strings --selectors
/tmp/margin-routing-strings --all-constants > /absolute/constants.jsonl
python3 tools/traffic-lights-lab/audit-button-config.py /absolute/appkit-disassembly.txt /absolute/constants.jsonl /absolute/new/audit
```

`verify-button-routing.py /absolute/archived/root` validates this archive's three-attempt layout
offline, including both rejected attempts, metadata, native state, original PNGs and cleanup logs.
No new protected app, user document/profile, preference, entitlement or system setting is modified.
No new video is claimed: this probe saves original still captures; earlier recordings remain in
their original archives. The inventory is limited to this build's selected Objective-C families;
other frameworks, dynamic dispatch, indirect constants and server authorization are incomplete.
