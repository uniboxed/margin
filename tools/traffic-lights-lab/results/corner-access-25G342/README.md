# Deeper corner access, 25G342

No external native square-corner backend is established. This evidence distinguishes stored mask
data, captured content pixels and transport status. Production code and system protections remain
unchanged; no third-party injection, overlay, privileged registration or preference change occurs.

| Experiment | Classification |
| --- | --- |
| Direct mask run 1 | Owner stores mask but content-pixel control unchanged; refuses before external requests |
| Direct mask run 2 | Clears numerical radii/path first; same rendering-control refusal, before external requests |
| Storage-control run 3 | Inspector expects the wrong mask image format; refuses before external requests |
| Storage-control run 4 | Owner stores/clears actual nonuniform mask; foreign clear/image requests leave owner mask state unchanged; content pixels unchanged relative to prepared state |
| System-only run 1 | Owner and foreign system-radius zero/32 leave corners unchanged; ordinary owner radius 32 control visibly changes them, then restores |

The local no-window format control creates an alpha-only bitmap context and confirms its output
image is an 8-bit mask (`isMask=true`, alphaInfo=none). Corrected run 4 reads 500/4096 samples below
128 from the server-returned mask plane. This is a storage control, not content-rendering acceptance.
Prepared content corners have 55 transparent pixels each versus the original/restored 63. The ordinary
radius 32 rendering control has 233. Shadows and full display composition are not validated here.

`verify-corner-mask.py` independently decodes original PNGs and validates owner storage controls,
foreign readback, windowed state, unchanged native controls and restoration/cleanup. `verify-corners.py`
validates the system-only PNGs and separate ordinary-owner rendering control. Five rejection checks
detect the three refused runs, a fabricated uniform positive control and an unexpected foreign mask.
Compact logs omit only repeated bundle lists; failures remain preserved and are not recast as passes.

`static/` contains current cache-aware `xcrun dyld_info -disassemble` excerpts with trailing whitespace
removed. SkyLight arm64e UUID: `D422F0A4-1C28-35B7-A6F5-9EB7BBE0801E`. Ordinary-radius and direct-mask
handlers check right 1; read-only `SLSWindowRightKeyForMask(1)` names it `kCGSWindowRightOwner`.
System-radius universal option `0x10` maps to `com.apple.private.skylight.windowmanager`. The universal
owner registration handler checks `com.apple.private.skylight.universal-owner`. These are reviewed
server-path findings, not proof about all APIs. Global registration was not invoked.

Relevant entitlement strings are confirmed in the loaded image at the addresses used in the actual
disassembly. The raw read-only address inspector is specific to this verified image/build/architecture,
not a portable tool. Runtime outputs, UUID, no-window format control and static excerpts are hashed.

Raw PNGs, all five run logs, each exact live source/binary snapshot, full SkyLight disassembly and
read-only inspectors remain local under `test-results/window-corners-deeper-2026-11-16/`. Successful
runs restore; all five owned processes/windows are gone at final readback. See the manifest for hashes.
Fresh unit tests: 1031 pass. Native warnings-as-errors build, two independent saved-evidence checks
and five rejection checks pass. E2E attempted/bounded at 15 seconds after missing pinned WebKit 2388;
no browser download/full-suite pass, production install or PR. Real protected-app compatibility,
resize persistence, other displays/builds and complete system-broker coverage remain open.
