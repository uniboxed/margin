# Working private corner launch settings, 25G342

**TextEdit and Preview honor the private launch setting without injection or saved corner-preference
writes. Chrome is unchanged in the matched test.** This is a startup configuration capability, not
a live foreign-window setter or traffic-light hiding backend. See the final section of
[the report](../../../../docs/TRAFFIC-LIGHTS-RESEARCH.md) and [reproduction](../../README.md).

Discovery source: [mac-window-corners](https://github.com/mansarip/mac-window-corners), especially its
[original reverse-engineering notes](https://github.com/mansarip/mac-window-corners/blob/main/macos-tahoe-window-corner-radius.md).
The configuration branch was missed in the prior trace. It is independently confirmed here on
macOS 26.7.3 / 25G342 / arm64 with AX/capture access and SIP enabled.

| Host | Normal corner transparency | Override 0.01 | Normal relaunch | Verified stable-phase PNGs |
| --- | --- | --- | --- | --- |
| Owned titled fixture | 63 pixels per corner, getter 16 | 0 pixels, getter about 0.01 | Not separately run | 3 snapshots per configuration |
| Apple TextEdit 1.20 (415) | 63 each | 0 each | 63 each | 92 |
| Apple Preview 11.0 (1113.5.3), runtime signing flag | 166 each | 0 each | 166 each | 90 |
| Google Chrome 157.0.8103.79, runtime signing flag | 102 each | 102 each; no effect | 102 each | 87 |

All counts come from alpha<128 in each actual 40x40 window corner. The independent verifier decodes
original PNGs and an original MP4 corner per real-app run, checks actual geometry/windowed state,
enabled AX controls and all three native traffic-light colors. Real-app recordings contain 134/132/129
sampled frames respectively. Capture is approximately seven fps, with monotonic timestamps; 30 fps
presentation repeats samples and adds labels/magnification outside the unchanged recorded window.

Launch arguments are `-NSConvolutionOverride1 0.01 -NSConvolutionOverride2 0.01`. AppKit caches the
values per process, so existing instances require relaunch. The probe refuses existing sessions and
uses disposable documents/fresh browser profiles. No persistent setting is written, and normal
launches restore rounding. Key 2's utility/panel behavior is not independently validated here.
Other apps, Safari/Edge, OS builds/displays and broad stability remain unvalidated.

The first Chrome override run fails the exact-local-tab guard before corner snapshots; its partial
captures remain invalid. The corrected setup selects only that owned tab through bounded AX before
recording. Browser tests use a loopback proxy endpoint. A prebuild invocation failure starts no
app and is retained separately. Neither failure is counted as corner-effect evidence.

Saved-key reads before/after cover the two corner keys in global/TextEdit/Preview domains for current
user at current/any host. They match. These read-only checks do not inventory unrelated preferences.
Executable hashes match and deep/strict signatures pass before/after for all three apps. No library
is inserted, bundle re-signed, system protection changed or image cover created. Final readback finds
all 12 owned window IDs and 18 known app/launcher PIDs gone, including the failed attempt.

`static/` contains current cache-aware AppKit disassembly excerpts, trailing whitespace removed.
The loaded constant inspector confirms both keys at the addresses used by `_convolutionOverride`.
Read-only key-inspection source, original live-source/binary snapshots, all logs/PNGs/MP4s and failures
are retained under `test-results/window-corners-launch-2026-11-16/`. The Apple runs and first/corrected
browser runs have separate exact source snapshots. Saved preference-read source is `preference-read.swift`
there; signature/hash records are also retained. No third-party source code was installed or executed.

`launch-verification.json` records accepted checks. `verify-corner-launch.py ROOT` reproduces them;
two additional rejection checks detect a false launch configuration and a substituted rounded frame.
Raw file hashes are in the local `raw-sha256.json`, whose hash is committed in `manifest.json`.
Presentation copies: `comparison.mp4` (about 55 seconds), plus each APP-comparison.mp4. These remain
local; compact logs, verification, static provenance and hashes are committed.

Validation: unit 1031 pass; new/changed native and legacy visual/cover builds pass warnings as errors.
Full E2E attempted with a 15-second bound, blocked by missing pinned WebKit 2388; no download/full
pass. No production app install or PR. This updates the earlier practical conclusion for corners;
the live WindowServer permission findings remain separately valid.
