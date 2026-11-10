# Mission Control geometry investigation

Diagnostic sources only; neither is compiled into Margin. Run a no-argument dry run first.

- `observe.swift`: bounded 90-second metadata observer. `--observe` reads Safari/Margin geometry, model bounds and transforms, and subscribes to candidate notifications. No UI actions, created windows, screenshots, titles or URLs. Notification 1327/1328 means Space creation/destruction, **not** Mission Control entry/exit. Those callbacks are not adopted in the product. AX notification registration succeeding does not establish that an event is delivered.
- `transform-control.swift`: `--run` creates one transparent off-screen panel, verifies it belongs to this process and intersects no display, changes only its own transform, restores it and closes it. An eight-second watchdog terminates the process. Never change this fixture to write another process's window transform.

Compile independently with `swiftc -warnings-as-errors <source> -o /tmp/<name> -framework AppKit`; these are explicit diagnostic runs outside `MARGIN_APP_TESTS`, whose product wrappers always refuse real calls.

## Evidence, macOS 27.2.1 (26B131), 2026-11-10

The installed app's trace showed a full-size logical native layout `[0,33,1512,949]` being resized to `[276,264,959,602]` during Mission Control, hidden, and restored after return. Later user-performed swipes also produced repeated size-based hides followed by show/placement roughly 154–349 ms later. The latest 90-second observer ended before the user's gesture, so it does **not** establish Safari's model geometry during that gesture; the app's own ongoing diagnostics captured the hide/show sequence.

The owned transform control exited zero. Before: model and CG bounds were 800×600, located off screen. After setting its own inverse-scale transform: `SLSGetWindowBounds` stayed 800×600 while CGWindowList presentation became 402×300. Restoring the exact original transform restored CG to 800×600; the owned panel closed. Evidence ID: `ev_05c7564878b3f48dbdbedfd21a5c29c47ef269c4278a80ea763c598d310fcd55`. This proves the getter/presentation distinction in that control; it does not prove compositor grouping or faithful Safari thumbnails.

Read-only observation evidence: `ev_eb266972c56cad72ca98ee5534cb1107de3e453cb71237c397f7b22c3ee9031a` (initial geometry transitions), `ev_e7a065e1c8aa4eb79931156c6a750430e068dc4014a97a036d82f99086887b16` (notification registration, no timed gesture), `ev_3b7f0df4f0b714299fe2a25c48c6306fe33871edfba430f46b6304ab90212a79` (90-second model/transform observer, no timed gesture). Process sampling was incomplete in some captures. Raw captures are not committed.

Initial observation pairs the actual main Margin panel 6114 with its Safari window 6266 (not pointer catcher 6123). CG rectangles `[x,y,width,height]`, milliseconds relative to that observer:

| ms | Safari | Margin main panel |
|---|---|---|
| 68 | `[0,33,1512,949]` | `[0,33,1512,949]` |
| 3505 | `[488,48,214,134]` | `[488,48,214,134]` |
| 3958 | `[276,264,959,602]` | `[276,264,959,602]` |
| 9229 | `[473,47,254,160]` | `[519,86,162,102]` |
| 9654 | `[0,33,1512,949]` | `[0,33,1511,948]`, off screen |
| 9812 | `[0,33,1512,949]` | `[0,33,1512,949]`, on screen |

The native surfaces initially transform together, then diverge after Margin has adopted thumbnail geometry. This supports retaining model geometry; it does not establish the corrected build's visual result.

## Product boundary

The product uses only checked `SLSGetWindowBounds`, independently gated at launch. It validates once against a full-size browser window, then reads again only when an already shown same-owner/same-window layout differs in size from CG presentation. Matching fresh model bounds retain native frames without hiding, restacking or reloading; uncertain reads retain conservative hiding. It never copies a foreign transform or writes foreign geometry. Native regression tests replay scaling with fake reads and real off-screen WKWebViews. Real Safari preview alignment, exit/reversal and multiple displays still need visual verification: desktop capture failed with ScreenCaptureKit -3811 and native computer control timed out during this investigation.

## Installed Safari follow-up

On 2026-11-10, candidate `595c83cc` in the real Margin process (23941) logged 11 successful retained-model presentation episodes and 11 returns, with no geometry getter error or logged put-away/show cycle after initial drawing. Its ongoing trace kept main panel 6975 bound to Safari 6963 at full logical size, allowing one-point rounding. This confirms the model getter works during actual Safari transitions on 26B131. It does not establish continuous compositor visibility: the user reports the layout disappears on entry, then appears during exit before the browser finishes returning. They accept the return behavior; entry preview visibility remains incomplete. No new capture was available, and no further runtime changes were made for this result.
