# Safari profile creation research

2026-11-16. Requirement: fully automatic creation of a **real Safari browsing
profile**, without Full Disk Access, Automation or Accessibility. No verified
implementation meets that requirement yet. The native creation API works against
an isolated database; that is not registration with Safari.

Detailed conclusions and remaining work: [research.md](research.md).
Checked host: macOS 26.7.3 (25G342), arm64, Safari 27.2 (21625.2.8.18.4).
These are host facts, not the environment version assumed by older project prose.

## Reproduce the isolated experiment

The helper refuses other builds and anything except an owned fixture created by
the runner. It never starts Safari. Run from the repository root:

```sh
clang -fobjc-arc -Wall -Wextra -Werror -framework Foundation \
  tools/safari-profile-lab/profile-probe.m -o /tmp/margin-profile-probe
/tmp/margin-profile-probe
python3 tools/safari-profile-lab/run-probe.py \
  --binary /tmp/margin-profile-probe \
  --output test-results/safari-profiles-local/fixture-1 --mode fixture-create
# Review that dry plan, then use a new output directory:
python3 tools/safari-profile-lab/run-probe.py \
  --binary /tmp/margin-profile-probe \
  --output test-results/safari-profiles-local/fixture-1 --mode fixture-create --run
python3 tools/safari-profile-lab/verify-fixture.py \
  test-results/safari-profiles-local/fixture-1
```

Use `--mode inspect` with a **different new** output directory to inspect selected
Objective-C classes, three XPC protocol declarations and a pinned entitlement
literal. It does not explicitly instantiate the inspected classes. Both modes retain native source,
binary, runner, policy and logs. Stop and inspect a failure before another run.

The process is confined with `sandbox-exec`: real Safari directories are denied,
as are writes outside the fixture, Apple Events, network, and selected Safari,
WebBookmarks, WebKit, AX, TCC, preferences and cloud services. An outside owned
canary must fail read/write; real database preflights use read-only `open`, close
immediately if accessible, and refuse before framework loading in that case.
Missing legacy files are recorded as ENOENT, not counted as permission denials.
The sandbox is an experimental control, **not evidence that the launching desktop
app has no existing TCC grants**. No permissions are granted or reset.

`fixture-create` uses a debug collection with an explicit scratch path, external
notifications disabled and a **nil profile-directory manager**. It exercises
native metadata persistence only. Never copy the resulting database into a real
Safari container. The policy deliberately blocks potential brokers; its failure
or success cannot prove that every external service is unavailable.

Compact evidence is in [results/macos-25G342](results/macos-25G342/summary.json).
Raw experiments remain local and ignored under
`test-results/safari-profiles-2026-11-16/`. No product code uses these APIs.
