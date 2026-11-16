# Third-party launch experiment, 25G342

`launch.json` and `hook-loaded.json` bind the successful native state to the actual Chrome for Testing
process/window. `pixel-checks.json` comes from independent decoding of the raw MP4, not the library's
replies. There are three physical controls, all hidden through resize and restored while windowed.
`protected-loader-control.jsonl` records the same library not observed loaded in installed Chrome;
that control sends no component commands. Do not infer arbitrary protected-browser support.

`signatures.json` retains complete signature inspections and strict-verification outcomes: the ad-hoc
test bundle has no sealed resources and fails whole-bundle strict verification; installed protected
Chrome passes. No bundle/executable is patched or re-signed. `manifest.json` identifies media, tested
source snapshots, executable hashes, validation and limitations. The source hashes under local media
bind the recorded run independently of future lab edits; they are not hashes of future repository HEAD.

`deeper-compact.json` retains valid run-3 native geometry/button state and independently sampled
transparency, omitting large duplicate bundle lists. Owner partial clipping has 1008/2072 transparent
samples, restoration and the same foreign request have zero. Bundle request returns zero with no
native change; the sole observed bundle difference is not attributed to custom loading. The two prior
zero-geometry runs are invalid and retained locally, not used as negative controls.

The `.txt` files are local cache-aware `dyld_info` disassembly excerpts for AccessibilityBundles,
AppKit accessibility dispatch and the sharing-button obscuring path. Reproduce the complete dump with:

```sh
xcrun dyld_info -disassemble /System/Library/PrivateFrameworks/AccessibilityBundles.framework/AccessibilityBundles
xcrun dyld_info -disassemble /System/Library/Frameworks/AppKit.framework/AppKit
```

The exact-build `bundle-policy.swift` decoder checks the expected bytes at the requirement's observed
image-relative offset and resolves them with Security.framework to `anchor apple`. This is read-only
instrumentation. It does not invoke a custom bundle or suppress a privacy indicator. The unbundled
manager was nil; no available custom-loading manager is claimed.

Accepted local media: `test-results/traffic-lights-launch-2026-11-16/retry/launch.mp4` (presentation),
`launch-raw.mp4`, 76 actual PNGs and monotonic timestamps. Labels/magnification stay outside original
window pixels. Sampling averages about 7 fps; this is not physical-display continuity evidence. The
root directory retains the first wrong-bundle-ID discovery failure; invalid geometry runs, raw logs
and exact source snapshots are retained alongside the accepted media. A helper rendezvous error near
shutdown is preserved in `launch-launch.stderr`, with no causal/stability conclusion.

Run `python3 tools/traffic-lights-lab/verify-launch.py ABSOLUTE_ACCEPTED_MEDIA_DIRECTORY` for native
state/pixel/resize/restore/windowed/cleanup verification. See the lab README for opt-in desktop
reproduction and deployment limits. Fresh unit tests pass 1031; the full E2E attempt is blocked by
absent pinned browsers and bounded during pending teardown. No production app changes.
