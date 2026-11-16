# Owner invocation, rights delegation and compositor filters

25G342 arm64. A cooperative writer-right handoff works; no native hide in protected apps is established.

- `catalog.jsonl`: own-connection `SLSNewCIFilterByName` accepts CIColorInvert/CIShapedWaterRipple,
  both released with result zero. CIColorMatrix/CIBlendWithAlphaMask/CICrop return 1006 and ID zero.
  No filter is attached to a window or display; no rendering acceptance is claimed.
- `skylight-constants.jsonl`: loaded exact-address filter-name/parameter constants and related strings.
- `rights-run-1-compact.json`: rejected setup, owner request zero but no offer callback/no right gained.
- `rights-run-2-compact.json`: corrected AppKit event pumping; self-grant 1001/unchanged rights,
  explicit owner grant plus matching recipient acceptance succeeds, readback gains 0x20000, then
  relinquishment restores `[0,0,65536]`. Bundle inventories omitted; full raw logs retained.
- `verification.json`: independent original whole-window pixels, native button/hit state, owner
  connection/rights/geometry and grant/readback/restoration checks. It explicitly reports no new hide.
- `cleanup.json`: both owned child PIDs/window IDs absent after the experiments.
- `static/`: traced filter name dispatcher, fixed ripple parameter parser, one-way attachment
  message/Presenter check, rights sender/server, offered-notification/completion/relinquishment,
  process-notification initialization and AppKit's own completion consumer. WindowManagerAgent
  snippets use actual arm64e function-start intervals; full stripped Swift handler semantics and
  broker authorization remain incomplete. These snippets do not prove a native hide or universal limit.
- `sha256.json`: source/binary/log/PNG hashes plus WindowManager image/dump/function-start inputs.

All live attempts, original screenshots, source/binary versions, full static drafts and test output
remain local under `test-results/traffic-lights-invocation-2026-11-16/`. Larger disassembly inputs are
under `/tmp/margin-traffic-lights-research/owner-invocation/`. Source/binary hashes and compact static
evidence are committed; raw artifacts are ignored.

Reproduce against only this build and independently owned fixtures. Compile completely before
invocation; run dry once before the side-effecting form:

```sh
clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit tools/traffic-lights-lab/compositor-catalog.m -o /tmp/margin-catalog
/tmp/margin-catalog
/tmp/margin-catalog --run
clang -c -Wall -Wextra -Werror tools/traffic-lights-lab/wire-clip.c -o /tmp/margin-invocation-wire.o
swiftc -warnings-as-errors tools/traffic-lights-lab/deeper.swift /tmp/margin-invocation-wire.o -o /tmp/margin-invocation
/tmp/margin-invocation --rights-grant --output /absolute/new/run
/tmp/margin-invocation --rights-grant --run --output /absolute/new/run > /absolute/new/run.jsonl
python3 tools/traffic-lights-lab/verify-invocation.py /absolute/archived/root
```

The verifier expects this archive's catalog and two-attempt layout. Catalog requires 25G342 arm64
and the checked SkyLight UUID. The rights fixture requires 25G342, AX/capture access and a new output
directory; it grants only nonexclusive BackingStoreWriter to its verified parent, accepts only the
matching window/connection/sender-PID/offer-serial callback, relinquishes it and closes. No actual
backing-store write, Presenter/Owner/EventReceiver transfer, app injection, global privilege
registration, system setting, protected target or user window is involved. This demonstrates rights
state only; it does not establish native control suppression or a generally available broker.

Native warnings-as-errors builds, saved-pixel/state verification and unit 1031 pass. Full E2E was
attempted/bounded after missing pinned WebKit 2388 setup errors; no download or full-suite pass.
