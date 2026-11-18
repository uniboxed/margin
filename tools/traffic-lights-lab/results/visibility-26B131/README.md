# AX visibility evidence, 26B131

See [report](../../../../docs/BUTTON-VISIBILITY-RESEARCH.md). `verification.json`
summarizes independent checks of the retained raw sources/binaries, native truth,
AX observations and all twelve controller/target PID exits. No pixels were captured.
`profile-cleanup.json` records removal of both owned temporary browser profiles
after checking no process arguments refer to them.

- `run-1`: 11 native fixture phases, including one fullscreen round trip.
- `run-2`: failed normal-level occluder ordering check; not acceptance evidence.
- `run-3`: same failure with diagnostics proving panel behind target; stopped.
- `run-4`: floating occluder bounds/order/pointer verified, all windowed phases.
- `chrome-1`, `edge-1`: absent installed browser, disposable profile, AX samples
  windowed/fullscreen/restored, graceful exit. AX evidence only, no pixel truth.

Each directory contains original observation JSONL, result and source/binary hash
manifest. Successful fixture directories also contain native pre/post truth. Raw
source/binary snapshots, compile failures, logs, browser stderr and static inspection
are local under `test-results/button-visibility-2026-11-18/`; binaries are not committed.
The source evolves between attempts: use the archived source and hash for that
attempt, not the final source, when auditing historical behavior.

Reproduce on **26B131 only**, with existing AX permission. No permission request:

```sh
clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework ApplicationServices tools/traffic-lights-lab/visibility-inspect.m -o /tmp/margin-visibility-inspect
/tmp/margin-visibility-inspect --inspect
clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework ApplicationServices tools/traffic-lights-lab/ax-button-visibility.m -o /tmp/margin-ax-button-visibility
/tmp/margin-ax-button-visibility
python3 tools/traffic-lights-lab/run-ax-visibility.py --binary /tmp/margin-ax-button-visibility --output test-results/button-visibility-local/run-1 --fullscreen
# Inspect dry output, then run once:
python3 tools/traffic-lights-lab/run-ax-visibility.py --binary /tmp/margin-ax-button-visibility --output test-results/button-visibility-local/run-1 --fullscreen --run
```

For each installed browser use a new output and `--browser chrome` or
`--browser edge` instead of `--fullscreen`, dry first, then `--run` once.
Do not start when that browser is already running. No browser data is read from
existing profiles. The runner preserves the IPC root as evidence; delete only its
owned temporary profile after verifying browser/helpers exited. It does not copy
that profile into the evidence directory.

Offline verification of this exact historical archive (requires raw files):

```sh
python3 tools/traffic-lights-lab/verify-ax-visibility.py test-results/button-visibility-2026-11-18
```

This verifies the enumerated archive cases, not an arbitrary newly numbered run.
It checks native state correlation, aliases, failed-setup exclusion and cleanup;
it cannot prove rendered pixels from metadata.
