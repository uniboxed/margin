# Window grouping observation (macOS 27.2.1, build 26B131)

**Mission Control previews remain unresolved.** This is an isolated research fixture, never part of
Margin.app, its helper, or the automatic app tests. It does not demonstrate a Mission Control fix.

The user confirmed that changing the native overlays from `managed` to `stationary` did not fix the
detached/scaled previews; the normal layout is correct after leaving Mission Control. That policy
experiment is reverted. The existing prepared-layout/Space-switch fixes remain.

## Run

```sh
swiftc -O -warnings-as-errors tools/window-group-lab/probe.swift -o /tmp/margin-window-group-lab
/tmp/margin-window-group-lab          # prints the plan; creates no windows
/tmp/margin-window-group-lab --run    # the explicit, bounded observation
```

The probe refuses any OS build other than 26B131. Both processes are this executable. Their three
panels are transparent, ignore input and are off every display (checked before and after ordering).
The second process's window owner is independently verified before grouping calls. There is an
eight-second child deadline and a twelve-second parent watchdog. Every window/process is ended.
No real browser, page, user window, setting or Space is changed; no screen/page is captured.
Only test window IDs, process IDs, relationship metadata and call results are printed.

## Observed readback

| Operation | Relationship readback |
| --- | --- |
| Public AppKit `addChildWindow`, same process | Association contains both windows; movement children contains the child; iterator parent ID equals the parent |
| Private movement + ordering, same process | Association and movement membership both established |
| Private movement + ordering, different owned processes | No combined association |
| Foreign parent, owned child (Margin's ownership direction) | No combined association; the child's iterator parent ID stays zero |
| Transaction variants, foreign parent/owned child | Same: no combined association and parent ID zero |
| `SLSSetWindowParent`, foreign parent/owned child | Same: parent ID stays zero |

These calls can report zero without establishing a relationship. Readback, not the return value, is
the evidence. The transaction commit's return register is not treated as an acknowledgement. AppKit's
pending removal is allowed to flush before the private same-process control, so that it cannot overwrite
the test operation afterwards. `result-26B131.json` retains the final observation excerpt and REA Evidence
ID, executable digest, cleanup result and capture limitations.

This tests ordinary off-screen panels, not native fullscreen or Mission Control's compositor. It does
not prove that every cross-process mechanism is impossible, or that fullscreen has the same restrictions.
No unverified grouping call, capture-group operation, browser-rendered preview, injection or snapshot
cache was added to the product.

## Signature and behavior evidence

- [Historical yabai grouping implementation](https://github.com/asmvik/yabai/blob/v3.3.0/src/osax/payload.m#L860-L885): movement and ordering groups, with cleanup. It executes in an injected Dock connection. Its [border implementation](https://github.com/asmvik/yabai/blob/v3.3.0/src/border.c#L50-L63) detaches on native-fullscreen entry; it is not a modern fullscreen solution.
- [Current query/iterator declarations](https://github.com/asmvik/yabai/blob/master/src/misc/extern.h#L64-L75): association, parent ID and owner readback.
- [TotalFinder developer's movement-group readback](https://github.com/lwouis/alt-tab-macos/issues/84#issuecomment-641548525): `CopyWindowGroup` with `movementGroup`, caller-freed IDs.
- Local `dyld_info -disassemble` of the cache-backed SkyLight image confirms the integer arguments, count width and pointer-out layout. Read-only LLDB tracing of this owned fixture's public AppKit control confirms transaction movement arguments `(transaction, parent, child)` and ordering arguments `(transaction, child, order, parent)`. These differ from the older non-transaction ordering API.
- The REA native-call run stopped on `SIGSTOP` without reaching a breakpoint; that run proves no call behavior. A separate bounded LLDB command run did reach the AppKit calls. The relevant traces stayed under `/tmp/margin-group-lldb.log` during the investigation. No live app was attached.

The native toolkit could not open the system framework's virtual path as a physical file because it
lives in the dyld shared cache. Apple's cache-aware `dyld_info` provided static inspection instead.
Live desktop verification was unavailable through the computer-use tool, and the user supplied the
failed visual check. Successful off-screen policy assertions alone were insufficient.

A bounded read-only check of Dock and `WindowManager.framework` 462.1.41 found coordinator/XPC client
entrypoints, not a demonstrated fullscreen thumbnail transform rule or attachment API. It does not
justify changing another collection flag. The actual compositor implementation, native-fullscreen
cases, and the installed signed app's permission context remain unverified by this fixture.
