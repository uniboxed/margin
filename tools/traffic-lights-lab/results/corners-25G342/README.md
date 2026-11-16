# Quick corner-radius test, 25G342

Two completed runs on macOS 26.7.3, ordinary UID 503, AX and capture access enabled. Only one
disposable titled child per run is targeted; its PID is independently checked against WindowServer
ownership. No protected app, preference, security setting or production code is changed.

| Operation | Transparent pixels in each 40x40 corner |
| --- | --- |
| Baseline native radius 16 | 63 |
| Owner native setter zero | 63; getter still 16 |
| Owner native setter 0.01 (second run) | 0; getter 0.01 |
| Owner WindowServer radius/system-radius zero, bounds path/image mask cleared | 55; incomplete removal |
| Owner WindowServer radius/system-radius 32, same clearing | 233; rendering positive control |
| Foreign WindowServer zero or 32, same clearing | 63; corner RGBA crops unchanged |
| Restored numerical radius 16 | 63; baseline corner RGBA restored |

The near-zero native setter removes corner transparency, but dark titlebar corner paint artifacts
remain. This is not seamless square-titlebar acceptance. All phases remain windowed with native
buttons unchanged. Resize persistence, actual third-party apps, other scales/builds, shadows and
crash recovery are unvalidated. These external transaction results do not rule out every private API.

`verify-corners.py` decodes saved original PNGs independently using ffmpeg; `corner-checks.json` is
its second-run output. Compact logs omit repeated loaded-bundle lists. Raw PNGs/logs and source/binary
snapshots remain local at `test-results/window-corners-2026-11-16/`. The first source is reconstructed
by removing only the later added native-0.01 command and phase; both original executables are retained.
`manifest.json` hashes raw files, evidence and reproduction sources. Final readback finds no remaining
fixture process or window. Fresh unit tests: 1,031 pass. Native warnings-as-errors compilation and
saved pixel verification pass. E2E attempted/bounded at 15 seconds after missing pinned WebKit 2388;
no browser download or full-suite pass. No app install or PR.
