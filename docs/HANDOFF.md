# The full-screen handoff with parking: design

Draft 2, 2026-11-06 (revised after two critics' reviews: Appendix A). Nothing here is built. It replaces today's close-based cross-profile switch (`app/macos/shell/ProfileSwitch.swift`) with Tirth's freeze-based handoff, and keeps the old profile's window alive ("parked") instead of closing it.

**Margin windows (2026-11-09):** this design had one chain of windows (one home window per profile, one shown window). `docs/BROWSER-WINDOWS.md` replaces that with a window per profile for **each** Margin window, and it overrides what this document says about home windows, the shown window, §6.2, §13.8 and §13.11 (answers 8 and 11). Where the two differ, WINDOWS.md holds.

Where things are:

- **Repo:** `/Users/tirth/Projects/margin`, read at `merge/icloud-tabs` (df6877e). File:line references are to that commit.
- **Labs:** `S = /private/tmp/claude-501/-Users-tirth-Projects-margin/1bb1ea82-aa29-4c73-85e7-63051090d15a/scratchpad`. `S/handoff/RESULTS.md`, `S/handoff/RESULTS-park.md`, `S/handoff/xp.swift`, `S/handoff/park.swift`, `S/handoff/lab.swift`, `S/stp/stp-handoff.swift`, `S/stp/stp-lab.swift`, and the STP logs `S/stp/margin-park-handoff.mp4.log`, `S/stp/stp-1793947553.log`, `S/stp/stp-1793947586.log`, `S/stp/stp-1793947722.log`.

Words used below:

- **A**: the window the switch starts from (shown, full screen, with Margin's overlay).
- **B**: the target window. Usually another profile's. It can be the same profile's (§6.11).
- **Parked**: hidden in a private Space Margin made for that window. Alive, normal (not full screen), not minimized, in no user Space, not in Mission Control.
- **Freeze**: the screen held still by `SLSNewTransition`. **Reveal**: `SLSInvokeTransition(cid, handle, 0)`.
- **Copy**: one Safari profile's running extension. Window and tab ids resolve only in their own copy (`docs/PROTOCOL.md:9`).
- **Gate Gn**: a lab run that must pass before the build relies on that part (§10.4). Until it passes, the part ships turned off, behind an `Options` flag, or with the fallback named next to it.

---

## 0. What Tirth decided, and what this design adds

Decided (2026-11-05/06):

- A freeze-based handoff replaces the slide. Private calls are OK. No Accessibility, no screen recording in the mechanism, no AppleScript.
- The old window is parked, not closed.
- Two modes: **Keep windows alive** (default) and **Close windows to save memory** (a visible setting).
- Fallback chain: 1) bridge parking; 2) the close handoff. No Desktop parking. A failed close is retried and logged. The old window stays in its own full-screen Space.
- Every private call is checked at launch, verified on use, logged locally only, and listed in a checked-in `docs/PRIVATE-APIS.md`, with a lab tool for each macOS beta.
- UX: the swipe stays live in the sidebar, a "switching profile" cover shows in the page area, and the handoff runs behind it. About 1.1-1.3 s of still screen in Safari, against today's 0.4-0.65 s slide.

This design adds the following, each defended below:

- **The freeze and the old window's fate are two separate choices** (§1.1). Without the freeze, parking still runs and the person sees macOS's slide. A close happens only when parking is off or failed, or the setting asks for it, and always after a drafts check.
- **The registry is keyed by window-server number**, and each parked window has its own private Space (§2.1). An entry is never forgotten just because its copy is quiet.
- **Every window return records who caused it** (§2.6). Only the person's own act (focus landing on a parked window) starts a handoff.
- **Late answers are owned** (§1.9). Requests carry a `notAfter`, a copy refuses a second windows call while one is pending, and an aftercare watch handles whatever lands late.
- A rAF probe to the target's front page and an overlay "framed" ack serve as readiness gates (R3, R4). R3 depends on gate G2.
- A small `parked` message to each copy (like `drawn`), and one `parkedActivity` push back (§2.5, §6.1).
- The close handoff uses two freezes: the form the lab proved (§4.5).

---

## 1. The switch's state machine

### 1.1 Two choices per switch: freeze, and the old window

Each switch picks both, from the launch check, what failed this session, the setting and the setup at that moment:

| Choice | Values | Picked |
|---|---|---|
| **Freeze** | `on` / `off` | `on` when the freeze calls passed the launch check, the session hasn't turned it off, and exactly one display is managed (`SLSCopyManagedDisplaySpaces` count, read per switch, §6.7) |
| **Old window** | `park` / `close` / `keep` | `park` when the bridge passed the launch and self-tests and the session hasn't turned it off, and the setting is "Keep windows alive". `close` when the setting is on, or parking is off. `keep` (A stays in its own full-screen Space) when closing isn't allowed this time: a draft in A, A's copy gone, A busy (§1.10), a failed close, or the multi-display rule (§6.7) |

- So the modes are `park+freeze` (the default), `park` without a freeze (the person sees the slide, and A is still kept alive), `close+freeze` (the two-freeze close, §4.5), `close` without a freeze (today's switch, plus the drafts check), and `keep`.
- **There's no lasting `plain` level.** Today's flow (`ProfileSwitch.swift:10-24`) is `close` without a freeze, run by the same machine.
- **Session demotions** (until Margin.app quits, Tirth's "for the session"), each one log line:
  - **park off:** the bridge is missing at launch, the self-test failed, or a park or show didn't land after one retry.
  - **freeze off:** missing at launch, `SLSNewTransition` nonzero on two switches in a row, or a reveal nonzero (then released).
- **Setup facts aren't demotions:** the display count and drafts are read per switch. Unplugging the second display brings the freeze back on the next switch.
- **A drafts check comes before every close**, in every mode (§4.5). A close never loses typed text without asking first.

### 1.2 Phases

```text
idle
 └ start ─▶ preparing ──coverShown, or 250 ms──▶ frozen ──────────────────────────────┐
             │ (cover up, target chosen,           showing B (bridge)                 │
             │  blockers checked §1.10,            entering (B to full screen)        │
             │  B's space set while parked,        waitingReady (R1-R4)               │
             │  drafts asked if a close may come)  leaving (A to normal) from R1+R2   │
             │                                     parking A / closing A (§4.5)       │
             │                                     settling (R5)                      │
             │                                     └ all done ─▶ reveal ─▶ after ─▶ landed ─▶ idle
             │                                     watchdog 1.7 s ─▶ reveal; the same steps go on unfrozen ("late")
             ├ the target's copy isn't linked, and the profile has no parked window ─▶ waitingForProfile (90 s) ─▶ preparing
             ├ … but it has a parked window ─▶ waitingForLink (up to 3 s, §1.5) ─▶ preparing, or that window returned to its Desktop
             └ cancel / back to A before the freeze ─▶ idle (cover down, nothing touched)
any failure ─▶ recovering (§4.4) ─▶ after ─▶ landed ─▶ idle
```

- **`after`** (unfrozen, at most 1.5 s, part of the switch): a late park of A and its verification, the focus check (§6.6), the registry's verification of both windows, and one diagnostics line.
- **`landed`**: every step done (the late park included) or recovery done, **and** no full-screen Space change for 150 ms. Only then is the switch idle. A queued switch starts only from idle (§1.7).
- Every phase has a deadline. Today's machine has `createTimeout` 8 s and `settleTimeout` 6 s (`ProfileSwitch.swift:70-80`). The new ones are in §1.4.
- **A foreign Space change aborts:** during the freeze the active Space may only be A's, or a type-4 Space that holds B. Any other active Space for 100 ms (the Desktop, another full-screen Space: a trackpad swipe, Mission Control, §6.10) means reveal at once and recover. The log says `aborted: the active Space moved to N`. Gate G15 checks that Safari's entry never passes through another Space.

### 1.3 The order: enter-first, one freeze

From the STP recording (`S/stp/stp-handoff.swift:188-221`, log `S/stp/margin-park-handoff.mp4.log`):

1. **Freeze.** `SLSNewTransition(cid, spec{version 0, type 1, option 0, window 0, nil}, &handle)`. A nonzero result means this switch runs without a freeze. Two in a row turn the freeze off for the session.
2. **Show B**, only if B is parked or a normal window on another Space (§3.1).
3. **B full screen and focused**, from B's copy: `setWindowState { windowId: B, state: 'fullscreen', focused: true, notAfter }` (§3.3). **Sent once. No blind retry** (§3.4).
4. **Wait for R1 and R2** (B in its own active full-screen Space, bounds steady for 3 polls), then R3 and R4 (§3.2) **in parallel with steps 5-7**.
5. **A to normal**, from A's copy: `setWindowState { windowId: A, state: 'normal', notAfter }`. It starts at R1+R2, not after R3/R4. **Latest start: 1.15 s after the freeze** (§1.4). If B isn't steady by then, A isn't touched under this freeze.
   - Before step 5, A's overlay and its edge panel are ordered out explicitly (`overlay.hide`, never `reveal`, §2.3). A's full-screen Space is about to go, and the overlay must not be in it.
   - A leaves full screen in the background, with no change of the active Space (`S/handoff/RESULTS-park.md`). In STP that took 101-360 ms after B was ready (log: B 827/841/951/790 ms, A left 1176/942/1063/1150 ms).
6. **Park A** in its own private Space (§2.1), only once its copy's state and the window server both say A is normal and out of its old Space (`S/stp/stp-handoff.swift:209-213`). Then verify.
7. **Settle (R5):** A off screen and in no user Space, A's overlay off screen, at least 130 ms after A's exit (`S/stp/stp-handoff.swift:216`), and no Safari window left over A's last bounds other than B's (§1.10).
8. **Reveal** when R3, R4 and R5 hold (or their timeouts pass). A nonzero result means `SLSReleaseTransition` (`S/stp/stp-handoff.swift:77`) and the freeze off for the session.

In `close` mode, steps 5-7 are replaced by §4.5's second freeze. In `keep` mode, steps 5-7 are skipped: A stays in its full-screen Space, and its overlay is ordered out. Without a freeze, the steps are the same and the person sees them.

### 1.4 The timeline against the 2 s limit

macOS releases a freeze by itself at about 2 s. Margin's watchdog reveals at 1.7 s (the lab used 1.7-1.85 s, and 1.7 leaves room for a late timer).

Parked B, with STP's numbers (`S/stp/margin-park-handoff.mp4.log`, 4 handoffs):

| From the freeze | What | Source |
|---|---|---|
| 0 | freeze | |
| 7-13 ms | B shown | STP: 8, 7, 9, 13 |
| +~20 ms | `setWindowState` reaches B's copy | link round trip, median about 20 ms (`PLAN.md` §14, Spike 3) |
| 790-951 ms | B in its full-screen Space, steady (R1+R2): step 5 starts | STP |
| +30-80 ms | B's page frames (R3), B's overlay framed (R4), in parallel | estimate, gate G2 |
| +101-360 ms after R1+R2 | A has left full screen | STP: 349, 101, 112, 360 |
| +4 ms | A parked | STP |
| +130 ms | settle | STP's lab rule |
| 1.02-1.44 s | reveal | from the rows above. STP's own strict order gave 1093-1318 ms |

- Headroom to the watchdog at the worst STP row: about 260 ms. Gate G16 measures the real distribution in release Safari with Margin's extension and real sites. It sets `Options.watchdog` and whether the late-reveal rate is acceptable.
- **Step 5's latest start is 1.15 s:** 1.7 s minus STP's worst exit (360 ms), the settle (130 ms) and 60 ms of margin. A B that isn't steady by then is revealed at the watchdog with A untouched. A's exit and park then run in `after`, with A's Space not the active one. Gate G17 checks that a background exit started after a reveal shows nothing.
- **Gate timeouts:** R3 waits 250 ms after R2, and R4 200 ms. Both run while A is leaving, so in the common case they cost nothing.

**The watchdog fires** (1.7 s) in one of three states:

- **B ready, A parking or settling:** reveal. A is normal and in no user Space, or in a Space that isn't active, so it shouldn't show. Gate G17 records what a reveal during the settle shows.
- **B ready, A not started** (B steady after 1.15 s): reveal. A's exit and park run in `after`.
- **B not ready:** reveal. The person sees the tail of Safari's full-screen entry. The steps go on unfrozen until `settleTimeout` (6 s), then success or recovery (§4.4). The log says `late` with the phase.

### 1.5 The target: which window, and what's done first

A switch's target is a **window**, not just a profile: `Target { link, space, number?, windowId? }`. The window, in this order:

1. **The window that asked**, when the switch comes from a parked window's activity (§6.1: a link landed there, or the person focused it).
2. **P's home window in this Margin window**: the line's window of P (`registry.lines[line].homes[link]`, docs/BROWSER-WINDOWS.md §2.1), parked.
3. A parked window of P in **no** line (the crash marker's, before any line took it), adopted. Another line's never: that's another Margin window's.
4. The line's window of P in full screen, not parked: the **focus** variant. Step 2 is skipped, and step 3 is `setWindowState(fullscreen, focused)`. macOS's Space slide runs hidden under the freeze.
5. The line's window of P, normal on some Space: the **show** variant, the same as parked. The bridge op with options 7 adds it to the active Space and removes it from its others. A window of P in no line, or in another line, is another Margin window: never a target.
6. A minimized window is **not a target in the first build**. Un-minimizing plays the genie and slides to the Desktop, and a genie under a freeze stalls. With only minimized windows, P gets the create variant, and the minimized window stays as it is. Gate G18 tries showing a minimized window through the bridge.
7. None: the **create** variant (§1.6).

**The target's copy isn't linked** (link down, reconnecting, a new copy relinking):

- **P has a parked window:** `waitingForLink`, up to 3 s, with the cover up and no freeze. The link usually comes back (`reconnectGrace`, `Shell.swift:398-407`). If it doesn't, the window is returned by number to its display's Desktop Space (§2.1 `returnToDesktop`, no copy needed), and the notice says: "Work's window is on the Desktop. Margin can't reach its extension right now." The window is never stranded, and the person never sees "isn't open in Safari" for a profile whose window exists.
- **P has none:** its window is asked of Safari's own menu (`Shell.openProfileWindow`, Accessibility) **under the freeze**, as a create (§1.6): way `openProfile`. Preparing as for any switch (the cover, the cooldown), then the freeze, then the ask. Once its copy links with that window, the switch goes on as for that window (`focus`, or `show`), its space set then. A window opened beside a full-screen one is put in full screen by macOS, which slides to it, and before this the slide was seen (Tirth, 2026-11-09).
  - Safari can't be asked (no Accessibility, no menu item): revealed at once, then `waitingForProfile` (90 s) with the notice, as before.
  - The copy slower than the freeze: revealed at the watchdog, then `waitingForProfile` for the rest of the 10 s, the keys the person's; once it links, a freeze of its own for its window.
  - No freeze (off for the session, two displays): asked at once and seen, `waitingForProfile` as before.

**A parked target whose copy id is unknown** (a new copy, not yet rebound, §2.2): no freeze. Margin shows it by number into the active Space, the binder binds it from on-screen evidence, and the switch goes on from step 3 once it's bound (visible, logged). This is rare: §2.2's rebinding usually binds it first.

**Done in `preparing`**, before the freeze, while B is still parked and hidden:

- **The space.** If B's active space (`openTabs.activeSpaceByWindow`, `ShellProfiles.swift:189-199`) isn't the target, `setSpace { windowId: B, spaceId }` goes to B's copy now. Safari switches B's tab behind, and R3 later probes the new tab in front.
- **Blockers** (§1.10).
- **Drafts**, whenever this switch may close A (the `close` choice, or `park` with a close possible after a failed park): `windowDrafts { windowId: A }`, at most 400 ms (§4.5).
- **The cover** in A's overlay (§7). The freeze starts when A's overlay says `coverShown`, or 250 ms after the start, whichever comes first. The sidebar's swipe settles for `SETTLE_MS` (220 ms) after the release (`extension/ui/behaviors/swipe.ts:16`, `:63-72`). The freeze is screen-wide, so it must not start mid-slide.
- **The cooldown.** At least 1 s since a watchdog reveal (gate G7 may shorten it), and at least 300 ms since any reveal.

### 1.6 The target has no window: create under the freeze

`openSpaceWindow` can take up to about 2 s (1 in 20 creates took 1.3-1.9 s in Chrome: `PLAN.md` §15, and `ProfileSwitch.swift:71`). The options were:

- **Create before the freeze.** This can't be done quietly. A window created while the app has a full-screen window is put into full screen by macOS, and macOS slides to it (`PLAN.md` §15 "bg-create": 10 of 10).
- **Pre-park ahead of time.** That costs a window per profile with no intent behind it. Not done (open question 9).
- **Create under the freeze, reveal at the watchdog if it's slow, and go on unfrozen.** Chosen.

The create variant, in the freeze:

1. `openSpaceWindow { spaceId, fullscreen: true }`, as today (`handlers.ts:715-741`). The app calls `binder.expect` for the new window (`Shell.swift:995-1002`), and B's overlay page loads early (`Shell.swift:792`).
2. **No second full-screen request.** macOS already puts the new window into full screen (bg-create 10/10), and the copy already asks with `state: 'fullscreen'`. Today's `fullScreenAfter` re-ask (`ProfileSwitch.swift:74`, `:211-215`) applies only after gate G4, and only on §3.4's evidence.
3. When the copy answers and the binder binds B: R1-R4 as for any B. The made-by-Margin binding needs the copy's bounds to fit (`WindowMatcher.swift:609-614`), so `openSpaceWindow` answers with the window's bounds too, and the copy pushes its window list at once (§3.3).
4. Then A as in §1.3, steps 5-8.

- A fast create (answer in 200-300 ms) comes to about 1.3-1.7 s, with STP's entry and exit times. Some creates hit the watchdog. The person then sees the end of the slide, which is no worse than today.
- In `park` mode, a create happens once per profile per Safari session.

### 1.7 A switch while one is under way, and the keys

- One switch at a time. A new target is queued, and **the last one asked wins**, as today (`ProfileSwitch.swift:119-128`).
- **During `preparing` or `waitingForLink`** (no freeze yet): a new target replaces the current one, and `preparing` starts again. A target in A's own profile cancels the switch: the cover goes, and a `setSpace` runs in A if the space differs.
- **From the freeze until `landed`:** the new target waits. **It starts only from idle**, after `after` has finished and the 150 ms with no Space change have passed (§1.2). It starts from where this switch landed. The same profile as the landing window is a `setSpace` there, as today (`ProfileSwitch.swift:296-305`).
- **A window with a request still pending** (§1.9) can't be the next switch's A or B. The next switch waits for it up to 1 s, then picks another target by §1.5, or fails with "Safari is busy in that window".
- **Held keys:** the space keys' repeat stops before another profile's space (`ShellProfiles.swift:201-232`), so a held key never chains handoffs.
- **The hot keys while a switch is busy.** Today the keys are on only while the front window has a shown overlay (`Shell.swift:1038-1044`, `:1125-1126`), and under the freeze B is on top with no overlay shown yet. So `updateKeys` keeps them on while `switcher.busy` and Safari or Margin is in front, and `run` sends them to the switcher instead: the space keys queue (above), and the others (⌘T, the sidebar key) are dropped and logged. Margin's keys never reach Safari's key window mid-switch, so A's copy never runs `navigate` or a hand-off there.

### 1.8 A cancelled switch, and a copy going away

- **Cancelled before the freeze** (back to A, or the target's space deleted): the cover goes and nothing else happens.
- **B closed by the person mid-switch:** reveal at once. If A was already left or parked, A comes back (§4.4).
- **A closed by the person mid-switch:** go on to B. There's nothing to park.
- **B's copy gone mid-switch** (link down, Safari quitting): reveal at once, then §4.4 "B fails". Parking B again needs only its number, but it also needs B normal (§4.4), which needs B's copy. So a B already asked for full screen stays where it lands, and a B still floating normal is parked again.
- **A's copy gone after B is ready:** A can't be asked to leave full screen, so it's `keep`. A stays in its full-screen Space and B is shown. When A's copy relinks, the aftercare (§1.9) parks it: normal first, then parked, in the background.
- **Safari quitting:** both copies go. Reveal at once, and the registry forgets entries whose pid is gone (§2.1).

### 1.9 Requests that land late

Safari carries out a windows call stuck behind a hung tab later, when it gets to it (`background/tabs.ts:156-158`, `:174`). Once the call is made, it can't be taken back. So:

- **`notAfter`.** Every `setWindowState` carries `notAfter` (ms since 1970: the app and the copies share the clock). The copy checks it just before it calls `windows.update` and answers `{ refused: 'late' }` if it's past. Values: B's full screen, 1.5 s after the freeze; A's normal, the switch's `settleTimeout`.
- **One windows call per window.** The copy keeps `pendingWindowCall[windowId]`. A second `setWindowState`, `focusWindow` or `closeWindow` for that window while one is pending answers `{ busy: true }` without calling. That's also positive evidence of a stuck window: the log says so, and §1.7 waits or moves on.
- **The aftercare watch.** After each switch, the shell keeps an expectation per touched window for 10 s, or until that window is a later switch's A or B (which then owns it): parked windows stay parked, and the shown window stays full screen. Each read compares:
  - **A parked window enters full screen late** (B's stuck request from a switch that gave up). If no switch started since and the person hasn't acted (no key, no click in Margin), it's a **late landing**: B is adopted as the shown window, the window shown before is set normal and parked in the background, and the notice says "Switched to Work (Safari was slow)". Otherwise B is set normal and parked again (visible, logged).
  - **The shown window leaves full screen late** (A's stuck `normal`), and it isn't the shown window any more: it's parked, as was meant.
  - **A parked window back in a user Space or on screen with no focus on it:** re-parked quietly (§2.6, a system return).
  - **A window answering `busy` or `refused: late`:** logged, with nothing else done.
- So a request already sent is always owned by someone: its switch, the aftercare, or the next switch that takes the window.

### 1.10 What blocks a handoff: dialogs, sheets, a busy A

Before the freeze, in `preparing`:

- **A sheet or dialog on A.** The app reads Safari's windows from the window server: a layer-0 window of Safari's pid, other than A and A's full-screen toolbar window (`WindowMatcher.fullScreenToolbar`), whose bounds sit inside A's. Then there's no handoff. The cover goes, and the notice says "Finish the dialog in this window first." Gate G8 checks which of Safari's prompts are separate windows (a JavaScript `alert`, permission and passkey prompts, "leave page?").
- **A busy** (its copy answered `busy`, §1.9): no handoff, and the notice says "Safari is busy in this window".
- **After the park (R5):** no Safari window may stay on screen over A's last bounds other than B and B's toolbar. One that stays is logged (`A's dialog window left behind`) and counted, and the switch still lands.
- A detached Web Inspector is an ordinary Safari window bound to no copy. It's left where it is.

---

### 1.11 Built (WP8)

`app/macos/shell/Handoff.swift` (`HandoffWorld`, `HandoffOptions`, `HandoffChoice`, `HandoffRun`, `AftercareWatch`, `HandoffSession`, and the machine as an extension of `ProfileSwitch`), with `app/macos/shell/ProfileSwitch.swift` as its face; tests in `app/macos/shell/tests/handoff-tests.swift` (`FakeHandoffWorld`: Safari, its Spaces, the real parker and registry over `FakeSpaceWorld`, `FakeFreezer`). Settled on the way:

- **One machine, two ways.** `ProfileSwitch` keeps today's close-based switch, its phases (`creating`, `settling`, `closing`, `checking`) and its words, and runs it when the world isn't a `HandoffWorld`, has no Space reads, or the display list doesn't read (never a guess). It also runs it for `close` without a freeze when the target has no parked window. In a `HandoffWorld` it asks A's drafts first: a draft or no answer keeps A, with `window-kept-draft`.
- **`HandoffWorld` extends `SwitchWorld`.** Four of its members are the shell's own already (`spaceReads`, `parker`, `parking`, `parkingOn`, and `showSwitchNotice`); the rest are WP9's. Until the shell conforms, every switch is today's.
- **The phase `frozen` means "the steps"**, under the freeze when there is one and seen when there isn't. The cover shows in it either way.
- **The choice is picked at the start,** from the facts then. Two changes can come later in the same switch: parking turned off mid-switch (B's show didn't land) makes A's part a close, drafts permitting; and a parked target with no copy id runs without a freeze.
- **A's drafts are asked in `preparing` and never waited for.** At the close, an answer not there yet counts as unknown: A is kept.
- **Notices come after the switch's end event.** The shell's words for an event replace any notice that was up.
- **Recovery waits for A's own pending call** before asking it back to full screen (a second call would only be `busy`), and for a park still under way.
- **The aftercare's watches:** `parkWhenNormal` (a recovered B, an A whose normal timed out) and `leaveFullScreen` (an A whose copy was gone). A recovered B whose full-screen request was sent is watched after it's parked again: going full screen later is a late landing. It counts only if it was seen not in full screen since, or its normal never reached Safari (`busy`, `late`). A Space swipe that aborts a switch is the person's act, so what lands after it isn't adopted. A late landing that isn't adopted puts the shown window back in front. Both mark the window's focus as Margin's (`noteCall`), so the sweep doesn't take it for the person's.
- **Parking off only after ops went out and didn't land.** A show refused before any op (`busy`, `gone`) fails this switch only. A parked target mid-step is waited for (as a pending call, 1 s), and picked again if its step let it go.
- **For WP9:** call `switcher.tick()` (the aftercare) before `parking.sweep`, and pass `switcher.movingNumbers` as the sweep's `moving`. Wire `coverShown(in:)`, `framed(_:mode:)`, `personActed()`, `revealNow(.sleep/.safariQuit/.quit)`, and `start(…, asked:)` for `parkedActivity`. `isTarget` and `leaving` serve §2.3 and §2.4.
- **For WP11:** close mode is freeze 1 with A untouched, then `closeOrKeepA` after the reveal. That's where the second freeze goes. A failed close is already tried once more after 0.5 s. Done: §4.5's "Built (WP11)".

After a review (2026-11-06), each with a case in `handoffReviewTests`:

- **A's normal timed out:** no aftercare watch while the switch still owns A (its `after` hands A on). A park answered `busy` (a step under way) is asked again, and `gone` ends A's part; only a park whose ops went out and didn't land turns parking off.
- **Margin windows** (docs/BROWSER-WINDOWS.md): A always gets its line (or is given one), and a late landing parks or closes only the window its own line showed, never another line's, never one that's parked.
- **A late landing in close mode** closes the window shown before, drafts permitting; with parking off it stays in its own full-screen Space.
- **A swipe's abort** marks the person's act after recovery made its watches, so a late landing after it is never adopted.
- **Going to sleep or quitting** turns the freeze off (until the wake, or for good), gives up a switch not frozen yet with nothing touched, and quitting drops what's queued.
- **The show variant with no bridge** runs unfrozen (macOS slides to the window's Desktop as it's asked into full screen); a bridge show that fails reveals first.
- **A parked target with no copy id:** its space set once it's bound, B's `notAfter` from then (no freeze), and parked again under its profile's link when it's never bound.
- **A B whose show didn't land** is returned to its Desktop when the switch gives up, whatever its drafts answer says or when.
- **The displays don't read and the target has a parked window:** the switch is refused ("macOS's Spaces didn't read"); the close-based switch never adopts a parked window.

## 2. Parking

### 2.1 The registry: keyed by window number

New `app/macos/shell/Parking.swift`, one per shell:

```swift
struct ParkedWindow {
    let number: Int           // the window server's (CGWindowID): the key
    var link: String          // the profile's link key: kept across relinks and new copies
    var windowId: Int?        // its copy's id; nil after a new copy until rebound (§2.2)
    let pid: pid_t            // Safari's process then
    var space: UInt64         // its own private Space
    var bounds: CGRect        // its normal bounds when parked, for rebinding
    let since: Double
    var phase: Phase          // .parking, .parked, .showing, .returning
}
enum Cause { case handoff, recovery, quit, aftercare, system(String), person }
final class ParkingRegistry {
    private(set) var entries: [Int: ParkedWindow]
    var lastShown: [String: Int]            // per link: the home window's number (§1.5)
    func isParked(_ number: Int) -> Bool
    func park(number: Int, link: String, windowId: Int?, done: (Result) -> Void)    // own Space + bridge op + verify
    func show(number: Int, cause: Cause, done: (Result) -> Void)                     // bridge op + removal + verify + destroy its Space
    func returnToDesktop(number: Int, cause: Cause, done: (Result) -> Void)          // to its display's type-0 Space
    func sweep(_ read: SweepRead) -> [SweepFinding]                                  // each read (§2.5)
    func rebind(link: String, unbound: [ExtWindow]) -> [WindowKey: Int]              // §2.2
    func returnAll(done: () -> Void)                                                 // quit (§6.4)
}
```

- **One private Space per parked window**, made at its park (`SLSSpaceCreate(cid, 1, nil)`) and destroyed after its show or return is verified (`SLSSpaceDestroy`). A recovery that destroys a Space affects only that window. A "later return into an older private Space" (`S/stp/stp-1793947586.log` G) can't happen, because a window's Space is gone once it's shown. The removal op still runs (`S/stp/stp-handoff.swift:59`). Gate G5 measures the create and destroy cost, and checks that destroying an empty private Space disturbs nothing.
- **An entry is forgotten only when the window no longer exists:** a per-number liveness read (`CGWindowListCopyWindowInfo(.optionIncludingWindow, n)`) comes back empty for 3 s while Safari's pid is alive, or that pid is gone, or the same copy instance (not a new one) stops listing its `windowId`. Nothing about `ext` or links alone forgets an entry. Gate G6 checks that the liveness read lists a parked window.
- **Hard rule:** the registry never drops an entry that's still alive. Every path that stops tracking a window calls `returnToDesktop` first and verifies it. A debug assertion and a unit test cover it.
- **Memory only**, except the crash marker (§6.4).

Built (WP4): `app/macos/shell/Parking.swift`, `ParkingRegistry` (made with the parker in `Shell.checkPrivateCalls`, as `Shell.parking`). Settled on the way:

- **`ParkedWindow`** also keeps `copy` (the copy instance its window id belongs to, so "the same copy stops listing it" can be told from a new copy) and `cause` (the call under way). `space` is optional: nil once destroyed after a show that didn't land.
- **A copy never seen with the window's id counts as a new copy** when it doesn't list that id. This covers a park before any read named the copy. "Closed in Safari" needs the same copy's word, so the window is rebound, never forgotten.
- **Phases:** `parking`, `parked`, `showing`, `returning`, `closing`, and `out`: still tracked but not in its private Space (a step that didn't land). An `out` window found in a user Space is an ordinary window again and is let go (verified by that read).
- **The liveness read counts only once it has listed the window since its park.** Whether the window server lists a parked window at all is gate G6's question. Without this, a G6 "no" would forget every parked window after 3 s and strand it. Until a read has listed it, only a pid gone or the copy's word forgets it. A number listed under another process is gone at once.
- **The hard rule** is `forget(_:_:)`, the only way out. It allows the four gone reasons, or `shown`/`returned` after a verified step, or a park that sent nothing. Anything else calls `strandCheck` (an `assertionFailure`; a test records it) and keeps the entry.
- **A park that didn't land is returned** to its Desktop by the registry itself (the window may be in its private Space), then let go. A park that sent nothing isn't tracked.
- **`sweep(_:)` acts on what it finds:** a system return is parked again (cause `.system(why)`), or returned when `parkingOn()` is false. One try only: the entry goes `out` first, so a step that doesn't land never loops. A window back but not `normal` waits (§4.4). A person's focus is reported, and nothing is moved: the handoff is WP9's (reported on every read until acted on: below).
- **Quit follows §13.1, not §6.4:** `quit(close:)` asks each window's copy to close it (WP9 passes the closer that sends `closeWindow`). Windows whose copy can't be asked, or didn't close them, are returned. 300 ms in all, then the marker goes. A window not done by then stays tracked and comes back by itself as Margin exits. `endAll` is the same without the marker, for §13.8's shown-window close. `returnAll` returns everything.
- **The crash marker follows §13.2:** `{ pid, build, at, count, windows: [{ number, link, windowId, copy, pid, bounds }], shown: [{ link, number }] }`. `pid` is Margin's, `build` the macOS build. It's rewritten on every change after the first park. At launch, `Shell.recoverParked()` runs once the self-test has answered. It takes the marker (the file is removed, so a second crash never replays it), unless that Margin is still running. It parks again each window of a Safari pid that still runs, still listed with the bounds it had (within 2 pt). The rest are left, and logged as of an earlier Safari, gone or moved. With parking off, all are left. Two more are left (after a review): the window in front on screen (the person may have gone on in one that came back), and, when no other Safari window is in a user Space (the shown one closed since), the one most in front, so Safari always has a window to show.
- **Not wired yet (WP9):** `sweep` from `Shell.track`, `systemEvent` from `WorkspaceApps`, `quit` from `Shell.stop`, `noteCall` for the machine's windows calls, and `rebind` into the binder's `expectParked` (WP5).
- Built (review fixes, after 5954702):
  - **An end that isn't answered leaves no window `closing`.** When `within` runs out, every window still `closing` goes back to the phase it had, with its cause cleared, and one line says so. §13.8 runs `endAll` while Margin keeps running, and a copy that never answered (a hung tab, §1.9) used to leave the window `busy` for every later show, return and park, and out of the sweep's checks. A late "closed" still forgets it; a late "couldn't" changes nothing.
  - **"Closed in Safari" waits for the copy's list.** The same copy must have listed the id since the park, or miss it for `copyLag` (2 s: `WINDOWS_MS` lags up to 1 s; the binder's `alone` + `reportLag`). A window made a moment before its park (§1.6) wasn't in its copy's next list yet, and was forgotten and its private Space destroyed with the window inside.
  - **A step that sent an op is never "nothing sent".** Any failure with `tries > 0` counts as possibly landed: a park's window is returned to its Desktop before it's let go, and a show's private Space is destroyed with the entry kept `out`. `forget(.neverParked)` gets `sent: o.tries > 0`.
  - **The person's return is theirs until it's acted on** (`ParkedWindow.claimed`). Once `.person` is found, it's said on every read (logged once), and the entry is never judged the system's again, focus lost or a system event. Before, a window brought back with focus while a switch was busy (§6.1 drops it then) was parked again as soon as focus left it. It ends with a handoff's `show`, a `park` (which now parks a claimed window for real), or `release(number)`: its Space destroyed and the entry forgotten, once it's in a user Space. WP9 calls `release` when it won't hand off.

### 2.2 The window binder (`app/macos/shell/WindowMatcher.swift`)

Today, a bound window missing from reads keeps its binding for `Timing.absent` (3 s), then the binding goes (`WindowMatcher.swift:211-213`, `:529-534`). A new copy drops all its bindings (`:514-519`).

Changes:

- `WindowBinder.update(…, parked: Set<Int>)`, given the registry's numbers by `Shell.track` (`Shell.swift:774-777`).
- **A bound parked number never drops** for being missing or off screen. It still drops for "closed in the browser" (the same copy stopped listing it), "the browser isn't running", and "a new copy". In the last case the registry keeps the number with `windowId = nil`, and the rebinding below binds the new id.
- **Rebinding after a new copy** (a Margin update gives every window a new id: memory note "safari-tab-ids"): for each link with parked numbers whose `windowId` is nil, `registry.rebind` looks at that copy's unbound windows. A unique match binds by `expectParked(key, number, why)`, like `expect`:
  1. by elimination: one unbound window of that copy with state `normal`, and one nil-id number of that link;
  2. else by bounds: one unbound `normal` window whose bounds fit the stored `bounds` within 2 pt.
  Several matches leave it unbound (§1.5 covers that), and the log says so.
- Parked numbers are left out of the "read that tells nothing" test (`liveBound`, `reliableBig`: `WindowMatcher.swift:398-404`, `:546-548`), and they're never front-window candidates, elimination rivals, or subjects of the moved or visible rules.

Built (WP5): `WindowBinder.update(…, parked:)`, `expectParked(_:number:why:)` (and a form that takes `rebind`'s map), and `expect(…, bounds:)` in `app/macos/shell/WindowMatcher.swift`; tests in `app/macos/shell/tests/window-tests.swift` (`parkedWindowBinding`). Settled on the way:

- **A parked binding is also kept while its copy isn't linked.** That isn't one of the three drop reasons above. A copy that comes back new still drops it, because the binder remembers each link's copy.
- **Each keep is one log line**, said again only when its reason changes: not listed by the window server, off screen, or its copy not linked.
- **Left out on both sides.** Parked numbers are never candidates and never count as browser-sized windows. Keys bound to a parked number, or waiting on `expectParked`, are left out of the reported side: free windows, the bounds groups and the "copies still have windows" test. So a read with only parked windows tells nothing, and a read whose only windows are parked ones is taken as it is.
- **More rules leave them out** than the list above: created together, focus moved (a parked window's focus is logged "not used"), the hidden-page drop and settled focus. A focused parked window stays unseen (§2.6), so its focus says nothing about the front window.
- **A parked window is never "new".** Its number stays in the binder's seen list however long it's missing. A number never listed (parked again from the crash marker) is taken as there before. Shown again, it can't pass for a create's new window.
- **Parked numbers aren't in `absentNumbers`.** That list means a blip kept for 3 s.
- **`expectParked` binds at the next read**, after the drop rules, so a new copy's old bindings go first. It binds on the registry's record, even on a read that tells nothing. It needs the key in its copy's list. It refuses a closed window's number and a key already bound elsewhere. It waits up to `Timing.created` (5 s) when another key holds the number or the copy hasn't reported. Each outcome is one line.
- **Made by Margin with answered bounds:** either the copy's listed bounds or the answer's bounds may fit the one new window. A window bound from the answer before its copy lists it isn't taken as closed for 2 s (`alone` + `reportLag`) after the answer. `Shell.windowMade` passes `SpaceWindowAnswer.bounds` from `ShellProfiles.request`. Those two lines are WP9's files, wired here so the rule works now.
- **Not wired yet (WP9):** `Shell.track` passing `parking.numbers` as `parked`, and `parking.rebind`'s map into `expectParked`.

### 2.3 The overlays (`app/macos/shell/Overlay.swift`, `Shell.track`)

- **Hidden while parked, never closed.** In `Shell.track`'s loop (`Shell.swift:788-850`), a parked key gets `overlay.hide("its window is parked")` and is skipped. The overlay's web view keeps its page, theme and state.
- **A's overlay leaves before A's Space goes** (§1.3 step 5). It's an own-Space panel (`.managed` + `.fullScreenAuxiliary`, `Overlay.swift:67`), which `track` would otherwise leave in A's Space to slide back in with it (`Shell.swift:804-817`). Step 5 orders it and its edge panel out first, and R5 checks it's off screen. Gate G14 records what macOS does with an own-Space panel when its full-screen Space is destroyed.
- **Own-Space checks skip the switch's windows.** `suspectOwnSpace` and `judgeOwnSpace` (`Shell.swift:641-680`), and `checkOwnSpace` (`:609-624`), leave out parked keys and the current switch's A and B. Their suspicions are cleared at park. A handoff can't trip `ownSpaceFallBack`.
- **B's overlay is decided from the app's own reads during a switch.** For the switch's target, `wanted` doesn't wait for the copy's `fullscreen`. The copy's list lags by up to `WINDOWS_MS` (1 s, `background/link.ts:92`, `:727`), and Safari's `onBoundsChanged` is optional (`background.ts:406`). The target's overlay is made or kept from the switch's start (the early overlay, `Shell.swift:792`, generalized). It's shown once R1 and R2 hold and B fills its display.
- **Never shown over nothing:** otherwise an overlay shows only over a bound, on-screen, display-filling window (`Shell.swift:794-823`).
- **Memory:** each kept overlay keeps its web view (open question 8).

Built (WP9): the shell is the switch's `HandoffWorld` (`app/macos/shell/ShellHandoff.swift`; `Shell.track`, `Overlay.swift`, `WindowServer.swift`); tests in `tools/app-tests/e2e-profiles.swift` (`handoffScenario`, with `SpaceWindows` playing the window server and macOS's Spaces from one `FakeSpaceWorld`) and `fake-extension.mts` (`play`). Settled on the way:

- **The gate.** `Shell.Options.handoff`, off by default; `forApp()` reads `MarginHandoff` from the defaults, so the gates' runs (G1's Margin.app half, G16) can turn it on. `handoffOn` is that and the Space reads. Off, `ProfileSwitch.handoffWorld` is nil (`HandoffWorld.handoffOn`, fixed in place in WP8's files): every switch is the close-based one exactly as before, with no drafts asked and no notices, and the registry's `parkingOn` is false, so a crash's marker leaves its windows as normal ones.
- **The parts.** `checkPrivateCalls` makes `RealFreezer(skyLight:)` when the freeze passed, and sets `switcher.session.rules = FreezeRules(availability:)`. A harness gives `Options.handoffParts` (reads, parker, freezer) and `Options.fillsDisplay` instead: used as the check's would be, with no self-test.
- **Each read:** `switcher.tick()` (the aftercare), then `parking.sweep` with Safari's processes, the copies' windows, their copies, the links held and `switcher.movingNumbers`; a new copy's windows rebound (`rebind` into `expectParked`); a parked window with its id known but not bound (from a crash's marker) bound on the registry's record, once; each copy told `parked` (on once it's `parked`, as `docs/PROTOCOL.md` says; a park or a close under way changes nothing, so a system return's re-park never says off and on again; off only after on; per link, so a new epoch hears it again).
- **Overlays.** A parked key's overlay is hidden and kept (its own-Space suspicion cleared). The window the switch leaves: `orderOutOverlay` hides it and it stays out until the switch is over. The target is wanted from the start, and shown once its copy says full screen or the machine has R2 (`run.r2At`), on screen and over a bound window. The own-Space checks skip both.
- **`windows`, `hello`, layout.** A held overlay (parked, or the switch's A or B) gets no `windows` push while its copy's list doesn't say full screen; the latest list goes once it does, or once it's let go. Its `hello` says full screen. `layoutChanged` does nothing for a parked key, and nothing from a hidden overlay a switch is moving. *Deviation:* not for every hidden overlay as §2.4 says: a hidden overlay's early layout is how a new window's pages get their box before its overlay shows (the first-paint work), and that path isn't the handoff's to change.
- **The palette** for a held window: dropped and logged, with no `notShown` and no `paletteDropped`.
- **Keys:** on mid-handoff with Safari or Margin in front (`switcher.keysMidSwitch`: not while it waits up to 90 s for a profile's copy, when there's no cover and A is still the person's). `run` gives the space keys to the switch from where it will land (the queued target, else the target: §1.7's rules then apply), and drops the rest. Every key and click in Margin (but the cover's own word) is `personActed()`. The close-based switch keeps today's keys.
- **A parked window used:** `parkedActivity` and the sweep's `.person` finding merge for 150 ms per window, then one handoff to it from its Margin window's shown window (its line's; with its line showing nothing, no A; a window in no line: `session.shown`, else the front overlay's, docs/BROWSER-WINDOWS.md §3), the tab's space if it named one. Busy: left (logged once). In its aftercare: left. Handoff off: the person's return is `release`d. Dropped while §13.8's closes run, and a `focus` dropped in the registry's 3 s after a wake, a display change or a Dock restart (the system's, §4.4.5).
- **§6.2:** Safari activated, no switch, parked windows, no unparked Safari window in a user Space, none on screen and none unbound; two reads at least 100 ms apart agree: a no-A handoff to the Margin window used last (`recentLine`): its window last shown, else its most recently parked (docs/BROWSER-WINDOWS.md §3). Not while §13.8's closes run.
- **§13.8:** the copies' windows at the last read against this one. A window gone from its copy's list, and not one Margin closed itself (the kept window's Close window: `marginCloses`), is kept (`ShownCloseWatch`) until no switch is busy, then judged: its link up, not parked, and its line's shown window (`parkedClosingWith`; a window in no line: `session.shown` by key): after 0.5 s, if Safari's still running and once no switch runs, `parking.endAll(only:)` closes **that line's** parked windows by their copies (no drafts check). Other Margin windows are as they were (docs/BROWSER-WINDOWS.md §3). So ⌘W on B in its switch's `after` or `landed` counts (the machine ends that switch `cancelled` with B still shown, and drops what was queued). The close-based switch's landing sets `session.shown` and its line's shown window too.
- **The system:** `WorkspaceApps` adds `will sleep` (`revealNow(.sleep)`) and a `com.apple.dock` launch ("the Dock restarted"). With a wake and a display change, each is `parking.systemEvent` (3 s). Safari gone with a switch running: `revealNow(.safariQuit)`.
- **Quit:** `Shell.stop` reveals (`.quit`), then `parking.quit(close:)` (§13.1: closed by each copy, 300 ms, the marker removed), then the existing stop. The closer is `parkedCloser()`, also §13.8's.
- **The crash marker:** `recoverParked` (WP4) now reads Safari's processes from `Options.bundleIds`, so a harness's stand-in Safari counts.
- **`framed`:** `Overlay.pageSaid` passes it (only while shown) to the delegate's new `framed(_:mode:)`, and the shell to `switcher.framed`. `switch.coverShown` goes on to `switcher.coverShown(in:)`.
- **Not done here:** several displays (§6.7) stay the machine's rule; nothing new in the copies.

### 2.4 `drawn`, mode and layout

Today a window that leaves full screen is `wanted: false`, so after 1.5 s (`Grace.notWanted`) its copy hears `drawn: false` and its pages lose their box (`Shell.swift:72-128`, `:902-951`).

- `wanted` becomes `((fullscreen || windowedToo) || registry.isParked(number) || switcher.isTarget(key)) && theme != nil`, in both places it's computed (`Shell.swift:790`, `:905`). A parked window's pages keep their box at its full-screen insets, and B is wanted for the whole entry, however late its copy reports.
- **Mode pinned to full screen.** The overlay page takes its mode from its own window's state in every `windows` push (`extension/ui/host-app.ts:133`, `:322-329`), and `PageLayout` carries the mode that `LayoutOutbox` compares (`LinkMessage.swift:37`, `Shell.swift:50-57`). So:
  - the shell doesn't forward a copy's `windows` list (`Shell.swift:556-567`) to the overlay of a parked window or of the switch's target until that copy's list says the window is full screen. Then the latest list is sent;
  - `hello` says `mode: 'fullscreen'` for those windows (`Shell.swift:1150`);
  - `layoutChanged` (`Shell.swift:1171-1179`) does nothing for a parked key, or for any overlay that isn't shown.
- With these, a parked window's pages get no `setLayout` while it's parked, and none when it's shown again, because the slot is the same size and in the same mode, so `LayoutOutbox` sees no change.
- **The palette path skips the switch's windows.** `palettePush` for a parked window or the current A or B is dropped (logged) with no `notShown` and no `paletteDropped` (`Shell.swift:448-473`). `drawn` never flips for a parked window, and Margin's new-tab page never opens in one.

### 2.5 The copies' window lists, `parked`, and the sweep

- The copies still list parked windows (`windows.getAll()`): state `normal`, their own `focused` flag, and `visible: false` once the page says so.
- **New app → copy message** `parked { epoch, windowId, on, at }`, sent like `drawn` (`docs/PROTOCOL.md:62`, `LinkMessage.swift:239`, `:258`). The copy keeps `appLink.parked[windowId]`, and a new epoch clears it. The copy uses it for:
  - `parkedActivity` (§6.1);
  - `focusTab` and `openPin`, which prefer a tab in a window that isn't parked (`handlers.ts:631-636`, `background/tabs.ts:176-199`). When the only match is in a parked window, the copy doesn't raise it: it sends `parkedActivity { why: 'raise', windowId, tabId }`, and the app hands off to that window (§6.11);
  - sleeping tabs: a parked window's tab in front doesn't sleep (`background/sleep.ts`).
- Built (WP7): `AppMessage.parked` and the copy's `parkedActivity` push (`link.parkedActivity(windowId, why, tabId)`). The app decodes that push as its own `LinkMessage.parkedActivity`, so it never reaches an overlay. A `tab` or `raise` must name its tab. A push and a msg that name two different windows aren't a message.
- Built (WP6): the copy keeps `parked` in `background/link.ts` (`appLink.parked(windowId)`, `parkedWindows()`, `onParked`), in memory only (no page reads it). A new link (a new epoch), the link going off and the window closing forget it. A drop that's still reconnecting keeps it: the app may still have the window parked. Settled on the way:
  - **`tab`:** `tabs.onCreated` in a parked window, unless Margin opened a tab in the last 2 s (`openedByMargin`, which `openKeptBehind` and every Margin open mark).
  - **`focus`:** `windows.onFocusChanged` naming a parked window, unless one of this copy's windows calls for it is pending or started or ended within 1 s. Each one heard is pushed: the app merges a burst.
  - **`raise`:** `focusTab` still brings the tab to the front of its parked window (so the handoff shows it, and R3 probes it), then pushes `raise` instead of focusing the window. Not linked (the push can't go), the window is raised as before.
  - **A window that isn't parked first:** `openPin` takes the asking window's tab, then one in a window that isn't parked, then any. A row's tab found by its address (`resolveTab`) ranks the same way.
  - **Sleep:** a parked window's tab in front is skipped as `in front, parked`, its own reason in the pass's log line. (A tab in front never sleeps anyway. This names why.)
- **`registry.sweep`**, on every read, gets the window-server read, Safari's pids, the copies' windows, the binder's held links (link without state, reconnecting) and the switch's state. For each entry:
  - **gone** (§2.1's rule only): forgotten;
  - **its link held or down:** nothing changes;
  - **a new copy:** `windowId = nil`, then rebinding (§2.2);
  - **back in a user Space or on screen, no switch moving it:** §2.6 decides who caused it.

### 2.6 Who caused a return

- **Margin** (a handoff's show, recovery, quit, aftercare): the registry marks the number before it calls. Such a return never starts a handoff.
- **The system** (wake, a display change, the Dock or WindowManager restarting: `NSWorkspace` launch of `com.apple.dock`; or a window found back with no focus on it): for 3 s after such an event, any parked window found back is re-parked quietly. If parking is off, it's returned to its display's Desktop. **It never starts a handoff.**
- **The person:** only **focus landing on a parked window** that Margin didn't cause: its copy's `windows.onFocusChanged` names it, outside a switch, and not within 1 s of Margin's own windows call for it. This covers Safari's Window menu, ⌘`, the Dock's window list, and a link from another app (§6.1). The STP lab showed that a focused parked window stays parked and invisible (`S/stp/stp-1793947586.log` D), so focus, not visibility, is the signal. It's one debounced `parkedActivity` (150 ms) and one handoff to that window.

---

## 3. Showing a parked window, and readiness

### 3.1 Showing

1. The bridge op `SLSBridgedSpaceAddWindowsAndRemoveFromSpacesOperation initWithSpaceID: active windows: [B] options: 7`, sent by `-performWithWMBridgeDelegate` (`S/stp/stp-handoff.swift:47-53`).
2. `SLSBridgedRemoveWindowsFromSpacesOperation initWithWindows: [B] spaces: [B's private Space]` (`S/stp/stp-handoff.swift:54-58`).
3. Verify within 300 ms: `SLSCopySpacesForWindows(cid, 7, [B])` isn't empty and holds the active Space. The lab took 11-21 ms. If gate G5 finds a read that lists a private Space's windows, also check that B is no longer listed there.
4. `SLSSpaceDestroy(B's private Space)`.
5. B appears as a floating window in A's full-screen Space, hidden by the freeze, then enters its own Space (`S/handoff/RESULTS-park.md`: the same on 12 returns).

Built (WP3): `app/macos/private/SpaceReads.swift` and `app/macos/private/BridgeParker.swift`. Settled on the way:

- **The reads** are `SpaceReads`: `activeSpace`, `spaces(of:)` (one window per call: `SLSCopySpacesForWindows` answers the union of the windows it's given), `displays()` (each display's Desktops and type-4 Spaces), `window(_:)` (the per-number window server read) and `display(at:)`. Derived from them: `fullScreenSpaces`, `managedDisplayCount`, `desktop(for:)` and `readsParked`. Every read is optional: nil is unknown.
- **A display list with any odd entry is unknown as a whole.** The count decides whether a switch freezes, so a half-read list isn't trusted.
- **A window's Desktop:** its display comes from its bounds (`CGGetDisplaysWithPoint`, then the display's UUID against `Display Identifier`). With one display entry, that display's Desktop. Otherwise the display showing the active Space. The Desktop is the display's current Space if that's a Desktop, else its first Desktop.
- **Parked reads as off screen when the window server doesn't list the window** (as the labs read it). Whether a parked window is listed is gate G6's question. So `gone` is checked only when a park starts.
- **The parker** is `BridgeParker`. `SpaceParker` is the real one, on `SkyLightSpaces` (reads and bridge), and the same logic runs in the tests on `FakeSpaceWorld`. It polls every 4 ms. Each op gets 300 ms and one resend. A show resends both ops.
- **`show` also handles a window with no private Space** (§1.5 rule 5's show variant): it sends only the first op.
- **A park or show that didn't land keeps its private Space on record,** because the window may still be in it. A later show or return takes the window out and destroys that Space. `destroySpace(of:)` is §4.4's "destroy B's own private Space only".
- **One step per window at a time.** A second step is `busy`.
- **A retry that can't be sent is `notLanded`, not `notSent`** (review fix). The first op went out and may still land, so the Space made for the park is kept and the caller takes the window out of it. `notSent` (and its Space destroyed) is only for a first op that couldn't be made: `tries` 0.
- **The parker logs only retries and failures,** with numbers, Space ids and milliseconds. The registry (WP4) logs each success line in §8.1.
- **`FakeParker` and `FakeSpaceWorld` live in the shell's files,** as `FakeFreezer` does, so WP8's machine tests and WP9's end-to-end run can inject them.
- **The shell holds them:** `Shell.spaceReads` and `Shell.parker` are made by `checkPrivateCalls` from what the check passed. `Shell.parkingOn` is true only once the self-test (§4.2) has passed.

### 3.2 Readiness: R1-R5, polled every 8 ms during the freeze

The freeze has its own poll timer (8 ms), apart from `track`'s burst (33 ms, `Shell.swift:155-160`). Each poll reads `SLSGetActiveSpace`, `SLSCopySpacesForWindows([B, A])`, the type-4 Spaces from `SLSCopyManagedDisplaySpaces`, and B's, A's and A's overlay's bounds and on-screen state (`CGWindowListCopyWindowInfo(.optionIncludingWindow, n)`). Each read takes about 0.1-0.3 ms.

- **R1, B's Space.** The active Space isn't A's (noted at the freeze), it's in B's Spaces, and it's a type-4 Space (`S/stp/stp-handoff.swift:199-205`).
- **R2, B's bounds.** B fills its display (`ScreenGeometry.fillsDisplay`, `WindowServer.swift:87-92`) with the same bounds for 3 polls in a row.
- **R3, a fresh page frame (gate G2).** `frameProbe { windowId: B, width, height, frames: 6, nudgeMs: 80, timeoutMs: 400 }` goes to B's copy when R1 first holds. The copy passes it to B's tab in front (`tabs.sendMessage`, as `reportVisibility` is: `background/link.ts:983`, `content/core.ts:590`). The page:
  - nudges for `nudgeMs`: a 1×1 fixed element, alternating alpha 0.01/0.02 each frame, outside the layout. In the AppKit lab, changed frames cleared full screen's leftover image (`S/handoff/RESULTS.md` step 4);
  - answers after `frames` `requestAnimationFrame`s at the full-screen width (within 2 pt): `{ tabId, frames, firstAt, lastAt, width, height, hasFocus, visible }`.
  - Margin's new-tab page answers the same way (`extension/newtab/newtab.ts`).
  - **Unknown until G2:** whether WebKit runs rAF for B's page under the freeze before it marks the page visible, and whether its commits count as fresh commits of Safari's window. The STP pages animated all the time, which masks the leftover. So R3 ships behind `Options.frameProbe`. G2 runs STP with still pages and logs, per poll, when rAF resumes and when `visibilitychange` fires relative to R1/R2. If rAF doesn't run under the freeze, R3 becomes "the page's `visibilitychange` to visible after R2" and the nudge runs from that. If neither signal comes, R3 is off, and the risk (a leftover or a dark first frame on still pages) is written in TESTING.md.
  - **No answer** within 250 ms of R2: go on, and the log says `no page frames (tab T)`.
- **R4, B's overlay.** B's overlay is shown just above B (`WindowMatcher.stackedAbove`, `WindowMatcher.swift:159-169`) and has said `framed { mode }` since this show, with `mode: 'fullscreen'`. After the shell's `shown` push (`app/shared/host/overlay.ts:274`), the overlay page answers on its next `requestAnimationFrame`. Timeout: 200 ms after R2, then go on (logged). G2 also checks the overlay web view's rAF under the freeze.
- **R5, the old window.** A off screen and in no user Space (parked), or gone (closed), or (`keep`) its Space not active. A's overlay off screen. At least 130 ms since A left full screen. No Safari window left over A's bounds (§1.10). "Left full screen" means the first poll where A's bounds no longer fill the display and A isn't in its old Space (`S/stp/stp-handoff.swift:209-210`).

**Without a freeze:** the same reads drive the steps. If the Space reads are missing too, R1 is today's public "in front" check (`ShellProfiles.swift:355-362`).

### 3.3 New copy requests

All go through `APP_REQUESTS` (`background/link.ts:117-130`) and `handlers.ts`:

- **`setWindowState { windowId, state, focused?, notAfter }`:**
  - refused (`{ refused: 'late' }`) past `notAfter`, and `{ busy: true }` while a windows call for that window is pending (§1.9);
  - otherwise `windows.update(windowId, { state, …(focused ? { focused: true } : {}) })`;
  - then it **polls `windows.get` every 100 ms until the state lands** (as `fullscreen.ts` `waitForState` does, `:21-28`), at most 3 s, and **pushes the window list at once** (`windowsNow`), so the app and B's overlay hear the new state without the 1 s lag;
  - answers `{ windowId, state, landedAt }`, or `{ windowId, state, timedOut: true }`.
  - It's not `focusWindow`, which always focuses (`handlers.ts:750-756`): A must leave full screen without taking focus.
- **`frameProbe { … }`** (above). Answers `{ none: 'no page' }` when the tab doesn't answer within `timeoutMs`.
- **`windowDrafts { windowId }`:** the tabs of that window with typed text not sent, from the sleeping-tabs draft check (`background/sleep.ts:250-266`), all tabs in parallel, 400 ms. Answers `{ drafts: [tabId], unknown: [tabId] }`.
- **`openSpaceWindow`** answers `bounds` too, and pushes the window list at once (§1.6).
- **`focusWindow` and `closeWindow`** take `notAfter` and the one-call-per-window rule too.

Built (WP7, the words only; the handlers are WP6's): `HandoffRequest`, `WindowCallAnswer`, `FrameProbeAnswer`, `WindowDrafts`, `SpaceWindowAnswer` and `OverlayFramed` in `LinkMessage.swift`; `APP_REQUESTS`, `WINDOW_CALLS` and `windowCallRefusal` in `background/link.ts`; all of it in `docs/PROTOCOL.md` "The handoff". Settled on the way:

- `busy` and `refused` are ordinary answers (`ok: true`), so the app tells "nothing done" from a failure.
- `refused: 'late'` also says `pastMs`, for the log line in §8.1.
- A request with no `notAfter` (today's switch) is never late. Late is checked before busy.
- `frameProbe`'s answer may carry `visibleAt` (the page's last `visibilitychange` to visible), for G2's fallback.
- `openSpaceWindow`'s `bounds` is `{ left, top, width, height }`, as the `windows` list has them.

Built (WP6, the copy's side): `extension/background/handoff.ts` (`windowCall`, `setWindowState`, `probeWindow`, `tabCreated`, `focusChanged`), the handlers in `background/handlers.ts`, `windowDrafts` in `background/sleep.ts`, and `extension/shared/frame-probe.ts` (`probeFrames`, `watchVisible`) answered by `content/core.ts` and `newtab/newtab.ts`; tests in `tests/handoff-copy.test.ts`, and the WebKit host's `frame-probe` scenario. Settled on the way:

- **Today's switch keeps its calls.** `ProfileSwitch.swift` sends `focusWindow` and `closeWindow` with no `notAfter`. Those are never late and never `busy`, so its undo's close is never dropped behind its own focus. They still count as pending, so a handoff's call for that window meanwhile is `busy`.
- **`pending` is held until Safari answers** the windows call (and, for `setWindowState`, through the poll). No cap: a call that never answers keeps its window `busy`, which is §1.9's evidence of a stuck window.
- **`setWindowState`** polls every 100 ms for 3 s, and sends the window list at once (`appLink.windowsNow`) whether it landed or not. The log line is the window, the state and the milliseconds.
- **The probe's nudge runs on until the count is done** (at least `nudgeMs`), so every frame counted is a changed one. A frame counts once `nudgeMs` has passed and the window is at the size asked (`outerWidth`/`outerHeight` within 2 pt: the window's size, so the page's zoom and Safari's own sidebar don't change it; a size of 0 isn't checked). The nudge is a `div` under `<html>`, every property `!important` after `all: initial`, its background alpha 0.01/0.02. The answer's `width`/`height` are that window size. The background adds the `tabId`, and waits `timeoutMs` + 50 ms. In the WebKit host, `outerWidth` is 0 (its window isn't Safari's), so the size match is checked only in the unit tests.
- **`windowDrafts`** asks every tab at once with the sleep's own check, drafts only (`sleepInPage(…, draftsOnly)`: shown, playing or moved don't count), in every frame. Not asked: a tab that isn't a web page (Margin's own pages, Safari's), one asleep (`discarded`), and one Safari had unloaded (`foundWithNoPage`): none can hold typed text. `unknown`: no access, no script, a frame nothing can look into, or no answer in 400 ms. Safari not listing the window's tabs in 400 ms is an error, not an answer (the app keeps the window).

### 3.4 The full-screen request: once, and no blind retry

The AppKit lab's own retry toggled B back out: B had entered, then "dropped; asking again", then `didExitFullScreen B` 3 ms later, and the watchdog fired (`S/handoff/park-enter-1793945331.log`). The "dropped while Spaces move" finding came from window creation in that lab's setup (`S/handoff/RESULTS.md` "Setup"), and STP sent one request each time (`S/stp/stp-handoff.swift:196`).

- **The first build sends one request per window per switch.** A request that never takes effect leads to the watchdog, then recovery.
- **A retry needs positive evidence, and gate G4.** G4 sends a duplicate full-screen update mid-entry in STP and finds how Safari treats it, and when a new type-4 Space first appears after a request. A retry may then be allowed only if all of these hold at least 400 ms after the request: the copy's `windows.get` says `normal`, B's bounds and Spaces haven't changed at all since the show, and no new type-4 Space has appeared on B's display. Never while any full-screen Space change is under way. Until G4 passes, `Options.fullScreenRetry = false`.

---

## 4. The fallback chain, checks and verification

### 4.1 Every private call (the list `docs/PRIVATE-APIS.md` holds)

| # | Name | Kind | Used for | Launch check |
|---|---|---|---|---|
| 1 | `SLSMainConnectionID` | function | the connection for all of these | `dlsym` |
| 2 | `SLSNewTransition` | function | the freeze | `dlsym` |
| 3 | `SLSInvokeTransition` | function | the reveal | `dlsym` |
| 4 | `SLSReleaseTransition` | function | after a failed reveal | `dlsym` |
| 5 | `SLSGetActiveSpace` | function | R1, where to show | `dlsym` |
| 6 | `SLSCopySpacesForWindows` | function | R1, park and show verified | `dlsym` |
| 7 | `SLSCopyManagedDisplaySpaces` | function | type-4 Spaces, each display's Desktop, the display count | `dlsym` |
| 8 | `SLSSpaceCreate` | function | a parked window's private Space | `dlsym` |
| 9 | `SLSSpaceDestroy` | function | after a show or return | `dlsym` |
| 10 | `SLSBridgedSpaceAddWindowsAndRemoveFromSpacesOperation` | class, `initWithSpaceID:windows:options:` | park, show, return | `NSClassFromString`, `instancesRespond(to:)`, **`method_getTypeEncoding` against the expected encoding** |
| 11 | `SLSBridgedRemoveWindowsFromSpacesOperation` | class, `initWithWindows:spaces:` | show and return (out of the private Space) | the same |
| 12 | `-performWithWMBridgeDelegate` | selector, via `WindowManagement.framework` | sending 10 and 11 | `dlopen` of the framework, `instancesRespond(to:)` on both classes, its type encoding |
| 13? | a read that lists a Space's windows (candidate: `SLSCopyWindowsWithOptionsAndTags`), or a mask of `SLSCopySpacesForWindows` that includes private Spaces | function | orphan check (§4.4 invariant 3) | only if gate G5 finds one. Without it, no orphan check |

- **Signatures:** every Copy function is declared as returning `Unmanaged<CFArray>?`, and nil means "unknown" (never a crash). The bridge initializers are called only when the type encodings match the ones recorded in `docs/PRIVATE-APIS.md` (from macOS 27.2). A mismatch means parking is off at launch.
- **Already in Margin.app, also listed** (not new, not part of the choices): WebKit's `drawsBackground` key (`app/macos/shell/OverlayWebView.swift:178`, a `responds`/`value(forKey:)` check at launch, logged), and Safari's files read only (`SafariTabs.db`, each profile's `Extensions.plist`, `CloudTabs.db`, with the schema checks those readers already do).
- **Considered and not used:** `SLSManagedDisplaySetCurrentSpace` (it didn't shorten the entry), `SLSOrderWindow` and other direct window calls (refused cross-process with error 1000, or silently ignored: `S/handoff/xp.swift:76-110`), and minimizing.

Built (WP1): `app/macos/private/PrivateCalls.swift` and `docs/PRIVATE-APIS.md`. Settled on the way:

- **Row 12's selector is SkyLight's, not WindowManagement's.** Both classes and their `-performWithWMBridgeDelegate` are implemented in SkyLight (read with `class_getImageName` and `dladdr` on 26B123). `WindowManagement.framework` is still opened and checked: every lab that parked had it loaded, and whether the bridge needs it is untested.
- **The encodings** (macOS 27.2, 26B123): `-initWithSpaceID:windows:options:` `@36@0:8Q16@24I32`, `-initWithWindows:spaces:` `@32@0:8@16@24`, `-performWithWMBridgeDelegate` `v16@0:8`. The perform selector is checked on each class, so the launch line says 4 selectors, not 3.
- **The enumerator's candidate** (row 13) is only looked up, never called: its signature isn't known. `Availability.enumerator` stays false until `PrivateCalls.enumeratorPassedG5` is set after gate G5.
- **The wrappers** are `SkyLight` (nonisolated, so the freezer's watchdog can reveal from its own queue). They're filled in only for the parts the check passed, so a changed encoding never reaches its initializer. Each returns nil or false when it refuses.
- **The bridge's operations are asynchronous** (superclass `SLSAsynchronousBridgedWindowManagementOperation`). The labs never released them. `SkyLight` keeps each for 10 s after it's sent (`KeptOperations`) instead of leaking each one.
  - Built (review fix): it was the last 16. Parked windows have no cap, and quit's returns send two ops per window at once, so a burst released ops still in flight. Kept by age, none is released before its step (at most two tries of 300 ms) is long over. Holding each op in its step was the other way, but it needs the op through `SpaceBridge`; by age needs nothing else. What releasing one mid-flight does is still untested.
- **`drawsBackground` has no launch check yet.** `OverlayWebView.swift:178` sets it unconditionally, not with the `responds`/`value(forKey:)` check written above. `docs/PRIVATE-APIS.md` lists it as still to add (not in WP1's files).

### 4.2 At launch

New `app/macos/private/PrivateCalls.swift`:

- `PrivateCalls.check(resolver:)` runs before the shell starts (`AppDelegate.startShell`). It returns `Availability { freeze, spaces, park, enumerator, missing: [String], mismatched: [String] }`.
- **The park self-test runs across processes.** Margin.app starts a copy of its own binary as a child (`Margin --park-probe`, no new Xcode target). The child shows a 1×1 borderless window at alpha 0, off screen, and prints its window number. Margin parks it, shows it, returns it and checks each step, then the child exits. It takes about 50 ms and shows nothing. A failure means parking is off. This tests the case that can break: Margin moving another process's window. The freeze isn't self-tested, because that would freeze the screen.
- **macOS build:** `sysctl kern.osversion` against the last one in `UserDefaults` (`MarginPrivateCallsBuild`). Every launch checks everything anyway. A changed build adds one log line.
- **Missing anything falls back silently:** no notice to the person, one log line.
- **Tests never call the real functions.** The real resolver and wrappers are made only in `Shell.forApp()` (`Shell.swift:277-286`). The real freezer and parker refuse to run when `MARGIN_APP_TESTS` is set.
- Built (WP1): `PrivateCalls.check(resolver:defaults:)` returns `Availability { freeze, spaces, park, enumerator, missing, mismatched }`, plus each off part's reason and the counts for the launch line. `Shell.checkPrivateCalls()` runs it from `AppDelegate.startShell`, before `shell.start()`. The real resolver goes in `Shell.Options.privateResolver`, set only in `forApp()`. With none (every test, the harness), nothing is checked and every part stays off. `RealPrivateResolver` and `SkyLight` both refuse under `MARGIN_APP_TESTS`, which `tools/app-tests/run.sh` now sets. The self-test is WP3's.
- Built (WP3): the self-test (`ParkSelfTest`, `ParkProbe` and `ProcessProbeChild` in `BridgeParker.swift`). Settled on the way:
  - **It runs right after `shell.start()`, not before** (`Shell.selfTestParking`, from `AppDelegate.startShell`). Starting the child takes a few hundred ms, and the link shouldn't wait for it. Parking stays off (`Shell.parkingOn` false) until the test passes, so a switch in that moment uses the fallback.
  - **Four steps, not three:** park, show, park again, then return. The second park makes the return start from a private Space, as every real return does (quit, `waitingForLink`). Each step is the real parker's own step, with its verify and retry.
  - **The child is caught in `AppDelegate.main()`.** It's a static `main` that runs `ParkProbe.runChild()` for `--park-probe` and otherwise calls `NSApplicationMain`, as AppKit's own `main` does. So the child never loads the storyboard, the shell, the set-up window or `endOthers`.
  - **The child's window:** borderless, 1×1, alpha 0, at (-3000, -3000), `.managed` and `.ignoresCycle`, in an accessory app that never activates. It prints `park-probe window N` and ends when its stdin closes (the parent's `end()`, or the parent gone), or after 10 s. The parent ends it with a `terminate` if it's still running 1 s after its stdin closed.
  - **Limits:** 3 s for the child's number, then 300 ms for its window to be in a Space. On any failure the leftover private Space is destroyed and the child is ended.
  - **The log line comes after the launch line, as its own line:** `private calls: cross-process self-test park 4 ms, show 14 ms, park again 4 ms, return 13 ms (the child's window in a Space in 2 ms, pid N)`, or `private calls: park off: the cross-process self-test failed: …`.
  - **Under `MARGIN_APP_TESTS`** the real child spawns nothing, and `SkyLightSpaces` refuses every read and op (its window read too, though it's public), so no test reads the real window server. The tests drive `ParkSelfTest` with a stand-in child.
- Under the hardened runtime, `dlopen` of Apple's own frameworks passes library validation. No entitlement is added. **Gate G1** confirms that the freeze and cross-process bridge work from a Developer-ID, hardened Margin.app with Screen Recording and Accessibility denied. All the labs so far ran as children of an app that had Screen Recording.

### 4.3 Every real call verified

| Call | Verified by | On failure |
|---|---|---|
| freeze | result 0, a handle | this switch without a freeze. Two switches in a row: freeze off for the session |
| reveal | result 0 | `SLSReleaseTransition`. Freeze off for the session |
| watchdog | the freezer's own timer on a private queue at 1.7 s | counted and logged. Not a call failure |
| show | B in the active Space within 300 ms | retry once, then §4.4 "B's show didn't land" |
| park | in no user Space and off screen within 300 ms | retry once, then parking off for the session, and A is `close` (drafts permitting) or `keep` |
| return | in its display's Desktop Space within 300 ms | retry once, logged. The window comes back by itself when Margin exits (§6.4) |
| private Space | a nonzero id | parking off for the session |

- **Not checkable in the product:** whether a freeze really holds the screen for this process. Only a capture of the screen shows it, and screen recording is ruled out of the mechanism. The lab tool checks it on each macOS beta (§10.3), and `docs/PRIVATE-APIS.md` records the result.
- **The watchdog belongs to the freezer** (`RealFreezer`): a `DispatchSourceTimer` on a private serial queue calls `SLSInvokeTransition` if the handle is still live at 1.7 s, with a lock guarding the handle. A stuck main thread can't hold the screen. Gate G13 kills a freezing process to learn whether macOS releases a dead process's freeze.
- **Reveal-at-once paths:** quit (`Shell.stop`, `Shell.swift:294`), will-sleep (§6.8), Safari quitting, a foreign Space change (§1.2), and any failure.

Built (WP2): `app/macos/private/Freezer.swift`. Settled on the way:

- **The protocol:** `Freezer { delegate, isLive, freeze(watchdog:) -> FreezeResult, reveal(RevealWhy) -> RevealResult }`. `FreezeResult` is `.frozen(handle)`, `.failed(result)` or `.unavailable(why)`. `RevealResult` is `.revealed`, `.failed(result, released:)` or `.notLive`. `RevealWhy` names each path above, plus `ready`, `watchdog`, `closed` and `cancelled`.
- **The session rules are `FreezeRules`,** a struct the delegate keeps (WP8's machine), fed by `FreezeReport`s: two failed freezes in a row, or one failed reveal, turn it off. A success resets the count. A watchdog reveal is counted, not a failure. `FreezeRules(availability:)` starts off when the launch check didn't pass the freeze. It also keeps `lastRevealAt` and `lastWatchdogAt` for §1.5's cooldown. The freezer itself never decides whether to freeze.
- **The lock is held through `SLSInvokeTransition` and `SLSReleaseTransition`,** not just while the handle is taken. So a reveal and the next freeze never overlap in SkyLight, and only one caller ever reveals a handle.
- **The watchdog reveals off the main thread.** The labs only ever revealed on the main thread (`S/handoff/lab.swift:66`). Revealing from another thread on the main connection hasn't been tried on screen yet. It should be part of G1's run (WP13).
  - Tried (WP13, 2026-11-06, 26B123): the handoff lab's `holds` and G1 let `RealFreezer`'s watchdog reveal a 0.5 s freeze from its own queue. It answered 0, nothing changed on screen while frozen, and the screen moved again at once after (`tools/handoff-lab/results/26B123-2026-11-06.md`).
- **A watchdog reveal reaches the delegate a moment later,** on the main actor. By then `isLive` is already false. Every report carries its handle, so a late one is never taken for a later freeze.
- **A freezer that goes away while live reveals** (the labs released instead). A freeze asked while one is live is `.unavailable` and isn't counted.
- **`FreezerOptions`:** `watchdog` 1.7 s and `closeWatchdog` 1.0 s. §4.5's caller passes `closeWatchdog` to `freeze(watchdog:)`.
- **`FakeFreezer` is in `Freezer.swift`, not in the tests.** WP9's end-to-end run (`e2e-profiles.swift`, built without the unit test files) and the harness inject it through `Shell` options. It calls nothing private. Its results are scripted per call, and its watchdog runs on a `SwitchClock`.
  - Built (review fix): **its watchdog keeps the real one's order.** It reveals at once (`isLive` false, a `reveal` then `notLive`) and reports `watchdogReportLag` (1 ms) later on the clock, as `RealFreezer`'s report reaches the main actor after the reveal on its queue. It used to report inside the timer, so WP8's machine would never meet a poll in that gap (`reveal(.ready)` answering `notLive` before `.revealed(.watchdog)` is heard).
- **Not wired yet:** WP8/WP9 make `RealFreezer(skyLight: shell.skyLight)` and `FreezeRules(availability: shell.privateCalls)`, and call `reveal(.quit)`, `.sleep` and `.safariQuit` from the shell's paths.

### 4.4 Never strand a window

Invariants, each with a unit test:

1. **Every switch ends with a visible window of A's or B's** in front: B full screen, A full screen again, or (when neither can be) one of them as a normal window on its display's Desktop. Never nothing.
2. **The screen is always revealed:** the watchdog, plus every exit path.
3. **Every window Margin parked stays in the registry** until Margin has returned or shown it (verified), or it no longer exists (§2.1). Nothing else removes an entry. The registry can check this from its own records. An orphan check of the private Spaces exists only if gate G5 finds an enumerator.
4. **At quit, every entry is returned** (verified) and every private Space destroyed (§6.4).
5. **No handoff starts from a return Margin or the system caused** (§2.6).

Recovery, by where it failed. **A window is parked again only once its copy reports it normal**: if needed, it's asked for `normal` first, then parked when it lands. Gate G10 records what macOS does when a window mid-entry or just after entry is bridged. Recovery after the freeze is visible, and TESTING.md says so.

- **B fails before A was touched** (not full screen in time, closed, its copy gone, a show that didn't land): A is as it was. B is set `normal` (if its full-screen request was sent) and parked again, or closed if this switch created it (today's undo, `ProfileSwitch.swift:271-277`), and the aftercare watches B (§1.9). Reveal. The notice, as today (`ShellProfiles.swift:364-382`): "Couldn't switch to X: …".
- **B fails after A went normal but before it was parked:** A back to full screen and focused, then B as above. This is visible: a second entry (0.8-1.0 s) doesn't fit in the freeze.
- **B fails after A was parked:** A shown (§3.1), full screen and focused, then B as above. Visible.
- **B's show didn't land** (still parked after a retry): destroy B's own private Space only, and check whether B comes back (gate G5). If not, B's copy closes B (`closeWindow`: its tabs are kept as not-open tabs, `PLAN.md` §6), drafts permitting, and the switch goes on as a create. Parking is off for the session. Other parked windows aren't touched: each stays in its own Space.
- **A's park didn't land:** A is a normal window on its Desktop Space, out of sight. Parking is off for the session. A is `close`d now (drafts permitting) or `keep`: it stays a normal window on the Desktop, and the notice says so.
- **A's close failed:** retried once after 0.5 s, and logged. A stays where it is (Tirth's decision).

### 4.5 The close handoff (`close`): two freezes

The lab only ever closed A under a second freeze after B's reveal (`S/handoff/lab.swift:287-296`: hold2 142-149 ms in every run), never inside the first freeze. Today's machine needs a front check after the close because macOS can drop to the Desktop as A's Space goes (`ProfileSwitch.swift:75-76`). So:

1. **Freeze 1**, the same as §1.3 steps 1-4, then reveal on B. A isn't touched, and stays in its own full-screen Space.
2. At least 300 ms later (the lab's pause; the cooldown in §1.5), **freeze 2**, with its own watchdog at 1.0 s.
3. `closeWindow { windowId: A, notAfter }` from A's copy.
4. Wait until A is gone from the window server, the active Space is still B's, and B is the first Safari window on screen, for 120 ms (the lab's rule). If macOS dropped to the Desktop, `focusWindow(B)` once, inside the freeze, while time allows.
5. Reveal. A Desktop drop that's still there at the watchdog is today's `checking` path, visible.

- **Gate G3:** this form in STP, against a single-freeze close. Until it passes, close-mode timings in TESTING.md are marked unmeasured.
- **Drafts:** asked in `preparing`. If a tab has a draft or didn't answer, A isn't closed (`keep`), and B's overlay says so with a new notice kind `window-kept-draft`: "Kept Work's window open: a page in it has text you haven't sent." (Open question 3.)
- **Pages reload** when the profile is opened again. Their tabs come back from Margin's records (`state/model.ts spaceWindowTabs`, `docs/DATA.md:134`).
- **Scroll:** each page goes back to where it was scrolled, once (the scroll record, `docs/DATA.md` "The scroll record").
- **Media restarts.** PiP ends with its window.
- **Honest timings:** a create plus entry is about 1.1-1.7 s still, then about 0.3 s of B, then about 0.15 s still again (G3 measures it). The setting's text says switching is slower and pages reload (§5).
- Built (WP11): `Handoff.swift` `startClose`, `closeTry`, `closingStep`, `checkingStep`; tests in `app/macos/shell/tests/handoff-tests.swift`. Settled on the way:
  - **When freeze 2 starts:** in `after`, once B's focus check (§6.6, 300 ms) is done and the cooldown has passed (300 ms since the reveal; 1 s after a watchdog reveal). The phase is then `closing`, and `checking` for a drop left at the watchdog. Both names are the close-based switch's too, for the same steps.
  - **The close's `notAfter`:** 600 ms into freeze 2. A close that would land after the freeze is refused rather than carried out seen. Unfrozen, `closeTimeout` as before.
  - **"B in front":** B's Space is the active one (the Space reads) and B is Safari's first window on screen (`inFront`). A is gone when the window server stops listing it; its copy's list lags.
  - **The Desktop drop's `focusWindow(B)`:** once, and only in the first 750 ms of freeze 2, so it has time to land before the watchdog. A drop still there at the watchdog (or after as long, unfrozen) is today's checking: B in front for 0.5 s, else focused again every 1.2 s, twice, then "macOS didn't show its window: click it in Mission Control". A switch that closed A always lands on B, even when it ends that way.
  - **A failed close** (an error, `busy`, `refused`): freeze 2 is revealed at once. One more try after 0.5 s, under a new freeze when the cooldown allows. Then A stays in its full-screen Space, logged (`A kept (its close failed)`).
  - **Close mode with no freeze** (and a parked target, so the handoff runs): the same steps, seen.
  - **A's copy not linked at the close:** A is kept with no draft notice (it isn't a draft).

---

## 5. "Close windows to save memory"

- **Where it lives:** the app's browser-level file `data/safari/browser.json` (`BrowserProfiles.swift:107-115`, `docs/DATA.md:121-126`), as `switching: { closeWindows: false }`. It's about switching between profiles, not about any one profile, so every profile's Settings show the same value (open question 6).
- **How it reaches the overlay:** `across` gets `switchSettings: { closeWindows }` (`ShellProfiles.swift:151-180`, `shared/across.ts`), and `ui/host-app.ts` passes it to the form as a feature, as it does `cloudTabs` (`host-app.ts:146-150`).
- **The field:** a toggle in the form after "Show iCloud Tabs" (`settings-form.ts:115`), shown for Safari with Margin.app and more than one profile:
  - "Close windows to save memory: when you switch to another profile, the window you leave closes. Switching takes a little longer and its pages reload when you come back. Off: the window stays open, out of sight, with your place, text and video kept."
- **How it reaches Margin.app:** `saveField` for this field returns `{ perform: 'switch.closeWindows', arg: { on } }`. `ShellProfiles.performAcross` writes `browser.json` and pushes `across` again.
- **Turned on with windows parked:** each parked window is set normal (it already is), returned out of sight, and closed by its copy, drafts permitting (those stay parked, and the notice says so). Turned off: nothing changes until the next switch.
- Built (WP11): `ProfileSwitch.closeParkedWindows()` (`Handoff.swift`), called by `ShellProfiles`' `switch.closeWindows` when it turns on (a no-op until the shell is a `HandoffWorld`, WP9). For each parked window that isn't mid-step:
  - its drafts are asked (`windowDrafts`, 1 s at most from the app's side);
  - nothing typed: closed by its copy where it's parked, through `ParkingRegistry.close(number:…)` (new: one window's close, as `endAll` does for all). Closed: its Space destroyed, the entry forgotten. Not closed in `closeTimeout`, or its copy couldn't: it stays parked as it was. One more try after 0.5 s, then it stays;
  - a draft or no answer: it stays parked, and `window-kept-draft` names it (its Close window closes it). The shell keeps one notice, so with several kept, the last one shows;
  - while a switch runs: done once it's idle.
  - **Not "returned out of sight" first:** it's closed in its private Space, as quit's close is (§13.1). A return is one more step that could show the window, and quit already relies on closing a parked window in place.
- Built (WP10): `BrowserProfiles.closeWindows` and `setCloseWindows` (`browser.json` `switching.closeWindows`; a file without it reads as off), `across.switchSettings`, the `closeWindows` field (`CLOSE_WINDOWS_LABEL`), shown when `ui/host-app.ts` gives the feature `switchSettings` (Safari, more than one profile in `across`, and the app said the value), and `performAcross`'s `switch.closeWindows`. Closing the parked windows when it's turned on is WP11's.

---

## 6. Edge cases

### 6.1 A link from another app, or the person's focus, lands in a parked window

- Seen in STP: with the only window parked, a link opened as a hidden tab in it, the page focused but `vis=hidden`, and no window showed (`S/stp/stp-1793947586.log` D).
- **The copy:** for a tab created in a parked window that Margin didn't open (`markMarginOpening`, `background/tabs.ts:291`; `openKeptBehind`'s tabs), or `windows.onFocusChanged` naming a parked window not within 1 s of Margin's own call, it pushes `{ type: 'parkedActivity', windowId, tabId?, why: 'tab' | 'focus' | 'raise' }`.
- **The app** merges a burst into one event (150 ms), ignores it while a switch is busy or in its aftercare for that window, and runs a handoff to **that window** (§1.5 rule 1), with the tab's space as the target space. It's a full handoff from whatever is in front, or a no-A handoff (§6.2).
- A tab can't be moved to the visible window instead: it belongs to another profile's copy.

### 6.2 Safari activated with every shown window gone

- With every window parked, activating Safari showed nothing (`S/stp/stp-1793947586.log` C).
- This happens when the person closes the shown window (⌘W) while other profiles' windows are parked. Nothing is shown at the ⌘W, because it reads as "I closed my window".
- **The trigger:** Safari activated (`NSWorkspace.didActivateApplicationNotification`), no switch running, parked windows exist, and **no bound, unparked Safari window is in any user Space** (`SLSCopySpacesForWindows`). It's checked after the active-Space notification or a settled read (two reads 100 ms apart that agree), never at a fixed time. A full-screen window that macOS is still sliding to is in a user Space, so this can't fire during that slide.
- **Then:** a no-A handoff to the profile's home window last shown (freeze, show, full screen, ready, reveal). Open question 7.
- If a Dock click makes Safari open a new window instead (gate G9), that window is bound as usual, and the parked ones stay parked.

### 6.3 A parked window closed, or Safari quitting

- **Closed** (Safari's Window menu, or ⌘W while it was key, §6.6): its copy stops listing it. The binder drops it, `DrawnOutbox.closed` runs (`Shell.swift:118-127`), the registry forgets it and destroys its Space, and its tabs are kept as not-open tabs.
- **Safari quits:** the registry forgets that pid's entries and destroys their Spaces. Safari's own restore may bring the windows back next launch as normal windows on the Desktop. Margin leaves them there, and each is parked the first time a switch leaves it (open question 11).

### 6.4 Margin.app quitting, crashing, or replaced by `npm run safari`

- **The lab:** when the parking process dies, the windows come back by themselves within 0-8 ms (`S/stp/stp-1793947722.log`), to Space 1, which was both the active Space and their old one. Gate G13 checks where they land when a full-screen Space is active.
- **A clean quit** (`applicationShouldTerminate` → `shell.stop`, `AppDelegate.swift:154-157`; the SIGTERM from `scripts/app-swap.sh`, `AppDelegate.swift:54-57`; `BundleWatch`'s quit):
  1. reveal if frozen;
  2. each parked window `returnToDesktop` (to its display's type-0 Space, out of its private Space), cause `quit`;
  3. verified, at most 300 ms in all;
  4. each private Space destroyed;
  5. then the existing stop.
  So they land on the Desktop as ordinary normal windows, not floating over the full-screen page (open question 1).
- **A crash:** nothing runs, and the windows come back where macOS puts them.
- **The crash marker:** `~/Library/Application Support/Margin/parked.json` (`{ pid, build, at, count }`, never a title or address), written at the first park and removed at a clean quit. The harness writes it to its temporary root (`Shell.swift:259-263`).
- **The new instance at launch** never re-parks on its own. If the marker is there, the log says `Margin.app didn't quit cleanly: N parked windows came back by themselves`. Those windows are ordinary normal windows of their profiles (open question 2).

### 6.5 The window binder through the switch

- B keeps its number through show and full screen, so its binding holds. Its bounds change on both sides together, so the moved rule doesn't fire.
- A keeps its binding as a parked number (§2.2).
- A created B binds by "made by Margin" (`WindowMatcher.swift:330-338`), with the bounds the copy now answers (§1.6).

### 6.6 Focus after each switch

- A parked window can stay key: `document.hasFocus()` stayed true in a parked page (`S/stp/stp-1793947553.log`).
- **After the reveal**, within 300 ms, B must be key: B's copy reports B `focused` with a `focusedAt` after the switch began, and R3's answer (or a second `frameProbe` with `frames: 1`) says `hasFocus: true`. If not, `focusWindow { windowId: B }` once more, logged either way.
- **Focus moving to a parked window** outside a switch is §6.1 (`why: 'focus'`): the person's choice. Margin never forces focus back to B. That would fight ⌘` and the Window menu.

### 6.7 Multiple displays

- The freeze is screen-wide, and `SLSGetActiveSpace` belongs to the active display. Nothing has been tested on two displays.
- **Read per switch:** the number of managed displays from `SLSCopyManagedDisplaySpaces` (one entry per display; mirrored displays count once), not `NSScreen.screens.count`.
- **More than one:** the freeze is off for that switch.
  - **Parking a new A:** `keep` until gate G11 (a Sidecar iPad is enough) passes. A stays in its own full-screen Space, so nothing is lost. It costs a Mission Control Space for now, and the log says so (open question 4).
  - **Showing an already parked B:** allowed. Its copy first moves B's bounds onto A's display while it's still parked (`windows.update { left, top }`, gate G11), then B is shown into that display's current Space. If B ends up on another display, the switch still finishes and logs it.
- **Back to one display:** the next switch freezes and parks again. Windows kept in their own Spaces are parked the next time a switch leaves them.

### 6.8 Sleep and wake, display changes, the Dock restarting

- `WorkspaceApps` (`WindowServer.swift:120-136`) gets `NSWorkspace.willSleepNotification`, and a launch of `com.apple.dock` (the Dock or WindowManager restarting). It already has `didWakeNotification` and display changes.
- **Will sleep:** reveal at once, and the switch recovers to a safe state (§4.4).
- **Woke, the displays changed, or the Dock restarted:** for 3 s these are system causes (§2.6). Each parked window is verified, and one found back is re-parked quietly, never handed off. If its private Space is gone (a Dock restart may clear it, gate G5), it gets a new one.

### 6.9 PiP and sound while parked

- PiP keeps playing over B while A is parked, sound keeps playing from a parked window, the page goes `hidden`, and its timers run (`S/stp/margin-park-handoff.mp4.log`, `S/handoff/RESULTS-park.md` "Media"). Nothing to build. Starting PiP needs a click or key in the page.
- **Not Margin's:** AirPods switching to another Mac can pause media (`audioaccessoryd` "Hijackv2"). TESTING.md says so.

### 6.10 Input during the freeze

- **Margin's keys** are the switcher's while it's busy (§1.7).
- **Other keys and clicks** reach the windows underneath. Until step 3 they go to A. This can't be prevented, so it's accepted, and the live checklist has a "typing during a switch" line.
- **A trackpad Space swipe or Mission Control** during the still screen moves Spaces under the freeze: §1.2's foreign-Space abort reveals at once and recovers, rather than waiting for the watchdog. Gate G15 records it.

### 6.11 A profile with more than one window, and same-profile handoffs

- A profile can have a shown window and a parked one. For example, Work's W2 is in its own full-screen Space while W1 is parked, or W1 is shown while W2 is parked.
- **Within one copy:** `focusTab` and `openPin` prefer a window that isn't parked. When the only match is in a parked window, the copy sends `parkedActivity { why: 'raise' }` instead of raising it (§2.5).
- **A same-profile handoff:** A and B are both one copy's windows. The machine works per window, so it's the same steps (park W1, show W2), only with one copy. It's never turned into a `setSpace` (`ShellProfiles.swift:251-255` applies only to a target without a window).
- **A link lands in a parked W2 while W1 is home:** the handoff goes to W2, the window that changed (§1.5 rule 1), not to W1.

---

## 7. The UX before the freeze

What exists today: `across.switching { profile, space, phase, notice }` (`ShellProfiles.swift:182-187`), the target chip's `switching: true` (`extension/ui/view-model.ts:393`, `:412`), and a notice for "needs profile" and failures (`view-model.js:567`). There's no cover.

New, kept small:

- **`switchCover`** in the view model, only in A's overlay and only while `phase` is `preparing`, `waitingForLink` or `frozen`: `{ profile: { name, emoji, color, symbol? }, space: { name, emoji } }`.
- **A guarded slot `<m-switch-cover>`** drawn over the page slot, like the launcher (`extension/themes/README.md:69`; slots in `ui/render.ts:38-69`, `ui/sanitize.ts:294`, `:373-385`). Every word is Margin's: "Switching to {profile}…", with the space's name under it. It's the one other exception, besides the launcher, to "never paint under `<m-page>`".
- **Margin's default part** when a theme has none: a centred card in the theme's colours. Arcadia and Neo-brutalism each get their own part.
- No fade in the first build. The "animated later" Tirth mentioned is a later change.
- **`coverShown`:** the overlay page posts `perform('switch.coverShown')` after the cover has been in the DOM for 2 animation frames and no swipe is settling (`m-settling`, `swipe.ts:63-72`).
- **After the switch**, the cover goes from A's (now hidden) overlay with the next `across`. R4 makes sure A's page has drawn without it the next time A is shown.
- **No snapshot of the target** in the first build. It would be stale, it would cross the 1 MB link cap (`docs/PROTOCOL.md:105`), and it would be the only page content the app holds (open question 5).
- **Honest numbers** for TESTING.md and DECISIONS.md, until G16 replaces them:
  - a parked window: about 1.0-1.45 s of still screen behind the cover (STP 1.09-1.32 s);
  - the first switch to a profile in a session (a create): about 1.3-1.7 s;
  - a slow switch: the 1.7 s watchdog, then visible motion;
  - close mode: §4.5;
  - more than one display: today's slide (0.4-0.65 s);
  - today's slide, for comparison: 0.4-0.65 s, with Margin's overlay gone for about 180 ms (`PLAN.md` §15).

Built (WP10, the overlay's side): `switchCover` in `ui/view-model.ts`, the guarded `<m-switch-cover>` slot and `switch-cover` part (`ui/sanitize.ts`, `ui/render.ts`, Margin's default in `DEFAULT_PARTS`), parts in Arcadia and Neo-brutalism, `extension/ui/switch-cover.ts` (`createCoverWatch`, `answerFramed`) wired in `app/shared/host/overlay.ts`, and the switch's notices by kind; tests in `tests/handoff-ui.test.ts`, `tests/theme/switch-cover.test.ts` and `app/macos/shell/tests/handoff-ui-tests.swift`. Settled on the way:

- **Which overlay is A's:** `across.switching.from { profile, windowId }` (the switcher's `from`). The view model draws the cover only when that's its own profile and window. Today's machine has none of the three phases, so it never shows one.
- **The cover's shape:** `{ id, text, label, hasSpace, profile: { name, emoji, color, initial, symbol }, space: { name, emoji } }`. `text` is "Switching to Work…", with Margin's words in the view model.
- **Where the themes put it:** over the page card, above the launcher and under a sidebar out over the page (so a swipe there keeps going). Arcadia's slot comes before its sidebar, and its launcher hides while the cover is up (`.arcadia.switching`). Neo-brutalism's sits at `z-index: 3`, between its launcher (2) and its floating sidebar (8).
- **Margin's default part** fills the slot of a theme with no part and nothing in it: a centred card in `--m-cover-ground`, `--m-cover-text` and `--m-cover-card`, else the system's colours. A theme with no `<m-switch-cover>` at all shows no cover, and the freeze starts at the 250 ms limit.
- **`coverShown`** waits for two frames in a row with the cover in the DOM and no `m-swiping` or `m-settling` element. A swipe frame starts the count again, and a new target counts again. No frames (the overlay off screen): nothing is said.
- **`framed`** is read at the frame after `shown`, so a `windows` list that came meanwhile counts. Only `fullscreen` or `windowed`.
- **The notices** are kinds, not text: `across.switching.noticeKind` (`window-kept-draft`, `dialog-open`, `window-busy`, `late-landing`, `window-on-desktop`) and `noticeProfile`, with the words in `shared/across.ts` `SWITCH_NOTICES`, and `noticeIn` for the one overlay they're for. The app's side is `SwitchNotice` and `Shell.showSwitchNotice` (`ShellProfiles.swift`): the kept window rides in the app's copy of the notice and never goes to an overlay. `window-kept-draft` stays 20 s, the others 8 s. Its **Close window** comes back as `switch.notice { kind, action: 'close' }`, and the app sends that window's copy `closeWindow` (no drafts check).
- **Left for WP8/WP9:** raising these notices from the machine's events, and acting on `switch.coverShown` (`Shell.switchCoverShown` only checks it's A's overlay and logs it), and `framed` (`Overlay.swift` ignores the op until then).

---

## 8. Local diagnostics, and `docs/PRIVATE-APIS.md`

### 8.1 The log

`Diagnostics.note` (`app/macos/shell/Diagnostics.swift:15-18`), with the prefix `handoff:` or `private calls:`. It holds ids, window numbers, counts, modes, results and milliseconds only. Never a title, an address or a page's words. Nothing is sent anywhere.

- **Launch:** `private calls on macOS 27.2 (26C123): freeze ok, spaces ok, park ok (9/9 functions, 2/2 classes, 3/3 selectors, encodings ok); cross-process self-test park 12 ms, show 15 ms, return 14 ms`, or `… park off: initWithSpaceID:windows:options: encoding changed`.
- **A build change:** `macOS build changed from 26B88 to 26C123: private calls checked again`.
- **Each switch, one summary line:** `handoff: safari:s-a#3 → safari:s-b#7 (park+freeze, parked target), frozen 1214 ms (result 0): shown 9, B steady 830, A asked 831, page frames 912 (6, tab 44), overlay framed 930, A normal 1062, A parked 1066, settled 1196; focus ok`. Plus `late (watchdog at 1700 ms, waiting for page frames)`, `aborted: the active Space moved to N`, `recovered: …` or `late landing` when they apply.
- **A demotion:** `private calls: park off for this session: window 18342's show didn't land in 300 ms (spaces [], on screen false)`.
- **The registry:** `parked window 18342 (safari:s-a#3) in its Space 2431 in 9 ms`, `shown … in 14 ms`, `window 18342 rebound to safari:s-a#11 (a new copy; by elimination)`, `window 18400 back after a wake: parked again`, `returned 2 parked windows to the Desktop at quit (31 ms)`.
- **The aftercare:** `aftercare: window 18400 went full screen 3.1 s after the switch gave up: late landing`.
- **The copy's side** (`appLink.note`): `parkedActivity window 3: focus (not Margin's)`, `setWindowState window 3: refused, 210 ms past notAfter`, `frameProbe tab 44: 6 frames in 74 ms at 1512×982`.

### 8.2 `docs/PRIVATE-APIS.md` (new, next to `PLAN.md`)

One table, kept up to date with every change. For each call:

- the **name and kind** (function, class, selector, KVC key, file format), the **framework**, and the exact signature or selector **with its type encoding**;
- **what it's used for**, and the **file and function** that calls it;
- the **launch check**, the **run-time verification**, and the **fallback**;
- the **risk** (high for the bridge: Apple closed similar tricks in macOS 14.5 and 15), the macOS versions seen working, and the last lab run's date, build and gate results (§10.4).

It also holds:

- the rule: no private call without a fallback and a launch-time check;
- the "considered, not used" list (§4.1);
- how to run the lab tool on a beta (§10.3), including the freeze-holds capture check, which the product can't do (§4.3);
- what to watch: the yabai and Hammerspoon trackers, and macOS beta notes.

---

## 9. A dev-only test hook (removed before production)

For live tests without Accessibility, AppleScript or clicks.

- **New `app/engines/webkit/safari/DevHooks.swift`.** It listens to `DistributedNotificationCenter` (as `ExtensionLink.swift:211` already does for `io.tirth.margin.setup`).
- **Off unless** `defaults write io.tirth.margin MarginDevHooks -bool YES`, checked at each notification.
- **Only Test A and Test B:** it refuses a target unless Safari's own name for the profile (`SafariProfiles.swift`) is exactly "Test A" or "Test B". Without names it refuses everything.
- **Notifications:**
  - `io.tirth.margin.dev.switch { to: "Test B", space? }`: a switch from the front window, as a key press would (`startSwitch`, `ShellProfiles.swift:234-240`);
  - `io.tirth.margin.dev.dump`: logs the registry, the choices, the availability, the aftercare and the last 5 switch lines;
  - `io.tirth.margin.dev.mode { freeze: on|off, old: park|close|keep }`: caps the choices for the session;
  - `io.tirth.margin.dev.fail { step: "show" | "park" | "reveal" | "fullscreen" }`: makes the next such call count as not landed (the call isn't made).
- Every honoured notification is logged: `dev hook: switch to Test B (asked by pid N)`.
- **A sender:** `tools/handoff-lab/devswitch.swift`.
- **Removal:** the file, its call sites and the sender go before production. Each has a `DEV-HOOK` comment so one grep finds them.

Built (WP12): `app/engines/webkit/safari/DevHooks.swift` (`DevHooks`, `DevHookWorld`, `DevHookState`, `DevFailStep`, and the shell's side), `Shell.Options.devHooksOn` (set only in `forApp()`), the machine's caps and four fault sites in `Handoff.swift`, `Diagnostics.scrub`, the sender `tools/handoff-lab/devswitch.swift`, the live checklist in `TESTING.md`, and the G1/G16 runbook in `tools/handoff-lab/README.md`; tests in `app/engines/webkit/safari/tests/devhooks-tests.swift`. Settled on the way:

- **"The current profile" is the window Margin shows** (where the last switch landed, else the one in front with its overlay, else the one Safari window with its overlay up). The sender runs in a terminal, so Safari usually isn't in front. It must be Test A's or Test B's for every kind, not only `switch`, and a switch's target the other one.
- **The caps and faults can't reach another profile.** `dev.mode` and `dev.fail` are kept for the session, but a switch uses them only if `HandoffWorld.devHookAllows(A, B)` holds as it starts: the default YES at that moment, and both profiles Safari's Test A and Test B. Anything armed stays armed through other profiles' switches.
- **The names are Safari's own** (`BrowserProfiles.browserNames`, from `SafariProfiles`), never the names typed in Margin. No names read: everything refused. Two Safari profiles with the same test name: refused.
- **Each fault, "not landed, the call not made":** `show` goes to §4.4's "B's show didn't land" with B still in its own Space (no op, so its Space isn't destroyed), then B is closed by its copy (drafts permitting) or returned to its Desktop. `park` goes to "A's park didn't land" with A a normal window where it is. `fullscreen` (B's request, not a new window's) answers `timedOut` with nothing sent: the watchdog, then the settle timeout's recovery. **`reveal` is the exception:** the reveal is made (the screen must never stay held), then counted as a failed reveal for `FreezeRules`, so the freeze goes off for the session as it would. The close mode's second freeze isn't faulted.
- **Delivery:** the observers use `.deliverImmediately`, and the sender posts with it, so Margin.app not being the active app holds nothing back. Fields come from `userInfo` (strings, 64 characters at most) or a JSON string object.
- **The log (§8.1):** the summary line now has the reveal's result (`frozen N ms (result 0)`, which G1 looks for), the probe's frames and tab, what a watchdog reveal was waiting for, and `dev hook: …` when a switch used a cap or a fault. A copy's error reaches the machine's lines (`recovered: Safari didn’t answer (…)`), and a browser's error can name a page. So the copy's errors (`Shell.request`), every machine line and the summary go through `Diagnostics.scrub`: quoted text and anything address-like is taken out. A title with no quotes can't be told from Margin's words, so the rule stays: only Margin's own words, ids and numbers are written on purpose.

---

## 10. The test plan

These must keep passing: `npm test`, `npm run test:theme`, `npm run test:app`, `tools/webkit-host/run.sh`. No `npm run test:e2e`. Tests never read Tirth's real Margin or Safari data, never call a real private function, and never freeze the screen.

### 10.1 Unit and app tests (`npm run test:app`, `npm test`)

- **`app/macos/shell/tests/handoff-tests.swift` (new):** the machine against fakes, in the `SwitchWorld`/`SwitchClock` pattern (`app/macos/shell/tests/profiles-tests.swift:12-80`; `FakeClock` reused).
  - `FakeHandoffWorld`: links (up, held, down, new copy), the copies' windows (id, state, focused, focusedAt, bounds), window numbers, Spaces and the active Space, overlays (ready, framed with mode), the cover, the display count, and scripted answers, lags, `busy` and `refused` for each request.
  - `FakeFreezer`: freeze, reveal and release results, and a watchdog driven by the fake clock.
  - `FakeParker`: park, show and return results and lags, per-window Spaces, and "came back by itself".
  - **Cases:**
    - every row of §1.1 (each mode, each demotion, and the display count per switch with no lasting demotion);
    - the drafts check before every close;
    - every phase's deadline;
    - the watchdog in each of its three states;
    - step 5's latest start;
    - the foreign-Space abort;
    - queued switches starting only from `landed` (including after a watchdog reveal with A's late park pending);
    - a window with a pending request as a next target;
    - every §1.9 aftercare reaction (late landing; late normal; a return with no focus);
    - every §4.4 recovery row, with "parked again only once normal";
    - §1.5's targets, including `waitingForLink` with a parked window, and return-to-Desktop on its timeout;
    - the create variant with no second request;
    - §1.10's blockers;
    - §6.11's same-profile handoff.
  - **The invariants of §4.4** run after every case.
- **`app/macos/shell/tests/parking-tests.swift` (new):** the registry.
  - Keyed by number, and forgotten only by §2.1's rule. Never forgotten by a link down, a reconnecting link or a new copy.
  - Rebinding by elimination and by bounds, and ambiguity left unbound.
  - §2.6's causes: a system return re-parked, never a handoff; a focus event a handoff.
  - A failed show destroys only that window's Space.
  - `returnAll`; the crash marker in the harness root.
- **`app/macos/shell/tests/window-tests.swift`:** the binder with `parked` (never dropped for missing; dropped for closed, browser gone and new copy; left out of `liveBound`, `reliableBig`, front candidates and the rules) and `expectParked`.
- **`app/macos/private/tests/private-calls-tests.swift` (new):** `PrivateCalls.check` with a fake resolver: each missing symbol, class or selector, and each mismatched encoding, gives the right availability. Nil Copy results read as unknown. The real wrappers refuse under `MARGIN_APP_TESTS`.
- **`tools/app-tests/e2e-profiles.swift`:** the whole switch with stand-in windows and `fake-extension.mts` (the fake parker and freezer injected through `Shell` options).
  - the cover and `coverShown`;
  - A's overlay ordered out before A's normal;
  - B's overlay shown from the app's reads before the copy says full screen;
  - no `windows` push and no `setLayout` to a parked window's overlay, and `hello` mode `fullscreen`;
  - `drawn` staying on through park and show;
  - the hot keys on mid-switch, with a space key queued and ⌘T dropped;
  - no palette drop for a parked window;
  - `parked` messages sent;
  - `parkedActivity` starting a handoff, and none while busy;
  - the own-Space checks skipping the switch's windows;
  - quit returning every window.
- **`npm test` (extension):** `setWindowState` (`notAfter`, `busy`, waiting for the state, pushing the list), `frameProbe` in the content script and the new-tab page (a fake rAF), `windowDrafts`, `parked` kept per epoch, `parkedActivity` (tab, focus not Margin's, raise), `focusTab`/`openPin` preferring an unparked window, sleep sparing a parked window's front tab, `openSpaceWindow`'s bounds, the settings field and its `perform`, the cover slot in the view model and sanitizer, and `framed { mode }`.
- **`npm run test:theme`:** the cover slot in Arcadia and Neo-brutalism, and Margin's default part.

### 10.2 The WebKit host (`tools/webkit-host/run.sh`)

It must pass as before. A scenario for `frameProbe` in a real WebKit page (rAF answers, nudge element outside the layout, no layout shift), and the overlay's `framed` answer. It can't show the freeze or parking (its window is ours).

### 10.3 The lab tool (`tools/handoff-lab/`, a repo test tool run on each macOS beta)

- Built from the STP labs (`S/stp/stp-handoff.swift`, `S/stp/stp-lab.swift`, `S/handoff/park.swift`, `S/handoff/xp.swift`), sharing `PrivateCalls.swift`'s declarations so the lab tests what ships.
- Runs against Safari Technology Preview with its own test extension (`S/stp/ext`), or release Safari in Test A/Test B. Only with Tirth's go-ahead, since it drives windows on screen (memory: on-screen test discipline: one dry run first, abort on the first failure).
- It records frames with ScreenCaptureKit, which needs Screen Recording **for the lab tool only**, never for Margin.app. That's how it checks that a freeze holds the screen (§4.3).
- Its report is one file per run (`tools/handoff-lab/results/<build>-<date>.md`): per gate, pass or fail and the numbers. `docs/PRIVATE-APIS.md` links the latest.

### 10.4 Gates (lab runs that decide what the build turns on)

Each gate is a mode of the lab tool. Until it passes, the part named stays off or uses its fallback.

| Gate | What it runs | Decides |
|---|---|---|
| G1 | the freeze and a cross-process bridge park/show from a Developer-ID, hardened Margin.app build, with Screen Recording and Accessibility denied | the whole mechanism. Fails: freeze and park off |
| G2 | STP handoffs with still pages (still variants of `a/b/n.html`) and the real nudge in a content script: per poll, rAF and `visibilitychange` against R1/R2, the overlay web view's rAF, and frames after the reveal | R3's signal (rAF, `visibilitychange`, or off), R4 |
| G3 | the close handoff in STP: two freezes against one | close mode's form and timings |
| G4 | a duplicate full-screen update mid-entry in STP, and when a new type-4 Space first appears after a request | `fullScreenRetry` and its evidence (§3.4) |
| G5 | per-window private Space create/destroy cost; destroying an empty one; a read or mask that lists a private Space's windows; the private Space after a Dock restart | per-window Spaces, the enumerator (§4.1 row 13), §6.8 |
| G6 | whether `.optionAll` and `.optionIncludingWindow` list a parked window, and with what bounds | the liveness read (§2.1), the binder's inputs |
| G7 | rapid A→B→A, and a second freeze 0.15, 0.3, 0.6 and 1 s after a watchdog reveal | the cooldown (§1.5) |
| G8 | `alert()`, `confirm()`, a permission prompt, "leave page?", and a detached Web Inspector in A at switch time | §1.10's blocker rule |
| G9 | ⌘`, the Window menu, the Dock's window list, ⌘H then unhide, Bring All to Front, a Dock click with every window parked | §2.6 and §6.2 |
| G10 | parking a window mid-entry and just after entry | recovery (§4.4) |
| G11 | two displays (a Sidecar iPad), including `windows.update {left, top}` on a parked window | §6.7 |
| G12 | `S/handoff/park.swift` `PARK=bridge` with the webkit-host window gone: frame counts | the bridge's frame evidence |
| G13 | killing the freezing process mid-freeze; where windows land when the parker dies with a full-screen Space active | §4.3, §6.4 |
| G14 | an own-Space panel (Margin's overlay behaviour) in a full-screen Space that's destroyed | §2.3 |
| G15 | the active Space during Safari's entry, polled; a trackpad swipe during a freeze | §1.2's abort rule |
| G16 | at least 30 handoffs in release Safari (Test A/Test B) with Margin's extension, real sites, and R3/R4 on: the reveal-time distribution and the late-reveal rate | the honest numbers, `Options.watchdog`, the step-5 limit. **Acceptance for the build, with Tirth's go-ahead** |
| G17 | a watchdog reveal during A's exit, and during the settle | §1.4's claim that nothing shows |
| G18 | the bridge on a minimized window | §1.5 rule 6 |

Built (WP13): `tools/handoff-lab/` (`lab.swift`, `build.sh`, `ext/`, `www/`, `server.py`, `results/`, and `README.md`, the runbook). One mode per gate, plus `holds`, the freeze-holds check. Settled on the way:

- **It compiles what ships.** `build.sh` builds the lab with the app's own `PrivateCalls.swift`, `Freezer.swift`, `SpaceReads.swift` and `BridgeParker.swift`, and what they need, with the app target's settings. So every freeze is `RealFreezer`'s, every park, show and return is `SpaceParker`'s, and G1 runs the real `ParkSelfTest` with the lab as its child. `BridgeParker.swift`'s `extension Shell` is left out of a copy, because the lab has no shell.
- **The lab drives only STP's windows, never release Safari's** (this changes §10.3's "or release Safari in Test A/Test B"). The lab can't tell which profile a Safari window belongs to, so it can't promise to stay in Test A and Test B. Release Safari is reached only through Margin.app: G1's second half and G16 post WP12's dev hook, which refuses any other profile, and they read Margin's own log lines.
- **The lab's server takes only the lab's calls** (review fix). Any web page in any browser on the Mac can reach 127.0.0.1, and the server took `/enqueue` from anyone with `Access-Control-Allow-Origin: *`, so a page could have read STP's tab addresses and titles or closed its windows. Now the lab's own calls carry a token made per run (`LAB_TOKEN`, `X-Lab-Token`); other origins and host names are refused; no answer allows every origin; and `ext/bg.js` runs only the lab's ops, opens only lab pages, allows only `tabs.update` to a lab page, and strips addresses, titles and icons from every answer.
- **Nothing runs on screen without `--go`.** `--dry-run`, or no `--go`, prints the plan and read-only checks. The first failure stops the run. At the end, and on ⌃C, every window the lab parked is returned and its own windows are closed.
- **G1 has two halves.** The lab's half (launch check, cross-process self-test, `holds`) runs hardened, but under the terminal's grants. The half without permissions is Margin.app's: its signature, its own launch and self-test lines, and with `--dev-hook` one switch. Whether Margin has Screen Recording or Accessibility can't be read, so that's checked by hand.
- **Where each gate runs:**
  - G6, G10, G12, G14, G17 and G18 use the lab's own windows (as `S/handoff/park.swift` did). G5, G6 and G13 use hidden windows of a child process. The window server treats these as it treats Safari's.
  - G7 and G15 also run in STP with `--stp`. Every STP handoff also logs G6's liveness read of the window it parked.
  - G8, G9 and G15's swipe are guided steps (`--person`), because the lab has no Accessibility to press keys or dismiss prompts.
- **G2's probe is the lab's `ext/probe.js`,** in §3.2's shape, until WP6's content script exists.
- **Reports are one file per macOS build and day** (`results/<build>-<date>.md`), with a section per run, so two runs on a day don't overwrite each other.
- **First runs** (own and child windows only, 26B123):
  - `holds` passed, including the watchdog's off-thread reveal.
  - G1's lab half was partial: the self-test passed (park 5 ms, show 5 ms), but Margin.app wasn't installed.
  - G5 passed: 20 empty Spaces made and destroyed with nothing disturbed, and a Space per window. Reads that list a private Space's window exist: `SLSCopySpacesForWindows` with mask 0xF and up, and `SLSCopyWindowsWithOptionsAndTags`. `enumeratorPassedG5` stays false until that's reviewed.
  - G6: the liveness read lists a parked window, with its bounds unchanged, so §2.1's rule can count on it.
  - G15 passed on the lab's own windows: two handoffs, about 1.33 s held, no other Space.

### 10.5 The live checklist (TESTING.md, in Test A and Test B only)

Switch both ways, ten times. Switch with PiP and with sound. A link from Mail into a parked profile. ⌘` and the Window menu. ⌘W the shown window, then click the Dock. Type during a switch. Swipe the sidebar into a switch. Sleep mid-switch. Quit Margin with windows parked. `npm run safari` with windows parked. A draft in close mode. Two windows in one profile. A second display. Each line says what to expect, including what's visible on purpose (recovery, a late reveal, close mode's two still moments).

---

## 11. Work packages

The work packages are listed in the structured output. They map to these sections:

- WP1 → §4.1-4.3 and `docs/PRIVATE-APIS.md`.
- WP2 → the freezer.
- WP3 → the Space reads and parker, with the self-test.
- WP4 → §2.1, §2.6 and §6.4.
- WP5 → §2.2.
- WP6 → §3.3, §2.5 and the copy-side parts of §6.1 and §6.11.
- WP7 → the protocol.
- WP8 → §1.
- WP9 → the shell's parts of §2.3, §2.4, §1.7, §6.
- WP10 → §7 and §5's UI.
- WP11 → §4.5 and the scroll record.
- WP12 → §8 and §9.
- WP13 → §10.3 and §10.4.

The build order is WP13 (lab tool) and WP1 first, so that G1 can run before anything relies on the mechanism.

---

## 12. Open questions for Tirth

1. At quit, parked windows go back to the Desktop as normal windows. OK, or should they be closed?
2. After a crash, windows that came back by themselves are left as normal windows. Should they be parked again?
3. A draft in a window that close mode would close: keep it open with a notice (designed), or ask first?
4. With more than one display, the first build keeps the old window in its own full-screen Space (an extra Mission Control Space) until the two-display lab passes. OK, and how soon do you want two displays supported?
5. A snapshot of the target in the cover: leave it out (designed)?
6. "Close windows to save memory" for the whole browser (designed), or per profile?
7. With every window parked and Safari activated: show the home window (designed), or nothing?
8. A cap on how many windows stay parked (memory)? If so, how many, and is the oldest closed (drafts permitting)?
9. Pre-park a window per profile ahead of time? Not designed.
10. A slow switch that lands late, with nothing done meanwhile: go to it ("late landing", designed), or undo it?
11. After Safari restarts, its restored windows are normal windows on the Desktop. Park them at once, or only when a switch leaves them (designed)?
12. A pin or tab click whose tab is only in a parked window of the same profile: hand off to that window (designed), or move the tab into the shown window?
13. A dialog up in the current window: refuse the switch with a notice (designed)?
14. The gates need on-screen runs in STP and in Test A/Test B (G1-G18, G16 at least 30 handoffs). When may they run, and may the lab tool have Screen Recording?
15. The launch self-test starts a hidden child copy of Margin for about 50 ms. OK?

---

## 13. Tirth's answers (2026-11-06)

These override the sections they name. Where §12 asked, this is the decision.

1. **Margin.app quits with windows parked (overrides §6.4 "a clean quit"):** every parked window is **closed** by its own copy (`closeWindow`, its tabs kept as not-open tabs, as any closed window's). Only the window on screen stays. This includes the quit from `npm run safari` (`scripts/app-swap.sh`) and `BundleWatch`. No drafts check at quit: Tirth (2026-11-06) wants every parked window closed, unsent text or not. A copy that isn't linked at quit: its parked windows are returned to the Desktop (they'd come back by themselves anyway).
2. **Margin.app crashes (overrides §6.4 "the new instance at launch"):** nothing can run at the crash, and the parked windows come back by themselves. The crash marker (`parked.json`) records what's needed to find them again: each parked window's number, link, copy window id, bounds and pid, plus the window that was shown (never a title or address). At the next launch, if Safari's pid is the same, each window from the marker that's still alive is **parked again** (no freeze, no handoff; logged), and the shown one stays. Windows whose pid changed (Safari restarted too) are left as normal windows (answer 3).
3. **Safari restarts:** as designed: restored windows stay normal windows, each parked the first time a switch leaves it.
4. **A draft in a window that close mode would close:** as designed (kept open), and the notice offers a **Close window** action so the person can close it themselves (`closeWindow` on their click, no drafts check then).
5. **"Close windows to save memory":** one setting for the whole browser, as designed.
6. **No cap** on parked windows. Only close mode closes them, as each switch leaves them.
7. **The cover:** no snapshot, for now.
8. **Closing the shown window closes every parked window (overrides §6.2 and §6.3's ⌘W case):** to the person it's one window. *(2026-11-09, docs/BROWSER-WINDOWS.md §3: only that Margin window's parked windows.)* When the window Margin shows is closed by the person (⌘W, its close button, the Window menu: any close that isn't Margin's own close handoff, a create's undo, or Safari quitting), Margin closes every parked window of every profile too (each by its own copy's `closeWindow`; tabs kept as not-open tabs; no drafts check). Their private Spaces are destroyed. So §6.2's "every window parked, Safari activated" no longer arises from ⌘W; a Dock click then opens Safari's own new window, bound as usual. §6.2's no-A handoff stays only for a return Margin can't explain (logged), and shows the last shown window. A person's own second window (answer 11) isn't closed.
9. **Late landing:** as designed, for now.
10. **A dialog in A blocks the switch** with a notice: as designed.
11. *(Replaced 2026-11-09 by docs/BROWSER-WINDOWS.md: every window is a Margin window with its own window per profile; ⌘N makes one.)* **One window per profile (overrides §6.11 and §1.5 rule 1's same-profile case):** a profile is one window, and its spaces switch inside it (`setSpace`), never by a handoff. A second window the person opens themselves (⌘N) is left alone: never parked, never a handoff target, and Margin's pins and tabs go to the profile's own window (the one Margin shows and parks, `registry.lastShown`). No same-profile handoffs are built.
12. **No pre-made windows** for now. (A pre-made window costs a whole Safari window, ~100-300 MB, and saves about 0.3 s on the first switch into a profile only.)
13. **Two or more displays must work like one display**, built right after the single-display handoff works properly. Until then, the multi-display rule of §6.7 stands.
14. **The gates may run** (Tirth on another computer, 2026-11-06). The lab tool may use Screen Recording (through the terminal's existing grant); Margin.app never does.
15. **The launch self-test** (a hidden child copy for about 50 ms): OK.

---

## Appendix A. Critiques: what was accepted, and what wasn't

Two critics reviewed draft 1. Each problem was checked against the code at df6877e and the lab files. Their numbering follows the order they were given.

| # | Problem (short) | Verdict | Where it's solved, or why not |
|---|---|---|---|
| 1 | The sweep forgets a parked window when its copy's link drops or its ids change, stranding it | **Accepted.** Confirmed: `linkDown` removes `links[key]` at once (`Shell.swift:394`), `ext` is built only from links with state (`:769-772`), and a new copy drops its bindings (`WindowMatcher.swift:514-519`) | §2.1 (keyed by number, forgotten only when the window is gone, the hard rule), §2.2 (rebinding), §2.5 (the sweep gets held links), §1.5 (`waitingForLink`, show or return by number) |
| 2 | A queued switch starts while the previous one's late steps still run | **Accepted.** Confirmed: draft 1 started 150 ms after the reveal, and today's `finish()` chains at once (`ProfileSwitch.swift:286-308`) | §1.2 (`after` and `landed`), §1.7 (only from idle), §1.5 (cooldown), G7 |
| 3 | Late answers to `setWindowState` have no owner | **Accepted**, with the generation number replaced by `notAfter` (the app is the only sender, and a deadline does the same job) | §1.9, §3.3 |
| 4 | `plain` drops "Keep windows alive" whenever there are two displays or one freeze call fails, and closes without a drafts check | **Accepted** | §1.1 (two separate choices, per-switch setup facts, two failures to turn the freeze off, drafts before every close) |
| 5 | One shared private Space: a recovery releases every profile's windows, and the returns become a chain of handoffs | **Accepted** | §2.1 (a Space per window), §2.6 (causes), §6.8, §4.4 invariant 5 |
| 6 | R4 and `drawn` wait for the copy's lagging `fullscreen` | **Accepted.** Confirmed: `WINDOWS_MS` 1 s, and the optional `onBoundsChanged` | §2.3, §2.4 (`isTarget`), §3.3 (the copy polls the state and pushes) |
| 7 | A parked window's hidden overlay flips to `windowed` and sends `setLayout` | **Accepted.** Confirmed: `windows` goes to every overlay of the link (`Shell.swift:556-567`, via `overlays(of:)`), and the mode comes from it (`host-app.ts:322-329`) | §2.4 (no list until full screen, `hello` mode, `layoutChanged` held), R4's `framed { mode }` |
| 8 | A's own-Space overlay stays in A's Space as it's destroyed; own-Space suspicion can fall back | **Accepted** | §1.3 step 5, §2.3, R5, G14 |
| 9 | The hot keys go off under the freeze, and Margin's keys reach Safari | **Accepted.** Confirmed: `run` needs `frontOverlay` (`Shell.swift:1125`), and the keys are active only with one (`:1038-1044`) | §1.7, §2.4 (palette path) |
| 10 | Retrying the full-screen request can toggle B out | **Accepted.** The AppKit log shows exactly that (`S/handoff/park-enter-1793945331.log`) | §3.4, §1.6 step 2, G4 |
| 11 | A profile can have a parked and a shown window. Margin's own `focusTab`/`openPin` raise parked windows, and links target the home window | **Accepted** | §1.5 (window targets), §2.5, §6.1, §6.11 |
| 12 | "None on screen 0.5 s after activation" matches a normal slide | **Accepted** | §6.2 (no user Space, settled read) |
| 13 | A watchdog reveal can land in A's exit or settle; STP exit times are longer than the AppKit lab's | **Accepted** in its budget part (STP's numbers, step 5 from R1+R2, a latest start). That A's frames would show is **not established**: A is out of the active Space by then. It's recorded as G17 rather than designed around | §1.3, §1.4, G17 |
| 14 | (the same as 10, with the log) | **Accepted**, merged with 10 | §3.4 |
| 15 | The self-test parks Margin's own window; the freeze is unverified; no lab ran without TCC | **Accepted** for the cross-process self-test and the hardened, TCC-less run (G1). **Rejected:** treating "freeze appears ineffective" as a run-time demotion signal. Only a screen capture can see it, and screen recording is ruled out of the mechanism. The lab tool checks it per beta instead (§4.3, §10.3) | §4.2, §4.3, G1 |
| 16 | The close handoff was never run with A closed inside the freeze; the Desktop drop isn't budgeted | **Accepted** | §4.5 (two freezes, the lab's proven form), G3, §7 numbers |
| 17 | R3/R4 rely on rAF under the freeze, untested with still pages | **Accepted** | §3.2 (R3 behind G2, with fallbacks), G2 |
| 18 | Safari focusing a parked window leaves it parked; draft 1's "focus B again" fights the person | **Accepted.** Confirmed: `S/stp/stp-1793947586.log` D | §2.6 (focus is the person's signal), §6.1, §6.6, G9 |
| 19 | Recovery parks windows mid-entry, a state no lab parked | **Accepted** | §4.4 (parked again only once normal; visible recovery stated), G10 |
| 20 | Verification can't see the private Space; invariant 3 can't be checked | **Accepted.** Invariant 3 restated in checkable terms, and the enumerator search added | §4.4, §4.1 row 13, G5, §6.8 |
| 21 | The budget rests on 4 STP handoffs | **Accepted.** G16 is the acceptance figure, and it needs Tirth's go-ahead for on-screen runs | §1.4, §7, G16 |
| 22 | (the same as 2) | **Accepted**, merged with 2 | §1.7 |
| 23 | Sheets, dialogs and inspectors aren't handled | **Accepted** | §1.10, R5, G8 |
| 24 | The launch checks don't check signatures; non-optional `Unmanaged` can crash | **Accepted** | §4.1 (encodings, optional returns), G13 |
| 25 | Multiple displays: bridge shows untested; the display count is weak | **Accepted** | §6.7 (managed-display count, `keep` until G11, B's bounds moved first), G11 |
| 26 | Bridge frame counts are mixed with the webkit-host window | **Accepted** | G12 |
| 27 | A minimized target slides visibly; swipes during the freeze aren't handled | **Accepted** | §1.5 rule 6, G18, §1.2's abort, §6.10, G15 |

Smaller points, partly rejected:

- **3's "have the copy refuse a stuck call":** a call already made can't be refused. The copy's check covers only requests that arrive late, so the aftercare (§1.9) handles calls that were made and then stuck.
- **5's "a private Space per attempt":** per window was chosen. A window's Space is destroyed once it's shown, so each park is a new attempt anyway.
- **11's "refuse to raise":** the copy asks the app instead of refusing, so a pin click still does what the person meant.
