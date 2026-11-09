# Margin windows: a window per profile for each window (design)

Decided by Tirth, 2026-11-09, to work as Arc's windows do:

1. ⌘N opens a new window of the current window's profile, full screen in its own Space like the first, on the
   space the person was in, with its own sidebar.
2. Each Margin window has its own window per profile. A profile switch in a window swaps among that window's own;
   a profile it has none of gets one, made for it under the freeze (HANDOFF.md §1.6).
3. A switch never lands on another Margin window's window.
4. Leaving a profile in a window parks that window's window of it, as now.
5. Closing a Margin window closes only its own parked windows of other profiles.
6. Any new full-screen window is its own Margin window, however it was opened: ⌘N, Safari's File › New Window, a
   link that opens one. This replaces HANDOFF.md §13.11's "extra window", which a switch passed over.

What this changes: today the shell assumes one chain of windows. The parking registry keeps one home window per
profile (`lastShown`), and the handoff keeps one shown window for the session (`session.shown`). Here, a
**Margin window** (in code a `Line`: a line of windows, one per profile) holds both, and there are as many as the
person has windows.

## 1. The model

```swift
struct Line {
    let id: Int // stable for the session, and kept in the crash marker
    var homes: [String: Int] // link → its window's number in this line (shown or parked)
    var shown: Int? // the number shown now (one of homes' values), nil while all of it is parked
    var usedAt: Double // the last switch, show or focus in it: the most recent line is §6.2's
}
```

- The registry owns the lines (`ParkingRegistry.lines`), beside `entries`, and replaces `lastShown`.
- **Every window Margin shows or parks is in exactly one line.** `line(of: number)` finds it.
- **A window in no line** is a Margin window that has never switched: one opened by the person, or one Margin
  finds after its own launch. It gets a line of its own the first time it's a switch's A (or its target, §2.1).
  A new line costs nothing: a struct, and the marker's few bytes.
- **A line's home for a link** is the window to show for that profile in that Margin window: parked, or shown.
- **A line ends** when its last window goes: a parked one forgotten as gone, or one the window server hasn't listed
  for 3 s (`pruneLines`, so a moment's absence never costs a line its home). An ended line's id isn't reused.

## 2. Switches

### 2.1 Which line, and which window

A switch's line is A's: `line(of: aNumber)`, else a new line with A as its home for A's link. A switch from a
parked window's own activity (§6.1: a link landed there, the person focused it) is that window's line, and its A
is that line's shown window.

The target window, in the line only (HANDOFF.md §1.5's rules, by line):

1. The window that asked (§6.1): in this line by definition.
2. The line's home for P, parked: shown (`parked`).
3. **Gone:** "any parked window of P" (another line's). Instead, a parked window of P in **no** line (the crash
   marker's, §4, before any line has it) is adopted into this line and shown.
4. The line's home for P, in full screen (`focus`) or normal (`show`), not parked.
5. **Gone:** "any of P's windows when no home is known". A window of P in no line is another Margin window (rule
   6), never a target.
6. A window of P opened for **this** switch (P had no window: Safari asked for one under the freeze, or the person
   opened one while the switch waited), in no line: adopted (`awaitedProfile`).
7. None: a new window, made for the line under the freeze (`create`; `openProfile` with P's copy not running).

When the switch lands, B is the line's home for P and its shown window, and the line's `usedAt` is now. A, parked
(or closed), stays the line's home for its link.

### 2.2 What goes

- `HandoffChoice.Facts.aExtra` and the `keep` it chose: every A is a line's, parked as any other.
- `session.shown` → the line's `shown`. Each use names its line:
  - `end()`: A shown again in its line.
  - `lateLanding`: the line's shown window, before and after.
  - `closeParked`'s notice: shown in the line's shown window.
  - `closedAfterReveal` (§13.8): B stays its line's shown window.
- Same-profile switches (a space of the profile the window shows) stay `setSpace` in that window.

### 2.3 The close-based switch (no parking)

`ProfileSwitch.ownWindow()` takes the line's home for P if it's open, else makes one. It never takes another
line's window or one in no line. `finish()` notes B as the line's home and shown window.

## 3. The shell

- **A parked window used** (`parkedActivity`, the sweep's `.person`): the handoff runs from **its line's** shown
  window (`ShellHandoff.shownWindow(line:)`), not the session's. With its line showing nothing (all parked), it's
  a handoff with no A (§6.2's way).
- **The shown window closed by the person** (§13.8): its **line's** parked windows are closed by their copies, and
  the line ends. Other lines are untouched. `ShownCloseWatch` judges each gone window against its own line.
  `parkedEnding` drops only that line's parked activity meanwhile.
- **Every Safari window parked** (§6.2): the most recently used line (`usedAt`) gets its home window shown, with
  no A.
- **Quit, power off, the setting "Close windows to save memory"**: every parked window, every line, as today.
- **Keys:** `frontOverlay()` stays the window in front. Its line is the one ⌘N and the switches use.

## 4. Persistence

- **The crash marker** gains `lines: [{ id, homes: [{ link, number }], shown }]`. `shown` (the old one-per-link
  list) is still written, as each line's homes flattened. An older Margin reading a new marker keeps working, and
  a new one reading an older marker makes a single line from it (the one chain it was).
- **After a crash**, `adoptAfterCrash` restores the lines whose windows Safari still has (by number). Windows no
  line names are left in no line, and adopted by the first switch that needs one of their profile (§2.1 rule 3).
- **A Safari quit:** parked windows Safari restores are closed and their tabs kept (`closesRestoredParked`), as
  today. Lines end with their windows.

## 5. ⌘N

- **A new app command, `new-window`, bound to ⌘N by default.** It's a hot key as the others are (Carbon, only
  while a linked browser with Margin's overlay is in front), so Safari never sees ⌘N while Margin draws. Without
  Margin.app running, Safari's own ⌘N is as before.
- **What it does:** the front overlay's window (its link and window id) asks its copy for `newWindow { fromWindowId }`
  (`Shell.newMarginWindow`, `background/handlers.js newWindow`):
  - The copy makes the window in full screen if `fromWindowId`'s is (`windows.create({ focused: true, state:
    'fullscreen' })`, retried without `state` if refused).
  - It sets the window's active space to the one `fromWindowId` shows (explicit, not `inheritSpace`'s guess).
  - The window opens with the browser's new tab, which is Margin's start page, as ⌘N's is today.
  - The answer has `{ windowId, bounds }`, so the binder binds the window as Margin's (`windowMade`).
- **The new window is a Margin window of its own** by §1's rule: it's in no line until its first switch gives it
  one (`lineFor`). Margin's sidebar is drawn over it as over any linked full-screen window.
- **macOS slides to it**, as to any new full-screen window: that's ⌘N's own new window, wanted, not hidden.
- **Mid-switch:** dropped, as ⌘T is (§1.7).
- **The palette's "New window"** does the same.

## 6. Speed

- A line lookup is a scan of a few small dictionaries, once per switch and per sweep finding: nothing per frame.
- The sweep and the window binder are unchanged.
- The marker grows by a few bytes per line, written only when a line changes, as `lastShown` is now.

## 7. Tests

The app tests' fake world gets lines:

- Two lines of the same two profiles: a switch in each swaps only among its own.
- A target in another line passed over: a window made instead.
- Rule 3's adoption of a line-less parked window.
- A line's shown window closed: only its parked windows closed.
- §6.2 picks the most recently used line.
- The marker: written with lines, read back, an older marker read as one line.
- ⌘N: `newWindow` asked of the front window's copy with its space, the new window a new line.

HANDOFF.md's tests that encode the extra window (§13.11) are rewritten to these rules. The extension's tests get
`newWindow` with `fromWindowId`.

## 8. Order of work

1. Lines in the registry and the marker (with the older marker read as one line), `lastShown`'s callers moved to
   them. The behavior is still one line, so every test still holds.
2. The handoff by line: rules 3 and 5, `aExtra` and `session.shown` gone, the close-based switch.
3. The shell by line: activity, §13.8, §6.2.
4. ⌘N: the command, `newWindow` in the copy, the new line.
5. HANDOFF.md §1.5, §6.2, §13.8 and §13.11 brought up to date. The gate. Then, with Tirth's OK, a check in real
   Safari with Test A and Test B.

## 9. Tabs across Margin windows (Arc's)

Tirth, 2026-11-09: two Margin windows of one profile on one space show the same tabs, in sync. A Safari tab is in
one window at a time, so **the tab follows the window in front**:

- Window 1 shows tab T. Window 2 opens on the same space, and its sidebar lists the same tabs.
- In window 2, T is chosen: T shows live in window 2. Window 1 keeps T chosen: its sidebar row highlighted but
  faded, and where the page was, a faded picture of it.
- Window 1 comes to the front again: T is live there, and window 2 shows it faded.

### 9.1 The model (state/model.js)

- **Each window's chosen tab** (`selectedByWindow[windowId] = tabId`) is apart from where the Safari tab is
  (`tab.windowId`). Today the two are the same; with this they may differ: a window whose chosen tab is in
  another window shows it **away**.
- **A space's tab list is the space's, not a window's**: the tabs of the space in every window of the profile, in
  one order (`order`, placed among the space's tabs, not the window's). A tab that moves windows keeps its place.
- **The stand-in**: a window showing a tab away has Margin's own page in front (`away.html`), never a Margin tab
  (not in any list, not kept, not synced). It shows the away tab's picture, faded, and a click on it (or the
  window coming to the front) brings the tab back. It also keeps Safari from closing a window whose last tab
  moved out. One per window at most; closed when the window chooses another tab, or its away tab closes.

### 9.2 Moves

- **Chosen in window W, while in window V:** V's picture of it taken, V's stand-in up (made or reused) and in
  front, then the tab moved to W (`tabs.move`) and made active. W chose it; V still has it chosen, away.
- **Window W comes to the front** (`windows.onFocusChanged`) with its chosen tab away in V: the same, the other
  way. Only then: a window in front whose chosen tab is already there moves nothing.
- **Never** while a profile switch runs (its windows are parked or being shown), for a parked window, or for a
  window Margin doesn't draw over.
- **Pictures**: `captureVisibleTab`, as a JPEG, in the background's memory only (never on disk, never in a log,
  never in synced state), one per away tab, dropped when it's back or closed.

### 9.3 Everything else

- **Closing T** in either window closes it; each window that had it chosen chooses its next tab, and its
  stand-in goes.
- **Sleeping tabs**: an away tab is never put to sleep while a window shows it away.
- **After a Safari quit**: stand-ins Safari restores are closed (by their address), and each window's chosen tab
  is its active one again.
- **Pins** stay the space's (already so); a pin open in another window is that tab, followed the same way.

### 9.4 Speed

- Nothing runs per frame or per page: a move only on a choice or a window coming to the front, and only when its
  chosen tab is away.
- One picture per move, taken as the tab leaves (tens of ms, measured by the probe); the stand-in draws it as a
  plain image.
- The sidebar's list for a space is the same work as now over all of the profile's windows' tabs (a few
  hundred at most).

### 9.5 First: the probe (`devswitch probe tabMove`, Test A only)

Before building: whether `tabs.move` between two full-screen windows keeps the page (no reload: a marker in its
memory, its scroll, a typed field), how long a move takes, and whether `captureVisibleTab` works for the window in
front and for one behind. If a move reloads the page, this design changes (a window would show the other's tab
as a picture only, and a choice there would switch to the window it's in).
