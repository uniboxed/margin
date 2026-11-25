# Link resilience: a slow Safari never leaves Margin stuck (design)

Tirth, 2026-11-24, after two probes on his Mac: no new permission (Accessibility stays Margin's only one), no relay
through pages or Margin's own page (paths A and B dropped), so: **resilience, a start-up that never sticks, and a
WebKit bug report**. "Yes please do it properly. make no mistakes." This is the design only; nothing here is built
yet. Line numbers are at `fix/waker-quit` (94bd90ab).

## Summary (for Tirth)

Safari sometimes runs Margin's extension in slow motion: right after the Mac starts, or when the Mac is very busy,
the extension's own timers and its connection to Margin.app can run 7 to 30 seconds late, while the events Safari
sends it (a window focused, a tab changed) still arrive on time. It's Safari's doing: WebKit means to keep an
extension's background awake, but loses that as the background starts (a WebKit bug, reported below). On a quiet Mac
it didn't happen once in about 50 minutes of use.

What changes:

1. **A tab switch Margin asks of Safari is never silently dropped.** Today Margin gives up after 15 seconds and the
   switch just doesn't happen ("its tab wasn't shown (timedOut)"). With the change, the item you picked is drawn as
   picked at once, Margin shows that Safari is switching (and, if it takes long, that Safari is slow), and the switch
   lands as soon as Safari catches up. Picking something else moves on at once (today the next pick of anything, an app
   too, waits behind the stuck one). A late answer to a switch you've moved past changes nothing.
2. **Starting Margin never sticks on "Getting you started".** The start screen waits only for what the first thing
   shown needs: the Safari profile of the item it reopens, or nothing at all when that item is an app or Margin's own
   page. Other profiles connect when you first use them. The extension tries to connect when Safari sends it events, so
   a slowed timer can't hold it back for half a minute.
3. **The WebKit bug is reported** with the evidence (text below, ready to file).

What doesn't change: Margin's permissions, what Margin does in Safari, the waker's rules (Safari's menu pressed only
on evidence), and anything on a Mac where Safari isn't slow: every new wait ends at the same moment the old code would
have succeeded.

One finding along the way: the "press 2: no window came of the one before" line this morning was only Margin's quit
(already fixed in 94bd90ab), not a fault in how the waker reads evidence.

## The evidence

From today's unified log (09:14–09:18 after the boot at 09:12:03; the probes 10:11–11:00), Safari's own log
(`ProcessSuspension`, `Extensions`), RunningBoard, and WebKit's source at Safari 27.2's tag `WebKit-7625.2.8.11.9`:

- **When.** Stalls came under heavy load (load average 35–40, 12 burners) or right after boot (the 15-minute load
  average was still 20.6 at 09:40). A quiet Mac showed none in ~50 minutes and 40 switches (timer ≤260 ms late,
  socket ≤206 ms).
- **Who.** A profile with no window stalls (s-default today). The profile whose window Margin hosts and shows was on
  time in both probes, but stalled this morning right after boot (Personal: 14.1, 13.7, 28.8, 10.6 s).
- **What stalls.** The background page's event loop: its `setInterval`, its WebSocket messages (a `hostShow` sent at
  09:17:20.3 ran at ~09:17:35.0), a `MessageChannel` task. What doesn't: extension events invoked by WebKit's IPC
  (`focus heard` at 09:16:54.802 and 09:17:00.468 inside a 13.7 s pause; promise replies of `windows.getAll`). The
  process wasn't suspended (RunningBoard: `running-active (role: Background)` throughout; no `PrepareToSuspend` for
  it).
- **Paths under load.** The socket is the best path (≤18 s at the worst). Native dispatch
  (`SFSafariApplication.dispatchMessage` into the copy's port) is the worst: 25–209 s, queued.
- **Why the background is treated as background.** `loadBackgroundWebView` takes the foreground activity "to keep
  background content responsive to events" on the web view's *initial* process, before `loadRequest`
  (`WebExtensionContextCocoa.mm` 2538–2548 at the tag). The load commits in another process; the first one's
  throttler disconnects and the activity goes with it (`Starting foreground activity / 'Web Extension background
  content'` at 09:16:09.738, `didDisconnectFromProcess … Ending` 1 ms later; the same at 09:14:51.545, .909, .914).
  Nothing takes it again, so the page runs on `BG Lifetime Activity` alone (role Background), like a hidden tab.
- **Content scripts can't help.** From an https page, `ws://127.0.0.1` and `http://127.0.0.1` are blocked as mixed
  content (off-screen WebKit host, 2026-11-24), and content scripts have no native messaging.

So the copy keeps running, but whatever goes through its event loop can be very late, and only Safari's own events are
reliably on time. The design follows from that: **never decide anything from a copy's silence alone, never let one
copy's slowness hold up anything else, and use the events that do arrive.**

## Where each piece goes (the architecture rule)

| Piece | Where | Why there |
|---|---|---|
| Requests: ids, acks, no fixed timeout, ending on evidence, re-issue on a new link, late answers ignored | margin-core `link.rs` (`Link`, `Connection`), `link_hub.rs`, `protocol.rs` | The link's session rules, already one copy for Mac and Windows (CORE-REFACTOR §1.5). |
| A show's wait raced against being overtaken, its progress shown, the queue not held | margin-core `session/` (`mod.rs` `ask`, `requests.rs` `show_web`, `loading.rs`) | The session's decisions, already in the core (step 3). |
| The start screen gated only on what the first item needs | margin-core `session/start.rs` | `resume_last`, `hold_startup`, `prepare_browser` are there. |
| The copy: ack at once, dedupe by id, latest show wins per window, waits advanced by events, no give-up from a late timer | `extension/background/link.ts` (and `handlers.ts`/`hosted.ts` for the show) | The extension's own link and lifetime; Chrome and Edge run the same file. |
| Sockets, `SFSafariApplication.dispatchMessage`, the waker's presses | Swift (`ExtensionLink.swift`, `SafariWaker.swift`): unchanged but for deleting a duplicated value | OS mechanism only. |

No rule goes into Swift; one Swift value goes away (`SocketLink.Timing.request`, below). Nothing is written per
platform.

## 1. Requests to a copy

### Today

- The core's link gives every request 15 s (`Timing.request`, `app/shared/core/src/link.rs:53,58`; armed in
  `Link::request`, `link.rs:453`ff; expired in `Link::tick`, `link.rs:392`ff, as `LinkError::TimedOut`). The same 15
  is set again in Swift (`ExtensionLink.swift:190`, sent to the core as `timing.request` in `SocketLink.init`).
- The session's `ask` (`session/mod.rs:1064`) awaits the command; the Mac carries it out through
  `HostedLinks.request` (`ShellHostedGlue.swift:39–48`), which returns the core's `TimedOut` as an error.
- A web show (`requests.rs:500` `show_web`) awaits `hostShow` (`requests.rs:520`) inside the session's **serial**
  queue (`library_request` → `exec.enqueue`, `requests.rs:186`). On an error it logs `its tab wasn't shown (…)`
  (`requests.rs:522`) and stops. Everything picked meanwhile waits behind it: 09:16:40.8 → 09:16:55.78 today, then
  `t-kmljyed8oh: not shown, t-hfhrhgtjoj asked for since`, and Maps only after that.
- The copy runs each `req` as it's read (`extension/background/link.ts:996` `request`), with no memory of ids: the
  same id twice would run twice.

### Rules (margin-core `link.rs`, `protocol.rs`)

1. **Every request has an id** (already: `Connection.next_id`, per link) **and is answered at most once** (already:
   a `reply` counts only while its id is waiting, `link.rs:288–293`).
2. **The copy acks at once.** New copy → app message `ack { id }`, sent in the socket's message handler before the
   request runs (`protocol.rs`: a `LinkMessage::Ack`). An old copy that never acks is handled as today's (its reply
   still ends the request).
3. **Ticks carry a number.** `tick { seq }` (protocol.rs `AppMessage::Tick` gains `seq`); the copy's `tock` echoes it
   (`LinkMessage::Tock { seq: Option<i64> }`; an old copy's tock without one counts only as life). Each waiting request
   remembers the last tick seq sent before it.
4. **No fixed timeout.** `Timing.request` goes (core and Swift). A waiting request ends only on evidence:
   - its **reply** → `Answer Ok`;
   - the **link down** (closed, replaced, 40 s of total silence: the existing `dead` rule, `link.rs:392`ff) → `Answer
     Err(Down)`;
   - **cancelled by the session** (`Link::cancel(conn, id)`: the pick overtaken) → no answer goes up; `cancel { id }`
     sent to the copy; a later reply for it is dropped (it's no longer waiting);
   - **lost**: a tock with a seq sent *after* the request arrived, and still no ack for it. The socket is in order, so
     the copy has read past the request without taking it. That never happens with a correct copy. It's sent once more
     with the same id (the copy dedupes), and logged as a warning. A second loss is `Answer Err(Lost)`.
5. **Signs of life, measured exactly:**
   - *alive* = any bytes on the link (`Link::heard`, `last_heard`, `link.rs:255`; unchanged). This feeds only the
     40 s dead rule.
   - *reading* = an `ack`, a `reply`, or a `tock` with a seq, on that link. Only *reading* says the copy got as far
     as a message, because those all come back from the copy's socket handler in order.
   - A copy that's alive but not reading is **slow, not gone**: its requests keep waiting. Margin says so
     (`Link::slow(conn) -> Option<Secs>`: the oldest unacked request's age, for the session's feedback).
6. **Re-issue on a new link.** When a profile's link goes down and comes back (a new epoch), the session decides
   again what's still wanted (rule 7 below). The link itself never replays old ids into a new epoch.

### Rules (margin-core `session/`)

7. **A show waits without holding the queue.** `show_web` asks with `ask_until(profile, "hostShow", payload, ||
   self.superseded(w, item))` (new, `session/mod.rs` beside `ask`). It ends on the answer or when a newer pick for that
   window arrives (the existing `superseded`, `requests.rs:202`), woken by the existing `exec.changed()`. On being
   overtaken it calls `Link::cancel` through a new command (`Command::Cancel { profile, id }`, carried out like `Ask`)
   and returns `Go::Stop` silently ("overtaken" in the log). The queue moves on at once.
8. **Progress the person sees.** While a show's `hostShow` waits, the window's loader shows the item being switched
   to (the existing `ports.set_showing(w, Some(title), Some(SAFARI_BUNDLE), slow)`, `session/mod.rs:112`, the same
   call `show_web` makes when Safari's window comes in). `slow` goes true once the link reports the copy slow
   (`Link::slow`) and the copy has been slow for `slowSay` (a new session option, default 3 s). That time only
   paces the feedback: nothing is decided by it. The loader itself is set at once, as `show_web` sets it today when
   Safari's window comes in.
9. **A show whose link went down** while it waited: if its pick is still the newest for its window, it's asked again
   once the profile links again (`ensure_linked_for`, `hosting.rs:228`, already waits on evidence through the waker).
   `hostShow` is safe to repeat (it shows a tab that may already be shown). Requests that aren't safe to repeat
   (`hostClose` of a tab that may be gone, `newTab`) aren't asked again: the session logs it, and the library's state
   is authoritative on the next show.
10. **A late answer does nothing.** An overtaken ask's reply never reaches the session (rule 4). If the copy still
    shows the old tab late, the newer `hostShow` comes after it on the same socket (in order), so Safari ends on the
    newer one.

### Rules (extension, `background/link.ts`)

11. **Ack at once and dedupe.** In `onApp` (`link.ts:954`), a `req` is acked before `request()` runs. Per epoch, the
    copy keeps the ids it has seen (running or answered, the last 64): a repeated id that's running is ignored (its
    reply comes); one answered gets its reply again.
12. **Cancel.** `cancel { id }`: a request not started yet is dropped and answered nothing. One under way checks
    between its Safari calls (rule 13).
13. **The newest show wins per window, one at a time.** A `hostShow` for window W waits for the one running in W to
    finish (Safari switches one tab at a time: overlapping, each took ~210 ms and none was drawn during a held key's
    run, 2026-11-25); one overtaken by a newer `hostShow` for W while it waits is answered `overtaken`, with no Safari
    call. A running one goes on to its end unless the app cancels it (it then stops before its next Safari call). This
    follows the existing one-windows-call-per-window rule (`WINDOW_CALLS`, `windowCallRefusal`, `link.ts:166,172`).
14. **After a pause, the queue is read first.** A `req` read while the copy knows it was just paused (the check that
    logs `paused … ran late`, `link.ts:879`) is started only after one more turn of the event loop: the same "after
    the socket's queued messages" step the pause check already relies on (`setTimeout(judge, 0)`, `link.ts:883`). The
    newest show and any cancel queued behind it are seen first, and only the newest show runs.

### A copy truly stalled for 30 s or more

- **0–40 s, the copy alive but not reading:** the request waits. The person sees the item they picked, the loader
  "switching", and after the pace "Safari is slow". Another pick overtakes it at once, and nothing else waits on it.
- **Total silence for 40 s:** the link is closed (the existing dead rule). Its waiting requests end `Down`. Still-wanted
  shows are asked again once the copy reconnects (rule 9).
- **The copy comes back:** its queued messages run in order. Overtaken shows were cancelled or lose to the newest
  (rules 12–14). The person's last pick is what Safari shows.
- **It never comes back:** nothing waits forever on it, because every wait is raced against the person moving on.
  The 40 s silence rule still ends the link.

## 2. A start-up that never sticks

### Today

- `resume_last` (`session/start.rs:282`) gates the first window on the browser's preparation when `prepares_browser`
  is on (`gate`, `start.rs:289`). `hold_startup` (`start.rs:208`) holds the start screen until the preparation is
  `Done`. After `startupWait` (15 s, `mod.rs:374`) it shows "held up" with Try again and Continue without Safari.
- `prepare_browser` (`start.rs:500`) links the **space's** profile (`space_profile`, `start.rs:542`;
  `ensure_linked_for(&p, true)`, `start.rs:553`), whatever item the window reopens. This morning that was Personal,
  whose copy didn't link for 50 s: "a Safari profile's copy not linked yet after 50.3 s".
- The copy's own tries are timer-driven: `ASK_MS` 5 s doubling to 60 s (`link.ts:86`, `failed` `link.ts:680–695`),
  `REPLY_WAIT_MS` 3 s (`link.ts:108`), the welcome's 2 s (`OPEN_WAIT_MS`, `link.ts:83`; the timer at `link.ts:791`).
  When the loop stalls, a late timer reads as "no answer" or "no welcome (slow)", and the next try is minutes away in
  real time. This morning: `wantLink: no answer … within 3000 ms (5843 ms)`, then `no welcome within 2000 ms (slow)`
  at 09:15:17, then nothing for 25 s.

### Rules (margin-core `session/start.rs`)

1. **Gate only on what the first thing shown needs.** `resume_last` computes the need from `last_item_of`:
   - a web item of profile P: wait for P only;
   - an app, Margin's own page, or no item (the launcher): no wait at all. The window shows at once.
   The browser's preparation still runs, out of sight, but nothing waits for it.
2. **Prepare the profile that's needed.** `prepare_browser` prepares the last item's profile when it's a web item,
   else the space's profile (as today). The window made ready is then the one the first show uses.
3. **Other profiles link lazily**, on first use through `show_web` → `host` → `ensure_linked_for` (already so). The
   start screen never waits for them.
4. **"Held up" is feedback, not failure.** After `startupWait` the screen still says Safari is slow, with Try again
   and Continue without Safari, as today. But the gate ends the moment the needed profile links, whenever that is.
   This is already so (`hold_startup`'s loop); it's kept.

### Rules (extension, `background/link.ts`)

5. **Waits are advanced by events.** Every timed wait in the link (the ask's pacing, `within` for the handler's
   answer, the welcome's wait) gets a due time. Two things advance it: its timer, and **any extension event the
   background hears while unlinked**: `windows.onFocusChanged`, `windows.onCreated`, `tabs.onActivated`,
   `tabs.onUpdated`, `runtime.onMessage` from a page, the native port's messages. Each such event calls `due()`, which
   runs whatever is past due. These events came on time during this morning's stalls; the waker's press opening a
   window is itself one.
6. **A late timer judges nothing.** A wait whose timer ran late (its gap over 1.5× what it asked for: the same
   evidence as the pause check) doesn't conclude "no answer" or "no welcome". It's re-armed, and judged once the loop
   has had a turn. A welcome or answer that came during the stall is then seen first. Only a timer that ran on time
   with nothing come gives up.
7. **The next try is paced from when the copy could act.** `askMs`'s doubling counts tries that really ran: a try
   ended by rule 6 isn't counted.

The waker (`SafariWaker.swift`) keeps its evidence rules unchanged. It stays Mac mechanism; its calls from the core
(`Command::Waker`, `ensureLinked`) are unchanged.

## 3. "press 2: no window came of the one before" at 09:15:42

The log: press 1 at 09:14:52.962. Window 205 came at 09:14:53.234 ("opened only to wake a profile"). Every 5 s line
from 09:14:55 to 09:15:40 said "its window opened: its copy waited for", so the waker counted it. Then at 09:15:42.667
"Margin quits (quit)", and at 09:15:42.733 "press 2: no window came of the one before".

The code: a press after the first needs `opened == 0` (`SafariWaker.swift:132`). `opened` is
`engine.wokenWindows(...) - seenBefore` (`SafariWaker.swift:129`), the engine's count of woken windows. The quit
gives those back (`HostEngine.quitAll` → `releaseWoken`, `HostEngine.swift:1053`), so the count fell to 0 between
the quit's start and the next look. That makes it the quit only, not an evidence bug.

94bd90ab covers it:
- `quitAll` sets `quitting` first (`HostEngine.swift:1027`);
- the waker's loop checks `engine.quitting` before it counts windows (`SafariWaker.swift:120`, before `:129`), and
  `parkWoken` does nothing while quitting (`HostEngine.swift:1115`).

To pin it, a unit test: a quit started between two looks gives no second press (in `hosted-tests.swift` beside 94bd90ab's).

## 4. The WebKit bug report (ready to file, not filed)

**Title:** Web extension background page loses its "Web Extension background content" foreground activity at its
first navigation, then runs as a background process (timers and WebSocket events delayed by seconds)

**Component:** WebKit Extensions (WKWebExtension). Seen in Safari 27.2 (WebKit 22625.2.8.11.9, macOS 27.2.1 26B131).

**Summary:** `WebExtensionContext::loadBackgroundWebView()` takes a foreground activity "to keep background content
responsive to events" on the background web view's process **before** `loadRequest`. In Safari the load commits in
another WebContent process. The first process's throttler disconnects, the activity is invalidated with it, and none
is taken on the process that hosts the page. The background page then holds only `BG Lifetime Activity`
(RunningBoard role Background). Under load, its DOM timers, MessageChannel tasks and WebSocket message events run
7–30 s late, while extension events dispatched by IPC (`windows.onFocusChanged`) keep running on time.

**Steps to reproduce:**
1. Install a Manifest V3 extension whose background is a page (`"background": { "scripts": [...] }`). In it:
   `setInterval` every 1 s logging its lateness, and a WebSocket to a local server that sends a message every 2 s.
2. Quit Safari, open it, and keep its windows visible but leave the extension's pages closed.
3. Load the Mac (e.g. 12 × `yes > /dev/null`), or run it right after a reboot.
4. Read the extension's log, and Safari's log: `log show --predicate 'process == "Safari" AND category ==
   "ProcessSuspension"' --info --debug`.

**Expected:** the background page's process holds a foreground activity while its content is loaded (as
`loadBackgroundWebView` intends), and its timers and socket events are as timely as an extension event.

**Actual:**
```
Safari: [PID=0, throttler=0x12508de10] ProcessThrottler::Activity::Activity: Starting foreground activity / 'Web Extension background content'
Safari: 0x12508de10 - [PID=0] ProcessThrottler::didDisconnectFromProcess:
Safari: [PID=0, throttler=0x12508de10] ProcessThrottler::Activity::invalidate: Ending foreground activity / 'Web Extension background content'
runningboardd: …WebContent…:2578: running-active (role: Background)
runningboardd: …:2578:2578] Set darwin role to: Background
```
(Times 09:16:09.738–.739 and 09:16:11.554. The page's process, 2578, never gets the activity: no line for it with a
real PID. Its 1 s timer then ran 13.7, 28.8 and 10.6 s late, while `windows.onFocusChanged` was handled within a
second.)

**Where:** `Source/WebKit/UIProcess/Extensions/Cocoa/WebExtensionContextCocoa.mm`, lines 2538–2548 at tag
`WebKit-7625.2.8.11.9`:
```
Ref backgroundPage = *m_backgroundWebView.get()._page;
Ref backgroundProcess = backgroundPage->siteIsolatedProcess();
...
if (siteIsolationEnabled)
    m_backgroundWebViewActivity = protect(backgroundPage->activityGroupContext())->foregroundProcessActivityGroup(activityName);
else
    m_backgroundWebViewActivity = protect(backgroundProcess->throttler())->foregroundActivity(activityName);
...
[m_backgroundWebView loadRequest:...];
```
On main (after 29769e195b, 2026-08-16) the activity group is used unconditionally. But
`ProcessActivityGroupContext::activityTargets()` only follows the main frame's process at creation and iframe
processes (`WebPageProxy::didCreateRemotePage`). A main-frame process swap still isn't followed.

**Suggested fix:** take the activity after the background page commits (`didCommitLoadForFrame` of its main frame),
or have the activity group follow a main-frame process swap (`WebPageProxy::swapToProvisionalPage` →
`didAddActivityTarget`/`didRemoveActivityTarget`).

**Impact:** extensions that keep a connection to a native app (WebSocket, native messaging) see their background
page's work delayed by up to tens of seconds under load or after login, which looks like a hang to the person.
Extension events still arrive on time, so the extension can't tell it's being throttled.

## 5. Tests (each written failing first, against today's code)

**margin-core unit tests** (`link.rs`, `link_hub.rs`, `protocol.rs`):
- A request with no reply and the copy alive but not reading stays waiting at 15 s, 60 s and 600 s (fails today:
  `TimedOut` at 15).
- It ends `Down` when the link closes, and `Down` on 40 s of total silence.
- `cancel` removes it: no `Answer` goes up, `cancel { id }` is sent, and a later reply is dropped.
- A tock with a later seq and no ack: sent once more with the same id, then `Lost`.
- An old copy's tock without seq is life only, never "lost".
- `ack` decodes; `tick` carries `seq`; an old copy's `tock {at}` still decodes.
- `Link::slow` reports the oldest unacked request's age.

**margin-core vector tests:** `tick`/`tock`/`ack`/`cancel` added to the protocol vectors the Swift and TypeScript
sides read.

**margin-core session tests** (`session/tests.rs`, `requests_tests.rs`, `start_tests.rs`), on the existing stand-in
ports:
- A `hostShow` that never answers doesn't hold the queue: an app pick after it is shown at once (fails today: it
  waits 15 s).
- An overtaken show sends `Cancel` and logs "overtaken", not "wasn't shown".
- The loader is set while the show waits, and `slow` after the link reports slow.
- A link down and back while the show is still wanted: shown once it links. If overtaken by then: not.
- Start: the last item an app → no gate, shown at once. The last item web in P while the space is Q → P prepared and
  waited on, not Q (fails today). No item → no gate.

**Extension tests** (`tests/link.test.ts`):
- A `req` is acked before its handler resolves, and a repeated id runs once (fails today: twice).
- `cancel` before start drops it.
- Two `hostShow`s for one window: only the newer reaches `tabs.update`.
- After a detected pause, a show and a newer show queued together: only the newer runs.
- With fake timers made late and an extension event fired, the due ask runs at the event, not at the timer (fails
  today).
- A welcome wait whose timer ran late doesn't give up; one whose timer ran on time does.

**App e2e** (`tools/app-tests/e2e*.swift` with `fake-extension.mts`): a new mode `stall { ms }`. The fake copy holds
every socket message it reads for `ms` before handling it, while it still sends event-driven messages (windows
reports) and acks late.
- A show to a stalled copy shows the loader and lands after the stall, and an app picked meanwhile is shown at once.
- Total silence for 40 s ends the link, and the show lands after the reconnect.
- The start with the last item an app: no start screen.

**Screen suite parts affected** (`npm run test:screen`): start-up (the start screen's parts), the hosted Safari
switch parts, and the split/card parts that ask the copy (`hostShow` with `role: 'card'`, `hostPromotePeek`). Run
whole once before merging, as the gate says.

**Measurements, before and after** (the same build otherwise, the installed app, his real Safari):
- **Start-up:** from launch to the first item shown (`hosted: … shown` after `Margin.app opened`), and to "browser
  prepared in". Cold after boot and warm, 3 runs each.
- **A switch:** `host: … switched in` and the `hostShow` round trip, median and p95 over 40 switches on a quiet Mac.
  The change adds one `ack` message per request (expected under 1 ms).
- **Idle cost:** Margin's and Safari's CPU over 10 idle minutes (`ps -o %cpu` sampled every 10 s), and link messages
  per minute. Unchanged ticks every 5 s, the seq adds bytes only.
- **Load test** like today's (`diag-run/phase2.sh`: 12 burners, load 35–40, 15 min, tab switches through the dev
  hook, plus app picks between them):
  - no `its tab wasn't shown`;
  - no pick waiting behind another;
  - every switch lands after the stall ends, with the loader shown meanwhile;
  - the start with the Mac loaded never stuck past the needed profile's link.

## 6. Chrome and Edge (and Windows)

- The same `link.ts` runs in Chrome's and Edge's copies, so acks, dedupe, cancel, the newest show winning, and waits
  advanced by events apply there unchanged.
- Their link reaches the core through the relay (`relay.rs`, `link_hub.rs`), so the core's request rules (no fixed
  timeout, ending on evidence, `Link::slow`, cancel) apply to relay connections as to sockets. No relay-specific rule
  is added.
- Chrome's MV3 service worker can be *stopped* rather than slowed. Its port then drops, which is the link going down:
  evidence, the request ends `Down`, and the show is asked again once it relinks. That's the right outcome there.
- Windows (`app/platforms/windows/src/tcp.rs`, `pipe.rs`) is transport only. It has no request timing of its own (it
  uses the core's `Timing::default()`), so nothing Windows-side changes. Its compile check and the core's tests cover
  it; the real-Windows check is still open (`docs/windows/UNVERIFIED.md`).
- The "events advance waits" rule uses `chrome.windows`/`chrome.tabs` events there too.

## 7. Risks and open questions (each with a default that changes nothing beyond the fix)

1. **A request with no fixed timeout could wait a long time** if a Safari call inside the copy never settles (Safari
   has dropped promises before). Default: it waits, the person sees "Safari is slow", and any other pick moves on.
   The 40 s silence rule still ends a dead link. Question: also end a request whose copy keeps reading (tocks with
   newer seqs come) without answering it for a long while? Default: no, only logged.
2. **No gate when the first item is an app** means Margin is usable before Safari is ready. A web pick then waits
   (with the loader) for its profile. Default: yes, as the summary says. Question: keep the old gate behind
   `MarginResumeLast`-style defaults? Default: no new setting.
3. **Re-issuing a show after a reconnect** may show a tab twice (harmless). Default: only `hostShow` is re-issued.
4. **Protocol changes** (`ack`, `cancel`, `tick.seq`, `tock.seq`) are backward compatible both ways: an old copy
   ignores unknown kinds (`link.ts` `default: return`), and an old app ignores `ack`. Default: no version bump.
5. **The extension's per-window "newest show wins"** stops an older show that the app still wanted (two windows
   aren't affected: it's per window). Default: as designed, since the app only sends a newer show for a window when the
   person picked again.
6. **WebKit fixes the bug** (the background gets its foreground activity): the stalls mostly go, the design stays
   correct, and the background may use a little more CPU at foreground priority. Default: nothing to do.
7. **Native dispatch stays** for `appUp` and the old `link` way in, but nothing waits on it. Default: kept, since it's
   harmless and helps a copy whose loop is healthy.
