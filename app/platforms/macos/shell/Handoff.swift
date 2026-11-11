// The profile handoff (docs/HANDOFF.md §1, with the answers in §13): the
// switch's state machine when the world can freeze the screen, read Spaces and
// park windows. ProfileSwitch (ProfileSwitch.swift) is its face; this is how
// it runs.
//
//   idle ─start─▶ preparing ─coverShown, or 250 ms─▶ frozen ─▶ after ─▶ landed ─▶ idle
//                                     close mode: after ─300 ms─▶ closing (freeze 2) ─▶ (checking) ─▶ landed
//                  │ cover up, target picked,         show B, B to full screen,
//                  │ blockers, B's space,             R1+R2, then A to normal
//                  │ A's drafts                       (latest 1.15 s), park A,
//                  │                                  R3/R4/R5, reveal
//                  ├ its copy not linked, a parked window ─▶ waitingForLink (3 s) ─▶ preparing,
//                  │   or that window returned to its Desktop
//                  ├ … and none ─▶ waitingForProfile (90 s) ─▶ preparing
//                  └ back to A's own profile, a dialog in A, A busy ─▶ idle (nothing touched)
//   any failure ─▶ recovering (§4.4) ─▶ landed ─▶ idle
//
// - Two choices per switch (§1.1): the freeze (on when the freezer is there,
//   the session hasn't turned it off, and exactly one display is managed), and
//   the old window (park when parking passed and this session hasn't turned it
//   off and the setting keeps windows; close when the setting asks or parking
//   is off; keep for A's copy gone, or several displays until gate G11). Only call failures are session
//   demotions: the freeze's are FreezeRules', parking's a show or park that
//   didn't land after its retry. The display count and the drafts are read per
//   switch.
// - Enter-first (§1.3): B shown and asked for full screen once (no blind
//   retry, §3.4), A asked to leave full screen at R1+R2 but never later than
//   1.15 s into the freeze (then in `after`), its overlay ordered out first.
//   R1-R5 are read every 8 ms (§3.2); R3 only behind Options.frameProbe.
// - The freezer's own watchdog reveals at 1.7 s; the steps then go on unseen no
//   longer ("late") until the settle timeout. A foreign Space change under the
//   freeze reveals at once and recovers.
// - One switch at a time: before the freeze a new target takes this one's
//   place; from the freeze on it waits, and starts only once this one is idle
//   (landed: no full-screen Space change for 150 ms). A window with a windows
//   call still pending can't be the next A or B for 1 s (§1.7).
// - Recovery (§4.4) brings A back full screen and focused, and sets B normal and
//   parks it again only once it's normal (the aftercare's watch), or closes the
//   window this switch made. A switch never ends with nothing of A's or B's in
//   front, and every window Margin hides stays in the registry.
// - The aftercare (§1.9) owns what lands late: a B that goes full screen after
//   its switch gave up (a late landing, if nothing happened since), an A whose
//   normal lands late (parked as meant), an A whose copy comes back (§1.8).
// - Close mode (§4.5): two freezes. The first shows B with A untouched; at
//   least 300 ms after its reveal a second one (its watchdog 1.0 s) closes A,
//   drafts permitting, and holds until A is gone and B is in front for 120 ms.
//   A Desktop drop gets one focusWindow(B) inside it; one left at its watchdog
//   is today's checking path, seen (phases closing, then checking). A failed
//   close is tried once more after 0.5 s; then A stays.
// - "Close windows to save memory" turned on with windows parked (§5): each
//   closed by its copy, drafts permitting (closeParkedWindows).
// - Margin windows (docs/BROWSER-WINDOWS.md, 2026-11-09, replacing §13.11's extra window): each Margin window
//   (a `Line` in the registry) has its own window per profile. A switch runs in A's line, targets only that
//   line's window of the profile (or one made for it), and never another line's. A window in no line is a
//   Margin window of its own, given its line by its first switch. A switch within a profile is a setSpace in
//   its window.
// - The log has ids, numbers, Spaces, modes and milliseconds only.

import AppKit

// What the machine needs from the shell beyond SwitchWorld (Shell, via WP9; the tests' fake).
protocol HandoffWorld: SwitchWorld {
    // Whether the handoff may run at all (the shell: its gate, HANDOFF.md §10.4). False: the world is
    // treated as a plain SwitchWorld, so every switch is the close-based one exactly as before (no
    // drafts asked, no notices).
    var handoffOn: Bool { get }
    var handoffFreezer: Freezer? { get } // nil: no freeze calls
    var handoffCover: HandoffCover? { get }
    func handoffCoverContext(from: WindowKey, to: ProfileSwitch.Target) -> LiveCoverContext?
    var spaceReads: SpaceReads? { get } // nil: no Space reads, and so the close-based switch
    var parker: BridgeParker? { get }
    var parking: ParkingRegistry? { get }
    var parkingOn: Bool { get } // the launch check and the cross-process self-test passed
    // "Close windows to save memory" for this link's browser (BrowserProfiles.closeWindows).
    func closesWindows(_ link: String) -> Bool
    // The copy's windows as it last said, with bounds and focus.
    func copyWindows(_ link: String) -> [ExtWindow]
    // The binder's: a copy's window and the window server's number, both ways.
    func number(of key: WindowKey) -> Int?
    func key(of number: Int) -> WindowKey?
    // The space the window shows (its copy's openTabs.activeSpaceByWindow).
    func activeSpaceId(of key: WindowKey) -> String?
    func fillsDisplay(_ bounds: CGRect) -> Bool
    // The window server's list of this link's browser's windows (every layer), for §1.10.
    func browserWindows(of link: String) -> [ServerWindow]
    // The sidebar the person is looking at (A's) handed to the switch's target (B), under the freeze: the same page,
    // already drawn, given B's window in place; B's own (if any) becomes A's. False: not done (none shown, or not drawn).
    func handOverOverlay(from a: WindowKey, to b: WindowKey) -> Bool
    // The window's overlay and its edge panel ordered out (never revealed: §2.3), before A's Space goes.
    func orderOutOverlay(_ key: WindowKey)
    func overlayOffScreen(_ key: WindowKey) -> Bool
    // Shown just above its window (WindowMatcher.stackedAbove): R4's first half.
    func overlayAbove(_ key: WindowKey) -> Bool
    func showSwitchNotice(_ notice: SwitchNotice)
    // DEV-HOOK: whether a switch between these two links may use what the dev-only hook set
    // (DevHooks.swift: its default on, and both Safari's Test A and Test B). False by default.
    func devHookAllows(_ a: String, _ b: String) -> Bool
}

extension HandoffWorld {
    var handoffOn: Bool { true }
    var handoffCover: HandoffCover? { nil }
    func handoffCoverContext(from: WindowKey, to: ProfileSwitch.Target) -> LiveCoverContext? { nil }
    func handOverOverlay(from a: WindowKey, to b: WindowKey) -> Bool { false }
    func devHookAllows(_ a: String, _ b: String) -> Bool { false } // DEV-HOOK
}

struct HandoffOptions {
    var coverSetupWait: Double = 0.8 // warmed alongside the existing source-cover/drafts checks
    var liveCoverWait: Double = 12 // soft deadline: recover under the live cover, never a 1.7 s reveal
    var poll: Double = 0.008 // §3.2: the freeze's own reads
    var watchPoll: Double = 0.1 // the aftercare, with no switch running
    var coverWait: Double = 0.25 // §1.5: the freeze starts on coverShown, or this long after the start
    var revealCooldown: Double = 0.3 // §1.5: since any reveal
    var watchdogCooldown: Double = 1 // §1.5: since a watchdog reveal (gate G7 may shorten it)
    var linkWait: Double = 3 // §1.5: waitingForLink
    var pendingWait: Double = 1 // §1.7: a window with a windows call still pending
    var bNotAfter: Double = 1.5 // §1.9: B's full-screen request, from the freeze
    var latestAStart: Double = 1.15 // §1.4: A's normal starts no later than this into the freeze
    var steadyPolls = 3 // R2
    var frameProbe = false // R3, until gate G2
    var probeWait: Double = 0.25 // R3, after R2
    var framedWait: Double = 0.2 // R4, after R2
    var settleAfterExit: Double = 0.13 // R5: since A left full screen
    var foreignFor: Double = 0.1 // §1.2: another Space active this long under the freeze
    var afterFor: Double = 1.5 // §1.2
    var stillFor: Double = 0.15 // §1.2: landed once the full-screen Spaces stay this still
    var landedFor: Double = 2 // …or after this, whatever moves
    var focusCheck: Double = 0.3 // §6.6
    var aftercareFor: Double = 10 // §1.9
    var boundWait: Double = 2 // §1.5: a parked target with no copy id, shown by number, bound by then
    var closeRetry: Double = 0.5 // §4.4: a failed close tried once more
    // §4.5: close mode's second freeze, at least revealCooldown after B's reveal.
    var closeWatchdog: Double = FreezerOptions().closeWatchdog // its own watchdog
    var closeNotAfter: Double = 0.6 // A's closeWindow refused past this into it (it would land seen)
    var closeHold: Double = 0.12 // A gone, B's Space active and B in front this long: revealed
    var closeFocusBy: Double = 0.75 // a Desktop drop's focusWindow(B) only this early into it (time to land)
    var draftsWait: Double = 1 // §5: a parked window's drafts not answered by then: unknown, kept
    var fullScreenRetry = false // §3.4, until gate G4
    var retryAfter: Double = 0.4 // §3.4: the evidence that a request never took
}

// The two choices of one switch (§1.1).
struct HandoffChoice: Equatable, CustomStringConvertible {
    enum Old: String { case park, close, keep }
    var freeze: Bool
    var old: Old
    var why: String? // why the old window is kept, or the freeze off, when it's not the plain case

    var description: String { old.rawValue + (freeze ? "+freeze" : "") + (why.map { " (\($0))" } ?? "") }

    struct Facts {
        var freezeOn = true // a freezer, and the session hasn't turned it off
        var parkOn = true // parking passed at launch and the self-test, and the session hasn't turned it off
        var closeSetting = false // "Close windows to save memory"
        var displays = 1 // managed now (SLSCopyManagedDisplaySpaces)
        var hasA = true
        var aLinked = true
    }

    static func pick(_ f: Facts) -> HandoffChoice {
        var c = HandoffChoice(freeze: f.freezeOn && f.displays == 1, old: f.parkOn && !f.closeSetting ? .park : .close)
        if f.freezeOn, f.displays != 1 { c.why = "\(f.displays) displays: no freeze" }
        if !f.hasA {
            c.old = .keep
            c.why = "no window to leave"
        } else if !f.aLinked {
            c.old = .keep
            c.why = "its copy isn't linked"
        } else if c.old == .park, f.displays > 1 {
            // §6.7: until gate G11, a new A stays in its own full-screen Space.
            c.old = .keep
            c.why = "\(f.displays) displays: kept in its own Space"
        }
        return c
    }
}

// One handoff, from its start to idle.
final class HandoffRun {
    enum Way: String {
        case parked = "parked target"
        case focus = "full-screen target" // §1.5 rule 4
        case show = "normal target" // rule 5
        case create = "new window" // rule 7
        case openProfile = "new profile window" // rule 7 with its copy not running: Safari's menu, under the freeze
    }
    let gen: Int
    var target: ProfileSwitch.Target
    let a: WindowKey?
    let aNumber: Int?
    let asked: WindowKey?
    let startedAt: Double
    var line: Int? // the Margin window it switches in (docs/BROWSER-WINDOWS.md §2.1)
    var awaitedProfile = false // its profile had no window: one opened for it (asked of Safari, or the person's) is its
    var choice = HandoffChoice(freeze: false, old: .keep)
    var way = Way.create
    var b: WindowKey?
    var bNumber: Int?
    var avoid: Set<Int> = [] // passed over: a windows call still pending
    var waitingSince: Double?
    var prepared = false
    var coverAt: Double?
    var coverPreparedAt: Double?
    var coverEligible = false
    var coverFailed = false
    var coverActive = false
    var deferredSpaceSelection = false
    var spaceSelectionAsked = false // setSpace can focus its browser window before other transition steps
    var coverStartedAt: Double?
    var coverEndedAt: Double?
    var stepsAt: Double?
    var drafts: WindowDrafts?
    var draftsAsked = false

    // the freeze
    var handle: Int32?
    var live = false
    var handedOver = false // A's sidebar offered to B (Handoff.handOver)
    var freezeAt: Double?
    var lateAt: Double? // the watchdog revealed
    var lateWaiting: String? // what the watchdog's reveal found still to do
    var revealResult: Int32? // the reveal's answer (SLSInvokeTransition's), the watchdog's too
    var devTest = false // DEV-HOOK: a switch between Test A and Test B, as the dev hook allows (DevHooks.swift)
    var devUsed: [String] = [] // DEV-HOOK: what of the hook's this switch used (its summary says so)
    var aSpace: UInt64? // A's full-screen Space (the active one at the freeze, with no A)
    var activeAtFreeze: UInt64?
    var fullScreenAtFreeze: Set<UInt64> = []
    var foreignSince: Double?

    // B
    var showAsked = false
    var shownAt: Double?
    var stateAskedAt: Double?
    var stateAnswer: WindowCallAnswer?
    var retried = false
    var boundsAtShow: CGRect?
    var spacesAtShow: [UInt64]?
    var createAskedAt: Double?
    var openedAt: Double? // the copy of an `openProfile` target linked with its window
    var createdAt: Double?
    var r1At: Double?
    var r2At: Double?
    var lastBounds: CGRect?
    var steady = 0
    var probeAsked = false
    var probe: FrameProbeAnswer?
    var r3At: Double?
    var framedAt: Double?
    var r4At: Double?
    var bReplaced = false // its show didn't land: closed, and the switch went on as a create
    var bClosed = false // closed by the person after the reveal (in after or landed): the switch ends there

    // A
    var aOverlayOut = false
    var aDeferred = false // not started under this freeze (B steady too late): in `after`
    var aAskedAt: Double?
    var aAnswer: WindowCallAnswer?
    var aLeftAt: Double?
    var aGone = false
    var aParkAsked = false
    var aParkedAt: Double?
    var aParkFailed = false
    var aParkBusy = false // its park answered busy (said once)
    var aCloseAsked = false
    var aClosedAt: Double?
    var aKept: String?
    var aDone = false // A's part is over: parked, closed, kept, gone, or there's none
    // close mode (§4.5): A closed under a second freeze, once B is revealed
    var closeDue = false // after the focus check and the cooldown
    var closeTries = 0
    var closeAt: Double? // this try's start: its freeze, its closeWindow
    var closeRetryAt: Double? // a failed close tried once more then
    var closeHandle: Int32?
    var closeLive = false
    var closeLate = false // its watchdog revealed it
    var closeHeldMs: Int?
    var holdSince: Double? // A gone and B in front since
    var dropSeen = false // the Desktop showed as A went
    var dropFocused = false // B focused once for it
    var checkTries = 0 // today's checking path, seen: B focused again
    var r5At: Double?
    var leftBehind = 0

    // the end
    var revealedAt: Double?
    var afterAt: Double?
    var focusDone = false
    var focusLine = ""
    var stillSince: Double?
    var lastSpaces: [UInt64] = []
    var landedAt: Double?
    var failure: String?
    var endEvent: ProfileSwitch.Event?
    // Recovery: how A comes back (§4.4), sent once A's own windows call (if any) has answered.
    enum Restore { case none, fullScreen, showThenFullScreen }
    var restore = Restore.none
    var restoreSent = false
    var restoring: Bool { restore != .none }

    init(gen: Int, target: ProfileSwitch.Target, a: WindowKey?, aNumber: Int?, asked: WindowKey?, startedAt: Double) {
        (self.gen, self.target, self.a, self.aNumber, self.asked, self.startedAt) = (gen, target, a, aNumber, asked, startedAt)
    }

    func ms(_ t: Double?) -> String {
        guard let t, let origin = stepsAt ?? freezeAt else { return "-" }
        return String(Int(((t - origin) * 1000).rounded()))
    }
}

// A window the aftercare looks after once its switch is over (§1.9), until `until` or until a later
// switch takes it as its A or B.
struct AftercareWatch {
    enum Kind: Equatable {
        case parkWhenNormal // parked once it's normal: recovery's B, an A whose normal lands late
        case leaveFullScreen // an A left in full screen because its copy was gone: asked normal once it's back
    }
    let key: WindowKey?
    let number: Int
    var kind: Kind
    let since: Double
    let until: Double
    let runs: Int // switches started by then: "no switch since" (§1.9)
    var landsLate = false // its full-screen request may land late: a late landing
    var normalAsked = false
    var normalTook = true // the normal request reached Safari (not busy or late)
    var sawNotFull = false
    var parked = false // parked again; a B that may land late is still watched
    var cause: Cause
    var link: String? = nil // its profile's, for a window whose copy id isn't known (parked again by number)
}

// What lasts the session (until Margin.app quits).
struct HandoffSession {
    var coverOff: String? // separate from FreezeRules; a cover failure cannot demote the freezer
    var rules = FreezeRules()
    var parkOff: String? // parking off for this session: why
    var pending: [WindowKey: (type: String, token: Int, at: Double)] = [:] // windows calls not answered yet
    var token = 0
    var watches: [AftercareWatch] = []
    var personAt = -Double.infinity // the person's last key or click in Margin
    var runs = 0
    var shown: (key: WindowKey, number: Int?)? // where the last switch landed
    var lines: [String] = [] // each switch's summary, the last 5
    var closeParkedAsked = false // §5: the setting turned on while a switch ran: its parked windows closed after it
    // No freeze from now on: the Mac going to sleep (until it wakes), or Margin quitting (for good).
    var noFreeze: RevealWhy?
    var dev = DevHookState() // DEV-HOOK: the dev-only hook's caps and faults (DevHooks.swift)
}

extension ProfileSwitch: FreezerDelegate {
    var handoffWorld: HandoffWorld? { (world as? HandoffWorld).flatMap { $0.handoffOn ? $0 : nil } }
    private var ho: HandoffOptions { options.handoff }

    // ---- for the shell (WP9) ----

    // The numbers this switch is moving (its A and B): the registry's sweep leaves them alone.
    var movingNumbers: Set<Int> { run.map { Set([$0.aNumber, $0.bNumber].compactMap { $0 }) } ?? [] }
    // The switch's target window (its overlay is made from the start, §2.3).
    private var liveCoverRecovery: Bool { run?.coverStartedAt != nil && run?.failure != nil }
    var inHandoffTransition: Bool { phase == .frozen || phase == .covered }
    func isTarget(_ key: WindowKey) -> Bool { liveCoverRecovery ? run?.a == key : run?.b == key }
    // The window the switch leaves.
    var leaving: WindowKey? { liveCoverRecovery ? run?.b : run?.a }

    // A's overlay drew the cover (app/shared/host/overlay.ts `switch.coverShown`).
    func coverShown(in key: WindowKey) {
        guard let run, run.a == key, [.preparing, .waitingForLink].contains(phase), run.coverAt == nil else { return }
        run.coverAt = clock.now()
        tick()
    }

    // An overlay page's `framed { mode }` after its `shown` (R4).
    func framed(_ key: WindowKey, mode: OverlayFramed.Mode) {
        guard let run, run.b == key, run.shownAt != nil, mode == .fullscreen, run.framedAt == nil else { return }
        run.framedAt = clock.now()
    }

    // A key or a click in Margin: a late landing is no longer the person's choice (§1.9).
    func personActed() { session.personAt = clock.now() }

    // Whether Margin's keys are the switch's (§1.7): only while it moves windows, from `preparing` on.
    // Waiting for a profile's copy (up to 90 s, no cover) leaves them as they are without a switch.
    var keysMidSwitch: Bool { run != nil && busy && phase != .waitingForProfile }

    // Reveal at once: the Mac going to sleep, Safari quitting, Margin quitting (§4.3). The switch
    // recovers to a visible window, unfrozen. Going to sleep, nothing freezes again until the Mac
    // wakes; quitting, never again (and nothing queued starts). A switch not frozen yet is given up
    // with nothing touched, so its next step can't freeze the screen as the Mac sleeps or Margin goes.
    func revealNow(_ why: RevealWhy) {
        if why == .sleep {
            if session.noFreeze == nil { session.noFreeze = .sleep }
            queued = nil
            // A late profile/link arrival must not resume a choice made before
            // sleep. Opening a profile or selecting its space may already have
            // changed focus, so use the same bounded source restoration.
            if [.preparing, .covering, .waitingForLink, .waitingForProfile].contains(phase) {
                return interruptHandoff("sleep", reveal: .sleep)
            }
        }
        if why == .quit {
            session.noFreeze = .quit
            queued = nil
        }
        guard let run, let hw = handoffWorld else { return }
        if run.live { reveal(run, hw, why) }
        if run.coverPreparedAt != nil || run.coverActive { endLiveCover(run, hw, why) }
        if run.closeLive { revealClose(run, hw, why) }
        if [.preparing, .covering, .waitingForLink].contains(phase) {
            guard why != .safariQuit || run.coverEligible else { return } // legacy: its copies go, the steps see it
            return finish(.cancelled(run.target), "\(why.rawValue) before the freeze: nothing done", landed: run.a.map { ($0.link, $0.windowId) })
        }
        if [.frozen, .covered].contains(phase), why != .quit { recover(run, hw, "the switch was interrupted (\(why.rawValue))") }
    }

    // The Mac woke: the freeze may run again (unless Margin is quitting).
    func woke() {
        guard session.noFreeze == .sleep else { return }
        session.noFreeze = nil
        note("the Mac woke: the freeze may run again")
    }

    // A display/Dock event invalidates the choices captured at start, including
    // a run still waiting for its link or a pending call before cover setup.
    // Never continue that old one-display freeze/park choice on the new topology.
    func handoffEnvironmentChanged(_ why: String) {
        interruptHandoff(why, reveal: .aborted)
    }

    private func interruptHandoff(_ why: String, reveal revealWhy: RevealWhy) {
        queued = nil // a later deliberate request will read the new environment
        guard let run, let hw = handoffWorld else { return }
        note("\(why): current handoff invalidated")
        let before = [.preparing, .covering, .waitingForLink, .waitingForProfile].contains(phase)
        let untouched = before && !run.awaitedProfile && !run.spaceSelectionAsked && !run.showAsked && run.shownAt == nil
            && run.stateAskedAt == nil && run.createAskedAt == nil && run.openedAt == nil
            && run.aAskedAt == nil && !run.aParkAsked && !run.aCloseAsked
        if untouched {
            endLiveCover(run, hw, revealWhy)
            return finish(.cancelled(run.target), "\(why) before moving windows: nothing done",
                          landed: run.a.map { ($0.link, $0.windowId) })
        }
        // Waiting for a profile can already have asked Safari to open/focus a
        // window. Restore the known source through the normal bounded recovery.
        if [.waitingForProfile, .waitingForLink, .preparing, .covering].contains(phase),
           (run.awaitedProfile || run.spaceSelectionAsked), !run.aGone, run.restore == .none, run.a != nil { run.restore = .fullScreen }
        // Unlike the ordinary pre-freeze interruption, this path may already
        // have opened a profile window while awaiting its link. Do not finish
        // that run before its source restoration has had a chance to execute.
        if run.live { reveal(run, hw, revealWhy) }
        if run.coverPreparedAt != nil || run.coverActive { endLiveCover(run, hw, revealWhy) }
        if run.closeLive { revealClose(run, hw, revealWhy) }
        guard self.run === run, phase != .recovering else { return }
        recover(run, hw, "\(why): restoring the source on the current displays", reveal: revealWhy, event: .cancelled(run.target))
    }

    // ---- the freezer's reports (FreezeRules, and the watchdog) ----

    func freezer(_ freezer: Freezer, reported: FreezeReport) {
        session.rules.note(reported, at: clock.now())
        guard let run else { return }
        switch reported {
        case .revealed(let handle, .watchdog, let heldMs), .revealFailed(let handle, .watchdog, _, _, let heldMs):
            if handle == run.closeHandle {
                closeWatchdog(run, heldMs)
            } else {
                guard handle == run.handle else { return }
                if case .revealFailed(_, _, let result, _, _) = reported { run.revealResult = result } else { run.revealResult = 0 }
                late(run, (run.freezeAt ?? clock.now()) + Double(heldMs) / 1000)
            }
            tick()
        default:
            return
        }
    }

    private func late(_ run: HandoffRun, _ now: Double) {
        run.live = false
        guard run.lateAt == nil, run.revealedAt == nil else { return }
        run.lateAt = now
        run.revealedAt = now
        let waiting = run.r2At == nil ? "B" : run.aDeferred || run.aAskedAt == nil ? "A not started" : run.aParkedAt == nil ? "A's park" : "the settle"
        run.lateWaiting = waiting
        note("late (watchdog at \(run.ms(now)) ms, waiting for \(waiting))")
    }

    // ---- start ----

    // A handoff, if this world can run one and this switch needs one. False: the close-based switch.
    func handoffStart(_ to: Target, from fromProfile: String, windowId: Int?, asked: WindowKey?) -> Bool {
        guard let hw = handoffWorld, let reads = hw.spaceReads else { return false }
        // Within a profile: its spaces switch inside the window (§13.11).
        if to.profile == fromProfile {
            note("\(to) in the same profile: its space, in window \(windowId.map(String.init) ?? "?")")
            hw.request(fromProfile, "setSpace", ["windowId": windowId ?? NSNull(), "spaceId": to.space], windowId: windowId) { _, _ in }
            return true
        }
        // Safari's only: parking's sweep, its checks and its recovery after a crash read Safari's windows
        // (ShellHandoff.swift). Chrome's and Edge's profiles switch the close-based way. Told by the target, which
        // always names its browser (`from` is "" for a parked window's own activity, with no window to leave).
        guard to.profile.hasPrefix("safari:") else {
            note("\(to): not Safari's, the close-based switch")
            return false
        }
        // The display count decides the freeze: unread, nothing is guessed. The close-based switch can't
        // show a parked window (and its Desktop can't be found without the displays either): with one
        // for the target, this switch is refused, and the window stays parked for the next one.
        guard let displays = reads.managedDisplayCount(), displays > 0 else {
            if !(hw.parking?.entries(of: to.profile).isEmpty ?? true) {
                note("the displays don't read and \(to.profile) has a parked window: not switched")
                world?.switchChanged(.failed(to, "macOS’s Spaces didn’t read"))
                return true
            }
            note("the displays don't read: the close-based switch")
            return false
        }
        let a = windowId.map { WindowKey(link: fromProfile, windowId: $0) }
        let aNumber = a.flatMap { hw.number(of: $0) }
        let parking = hw.parking
        let facts = HandoffChoice.Facts(freezeOn: hw.handoffFreezer != nil && session.rules.on && session.noFreeze == nil,
                                        parkOn: hw.parkingOn && parking != nil && session.parkOff == nil,
                                        closeSetting: hw.closesWindows(to.profile), displays: displays,
                                        hasA: a != nil, aLinked: a.map { hw.isLinked($0.link) } ?? false)
        var choice = HandoffChoice.pick(facts)
        // DEV-HOOK: the dev-only hook's caps, only for a switch between Safari's Test A and Test B.
        let devTest = hw.devHookAllows(fromProfile, to.profile)
        var devCapped = false
        if devTest, !session.dev.isEmpty {
            choice = session.dev.capped(choice)
            devCapped = choice != HandoffChoice.pick(facts)
            if devCapped { note("dev hook: choice capped to \(choice)") }
        }
        let hasParked = !(parking?.entries(of: to.profile).isEmpty ?? true)
        // Closing without a freeze is today's switch (plus its drafts check), unless there's a parked
        // window to show, or a window's own activity asked.
        let coverCapped = devTest && session.dev.cover == false // DEV-HOOK: subtractive, never touches the real session gate
        let liveCover = !coverCapped && hw.handoffCover != nil && session.coverOff == nil && session.noFreeze == nil && displays == 1 && a != nil
        if !choice.freeze, !liveCover, choice.old == .close, !hasParked, asked == nil, a != nil {
            note("\(choice): the close-based switch")
            return false
        }
        gen += 1
        let run = HandoffRun(gen: gen, target: to, a: a, aNumber: aNumber, asked: asked, startedAt: clock.now())
        // Its Margin window (docs/BROWSER-WINDOWS.md §2.1): A's line, or a new one with A its home; with no A (§6.2, a
        // parked window's own activity), the line of the window that asked.
        run.line = aNumber.flatMap { n in parking?.lineFor(number: n, link: fromProfile) }
            ?? asked.flatMap { hw.number(of: $0) }.flatMap { parking?.line(of: $0) }
            ?? (a == nil ? parking?.recentLine : nil)
        run.choice = choice
        run.coverEligible = liveCover
        if hw.handoffCover != nil, displays != 1 { note("live cover unavailable with multiple displays: degraded freeze/slide fallback") }
        run.devTest = devTest // DEV-HOOK
        if devCapped { run.devUsed.append("cap") } // DEV-HOOK
        if coverCapped { run.devUsed.append("cover off") } // DEV-HOOK
        target = to
        from = (fromProfile, windowId)
        newWindow = nil
        queued = nil
        self.run = run
        session.runs += 1
        if let aNumber { dropWatch(aNumber) }
        hw.handoffFreezer?.delegate = self
        world?.switchChanged(.started(to))
        note("\(a.map(\.description) ?? "nothing") → \(to) (\(choice))")
        pickTarget(run, hw)
        poll()
        return true
    }

    // A new target while one runs (§1.7): before the freeze it takes this one's place (or, in A's own
    // profile, ends it); from the freeze on it waits, the last one asked kept.
    func handoffAgain(_ to: Target, _ run: HandoffRun) {
        guard let hw = handoffWorld else { return }
        if to == run.target { return }
        guard [.preparing, .covering, .waitingForLink, .waitingForProfile].contains(phase) else {
            queued = to
            return note("\(to) asked mid-switch: after this one")
        }
        if let a = run.a, to.profile == a.link {
            if hw.activeSpaceId(of: a) != to.space {
                hw.request(a.link, "setSpace", ["windowId": a.windowId, "spaceId": to.space], windowId: a.windowId) { _, _ in }
            }
            return finish(.cancelled(run.target), "back to \(a.link) before the freeze: nothing done", landed: (a.link, a.windowId))
        }
        note("\(to) asked before the freeze: in place of \(run.target)")
        let (fromProfile, windowId) = (run.a?.link ?? from?.profile ?? "", run.a?.windowId)
        endLiveCover(run, hw, .cancelled)
        self.run = nil
        phase = .idle
        target = nil
        start(to, from: fromProfile, windowId: windowId)
    }

    // §1.5: the window, in order: the one that asked, the profile's home window parked, any parked one
    // (the most recent first), its own window in full screen (focus), its own normal window (show), a
    // new one. Its copy not linked: waitingForLink with a parked window, else waitingForProfile.
    private func pickTarget(_ run: HandoffRun, _ hw: HandoffWorld) {
        let link = run.target.profile
        guard hw.isLinked(link) else {
            if !(hw.parking?.entries(of: link).isEmpty ?? true) {
                if phase != .waitingForLink {
                    enter(.waitingForLink, for: ho.linkWait)
                    note("\(link) isn't linked: its parked window waits up to \(Int(ho.linkWait)) s for it")
                }
            } else if phase != .waitingForProfile, world?.marginOff(link) == true {
                // Margin turned off in that profile (Safari's settings): no window opened, failed at once, and said.
                return finish(.failed(run.target, "Margin is turned off in it"), "Margin is turned off in \(link) (the browser's settings)")
            } else if phase != .waitingForProfile, run.way == .openProfile {
                return // asked under the freeze (showB), or about to be (preparing)
            } else if phase != .waitingForProfile, protectsSwitch(run, hw) {
                // Its copy starts with a window Margin asks Safari for (its own menu, through Accessibility). A window
                // opened beside a full-screen one is put in full screen by macOS, which slides to it (§1.6), so it's
                // asked under the freeze, as a create: the cover, the freeze, then the window (showB). The switch
                // goes on once that copy links with it (frozenStep).
                run.way = .openProfile
                run.awaitedProfile = true
                run.b = nil
                run.bNumber = nil
                run.prepared = false
                newWindow = nil
                if phase != .preparing { enter(.preparing, for: options.settleTimeout) }
                note("\(link) isn't linked: its window to be asked for under the transition cover")
            } else if phase != .waitingForProfile {
                // No freeze: asked now, and seen (the switch goes on once that copy links). Else the person is told.
                let opened = world?.openProfileWindow(link) == true
                run.awaitedProfile = true
                enter(.waitingForProfile, for: opened ? options.openedProfileWait : options.profileWait)
                if opened {
                    note("\(link) isn't linked: asked the browser for a new window of it, waiting for its copy")
                } else {
                    note("\(link) isn't linked: waiting for one of its windows")
                    world?.switchChanged(.needsProfile(run.target))
                }
            }
            return
        }
        let (way, key, number) = pickWindow(run, hw)
        run.prepared = false
        run.way = way
        run.b = key
        run.bNumber = number
        newWindow = key?.windowId
        if let number { dropWatch(number) }
        if phase != .preparing { enter(.preparing, for: options.settleTimeout) }
        note("target: \(way.rawValue) \(key.map(\.description) ?? "-") (\(number.map(String.init) ?? "-"))")
    }

    private func pickWindow(_ run: HandoffRun, _ hw: HandoffWorld) -> (HandoffRun.Way, WindowKey?, Int?) {
        let link = run.target.profile
        let parking = hw.parking
        // A parked window mid-step (the sweep parking it again) is still the one: preparing waits for it.
        let parked = (parking?.entries(of: link) ?? []).filter { !run.avoid.contains($0.number) }
        let parkedNumbers = parking?.numbers ?? []
        let wins = hw.copyWindows(link)
        // 1. the window that asked
        if let asked = run.asked, asked.link == link {
            if let e = parked.first(where: { $0.key == asked }) { return (.parked, e.key, e.number) }
            if let w = wins.first(where: { $0.key == asked }), w.state != "minimized" {
                let n = hw.number(of: asked)
                if n.map({ !parkedNumbers.contains($0) && !run.avoid.contains($0) }) ?? true { return (w.state == "fullscreen" ? .focus : .show, asked, n) }
            }
        }
        // 2. its line's home window, parked; 3. a parked window of it in no line (the crash marker's, before any
        // line took it), adopted. Another line's never: that's another Margin window's (docs/BROWSER-WINDOWS.md §2.1).
        let home = run.line.flatMap { parking?.lines[$0]?.homes[link] }
        if let home, let e = parked.first(where: { $0.number == home }) { return (.parked, e.key, e.number) }
        if let e = parked.first(where: { parking?.line(of: $0.number) == nil }) { return (.parked, e.key, e.number) }
        // 4, 5. its line's home window, not parked, in full screen (focus) or normal (show). One of its windows
        // in no line, or in another, is another Margin window: never a target.
        if let home, let w = wins.first(where: { hw.number(of: $0.key) == home }), w.state != "minimized" { // §1.5 rule 6
            if !parkedNumbers.contains(home), !run.avoid.contains(home) { return (w.state == "fullscreen" ? .focus : .show, w.key, home) }
        }
        // A window of it opened for this switch (Safari asked for one under the freeze, or the person opened one
        // while it waited for the profile): adopted into the line, full screen first.
        if run.awaitedProfile {
            let fresh = wins.filter { w in
                w.state != "minimized" && hw.number(of: w.key).map { !parkedNumbers.contains($0) && parking?.line(of: $0) == nil && !run.avoid.contains($0) } ?? true
            }
            if let w = fresh.first(where: { $0.state == "fullscreen" }) ?? fresh.first { return (w.state == "fullscreen" ? .focus : .show, w.key, hw.number(of: w.key)) }
        }
        return (.create, nil, nil)
    }

    // ---- each look ----

    func handoffStep(_ run: HandoffRun) {
        guard let hw = handoffWorld, self.run === run else { return }
        let now = clock.now()
        switch phase {
        case .waitingForLink:
            if hw.isLinked(run.target.profile) { note("\(run.target.profile) linked again"); return pickTarget(run, hw) }
            if now >= deadline { return linkGone(run, hw) }
        case .waitingForProfile:
            if hw.isLinked(run.target.profile), !hw.copyWindows(run.target.profile).isEmpty {
                note("\(run.target.profile) linked with a window")
                return pickTarget(run, hw)
            }
            if now >= deadline { return finish(.failed(run.target, "no window of it was opened"), "gave up waiting for \(run.target.profile)") }
        case .preparing:
            prepareStep(run, hw, now)
        case .frozen:
            transitionStep(run, hw, now)
        case .covering:
            if now >= deadline { coverFallback(run, hw, "activation timed out") }
        case .covered:
            coveredStep(run, hw, now)
        case .after:
            afterStep(run, hw, now)
        case .recovering:
            recoverStep(run, hw, now)
        case .landed:
            landedStep(run, hw, now)
        case .closing:
            closingStep(run, hw, now)
        case .checking:
            checkingStep(run, hw, now)
        case .idle, .creating, .settling:
            return
        }
    }

    // The copy didn't come back in 3 s: its parked window back on its display's Desktop, by number (no
    // copy needed), and the person told (§1.5). Never stranded, never "isn't open in Safari".
    private func linkGone(_ run: HandoffRun, _ hw: HandoffWorld) {
        let link = run.target.profile
        let entries = hw.parking?.entries(of: link) ?? []
        let home = run.line.flatMap { hw.parking?.lines[$0]?.homes[link] }
        let e = entries.first { $0.number == home } ?? entries.first
        if let e { hw.parking?.returnToDesktop(number: e.number, cause: .recovery) }
        notices.append(SwitchNotice(.windowOnDesktop, profile: link, shownIn: run.a))
        finish(.cancelled(run.target), "\(link) didn't link again in \(Int(ho.linkWait)) s: window \(e.map { String($0.number) } ?? "-") returned to the Desktop",
               landed: run.a.map { ($0.link, $0.windowId) })
    }

    private func prepareStep(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        if run.way == .openProfile {
            // Its copy linked with a window meanwhile (the person opened one): that window is the target.
            if hw.isLinked(run.target.profile), !hw.copyWindows(run.target.profile).isEmpty { return pickTarget(run, hw) }
        } else if !hw.isLinked(run.target.profile) {
            return pickTarget(run, hw)
        }
        if run.bNumber == nil, let b = run.b { run.bNumber = hw.number(of: b) }
        // A window with a windows call still pending (§1.7): A's waits, then the switch is refused; B's
        // waits, then another target is picked.
        if let a = run.a, session.pending[a] != nil {
            let since = run.waitingSince ?? now
            run.waitingSince = since
            if now - since < ho.pendingWait { return }
            return blocked(run, hw, .windowBusy, profile: a.link, "window \(a) still has a windows call pending")
        }
        // A parked target its step let go of (returned, closed): picked again.
        if run.way == .parked, let n = run.bNumber, hw.parking?.entries[n] == nil {
            note("window \(n) is no longer parked: the target picked again")
            return pickTarget(run, hw)
        }
        let bStepping = run.way == .parked && run.bNumber.flatMap { hw.parking?.entries[$0]?.stepping } == true
        if bStepping || run.b.map({ session.pending[$0] != nil }) == true {
            let since = run.waitingSince ?? now
            run.waitingSince = since
            if now - since < ho.pendingWait { return }
            note("window \(run.b.map(\.description) ?? "-") still has a call pending: another target")
            run.waitingSince = nil
            let before = run.way
            if let n = run.bNumber { run.avoid.insert(n) }
            pickTarget(run, hw)
            if run.way == .create, before != .create { return blocked(run, hw, .windowBusy, profile: run.target.profile, "no other window of \(run.target.profile)") }
            return
        }
        run.waitingSince = nil
        if !run.prepared {
            run.prepared = true
            // §1.10: a sheet or dialog on A.
            if dialogOver(run, hw) { return blocked(run, hw, .dialogOpen, profile: run.a?.link ?? run.target.profile, "a dialog is up in \(run.a.map(\.description) ?? "-")") }
            if run.coverEligible, !run.coverFailed, let a = run.a, let cover = hw.handoffCover {
                if let context = hw.handoffCoverContext(from: a, to: run.target) {
                    run.coverPreparedAt = now
                    cover.prepare(context)
                } else {
                    run.coverFailed = true
                    note("live cover unavailable for this window: degraded freeze/slide fallback")
                }
            }
            // Selecting a space may activate its browser window. Live mode
            // defers that request until the cover has visibly acknowledged.
            run.deferredSpaceSelection = run.coverEligible && !run.coverFailed
            if !run.deferredSpaceSelection { selectTargetSpace(run, hw) }
            // A's drafts, whenever this switch may close it (a close, or a park that may fail).
            if run.choice.old != .keep, let a = run.a { askDrafts(run, hw, a) }
        }
        // The cover drawn in A (or 250 ms), then the cooldown (§1.5).
        guard run.a == nil || run.coverAt != nil || now - run.startedAt >= ho.coverWait else { return }
        if run.coverPreparedAt != nil, !run.coverFailed, let cover = hw.handoffCover {
            switch cover.state {
            case .prepared:
                return startLiveCover(run, hw, cover)
            case .failed(let why):
                coverFallback(run, hw, why)
                return
            default:
                if now - (run.coverPreparedAt ?? now) >= ho.coverSetupWait { coverFallback(run, hw, "content preparation timed out") }
                return
            }
        }
        if run.choice.freeze, !cooledDown(now) { return }
        freezeAndGo(run, hw, now)
    }

    // This switch will freeze, as freezeAndGo decides it (before the per-way exceptions, none of which is a
    // window yet to be opened).
    private func freezes(_ run: HandoffRun, _ hw: HandoffWorld) -> Bool {
        run.choice.freeze && session.rules.on && session.noFreeze == nil && hw.handoffFreezer != nil
    }

    private func protectsSwitch(_ run: HandoffRun, _ hw: HandoffWorld) -> Bool {
        freezes(run, hw) || (run.coverEligible && !run.coverFailed && session.coverOff == nil && hw.handoffCover != nil)
    }

    private func selectTargetSpace(_ run: HandoffRun, _ hw: HandoffWorld) {
        run.deferredSpaceSelection = false
        if let b = run.b, hw.activeSpaceId(of: b) != run.target.space {
            run.spaceSelectionAsked = true
            hw.request(b.link, "setSpace", ["windowId": b.windowId, "spaceId": run.target.space], windowId: b.windowId) { _, _ in }
        }
    }

    private func startLiveCover(_ run: HandoffRun, _ hw: HandoffWorld, _ cover: HandoffCover) {
        captureStartSpaces(run, hw)
        enter(.covering, for: ho.coverSetupWait)
        cover.onEmergency = { [weak self, weak run, weak hw] in
            guard let self, let run, let hw, self.run === run else { return }
            self.session.coverOff = "cover process or emergency watchdog"
            if self.phase == .covered {
                self.endLiveCover(run, hw, .failed)
                self.recover(run, hw, "live cover ended unexpectedly: degraded recovery")
            } else if self.phase == .preparing || self.phase == .covering {
                self.coverFallback(run, hw, "cover preparation ended unexpectedly")
            }
        }
        cover.activate { [weak self, weak run, weak hw] ok in
            guard let self, let run, let hw, self.run === run, self.phase == .covering else { return }
            guard ok else { return self.coverFallback(run, hw, "activation refused") }
            run.coverActive = true
            run.coverStartedAt = self.clock.now()
            run.stepsAt = self.clock.now()
            self.enter(.covered, for: self.ho.liveCoverWait)
            self.handOver(run, hw)
            self.showB(run, hw) // never before the live cover's own readiness acknowledgement
        }
    }

    private func coverFallback(_ run: HandoffRun, _ hw: HandoffWorld, _ why: String) {
        run.coverFailed = true
        session.coverOff = why
        endLiveCover(run, hw, .failed)
        note("live cover off this session (\(why)): degraded \(freezes(run, hw) ? "freeze" : "macOS slide") fallback")
        enter(.preparing, for: options.settleTimeout)
        prepareStep(run, hw, clock.now())
    }

    // Also used by finish/replacement/quit: prepared but not shown pages must be disposed too.
    func endLiveCover(_ run: HandoffRun, _ hw: HandoffWorld, _ why: RevealWhy) {
        guard run.coverPreparedAt != nil || run.coverActive else { return }
        run.coverActive = false
        if run.coverStartedAt != nil, run.coverEndedAt == nil { run.coverEndedAt = clock.now() }
        if hw.handoffCover?.end(why) == false { session.coverOff = "cover cleanup refused" }
    }

    private func coveredStep(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        guard run.coverActive, hw.handoffCover?.state == .shown else {
            session.coverOff = "cover stopped while switching"
            endLiveCover(run, hw, .failed)
            return recover(run, hw, "live cover stopped: degraded recovery")
        }
        if now >= deadline { return recover(run, hw, "live cover soft deadline: restoring the old window under cover") }
        transitionStep(run, hw, now)
    }

    private func captureStartSpaces(_ run: HandoffRun, _ hw: HandoffWorld) {
        let reads = hw.spaceReads
        run.activeAtFreeze = run.aNumber.flatMap { reads?.showing(onDisplayOf: $0) } ?? reads?.activeSpace()
        run.fullScreenAtFreeze = reads?.fullScreenSpaces() ?? []
        if let n = run.aNumber, let spaces = reads?.spaces(of: n) {
            run.aSpace = spaces.first { run.fullScreenAtFreeze.contains($0) } ?? run.activeAtFreeze
        } else { run.aSpace = run.activeAtFreeze }
    }

    private func cooledDown(_ now: Double) -> Bool {
        let rules = session.rules
        if let at = rules.lastWatchdogAt, now - at < ho.watchdogCooldown { return false }
        if let at = rules.lastRevealAt, now - at < ho.revealCooldown { return false }
        return true
    }

    // §1.10: a layer-0 window of A's process over A, smaller than A, not bound to a copy and not A's
    // full-screen toolbar.
    private func dialogOver(_ run: HandoffRun, _ hw: HandoffWorld) -> Bool {
        guard let a = run.a, let n = run.aNumber else { return false }
        let list = hw.browserWindows(of: a.link)
        guard let aw = list.first(where: { $0.number == n }) else { return false }
        let toolbar = WindowMatcher.fullScreenToolbar(list, browser: aw)?.number
        let parked = hw.parking?.numbers ?? []
        let area = aw.bounds.width * aw.bounds.height
        return list.contains { w in
            w.number != n && w.number != toolbar && w.pid == aw.pid && w.layer == 0 && w.onScreen && w.alpha > 0
                && !parked.contains(w.number) && hw.key(of: w.number) == nil
                && aw.bounds.insetBy(dx: -1, dy: -1).contains(w.bounds) && w.bounds.width * w.bounds.height < area
        }
    }

    // Nothing touched: the cover goes, and the person is told why.
    private func blocked(_ run: HandoffRun, _ hw: HandoffWorld, _ kind: SwitchNotice.Kind, profile: String, _ why: String) {
        notices.append(SwitchNotice(kind, profile: profile, shownIn: run.a))
        finish(.cancelled(run.target), "\(why): no handoff", landed: run.a.map { ($0.link, $0.windowId) })
    }

    private func askDrafts(_ run: HandoffRun, _ hw: HandoffWorld, _ a: WindowKey) {
        guard !run.draftsAsked, hw.isLinked(a.link) else { return }
        run.draftsAsked = true
        hw.request(a.link, "windowDrafts", HandoffRequest.windowDrafts(windowId: a.windowId).payload, windowId: a.windowId) { [weak self, weak run] result, _ in
            guard let self, let run, self.run === run else { return }
            run.drafts = result.flatMap { WindowDrafts($0) } ?? WindowDrafts(drafts: [], unknown: [-1])
        }
    }

    // ---- the freeze, and the steps under it ----

    private func freezeAndGo(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        captureStartSpaces(run, hw)
        // A parked target its copy hasn't named yet is shown by number, seen (§1.5).
        if run.way == .parked, run.b == nil, run.choice.freeze {
            run.choice.freeze = false
            note("window \(run.bNumber.map(String.init) ?? "-") has no copy id yet: no freeze")
        }
        // A normal window on another Space with no bridge to bring it here: its full-screen request makes
        // macOS slide to its Desktop first, which the freeze's Space rule would abort. Seen instead.
        if run.way == .show, run.choice.freeze, !bridgeShows(run, hw) {
            run.choice.freeze = false
            note("window \(run.bNumber.map(String.init) ?? "-") can't be shown by the bridge: no freeze")
        }
        if run.choice.freeze, session.rules.on, session.noFreeze == nil, let freezer = hw.handoffFreezer {
            freezer.delegate = self
            switch freezer.freeze() {
            case .frozen(let handle):
                run.handle = handle
                run.live = true
                handOver(run, hw)
            case .failed(let result):
                note("freeze answered \(result): this switch runs without one")
            case .unavailable(let why):
                note("no freeze: \(why)")
            }
        }
        run.freezeAt = clock.now()
        run.stepsAt = run.freezeAt
        enter(.frozen, for: options.settleTimeout)
        showB(run, hw)
    }

    // §1.3 step 2: a parked B into the active Space (or a normal one from its Space), then step 3.
    private func showB(_ run: HandoffRun, _ hw: HandoffWorld) {
        let now = clock.now()
        if run.deferredSpaceSelection { selectTargetSpace(run, hw) }
        switch run.way {
        case .parked:
            guard let n = run.bNumber, let parking = hw.parking else { return recover(run, hw, "Margin couldn’t find its window") }
            run.showAsked = true
            // DEV-HOOK: a show that didn't land, with no call made: B stays in its own Space, and §4.4 goes on.
            if devFault(run, .show) {
                return showFailed(run, hw, n, ParkOutcome(number: n, step: .show, failure: .notLanded(spaces: hw.spaceReads?.spaces(of: n), onScreen: false), ms: 0, tries: 0, space: nil))
            }
            parking.show(number: n, cause: .handoff) { [weak self, weak run] o in
                guard let self, let run, self.run === run else { return }
                guard self.inHandoffTransition else {
                    // Shown after the switch gave up: parked again once it's normal (it is).
                    if o.ok { self.addWatch(AftercareWatch(key: run.b, number: n, kind: .parkWhenNormal, since: self.clock.now(), until: self.clock.now() + self.ho.aftercareFor, runs: self.session.runs, cause: .recovery, link: run.target.profile)) }
                    return
                }
                if o.ok { return self.bShown(run, hw) }
                // Only a show whose ops went out and didn't land turns parking off (§4.3); one refused
                // before any op (busy, gone) is this switch's failure alone.
                guard ParkingRegistry.mayHaveMoved(o) else { return self.recover(run, hw, "Margin couldn’t show its window (\(ParkSelfTest.describe(o.failure)))") }
                self.showFailed(run, hw, n, o)
            }
        case .show:
            if bridgeShows(run, hw), let n = run.bNumber, let parker = hw.parker {
                run.showAsked = true
                parker.show(n) { [weak self, weak run] o in
                    guard let self, let run, self.run === run, self.inHandoffTransition else { return }
                    // A normal window on another Space: its full-screen request brings it anyway, but by
                    // macOS's slide to its Desktop, which the freeze would abort: revealed, then seen.
                    if !o.ok {
                        self.note("window \(n) not shown by the bridge (\(ParkSelfTest.describe(o.failure))): asked for full screen as it is\(run.live ? ", revealed first" : "")")
                        self.reveal(run, hw, .failed)
                    }
                    self.bShown(run, hw)
                }
            } else {
                bShown(run, hw)
            }
        case .focus:
            bShown(run, hw)
        case .create:
            run.createAskedAt = now
            askCreate(run, hw)
        case .openProfile:
            run.createAskedAt = now
            askProfileWindow(run, hw)
        }
    }

    // §1.6 for a profile whose copy isn't running: its window asked of Safari's own menu under the freeze, the
    // switch on as for its own window once that copy links with it (frozenStep). Safari not asked (no
    // Accessibility, no menu item): revealed, and the person asked to open one, as with no freeze.
    private func askProfileWindow(_ run: HandoffRun, _ hw: HandoffWorld) {
        let link = run.target.profile
        guard world?.openProfileWindow(link) == true else {
            note("\(link) isn't linked: waiting for one of its windows")
            if run.coverActive {
                // No browser transition has been requested. The person must be
                // able to use Safari's menu, rather than waiting behind a cover
                // until its emergency watchdog. A later manual opening follows
                // the existing visible path for this run.
                run.coverFailed = true
                endLiveCover(run, hw, .failed)
                // No browser work ran under this cover. Its later manual path
                // must use ordinary fallback close/recovery ownership rules.
                run.coverStartedAt = nil
                run.coverEndedAt = nil
                note("live cover ended before manual profile opening: degraded macOS slide fallback")
            }
            reveal(run, hw, .failed)
            enter(.waitingForProfile, for: options.profileWait)
            world?.switchChanged(.needsProfile(run.target))
            return
        }
        note("\(link) isn't linked: asked the browser for a new window of it under transition protection, waiting for its copy")
    }

    // The show variant's window can go through the bridge (§1.5 rule 5): known, and parking on.
    private func bridgeShows(_ run: HandoffRun, _ hw: HandoffWorld) -> Bool {
        run.bNumber != nil && hw.parker?.isAvailable == true && hw.parkingOn && session.parkOff == nil
    }

    private func bShown(_ run: HandoffRun, _ hw: HandoffWorld) {
        run.shownAt = clock.now()
        if let n = run.bNumber, let reads = hw.spaceReads {
            run.boundsAtShow = reads.window(n)?.bounds
            run.spacesAtShow = reads.spaces(of: n)
        }
        askB(run, hw)
    }

    // §4.4 "B's show didn't land": parking is off for the session; B's own private Space only was
    // destroyed (the registry's). B back in a user Space anyway goes on; else its copy closes it,
    // drafts permitting, and the switch goes on as a create. A draft: back to its Desktop, and failed.
    private func showFailed(_ run: HandoffRun, _ hw: HandoffWorld, _ n: Int, _ o: ParkOutcome) {
        demotePark("window \(n)'s show didn't land in \(o.ms) ms (\(ParkSelfTest.describe(o.failure)))")
        if hw.spaceReads?.spaces(of: n)?.isEmpty == false {
            note("window \(n) came back anyway")
            return bShown(run, hw)
        }
        guard let b = run.b, hw.isLinked(b.link) else {
            hw.parking?.returnToDesktop(number: n, cause: .recovery)
            return recover(run, hw, "its window didn’t come back")
        }
        hw.request(b.link, "windowDrafts", HandoffRequest.windowDrafts(windowId: b.windowId).payload, windowId: b.windowId) { [weak self, weak run] result, _ in
            // Answered after the switch gave up: B is in no Space now, whatever its drafts say.
            guard let self, let run, self.run === run, self.inHandoffTransition else { self?.returnUnshownB(n, hw); return }
            guard result.flatMap({ WindowDrafts($0) })?.mayClose == true else {
                hw.parking?.returnToDesktop(number: n, cause: .recovery)
                self.notices.append(SwitchNotice(.windowKeptDraft, profile: b.link, shownIn: run.a, kept: b))
                return self.recover(run, hw, "its window didn’t come back")
            }
            self.note("window \(n) closed by its copy: on as a new window")
            self.windowCall(hw, b, .closeWindow(windowId: b.windowId, notAfter: self.msNow(self.options.closeTimeout)), cause: .recovery) { _, _ in }
            run.bReplaced = true
            run.way = .create
            run.b = nil
            run.bNumber = nil
            self.newWindow = nil
            run.createAskedAt = self.clock.now()
            self.askCreate(run, hw)
        }
    }

    // A B whose show didn't land, its private Space destroyed, and in no user Space: back to its
    // Desktop by number, whatever else is going on (§4.4: never left where nothing reaches it).
    private func returnUnshownB(_ n: Int, _ hw: HandoffWorld) {
        guard let e = hw.parking?.entries[n], e.phase == .out, hw.spaceReads?.spaces(of: n)?.isEmpty == true else { return }
        note("window \(n) wasn't shown and is in no user Space: returned to its Desktop")
        hw.parking?.returnToDesktop(number: n, cause: .recovery)
    }

    // §1.3 step 3: B full screen and focused, once (§3.4).
    private func askB(_ run: HandoffRun, _ hw: HandoffWorld) {
        guard let b = run.b, run.stateAskedAt == nil else { return }
        run.stateAskedAt = clock.now()
        // DEV-HOOK: a request that never took, with no call made: the watchdog, then the settle timeout's recovery.
        if devFault(run, .fullscreen) {
            run.stateAnswer = .timedOut(windowId: b.windowId, state: "fullscreen")
            return
        }
        // From the freeze, which it must land inside; with none (a window shown by number and bound later,
        // seen), from now: there's no still screen to protect.
        let notAfter = ((run.handle == nil ? clock.now() : run.freezeAt ?? clock.now()) + ho.bNotAfter) * 1000
        windowCall(hw, b, .setWindowState(windowId: b.windowId, state: .fullscreen, focused: true, notAfter: notAfter)) { [weak self, weak run] answer, error in
            guard let self, let run, self.run === run else { return }
            run.stateAnswer = answer
            guard self.inHandoffTransition, run.r2At == nil else { return }
            switch answer {
            case .busy?: self.recover(run, hw, "Safari is busy in that window")
            case .refused?: self.recover(run, hw, "Safari was too slow")
            case nil: self.recover(run, hw, "Safari didn’t answer (\(error ?? "no answer"))")
            default: return
            }
        }
    }

    // §1.6: the window made under the freeze, with no second full-screen request.
    private func askCreate(_ run: HandoffRun, _ hw: HandoffWorld) {
        let link = run.target.profile
        note("create \(run.target)")
        hw.request(link, "openSpaceWindow", HandoffRequest.openSpaceWindow(spaceId: run.target.space).payload, windowId: nil) { [weak self, weak run] result, error in
            guard let self else { return }
            let made = result.flatMap { SpaceWindowAnswer($0) }
            guard let run, self.run === run, self.inHandoffTransition else {
                // Answered after the switch gave up: its window would be a second one.
                if let made {
                    self.note("late window \(made.windowId) of \(link): closed")
                    hw.request(link, "closeWindow", HandoffRequest.closeWindow(windowId: made.windowId).payload, windowId: made.windowId) { _, _ in }
                }
                return
            }
            guard let made else { return self.recover(run, hw, "Safari didn’t open a window for it (\(error ?? "no window"))") }
            let key = WindowKey(link: link, windowId: made.windowId)
            run.b = key
            run.bNumber = hw.number(of: key)
            run.createdAt = self.clock.now()
            run.shownAt = run.createdAt
            run.stateAskedAt = run.createdAt // its copy asked for full screen itself
            self.newWindow = made.windowId
            self.note("created window \(made.windowId) (\(made.state)) at \(run.ms(run.createdAt)) ms")
        }
    }

    private func transitionStep(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        let reads = hw.spaceReads
        // The freeze gone by itself (the watchdog), its report still on its way.
        if run.live, hw.handoffFreezer?.isLive != true { late(run, now) }
        if run.way == .openProfile {
            let link = run.target.profile
            guard hw.isLinked(link), !hw.copyWindows(link).isEmpty else {
                let waited = now - (run.createAskedAt ?? now)
                if waited >= options.openedProfileWait { return recover(run, hw, "no window of it was opened") }
                // The freeze over (the watchdog) with its copy still not linked: waited for as with no freeze, the
                // keys the person's again; once it links, the switch freezes again for its window (pickTarget).
                if run.handle != nil, !run.live {
                    note("\(link) not linked by the reveal: waiting for its copy unfrozen")
                    enter(.waitingForProfile, for: options.openedProfileWait - waited)
                }
                return
            }
            let (way, key, number) = pickWindow(run, hw)
            guard way != .create, let key else { return recover(run, hw, "Margin couldn’t find its window") }
            run.openedAt = now
            run.way = way
            run.b = key
            run.bNumber = number
            newWindow = key.windowId
            if let number { dropWatch(number) }
            note("\(link) linked with a window at \(run.ms(now)) ms: \(way.rawValue) \(key)")
            // Its space, which preparing couldn't set with no window to name.
            if hw.activeSpaceId(of: key) != run.target.space {
                hw.request(key.link, "setSpace", ["windowId": key.windowId, "spaceId": run.target.space], windowId: key.windowId) { _, _ in }
            }
            return showB(run, hw)
        }
        guard hw.isLinked(run.target.profile) else { return recover(run, hw, "Safari stopped answering", reveal: .closed) }
        if run.bNumber == nil, let b = run.b { run.bNumber = hw.number(of: b) }
        // A parked target shown by number: on once the binder names it.
        if run.way == .parked, run.b == nil, let n = run.bNumber, let shown = run.shownAt {
            if let key = hw.key(of: n) {
                run.b = key
                newWindow = key.windowId
                note("window \(n) bound to \(key) after its show")
                // Its space, which preparing couldn't set with no id to name it by.
                if hw.activeSpaceId(of: key) != run.target.space {
                    hw.request(key.link, "setSpace", ["windowId": key.windowId, "spaceId": run.target.space], windowId: key.windowId) { _, _ in }
                }
                askB(run, hw)
            } else if now - shown >= ho.boundWait {
                return recover(run, hw, "Margin couldn’t find its window")
            }
        }
        // B closed by the person (§1.8).
        if let b = run.b, run.shownAt != nil, bGone(run, hw, b) {
            return recover(run, hw, "its window was closed", reveal: .closed, event: .cancelled(run.target))
        }
        // A closed by the person: on to B, nothing to park.
        if let a = run.a, !run.aGone, aGoneNow(run, hw, a) {
            run.aGone = true
            run.aDone = true
            note("\(a) closed mid-switch: nothing to park")
        }
        // §1.2: under the freeze, the active Space may only be A's, or a full-screen one holding B.
        if run.live || run.coverActive, let reads, let active = (run.aNumber ?? run.bNumber).flatMap({ reads.showing(onDisplayOf: $0) }) ?? reads.activeSpace() {
            let fs = reads.fullScreenSpaces() ?? []
            let holdsB = run.bNumber.flatMap { reads.spaces(of: $0)?.contains(active) } ?? !run.fullScreenAtFreeze.contains(active)
            if active != run.aSpace, !(fs.contains(active) && holdsB) {
                let since = run.foreignSince ?? now
                run.foreignSince = since
                if now - since >= ho.foreignFor - 1e-9 {
                    if run.coverActive { endLiveCover(run, hw, .aborted) }
                    recover(run, hw, "aborted: the active Space moved to \(active)", reveal: .aborted)
                    // A swipe or Mission Control: the person's, so B landing after it is no late landing.
                    // Marked after recovery made its watches (the clock moves while it reveals), so no
                    // watch's `since` is later than it.
                    session.personAt = clock.now()
                    return
                }
            } else {
                run.foreignSince = nil
            }
        }
        // Deadlines (§1.4): the create's answer, then the settle timeout from the freeze (or the answer).
        if run.way == .create, run.createdAt == nil {
            if now - (run.createAskedAt ?? now) >= options.createTimeout { return recover(run, hw, "Safari took too long to open its window") }
        } else if now - (run.createdAt ?? run.openedAt ?? run.stepsAt ?? run.freezeAt ?? now) >= options.settleTimeout {
            if run.coverActive {
                note("live cover readiness timeout: R1 \(run.ms(run.r1At)), R2 \(run.ms(run.r2At)), R3 \(run.ms(run.r3At)), framed \(run.ms(run.framedAt)), R4 \(run.ms(run.r4At)), R5 \(run.ms(run.r5At)); A done \(run.aDone), overlay out \(run.aOverlayOut), parked \(run.ms(run.aParkedAt)); selected space matches \(run.b.map { hw.activeSpaceId(of: $0) == run.target.space } ?? false)")
                return recover(run, hw, "live cover readiness/old-window timeout: restoring under cover")
            }
            if run.r2At != nil {
                note("settle timeout with B ready: A's part to the aftercare")
                return enterAfter(run, hw)
            }
            return recover(run, hw, "Safari’s window didn’t go full screen")
        }
        guard let n = run.bNumber, run.b != nil, run.shownAt != nil else { return }
        readB(run, hw, n, now)
        retryIfStuck(run, hw, n, now)
        guard run.r2At != nil else { return }
        // A fullscreen Space existing and being active does not establish that
        // B is the front browser window. Never dismantle A behind a live cover
        // until that independent identity check also holds.
        if run.coverActive, let b = run.b, !bInFront(run, hw, b) {
            if run.checkTries == 0 {
                run.checkTries = 1
                windowCall(hw, b, .focusWindow(windowId: b.windowId, fullscreen: true, notAfter: msNow(options.frontCheck))) { _, _ in }
            }
            return
        }
        aSteps(run, hw, now)
        guard r3(run, now), r4(run, hw, now), r5(run, hw, now) else { return }
        if run.coverActive {
            guard let b = run.b else { return }
            // A browser-tab echo can precede its selected-space storage echo.
            // Keep the live cover until the cached sidebar selection agrees.
            guard hw.activeSpaceId(of: b) == run.target.space else { return }
            guard bInFront(run, hw, b), hw.overlayAbove(b) else {
                if run.checkTries == 0 {
                    run.checkTries = 1
                    windowCall(hw, b, .focusWindow(windowId: b.windowId, fullscreen: true, notAfter: msNow(options.frontCheck))) { _, _ in }
                }
                return
            }
            endLiveCover(run, hw, .ready)
        }
        reveal(run, hw, .ready)
        enterAfter(run, hw)
    }

    private func bGone(_ run: HandoffRun, _ hw: HandoffWorld, _ b: WindowKey) -> Bool {
        let listed = hw.copyWindows(b.link).contains { $0.key == b }
        let server = run.bNumber.flatMap { hw.spaceReads?.window($0) }
        // A made window may not be in its copy's list yet; the window server says first.
        if run.way == .create, let made = run.createdAt, clock.now() - made < 1 { return false }
        return !listed && server == nil
    }

    private func aGoneNow(_ run: HandoffRun, _ hw: HandoffWorld, _ a: WindowKey) -> Bool {
        guard hw.isLinked(a.link) else { return run.aNumber.map { hw.spaceReads?.window($0) == nil } ?? true }
        return !hw.copyWindows(a.link).contains { $0.key == a } && run.aNumber.map { hw.spaceReads?.window($0) == nil } ?? true
    }

    // R1, R2, and R3's probe once R1 holds.
    private func readB(_ run: HandoffRun, _ hw: HandoffWorld, _ n: Int, _ now: Double) {
        guard let b = run.b else { return }
        let reads = hw.spaceReads
        let r1: Bool
        if let reads, let active = reads.showing(onDisplayOf: n), let spaces = reads.spaces(of: n), let fs = reads.fullScreenSpaces() {
            r1 = active != run.aSpace && spaces.contains(active) && fs.contains(active)
        } else {
            // No Space reads: today's public check (§3.2).
            r1 = hw.copyWindows(b.link).first { $0.key == b }?.state == "fullscreen" && hw.inFront(b.link, windowId: b.windowId)
        }
        if r1, run.r1At == nil {
            run.r1At = now
            if ho.frameProbe { probe(run, hw, b, n) }
        }
        if let w = reads?.window(n), hw.fillsDisplay(w.bounds) {
            run.steady = w.bounds == run.lastBounds ? run.steady + 1 : 1
            run.lastBounds = w.bounds
        } else {
            run.steady = 0
            run.lastBounds = nil
        }
        if r1, run.steady >= ho.steadyPolls, run.r2At == nil {
            run.r2At = now
            handOver(run, hw) // (a window made by the switch: B known only now)
        }
    }

    // The same sidebar through the switch (2026-11-07): as the freeze starts (A's sidebar showing the switch's
    // cover and the target space, B not shown yet), A's sidebar is handed to B, and the shell shows it over B once B is
    // in place; B's own (if any) is A's now, and goes out with A's (outA). Once per switch, only under a freeze (the
    // hand-over would be seen otherwise); B not known yet (a window the switch makes): at R2.
    private func handOver(_ run: HandoffRun, _ hw: HandoffWorld) {
        guard run.live || run.coverActive, !run.handedOver, let a = run.a, let b = run.b, a != b else { return }
        run.handedOver = true
        if hw.handOverOverlay(from: a, to: b) { note("A's sidebar handed to \(b)") }
    }

    private func probe(_ run: HandoffRun, _ hw: HandoffWorld, _ b: WindowKey, _ n: Int) {
        guard !run.probeAsked else { return }
        run.probeAsked = true
        let size = hw.spaceReads?.window(n)?.bounds.size ?? .zero
        let req = HandoffRequest.frameProbe(windowId: b.windowId, width: Double(size.width), height: Double(size.height))
        hw.request(b.link, req.type, req.payload, windowId: b.windowId) { [weak run] result, error in
            run?.probe = result.flatMap { FrameProbeAnswer($0) } ?? .none(why: error ?? "no answer")
        }
    }

    // §3.4: a second full-screen request only behind Options.fullScreenRetry (gate G4), and only on
    // positive evidence that the first never took: still normal 400 ms on, its bounds and Spaces as at
    // the show, and no new full-screen Space.
    private func retryIfStuck(_ run: HandoffRun, _ hw: HandoffWorld, _ n: Int, _ now: Double) {
        guard ho.fullScreenRetry, !run.retried, run.r1At == nil, let b = run.b, let asked = run.stateAskedAt, now - asked >= ho.retryAfter,
              let reads = hw.spaceReads else { return }
        let state = hw.copyWindows(b.link).first { $0.key == b }?.state
        let fs = reads.fullScreenSpaces() ?? []
        guard state == "normal", reads.window(n)?.bounds == run.boundsAtShow, reads.spaces(of: n) == run.spacesAtShow,
              fs.subtracting(run.fullScreenAtFreeze).isEmpty else { return }
        run.retried = true
        note("window \(n) still normal \(Int(((now - asked) * 1000).rounded())) ms after its request, nothing moved: asked once more")
        let notAfter = ((run.freezeAt ?? now) + ho.bNotAfter) * 1000
        windowCall(hw, b, .setWindowState(windowId: b.windowId, state: .fullscreen, focused: true, notAfter: notAfter)) { _, _ in }
    }

    private func r3(_ run: HandoffRun, _ now: Double) -> Bool {
        if run.r3At != nil { return true }
        guard ho.frameProbe else { run.r3At = now; return true }
        if let p = run.probe {
            run.r3At = now
            if case .frames(let f) = p { note("page frames at \(run.ms(now)) ms (\(f.frames), tab \(f.tabId))") } else { note("no page frames (\(p))") }
            return true
        }
        guard let r2 = run.r2At, now - r2 >= ho.probeWait else { return false }
        run.r3At = now
        note("no page frames in \(Int(ho.probeWait * 1000)) ms")
        return true
    }

    private func r4(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) -> Bool {
        if run.r4At != nil { return true }
        if run.framedAt != nil, let b = run.b, hw.overlayAbove(b) { run.r4At = now; return true }
        if run.coverActive { return false } // a live cover cannot reveal an unframed destination
        guard let r2 = run.r2At, now - r2 >= ho.framedWait else { return false }
        run.r4At = now
        note("B's overlay not framed in \(Int(ho.framedWait * 1000)) ms")
        return true
    }

    // §1.3 steps 5-7: A to normal from R1+R2 (its overlay out first), parked once it's normal and out
    // of its Space. In keep and close modes A isn't touched here.
    private func aSteps(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        guard let a = run.a, let n = run.aNumber, !run.aGone, !run.aDone else { return }
        // A window the aftercare watches is its to park, not this switch's (two parks of one window would
        // race). A switch drops its windows' watches as it starts, so this is only ever belt and braces.
        if session.watches.contains(where: { $0.number == n }) { return }
        if run.aAskedAt == nil, !hw.isLinked(a.link) {
            // §1.8: A's copy gone after B is ready: it stays in its full-screen Space; parked once it's back.
            run.aKept = "its copy isn't linked"
            run.aDone = true
            outA(run, hw, a)
            addWatch(AftercareWatch(key: a, number: n, kind: .leaveFullScreen, since: now, until: now + ho.aftercareFor, runs: session.runs, cause: .aftercare))
            return note("\(a)'s copy is gone: kept in its full-screen Space")
        }
        if run.choice.old == .park, session.parkOff != nil, run.aAskedAt == nil {
            run.choice.old = .close
            run.choice.why = "parking off this session"
            note("parking turned off mid-switch: \(a) closed instead, drafts permitting")
        }
        switch run.choice.old {
        case .keep, .close:
            outA(run, hw, a)
            if run.coverActive, run.choice.old == .close {
                guard run.drafts != nil || now - run.startedAt >= ho.draftsWait else { return }
                closeOrKeepA(run, hw, a)
            }
            if run.choice.old == .keep, !run.aDone {
                run.aKept = run.choice.why ?? "kept"
                run.aDone = true
            }
            return
        case .park:
            break
        }
        if run.aAskedAt == nil {
            if run.aDeferred { return }
            if run.live, let freezeAt = run.freezeAt, now - freezeAt > ho.latestAStart + 1e-9 {
                run.aDeferred = true
                return note("B steady at \(run.ms(run.r2At)) ms: A not touched under this freeze")
            }
            askA(run, hw, a)
            return
        }
        guard run.aKept == nil else { return }
        let reads = hw.spaceReads
        let server = reads?.window(n)
        if run.aLeftAt == nil {
            let spaces = reads?.spaces(of: n)
            let filled = server.map { hw.fillsDisplay($0.bounds) } ?? false
            let inOld = run.aSpace.map { spaces?.contains($0) ?? true } ?? false
            if !filled, !inOld { run.aLeftAt = now }
        }
        guard run.aLeftAt != nil, !run.aParkAsked else { return }
        let copyNormal: Bool = {
            if case .landed(_, "normal", _)? = run.aAnswer { return true }
            return hw.copyWindows(a.link).first { $0.key == a }?.state == "normal"
        }()
        guard copyNormal, let server, let parking = hw.parking else { return }
        run.aParkAsked = true
        // DEV-HOOK: a park that didn't land, with no call made: A stays a normal window where it is (§4.4).
        if devFault(run, .park) {
            let o = ParkOutcome(number: n, step: .park, failure: .notLanded(spaces: reads?.spaces(of: n), onScreen: server.onScreen), ms: 0, tries: 0, space: nil)
            return aParkFailed(run, hw, a, n, ParkingRegistry.ParkResult(park: o))
        }
        parking.park(number: n, link: a.link, windowId: a.windowId, pid: server.pid, bounds: server.bounds, cause: .handoff) { [weak self, weak run] r in
            guard let self, let run, self.run === run else { return }
            if r.park.ok {
                run.aParkedAt = self.clock.now()
                run.aDone = true
                return
            }
            self.aParkFailed(run, hw, a, n, r)
        }
    }

    private func outA(_ run: HandoffRun, _ hw: HandoffWorld, _ a: WindowKey) {
        guard !run.aOverlayOut else { return }
        run.aOverlayOut = true
        hw.orderOutOverlay(a)
    }

    private func askA(_ run: HandoffRun, _ hw: HandoffWorld, _ a: WindowKey) {
        outA(run, hw, a)
        run.aAskedAt = clock.now()
        let notAfter = ((run.freezeAt ?? clock.now()) + options.settleTimeout) * 1000
        windowCall(hw, a, .setWindowState(windowId: a.windowId, state: .normal, notAfter: notAfter)) { [weak self, weak run] answer, error in
            guard let self, let run else { return }
            run.aAnswer = answer
            switch answer {
            case .busy?, .refused?, nil:
                // Nothing done: A stays in its full-screen Space (§1.9 logs it).
                guard self.run === run, !run.aDone else { return }
                run.aKept = answer == nil ? "no answer (\(error ?? "-"))" : "\(answer!)"
                run.aDone = true
            case .timedOut?:
                // Safari may still carry it out. While the run owns A, its steps park A as it lands and its
                // `after` hands A to the aftercare; a run already over hands it on now. A recovered run
                // never does: A is its shown window again.
                guard let n = run.aNumber else { return }
                self.note("\(a)'s normal timed out")
                guard self.run !== run, run.failure == nil, run.choice.old == .park, run.aParkedAt == nil else { return }
                self.addWatch(AftercareWatch(key: a, number: n, kind: .parkWhenNormal, since: self.clock.now(), until: self.clock.now() + self.ho.aftercareFor, runs: self.session.runs, cause: .aftercare))
            default:
                return
            }
        }
    }

    // §4.4 "A's park didn't land": A is a normal window on its Desktop (the registry returned it).
    // Parking is off for the session; A is closed now, drafts permitting, or kept there.
    private func aParkFailed(_ run: HandoffRun, _ hw: HandoffWorld, _ a: WindowKey, _ n: Int, _ r: ParkingRegistry.ParkResult) {
        // Refused before any op went out: a step of the registry's for A is under way (asked again on the
        // next look), or A is gone. Neither is a park that didn't land (the show path's rule, §4.3).
        if !ParkingRegistry.mayHaveMoved(r.park) {
            switch r.park.failure {
            case .busy?:
                guard mayFinishSourceHandling(run) else { return }
                run.aParkAsked = false
                if run.aParkBusy { return }
                run.aParkBusy = true
                return note("\(a)'s park: a step for it is under way: asked again")
            case .gone?:
                guard mayFinishSourceHandling(run) else { return }
                run.aGone = true
                run.aDone = true
                return note("\(a) gone as it was parked: nothing to park")
            default:
                break
            }
        }
        run.aParkFailed = true
        demotePark("window \(n)'s park didn't land in \(r.park.ms) ms (\(ParkSelfTest.describe(r.park.failure)))")
        // A real sent failure still demotes parking, even if recovery has taken
        // ownership of A. Its old close fallback must not act on restored A.
        guard mayFinishSourceHandling(run) else { return }
        closeOrKeepA(run, hw, a)
    }

    private func r5(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) -> Bool {
        if run.r5At != nil { return true }
        if run.coverActive, let a = run.a, let n = run.aNumber, !run.aGone {
            guard run.aDone, hw.overlayOffScreen(a) else { return false }
            if run.aClosedAt != nil {
                guard hw.spaceReads?.window(n) == nil, !hw.copyWindows(a.link).contains(where: { $0.key == a }) else { return false }
            } else if run.aParkedAt != nil {
                guard hw.spaceReads?.readsParked(n) == true else { return false }
            } else if run.aKept != nil {
                guard hw.spaceReads?.window(n)?.onScreen == false else { return false }
            } else { return false }
        }
        let holds: Bool = {
            guard let a = run.a, let n = run.aNumber, !run.aGone else { return true }
            if run.aDeferred || run.aParkFailed { return true }
            let reads = hw.spaceReads
            // Untouched in its full-screen Space: keep, close's first freeze, a busy A, its copy gone.
            if run.choice.old != .park || run.aKept != nil {
                return reads?.showing(onDisplayOf: n) != run.aSpace && hw.overlayOffScreen(a)
            }
            guard run.aParkedAt != nil, let left = run.aLeftAt else { return false }
            return reads?.readsParked(n) != false && hw.overlayOffScreen(a) && now - left >= ho.settleAfterExit - 1e-9
        }()
        guard holds else { return false }
        run.r5At = now
        leftBehind(run, hw)
        return true
    }

    // §1.10 after the park: a Safari window still on screen over A's bounds, other than B and its toolbar.
    private func leftBehind(_ run: HandoffRun, _ hw: HandoffWorld) {
        guard let a = run.a, let bn = run.bNumber, let bounds = run.boundsAtShow ?? run.lastBounds else { return }
        let list = hw.browserWindows(of: a.link)
        let toolbar = list.first { $0.number == bn }.flatMap { WindowMatcher.fullScreenToolbar(list, browser: $0)?.number }
        let left = list.filter { $0.number != bn && $0.number != toolbar && $0.number != run.aNumber && $0.layer == 0 && $0.onScreen && hw.key(of: $0.number) == nil
            && !(hw.parking?.isParked($0.number) ?? false) && $0.bounds.intersects(bounds) && $0.bounds.width < bounds.width }
        if !left.isEmpty {
            run.leftBehind = left.count
            note("A's dialog window left behind (\(left.count))")
        }
    }

    private func reveal(_ run: HandoffRun, _ hw: HandoffWorld, _ why: RevealWhy) {
        guard run.live else { return }
        run.live = false
        let r = hw.handoffFreezer?.reveal(why)
        switch r {
        case .revealed?: run.revealResult = 0
        case .failed(let result, _)?: run.revealResult = result
        default: break
        }
        if r == .notLive { late(run, clock.now()) } else { run.revealedAt = clock.now() }
        // DEV-HOOK: revealed (the screen is never left held), then counted as a reveal that failed: the
        // freeze off for the session, as FreezeRules has it.
        if r == .revealed, devFault(run, .reveal) {
            let held = run.freezeAt.map { Int(((clock.now() - $0) * 1000).rounded()) } ?? 0
            session.rules.note(.revealFailed(handle: run.handle ?? 0, why: why, result: -1, released: nil, heldMs: held), at: clock.now())
            run.revealResult = -1
        }
    }

    // DEV-HOOK: a fault the dev-only hook armed (DevHooks.swift), used up by a Test A/Test B switch only.
    private func devFault(_ run: HandoffRun, _ step: DevFailStep) -> Bool {
        guard run.devTest, session.dev.take(step) else { return false }
        run.devUsed.append(step.rawValue)
        Diagnostics.note("dev hook: \(step.said)")
        return true
    }

    // ---- after the reveal ----

    private func enterAfter(_ run: HandoffRun, _ hw: HandoffWorld) {
        enter(.after, for: ho.afterFor)
        run.afterAt = clock.now()
        if let b = run.b, let n = run.bNumber ?? hw.number(of: b) {
            run.bNumber = n
            // B is its line's home for its profile, and the window it shows (docs/BROWSER-WINDOWS.md §2.1).
            hw.parking?.noteShown(link: b.link, number: n, line: run.line ?? hw.parking?.lineFor(number: n, link: b.link))
            session.shown = (b, n)
        }
        // B steady too late under the freeze: A's exit and park now, with A's Space not the active one.
        if run.aDeferred, let a = run.a, run.aAskedAt == nil, !run.aGone {
            run.aDeferred = false
            if hw.isLinked(a.link) { askA(run, hw, a) }
        }
        // Close mode: A closed under a second freeze once the focus check is done and the cooldown has
        // passed, drafts permitting (§4.5).
        if run.choice.old == .close, run.a != nil, !run.aGone, !run.aDone, run.aKept == nil { run.closeDue = true }
    }

    // A drafts check before every close (§1.1, §4.5): a draft or no answer keeps it, and the person is
    // told in B's overlay, with a Close window button (§13.4).
    private func mayFinishSourceHandling(_ run: HandoffRun) -> Bool {
        guard self.run === run, run.failure == nil,
              [.frozen, .covered, .after, .landed].contains(phase) else { return false }
        return run.coverStartedAt == nil || phase == .covered
    }

    private func closeOrKeepA(_ run: HandoffRun, _ hw: HandoffWorld, _ a: WindowKey) {
        guard mayFinishSourceHandling(run), !run.aCloseAsked, mayCloseA(run, hw, a) else { return }
        run.aCloseAsked = true
        outA(run, hw, a)
        closeA(run, hw, a, tries: 1)
    }

    // A's drafts allow its close, and its copy can be asked; else A is kept, and the person told.
    private func mayCloseA(_ run: HandoffRun, _ hw: HandoffWorld, _ a: WindowKey) -> Bool {
        if run.drafts?.mayClose == true, hw.isLinked(a.link) { return true }
        run.aKept = !hw.isLinked(a.link) ? "its copy isn't linked" : run.drafts.map { "\($0.drafts.count) with drafts, \($0.unknown.count) unknown" } ?? "no drafts answer"
        run.aDone = true
        outA(run, hw, a)
        note("\(a) kept open: \(run.aKept!)")
        if hw.isLinked(a.link) { notices.append(SwitchNotice(.windowKeptDraft, profile: a.link, shownIn: run.b, kept: a)) }
        return false
    }

    private func closeA(_ run: HandoffRun, _ hw: HandoffWorld, _ a: WindowKey, tries: Int) {
        guard mayFinishSourceHandling(run) else { return }
        windowCall(hw, a, .closeWindow(windowId: a.windowId, notAfter: msNow(options.closeTimeout))) { [weak self, weak run] answer, error in
            guard let self, let run else { return }
            guard self.mayFinishSourceHandling(run) else { return }
            if error == nil, answer?.called != false {
                run.aClosedAt = self.clock.now()
                run.aDone = true
                return
            }
            // §4.4: tried once more after 0.5 s, then A stays where it is.
            guard tries < 2 else {
                self.note("\(a) not closed (\(error ?? "\(answer!)")): it stays")
                run.aKept = "its close failed"
                run.aDone = true
                return
            }
            self.note("\(a)'s close failed (\(error ?? "\(answer!)")): again in \(Int(self.ho.closeRetry * 1000)) ms")
            self.clock.after(self.ho.closeRetry) { [weak self] in self?.closeA(run, hw, a, tries: tries + 1) }
        }
    }

    // ---- close mode's second freeze (§4.5) ----

    // The lab only ever closed A under a freeze of its own after B's reveal, never inside the first:
    // macOS can drop to the Desktop as A's full-screen Space goes. So, at least 300 ms after B's
    // reveal: freeze 2 (its watchdog 1.0 s), closeWindow(A), and hold until A is gone, B's Space is
    // the active one and B is Safari's first window on screen for 120 ms. A Desktop drop gets one
    // focusWindow(B) inside the freeze while there's time for it to land; one still there at the
    // watchdog is today's checking path, seen. Without a freeze, the same steps, seen.
    private func startClose(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        run.closeDue = false
        guard let a = run.a, !run.aCloseAsked, mayCloseA(run, hw, a) else { return }
        run.aCloseAsked = true
        outA(run, hw, a)
        enter(.closing, for: options.closeTimeout)
        closeTry(run, hw, now)
    }

    private func closeTry(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        guard let a = run.a else { return }
        run.closeTries += 1
        run.closeAt = now
        run.closeRetryAt = nil
        run.holdSince = nil
        run.dropFocused = false
        if run.choice.freeze, session.rules.on, session.noFreeze == nil, cooledDown(now), let freezer = hw.handoffFreezer {
            freezer.delegate = self
            switch freezer.freeze(watchdog: ho.closeWatchdog) {
            case .frozen(let handle):
                run.closeHandle = handle
                run.closeLive = true
                run.closeLate = false
            case .failed(let result):
                note("the close's freeze answered \(result): A closed without one")
            case .unavailable(let why):
                note("no freeze for the close: \(why)")
            }
        }
        // Under the freeze, a close that would land after it is refused instead: seen, it could drop
        // to the Desktop with nothing held.
        let notAfter = msNow(run.closeLive ? ho.closeNotAfter : options.closeTimeout)
        let tryNo = run.closeTries
        windowCall(hw, a, .closeWindow(windowId: a.windowId, notAfter: notAfter)) { [weak self, weak run] answer, error in
            guard let self, let run, self.run === run, run.closeTries == tryNo, [.closing, .checking].contains(self.phase) else { return }
            if error == nil, answer?.called != false { return } // its copy closed it: the window server says when it's gone
            self.revealClose(run, hw, .failed)
            let why = error ?? answer.map { "\($0)" } ?? "no answer"
            // §4.4: tried once more after 0.5 s, then A stays where it is.
            guard run.closeTries < 2 else {
                self.note("\(a) not closed (\(why)): it stays")
                run.aKept = "its close failed"
                run.aDone = true
                return self.enterLanded(run, hw)
            }
            self.note("\(a)'s close failed (\(why)): again in \(Int(self.ho.closeRetry * 1000)) ms")
            run.closeRetryAt = self.clock.now() + self.ho.closeRetry
        }
    }

    private func closingStep(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        // The second freeze gone by its watchdog, its report still on its way.
        if run.closeLive, hw.handoffFreezer?.isLive != true { closeWatchdog(run, nil) }
        if let at = run.closeRetryAt {
            if now >= at - 1e-9 { closeTry(run, hw, now) }
            return
        }
        guard let a = run.a, let b = run.b, hw.isLinked(b.link) else {
            revealClose(run, hw, .closed)
            return enterLanded(run, hw)
        }
        // Gone from the window server (its copy's list lags up to a second); with no reads, its copy's word.
        let aThere: Bool
        if let reads = hw.spaceReads, let n = run.aNumber { aThere = reads.window(n) != nil } else { aThere = hw.copyWindows(a.link).contains { $0.key == a } }
        if aThere {
            guard now >= deadline else { return }
            revealClose(run, hw, .failed)
            note("\(a) still there \(Int(options.closeTimeout)) s after its close: it stays")
            run.aKept = "not closed in time"
            run.aDone = true
            return enterLanded(run, hw)
        }
        if run.aClosedAt == nil {
            run.aClosedAt = now
            run.aGone = true
            run.aDone = true
        }
        if bInFront(run, hw, b) {
            let since = run.holdSince ?? now
            run.holdSince = since
            guard now - since >= ho.closeHold - 1e-9 else { return }
            revealClose(run, hw, .ready)
            return enterLanded(run, hw)
        }
        run.holdSince = nil
        run.dropSeen = true
        let into = now - (run.closeAt ?? now)
        // One focusWindow(B), inside the freeze while it has time to land.
        if !run.dropFocused, !run.closeLive || into <= ho.closeFocusBy + 1e-9 {
            run.dropFocused = true
            note("the Desktop showed as \(a) closed: \(b) focused\(run.closeLive ? " inside the close's freeze" : "")")
            windowCall(hw, b, .focusWindow(windowId: b.windowId, fullscreen: true, notAfter: msNow(ho.closeWatchdog))) { _, _ in }
            return
        }
        // Still there at the watchdog (or as long, unfrozen): today's checking path, seen.
        if run.closeLive || into < ho.closeWatchdog - 1e-9 { return }
        note("\(b) not in front \(Int((into * 1000).rounded())) ms after the close: checked, seen")
        enter(.checking, for: options.frontCheck)
    }

    // Today's checking (ProfileSwitch: after the close, the new window in front and still for
    // frontHold, else its copy focuses it again, twice), now that A is gone and the screen is seen.
    private func checkingStep(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        guard let b = run.b else { return enterLanded(run, hw) }
        if !hw.copyWindows(b.link).contains(where: { $0.key == b }), run.bNumber.map({ hw.spaceReads?.window($0) == nil }) ?? true {
            note("\(b) closed after the switch")
            run.endEvent = .cancelled(run.target)
            return enterLanded(run, hw)
        }
        if bInFront(run, hw, b) {
            let since = run.holdSince ?? now
            run.holdSince = since
            if now - since >= options.frontHold - 1e-9 {
                note("\(b) in front\(run.checkTries > 0 ? " after \(run.checkTries) focus" : "")")
                enterLanded(run, hw)
            }
            return
        }
        run.holdSince = nil
        guard now >= deadline else { return }
        guard run.checkTries < options.recoverTries else {
            let why = "macOS didn’t show its window: click it in Mission Control"
            note("\(b) not in front after \(run.checkTries) tries")
            run.failure = why
            run.endEvent = .failed(run.target, why)
            return enterLanded(run, hw)
        }
        run.checkTries += 1
        note("\(b) not in front after the close: focused again (\(run.checkTries))")
        windowCall(hw, b, .focusWindow(windowId: b.windowId, fullscreen: true, notAfter: msNow(options.frontCheck))) { _, _ in }
        enter(.checking, for: options.frontCheck)
    }

    // B in front: its Space the active one (the window server), and Safari's first window on screen.
    private func bInFront(_ run: HandoffRun, _ hw: HandoffWorld, _ b: WindowKey) -> Bool {
        if let reads = hw.spaceReads, let n = run.bNumber ?? hw.number(of: b), let active = reads.showing(onDisplayOf: n) {
            guard reads.spaces(of: n)?.contains(active) == true else { return false }
        }
        return hw.inFront(b.link, windowId: b.windowId)
    }

    private func revealClose(_ run: HandoffRun, _ hw: HandoffWorld, _ why: RevealWhy) {
        guard run.closeLive else { return }
        run.closeLive = false
        let r = hw.handoffFreezer?.reveal(why)
        if r == .notLive { return closeWatchdog(run, nil) }
        run.closeHeldMs = run.closeAt.map { Int(((clock.now() - $0) * 1000).rounded()) }
    }

    // The second freeze revealed by its own watchdog (its report, or found not live).
    private func closeWatchdog(_ run: HandoffRun, _ heldMs: Int?) {
        let wasLive = run.closeLive
        run.closeLive = false
        guard wasLive || run.closeHeldMs == nil else { return }
        run.closeLate = true
        run.closeHeldMs = heldMs ?? run.closeAt.map { Int(((clock.now() - $0) * 1000).rounded()) }
        note("the close's freeze revealed by its watchdog at \(run.closeHeldMs ?? 0) ms")
    }

    // ---- §5: the setting turned on with windows parked ----

    // "Close windows to save memory" turned on (ShellProfiles' switch.closeWindows): each parked
    // window closed by its own copy, drafts permitting. One with a draft, or no answer, stays
    // parked, and the person is told (its notice's Close window closes it). While a switch runs: after
    // it. A close that fails is tried once more after 0.5 s; then the window stays parked.
    func closeParkedWindows() {
        guard let hw = handoffWorld, let parking = hw.parking else { return }
        guard !busy else {
            session.closeParkedAsked = true
            return note("close windows to save memory on mid-switch: the parked windows after it")
        }
        session.closeParkedAsked = false
        let list = parking.entries.values.filter { !$0.stepping }.sorted { $0.number < $1.number }
        guard !list.isEmpty else { return }
        note("close windows to save memory on: \(list.count) parked window\(list.count == 1 ? "" : "s"), their drafts asked")
        for e in list { closeParked(e.number, hw, tries: 1) }
    }

    private func closeParked(_ number: Int, _ hw: HandoffWorld, tries: Int) {
        guard let parking = hw.parking, let e = parking.entries[number], !e.stepping else { return }
        guard let key = e.key, hw.isLinked(key.link) else { return note("window \(number) stays parked: its copy can't be asked") }
        var answered = false
        let decide = { [weak self] (drafts: WindowDrafts?) in
            guard let self, !answered else { return }
            answered = true
            guard drafts?.mayClose == true else {
                self.note("window \(number) (\(key)) stays parked: \(drafts.map { "\($0.drafts.count) with drafts, \($0.unknown.count) unknown" } ?? "no drafts answer")")
                hw.showSwitchNotice(SwitchNotice(.windowKeptDraft, profile: key.link, shownIn: self.session.shown?.key, kept: key))
                return
            }
            parking.close(number: number, cause: .handoff, within: self.options.closeTimeout, close: { [weak self] w, closed in
                guard let self, let k = w.key, hw.isLinked(k.link) else { return false }
                self.windowCall(hw, k, .closeWindow(windowId: k.windowId, notAfter: self.msNow(self.options.closeTimeout))) { answer, error in
                    closed(error == nil && answer?.called != false)
                }
                return true
            }) { [weak self] closed in
                guard let self else { return }
                if closed { return self.note("window \(number) (\(key)) closed: close windows to save memory") }
                guard tries < 2 else { return self.note("window \(number) (\(key)) not closed: it stays parked") }
                self.note("window \(number) (\(key))'s close failed: again in \(Int(self.ho.closeRetry * 1000)) ms")
                self.clock.after(self.ho.closeRetry) { [weak self] in self?.closeParked(number, hw, tries: tries + 1) }
            }
        }
        hw.request(key.link, "windowDrafts", HandoffRequest.windowDrafts(windowId: key.windowId).payload, windowId: key.windowId) { result, _ in
            decide(result.flatMap { WindowDrafts($0) } ?? WindowDrafts(drafts: [], unknown: [-1]))
        }
        clock.after(ho.draftsWait) { decide(nil) }
    }

    private func afterStep(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        closedAfterReveal(run, hw)
        aSteps(run, hw, now)
        // §6.6: B key within 300 ms, else asked once more.
        if !run.focusDone, let b = run.b, let at = run.afterAt, now - at >= ho.focusCheck {
            run.focusDone = true
            let w = hw.copyWindows(b.link).first { $0.key == b }
            var ok = w?.focused == true && (w?.focusedAt ?? -.infinity) >= run.startedAt
            if case .frames(let f)? = run.probe, f.hasFocus { ok = true }
            if ok {
                run.focusLine = "focus ok"
            } else {
                run.focusLine = "focus asked again"
                windowCall(hw, b, .focusWindow(windowId: b.windowId, notAfter: msNow(1.5))) { _, _ in }
            }
        }
        // Close mode (§4.5): the second freeze once B's focus is checked and the cooldown has passed (at
        // most the watchdog's, 1 s, after a watchdog reveal: within this phase).
        if run.closeDue, run.focusDone, !run.aGone {
            if run.choice.freeze, session.rules.on, session.noFreeze == nil, hw.handoffFreezer != nil, !cooledDown(now) { return }
            return startClose(run, hw, now)
        }
        guard (run.aDone || run.a == nil || run.aGone) && run.focusDone || now >= deadline else { return }
        if !run.aDone, let a = run.a, let n = run.aNumber, !run.aGone {
            // Not done in time: A's part is the aftercare's (§1.9).
            note("\(a) not settled in \(Int(ho.afterFor * 1000)) ms: to the aftercare")
            if run.choice.old == .park, run.aAskedAt != nil, run.aParkedAt == nil, !run.aParkAsked {
                addWatch(AftercareWatch(key: a, number: n, kind: .parkWhenNormal, since: now, until: now + ho.aftercareFor, runs: session.runs, cause: .aftercare))
            }
        }
        enterLanded(run, hw)
    }

    // B closed by the person once it was shown (⌘W in `after` or `landed`): the switch ends with it as the
    // shown window, so the shell's §13.8 sees the shown window closed once the switch is idle. A's steps
    // go on (it's parked, then closed with the others); no focus check, no close mode's close, and
    // nothing queued starts from a window that's gone.
    private func closedAfterReveal(_ run: HandoffRun, _ hw: HandoffWorld) {
        guard !run.bClosed, run.failure == nil, run.endEvent == nil, let b = run.b, bGone(run, hw, b) else { return }
        run.bClosed = true
        run.closeDue = false
        run.focusDone = true
        run.endEvent = .cancelled(run.target)
        note("\(b) closed after it was shown")
    }

    private func enterLanded(_ run: HandoffRun, _ hw: HandoffWorld) {
        enter(.landed, for: ho.landedFor)
        run.landedAt = clock.now()
        run.stillSince = run.landedAt
        run.lastSpaces = spacesKey(hw)
    }

    private func spacesKey(_ hw: HandoffWorld) -> [UInt64] {
        guard let reads = hw.spaceReads else { return [] }
        return (reads.fullScreenSpaces() ?? []).sorted() + reads.showingAll()
    }

    // §1.2: landed once no full-screen Space has changed for 150 ms. Only then is the switch idle.
    private func landedStep(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        closedAfterReveal(run, hw)
        let key = spacesKey(hw)
        if key != run.lastSpaces {
            run.lastSpaces = key
            run.stillSince = now
        }
        guard now - (run.stillSince ?? now) >= ho.stillFor - 1e-9 || now >= deadline else { return }
        end(run, hw)
    }

    private func end(_ run: HandoffRun, _ hw: HandoffWorld) {
        if run.bClosed, queued != nil {
            note("\(queued!) dropped: the window it would start from was closed")
            queued = nil
        }
        let event = run.endEvent ?? (run.failure.map { .failed(run.target, $0) } ?? .done(run.target))
        let line = summary(run, hw)
        session.lines = Array((session.lines + [line]).suffix(5))
        Diagnostics.note(line)
        let landed: (profile: String, windowId: Int?)?
        let onB: Bool = { if case .done = event { return true }; return run.aClosedAt != nil }() // A closed: only B is left
        if onB, let b = run.b {
            landed = (b.link, b.windowId)
        } else {
            landed = run.a.map { ($0.link, $0.windowId) } ?? run.b.map { ($0.link, $0.windowId) }
            // A is its line's shown window again, unless B was shown and then closed (it stays the one).
            if let a = run.a, !run.aGone, !run.bClosed {
                session.shown = (a, run.aNumber)
                if let n = run.aNumber, let line = run.line { hw.parking?.noteShown(link: a.link, number: n, line: line) }
            }
        }
        finish(event, run.failure.map { "ended: \($0)" } ?? "done: \(run.b.map(\.description) ?? "-") in front", landed: landed)
    }

    // §8.1: one line per switch, numbers only.
    private func summary(_ run: HandoffRun, _ hw: HandoffWorld) -> String {
        var s = "handoff: \(run.a.map(\.description) ?? "nothing") → \(run.b.map(\.description) ?? run.target.profile) (\(run.choice.old.rawValue)\(run.choice.freeze && run.handle != nil ? "+freeze" : ""), \(run.way.rawValue))"
        if let start = run.coverStartedAt {
            s += ", live cover \(Int(((run.coverEndedAt ?? clock.now()) - start) * 1000)) ms (no freeze)"
            if let ended = run.coverEndedAt { s += ", request to reveal \(Int(((ended - run.startedAt) * 1000).rounded())) ms" }
        }
        if let freezeAt = run.freezeAt, let revealed = run.revealedAt, run.handle != nil {
            s += ", frozen \(Int(((revealed - freezeAt) * 1000).rounded())) ms" + (run.revealResult.map { " (result \($0))" } ?? "")
            if run.coverStartedAt == nil { s += ", request to reveal \(Int(((revealed - run.startedAt) * 1000).rounded())) ms" }
        }
        var parts: [String] = []
        if run.openedAt != nil { parts.append("profile window linked \(run.ms(run.openedAt))") }
        if run.way == .create { parts.append("created \(run.ms(run.createdAt))") } else { parts.append("shown \(run.ms(run.shownAt))") }
        parts.append("B steady \(run.ms(run.r2At))")
        if run.aAskedAt != nil { parts.append("A asked \(run.ms(run.aAskedAt))") }
        if ho.frameProbe {
            var frames = "page frames \(run.ms(run.r3At))"
            if case .frames(let f)? = run.probe { frames += " (\(f.frames), tab \(f.tabId))" } else if run.probe != nil { frames += " (none)" }
            parts.append(frames)
        }
        parts.append("overlay framed \(run.framedAt == nil ? "-" : run.ms(run.framedAt))")
        if run.aLeftAt != nil { parts.append("A normal \(run.ms(run.aLeftAt))") }
        if run.aParkedAt != nil { parts.append("A parked \(run.ms(run.aParkedAt))") }
        if run.aClosedAt != nil { parts.append("A closed \(run.ms(run.aClosedAt))") }
        if run.closeTries > 0 {
            var close = "close \(run.closeHeldMs.map { "frozen \($0) ms" } ?? "unfrozen")"
            if run.closeLate { close += " (watchdog)" }
            if run.closeTries > 1 { close += ", \(run.closeTries) tries" }
            if run.dropSeen { close += ", Desktop drop" + (run.dropFocused ? ", B focused" : "") + (run.checkTries > 0 ? ", checked \(run.checkTries)" : "") }
            parts.append(close)
        }
        if let kept = run.aKept { parts.append("A kept (\(kept))") }
        parts.append("settled \(run.ms(run.r5At))")
        s += ": " + parts.joined(separator: ", ")
        if !run.focusLine.isEmpty { s += "; \(run.focusLine)" }
        if let at = run.lateAt { s += "; late (watchdog at \(run.ms(at)) ms\(run.lateWaiting.map { ", waiting for \($0)" } ?? ""))" }
        if let why = run.failure { s += "; recovered: \(why)" }
        if run.leftBehind > 0 { s += "; \(run.leftBehind) window left over A" }
        if !run.devUsed.isEmpty { s += "; dev hook: \(run.devUsed.joined(separator: ", "))" } // DEV-HOOK
        // Its failure's words can carry a copy's (an error from Safari): never a page's address or title.
        return Diagnostics.scrub(s)
    }

    // ---- recovery (§4.4) ----

    // Revealed at once; A back full screen and focused (shown first if it was parked); B set normal and
    // parked again once it's normal, or closed if this switch made it. With A gone, B stays where it is:
    // a switch never ends with nothing in front.
    func recover(_ run: HandoffRun, _ hw: HandoffWorld, _ why: String, reveal revealWhy: RevealWhy = .failed, event: Event? = nil) {
        guard self.run === run, phase != .recovering else { return }
        note("recovered: \(why)")
        reveal(run, hw, revealWhy)
        if run.coverActive { hw.handoffCover?.recovering() }
        run.failure = why
        run.endEvent = event ?? .failed(run.target, why)
        enter(.recovering, for: options.settleTimeout)
        let now = clock.now()
        let reads = hw.spaceReads
        if run.way == .parked, run.showAsked, let n = run.bNumber { returnUnshownB(n, hw) }
        var aBack = false
        if let a = run.a, let n = run.aNumber, !run.aGone, reads?.window(n) != nil || hw.copyWindows(a.link).contains(where: { $0.key == a }) {
            // Recovery owns the source again. An earlier leave/park watch must
            // not take it back out of full screen when its copy reconnects.
            dropWatch(n)
            aBack = hw.isLinked(a.link) || run.aAskedAt == nil
            if run.aParkAsked, hw.parking != nil {
                // Parked (or on its way): shown again first, then full screen.
                run.restore = .showThenFullScreen
            } else if run.aAskedAt != nil || run.stateAskedAt != nil || run.shownAt != nil {
                // Asked normal, or B may have taken the front: full screen and focused again.
                run.restore = .fullScreen
            }
            restoreA(run, hw)
        }
        guard let b = run.b ?? run.bNumber.flatMap({ hw.key(of: $0) }) else {
            if run.way == .parked, let n = run.bNumber, run.shownAt != nil, aBack {
                // Its profile kept with it: parked again with no id, it's rebound like any of a new copy's (§2.2).
                addWatch(AftercareWatch(key: nil, number: n, kind: .parkWhenNormal, since: now, until: now + ho.aftercareFor, runs: session.runs, cause: .recovery, link: run.target.profile))
            }
            return
        }
        guard aBack else { return note("\(b) left where it is: nothing else to show") }
        let n = run.bNumber ?? hw.number(of: b)
        if run.way == .create {
            // Today's undo: the window made for it closed.
            if hw.isLinked(b.link) {
                windowCall(hw, b, .closeWindow(windowId: b.windowId, notAfter: msNow(options.closeTimeout)), cause: .recovery) { _, _ in }
            }
            return
        }
        guard run.shownAt != nil || run.stateAskedAt != nil, let n else { return }
        var watch = AftercareWatch(key: b, number: n, kind: .parkWhenNormal, since: now, until: now + ho.aftercareFor, runs: session.runs, cause: .recovery)
        if run.stateAskedAt != nil {
            watch.landsLate = true
            if hw.isLinked(b.link) {
                watch.normalAsked = true
                windowCall(hw, b, .setWindowState(windowId: b.windowId, state: .normal, notAfter: msNow(options.settleTimeout)), cause: .recovery) { [weak self] answer, _ in
                    guard let self, answer?.called != true, let i = self.session.watches.firstIndex(where: { $0.number == n }) else { return }
                    self.session.watches[i].normalTook = false
                }
            }
        }
        addWatch(watch)
    }

    // A back, once its own windows call has answered (a second one would only be `busy`) and its park,
    // if one is under way, is over.
    private func restoreA(_ run: HandoffRun, _ hw: HandoffWorld) {
        guard run.restoring, !run.restoreSent, let a = run.a, let n = run.aNumber, hw.isLinked(a.link) || run.restore == .showThenFullScreen,
              session.pending[a] == nil else { return }
        let full = { [weak self] in
            guard let self, hw.isLinked(a.link) else { return }
            self.windowCall(hw, a, .setWindowState(windowId: a.windowId, state: .fullscreen, focused: true, notAfter: self.msNow(self.options.settleTimeout)), cause: .recovery) { _, _ in }
        }
        switch run.restore {
        case .none:
            return
        case .fullScreen:
            run.restoreSent = true
            full()
        case .showThenFullScreen:
            guard let parking = hw.parking, parking.entries[n]?.stepping != true else { return }
            run.restoreSent = true
            parking.show(number: n, cause: .recovery) { [weak self] o in
                if !o.ok, o.failure != .gone { self?.note("\(a) wasn't shown again (\(ParkSelfTest.describe(o.failure)))") }
                full()
            }
        }
    }

    // Recovering until A is back in front (full screen in the active Space), or the settle timeout.
    private func recoverStep(_ run: HandoffRun, _ hw: HandoffWorld, _ now: Double) {
        restoreA(run, hw)
        let back: Bool = {
            guard run.restoring, let a = run.a, let n = run.aNumber else { return true }
            guard let reads = hw.spaceReads, let active = reads.showing(onDisplayOf: n) else { return true }
            let full = hw.copyWindows(a.link).first { $0.key == a }?.state == "fullscreen"
            return full && reads.spaces(of: n)?.contains(active) == true && (reads.fullScreenSpaces()?.contains(active) ?? false)
        }()
        let liveReady: Bool = {
            guard run.coverActive, let a = run.a, !run.aGone else { return true }
            return back && hw.inFront(a.link, windowId: a.windowId) && hw.overlayAbove(a)
        }()
        guard back && liveReady || now >= deadline else { return }
        if !back { note("\(run.a.map(\.description) ?? "-") not back in full screen in \(Int(options.settleTimeout)) s") }
        if run.coverActive {
            if !liveReady { session.coverOff = "recovery readiness timeout"; note("live cover recovery readiness timed out: degraded reveal") }
            endLiveCover(run, hw, .failed)
        }
        enterLanded(run, hw)
    }

    // ---- the aftercare (§1.9) ----

    func addWatch(_ watch: AftercareWatch) {
        session.watches.removeAll { $0.number == watch.number }
        session.watches.append(watch)
    }

    // A window a switch takes as its A or B is that switch's from then on.
    private func dropWatch(_ number: Int) { session.watches.removeAll { $0.number == number } }

    func aftercare() {
        if session.closeParkedAsked, !busy { closeParkedWindows() }
        guard let hw = handoffWorld, !session.watches.isEmpty else { return }
        let now = clock.now()
        // A later switch that takes a window drops its watch as it does (dropWatch); a switch's own
        // recovery watches its windows while it's still landing.
        session.watches.removeAll { now >= $0.until }
        for watch in session.watches {
            guard let i = session.watches.firstIndex(where: { $0.number == watch.number }) else { continue }
            var w = watch
            let key = w.key ?? hw.key(of: w.number)
            let mine = key.flatMap { k in hw.copyWindows(k.link).first { $0.key == k } }
            let server = hw.spaceReads?.window(w.number)
            if server == nil, mine == nil, key.map({ hw.isLinked($0.link) }) ?? true {
                session.watches.remove(at: i)
                continue // gone
            }
            switch w.kind {
            case .leaveFullScreen:
                // §1.8: A's copy is back: normal first, then parked.
                guard let key, hw.isLinked(key.link) else { continue }
                note("aftercare: \(key)'s copy is back: set normal, then parked")
                w.kind = .parkWhenNormal
                w.normalAsked = true
                session.watches[i] = w
                windowCall(hw, key, .setWindowState(windowId: key.windowId, state: .normal, notAfter: msNow(options.settleTimeout)), cause: .aftercare) { _, _ in }
            case .parkWhenNormal:
                let full = mine.map { $0.state == "fullscreen" } ?? false
                if !full, mine != nil { w.sawNotFull = true }
                if full, w.landsLate, w.sawNotFull || !w.normalTook {
                    session.watches.remove(at: i)
                    lateLanding(w, key, hw, now)
                    continue
                }
                let normal = mine.map { $0.state == "normal" } ?? server.map { !hw.fillsDisplay($0.bounds) } ?? false
                session.watches[i] = w
                guard normal, !w.parked, let server, hw.parkingOn, session.parkOff == nil, let parking = hw.parking else { continue }
                if w.landsLate {
                    session.watches[i].parked = true
                } else {
                    session.watches.remove(at: i)
                }
                guard let link = key?.link ?? w.link else {
                    note("aftercare: window \(w.number) normal, but its profile isn't known: left as it is")
                    continue
                }
                note("aftercare: window \(w.number) normal: parked again")
                parking.park(number: w.number, link: link, windowId: key?.windowId, pid: server.pid, bounds: server.bounds, cause: w.cause)
            }
        }
    }

    // The window shown in the line of window `number` (docs/BROWSER-WINDOWS.md §2.2), with its key.
    private func lineShown(of number: Int, _ hw: HandoffWorld) -> (key: WindowKey, number: Int?)? {
        guard let parking = hw.parking, let n = parking.shown(in: parking.line(of: number)), let key = hw.key(of: n) else { return nil }
        return (key, n)
    }

    // §1.9: a parked window that went full screen after its switch gave up. With no switch since and
    // nothing done by the person, it's adopted: the window shown before set normal and parked in the
    // background, and the person told. Otherwise it's set normal and parked again.
    private func lateLanding(_ w: AftercareWatch, _ key: WindowKey?, _ hw: HandoffWorld, _ now: Double) {
        guard let key else { return }
        let seconds = String(format: "%.1f", now - w.since)
        let quiet = !busy && session.runs == w.runs && session.personAt < w.since
        // Its focus as it landed is Margin's request's, not the person's (§2.6).
        hw.parking?.noteCall(w.number, cause: .aftercare)
        guard quiet else {
            note("aftercare: window \(w.number) went full screen \(seconds) s after the switch gave up, something happened since: parked again")
            // Still in the registry: its sweep parks it again once it's normal (a system return).
            if hw.parking?.isParked(w.number) != true {
                var again = AftercareWatch(key: key, number: w.number, kind: .parkWhenNormal, since: now, until: now + ho.aftercareFor, runs: session.runs, cause: .aftercare)
                again.normalAsked = true
                addWatch(again)
            }
            windowCall(hw, key, .setWindowState(windowId: key.windowId, state: .normal, notAfter: msNow(options.settleTimeout)), cause: .aftercare) { _, _ in }
            // It took the front as it landed: its line's shown window back in front.
            if let shown = lineShown(of: w.number, hw), shown.key != key, hw.isLinked(shown.key.link), shown.number.map({ hw.parking?.isParked($0) != true }) ?? true {
                windowCall(hw, shown.key, .setWindowState(windowId: shown.key.windowId, state: .fullscreen, focused: true, notAfter: msNow(options.settleTimeout)), cause: .aftercare) { _, _ in }
            }
            return
        }
        note("aftercare: window \(w.number) went full screen \(seconds) s after the switch gave up: late landing")
        // Parked again meanwhile: out of the registry by Margin's own show into the Space it's in now.
        if hw.parking?.isParked(w.number) == true { hw.parking?.show(number: w.number, cause: .aftercare) }
        // The window its line showed before: set normal and parked (or closed). Another line's is left as it is.
        let before = lineShown(of: w.number, hw)
        let line = hw.parking?.line(of: w.number) ?? hw.parking?.lineFor(number: w.number, link: key.link)
        hw.parking?.noteShown(link: key.link, number: w.number, line: line)
        session.shown = (key, w.number)
        hw.showSwitchNotice(SwitchNotice(.lateLanding, profile: key.link, shownIn: key))
        guard let before, before.key != key, hw.isLinked(before.key.link), let n = before.number else { return }
        if hw.parking?.isParked(n) == true { return } // one parked already: as it is
        hw.orderOutOverlay(before.key)
        if hw.parkingOn, session.parkOff == nil, !hw.closesWindows(before.key.link) {
            var park = AftercareWatch(key: before.key, number: n, kind: .parkWhenNormal, since: now, until: now + ho.aftercareFor, runs: session.runs, cause: .aftercare)
            park.normalAsked = true
            addWatch(park)
            windowCall(hw, before.key, .setWindowState(windowId: before.key.windowId, state: .normal, notAfter: msNow(options.settleTimeout)), cause: .aftercare) { _, _ in }
        } else if hw.closesWindows(before.key.link) {
            // Close mode: closed by its copy, drafts permitting (§4.5); a draft keeps it in its own
            // full-screen Space, and the person is told.
            let old = before.key
            hw.request(old.link, "windowDrafts", HandoffRequest.windowDrafts(windowId: old.windowId).payload, windowId: old.windowId) { [weak self] result, _ in
                guard let self, hw.isLinked(old.link) else { return }
                guard let drafts = result.flatMap({ WindowDrafts($0) }), drafts.mayClose else {
                    self.note("aftercare: \(old) kept open: \(result.flatMap { WindowDrafts($0) }.map { "\($0.drafts.count) with drafts, \($0.unknown.count) unknown" } ?? "no drafts answer")")
                    return hw.showSwitchNotice(SwitchNotice(.windowKeptDraft, profile: old.link, shownIn: key, kept: old))
                }
                self.note("aftercare: \(old) closed: close windows to save memory")
                self.windowCall(hw, old, .closeWindow(windowId: old.windowId, notAfter: self.msNow(self.options.closeTimeout)), cause: .aftercare) { _, _ in }
            }
        } else {
            // Parking off: it stays in its own full-screen Space, as `keep` leaves a window.
            note("aftercare: \(before.key) kept in its full-screen Space (parking off)")
        }
    }

    // ---- the windows calls ----

    // Every windows call the machine makes: kept pending until it's answered (§1.7), marked in the
    // registry as Margin's (§2.6), and its answer read as a WindowCallAnswer.
    func windowCall(_ hw: HandoffWorld, _ key: WindowKey, _ req: HandoffRequest, cause: Cause = .handoff, done: @escaping (WindowCallAnswer?, String?) -> Void) {
        session.token += 1
        let token = session.token
        session.pending[key] = (req.type, token, clock.now())
        if let n = hw.number(of: key) { hw.parking?.noteCall(n, cause: cause) }
        hw.request(key.link, req.type, req.payload, windowId: key.windowId) { [weak self] result, error in
            guard let self else { return }
            if self.session.pending[key]?.token == token { self.session.pending[key] = nil }
            let answer = result.map { WindowCallAnswer($0) }
            switch answer {
            case .busy?: self.note("\(req.type) \(key): busy (a call before it is still pending)")
            case .refused(let why, let past)?: self.note("\(req.type) \(key): refused, \(why)\(past.map { ", \(Int($0)) ms past notAfter" } ?? "")")
            default: break
            }
            done(answer, error)
        }
    }

    private func msNow(_ plus: Double) -> Double { (clock.now() + plus) * 1000 }

    // §1.1: parking off for the session, one line.
    private func demotePark(_ why: String) {
        guard session.parkOff == nil else { return }
        session.parkOff = why
        Diagnostics.note("private calls: park off for this session: \(why)")
    }
}
