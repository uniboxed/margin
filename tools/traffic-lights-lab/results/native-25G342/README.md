# Native-only follow-up, 25G342

This evidence does **not** establish external native hiding in protected apps. Image covers are
rejected for the current request. See [the report](../../../../docs/TRAFFIC-LIGHTS-RESEARCH.md#native-only-follow-up-regions-proxies-and-system-services-2026-11-16)
and [reproduction commands](../../README.md#native-only-button-region-and-retained-proxy-probes).

Host: macOS 26.7.3 / 25G342, arm64, UID 503, SIP enabled, AX/capture preflight true. Runtime mutation
is restricted to one disposable child per run. No new protected-app compatibility claim, target
library loading, target modification, preference write, sharing session or privacy-indicator change.

| Run | Classification | Result |
| --- | --- | --- |
| `buttons-run-1` | Accepted button-region experiment | Owner metadata changes; zero changed button-crop pixels; foreign metadata unchanged; native-hide control changes 516 pixels and native hit states; restore/cleanup pass |
| `buttons-proxy-run-1` | Invalid combined clip experiment | Owner saved an unsettled empty clip; restoration made capture unavailable; stopped before foreign clipping; exact child cleaned up |
| `buttons-proxy-run-2` | Accepted corrected experiment | Retained foreign proxy has unchanged raw rights; matched owner local/global clips work and restore; foreign clips leave pixels unchanged; native-hide positive control and cleanup pass |

The compact JSON retains all log records but removes repeated loaded-bundle lists from native
snapshots. The raw JSONL and PNGs remain local. The `*-pixels.json` files are independent decoder
results from `verify-native.py`, not just API return codes. Its additional rejection checks detect
the actual invalid run, fabricated native state and a missing rendering positive control.

The `static/` directory contains reviewed method excerpts with trailing whitespace removed.
AppKit/SkyLight/WindowManagement excerpts
come from cache-aware `xcrun dyld_info -disassemble IMAGE`; the titlebar service uses
`xcrun dyld_info -arch arm64e -disassemble SERVICE`. Regenerating that service dump matches the saved
disassembly byte for byte. Image UUIDs and service-file hash are in `manifest.json`.
`protocols-final.jsonl` and `constant-strings.jsonl` are read-only runtime observations using
`native-strings.m`. `launch-key-xrefs.json` records the cache-key reference; it is not proof of a
launch-default visibility control. The reviewed WindowManagement setter sends owner model updates
outward; its reviewed agent-property return path does not set native button visibility. No fabricated
XPC request was sent and full server-side authorization remains uninvestigated.

Raw evidence, failed attempts, original binaries and reproduction source snapshots are ignored by
Git under `test-results/traffic-lights-native-2026-11-16/`. That directory's `raw-sha256.json` is itself
hashed by this manifest. The accepted combined run's live source is reconstructed from the current
source by removing only a subsequently added dry-run-plan sentence; its original executable is
retained unchanged. The provenance note makes that distinction explicit. Earlier runs retain their
own source snapshots. Final reproduction sources/binaries are stored separately.

Validation: 1,031 unit tests pass; C/Swift/Objective-C warnings-as-errors builds, dry plans, two
independent accepted-evidence checks and three verifier rejection checks pass. Full E2E attempted
with a 15-second bound, blocked by missing pinned WebKit 2388; pinned Chromium 1254 and
`/opt/pw-browsers` also absent. No browser download or full-suite pass. Final readback finds none of
the three fixture processes/windows remaining. Production app and extension sources are unchanged.
