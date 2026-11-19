# Recorded AX visibility evidence

See [full findings](../../../../docs/RECORDED-BUTTON-VISIBILITY-RESEARCH.md).
Actual host 27.2.1/26B131; existing AX and Screen Recording grants, no new requests.
Capture is solely an independent test instrument. No product code changes.

`verification.json` audits 28 attempted cases, 14 original recordings and all 70
recorded controller/target PID exits. It checks source/binary hashes, encoded frame
counts against SC complete-frame timestamps, relative PTS agreement, native truth,
settled pixel/AX correspondence, failed-stimulus exclusion and measured costs.

| Evidence | Meaning |
|---|---|
| `browsers` | 35 settled samples across Chrome, Edge, Safari; actual color/gray discs |
| `nativeSnapshots` | Native states, recorded discs and AX; includes custom AX counterexample |
| `nativePollingDelay` | Seven logged completed native mutations to next correct 30 Hz poll |
| `pollingCPU` | Six-second capture-free 15/30/60 Hz trials; fixture baseline included |
| `notifications` | All 40 app/window/button registrations succeed; only move positives observed |
| `fullFootprintGuards` | Clipped 16-point guard 31/260; overflow 24-point 1/260; overflow 32-point 0/259 |
| `conditionalCover` | Large-guard 30 Hz reveal/fade trial still exposes colored controls in 3/201 frames |
| `movementGroups` | Same-owner positive; foreign zero return without ordinary following; drag inconclusive |
| `exclusions` | Setup, measurement-intervention and failed-candidate reasons |

The zero-exposure guard requests 126×80 points and extends about 24 points outside
the native left/top edges. It overcovers UI. These are finite recorded observations,
not native removal, every-refresh proof or an all-app flicker guarantee.

`validation.json` records checked native builds, backend source/binary hashes,
capture-call/image-read/linkage audit, Python parsing, unit 1,031 pass and bounded
full E2E blocked by missing pinned WebKit 2388. No browser download/full-pass claim.

Per-case folders preserve original driver/observer/group logs, manifests and
results, plus explicitly named detector/native excerpts. Full-disc pixel analysis
for the final three guard cases is included. Excerpts omit periodic samples;
`analysis-hashes.json` identifies complete raw streams and final offline analyzers.
Original raw sources/binaries/MP4s, every failed version, stderr/build logs and
independent native truth remain in the local archive:
`test-results/button-visibility-recorded-2026-11-18/`. No binaries or recordings are
committed. The first app-filtered capture and failed setup trials are not acceptance.

`presentation.json` describes local corner crops enlarged 2×, with original frame
count/PTS preserved and no temporal interpolation. Safari's shared presentation is
limited to the titlebar corner. Full raw recordings remain local. Chromium profiles
were removed after matching-process checks; no Safari profile directory was deleted.

## Reproduction

Use this inspected OS build, an unused output directory and existing permissions.
The browsers must be absent; the driver refuses existing targets. Safari menu actions
currently match the English labels. Do not repurpose the script to close user windows.

Build the three separate executables:

```sh
clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework ApplicationServices tools/traffic-lights-lab/ax-live-detector.m -o /tmp/margin-ax-live-detector
clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework ApplicationServices tools/traffic-lights-lab/visibility-stimulus.m -o /tmp/margin-visibility-stimulus
swiftc -parse-as-library -warnings-as-errors tools/traffic-lights-lab/visibility-recorder.swift -o /tmp/margin-visibility-recorder
/tmp/margin-ax-live-detector
/tmp/margin-visibility-stimulus
/tmp/margin-visibility-recorder
/tmp/margin-visibility-recorder --preflight
python3 tools/traffic-lights-lab/run-recorded-visibility.py --output test-results/button-visibility-recorded-local/visibility --mode visibility
# Check dry output, then open the one disposable target once:
python3 tools/traffic-lights-lab/run-recorded-visibility.py --output test-results/button-visibility-recorded-local/visibility --mode visibility --run
```

Use `--mode custom` for the intentionally mismatched AX counterexample. For a motion
trial use `--mode motion --cover --hz 60 --padding 16`, or `--padding 32
--overflow-guard`. The latter knowingly extends the patch outside the target.
Always dry first, then one `--run` with the same flags and a new output. Stop at the
first failed setup, inspect and preserve it before making a corrected attempt.

For capture-free CPU trials use `--mode idle --no-recording --seconds 6 --hz 15`,
then separate outputs for 30/60 Hz. Add `--no-detector` for the fixture baseline.
Idle acceptance does not require key-window status and makes no visual claim.

App/button notification trial:

```sh
clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework ApplicationServices tools/traffic-lights-lab/visibility-observer.m -o /tmp/margin-visibility-observer
/tmp/margin-visibility-observer
python3 tools/traffic-lights-lab/run-recorded-visibility.py --output test-results/button-visibility-recorded-local/events --mode events --observe --no-recording
```

Inspect dry output, then add `--run` once. This mode adds two native moves as
notification positives among the hide/fade changes.

For browser tests, build `browser-visibility-stimulus.m` with the same clang flags,
output `/tmp/margin-browser-visibility-stimulus`, invoke it without flags for dry
output, then run `run-browser-visibility.py --browser chrome --output
test-results/button-visibility-recorded-local/chrome` (dry), and again with `--run`.
Other cases are `edge` and `safari`. Driver uses owned temporary Chromium profiles
or a new Safari private window, restores toolbar/cursor, then quits its owned app.
Remove only the owned temporary profile after all matching processes exit.

`ax-movement-group.m`, built similarly as `/tmp/margin-ax-movement-group`, prints
a dry plan without arguments. `--run OWNED_ROOT` needs a new owned-marked root and
the built stimulus executable. Save stdout/stderr and exact binaries/sources.
`--drag` is retained as a rejected/inconclusive stimulus, not accepted drag support.

Offline analysis requires the existing `/opt/homebrew/bin/ffmpeg` and `ffprobe`:

```sh
swiftc -O -warnings-as-errors tools/traffic-lights-lab/analyze-visibility-video.swift -o /tmp/margin-analyze-visibility-video
swiftc -O -warnings-as-errors tools/traffic-lights-lab/analyze-browser-buttons.swift -o /tmp/margin-analyze-browser-buttons
# The historical native recordings here are 1100×820 at scale 1:
/tmp/margin-analyze-visibility-video VIDEO 1100 820 1 STIMULUS_JSONL 7.5
/tmp/margin-analyze-browser-buttons VIDEO 1100 820
python3 tools/traffic-lights-lab/verify-recorded-visibility.py test-results/button-visibility-recorded-2026-11-18
```

Save analyzer output to the appropriate original case directory. Default native
radius 6 reproduces the earlier interior measurements; explicit 7.5 checks the
larger native disc footprint. The verifier targets this enumerated historical
archive, requires local raw files, and must not be presented as verification of
newly numbered trials. It does not replay desktop actions.
