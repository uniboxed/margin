// The first click in another pane goes through (decided by Tirth 2026-11-21; DECISIONS.md "The first click in another
// pane goes through", the click-through lab's numbers there).
//
// In a split each pane is a hosted window of its own (a Safari pane its own Safari window, an app's pane that app's
// window) under Margin's window, which lets the pointer through holes over them. A press on a pane whose window isn't
// the key one only made it key: WebKit refuses the first mouse (WebViewImpl::acceptsFirstMouse is NO but for a
// selection drag), and so do AppKit's text views; a link in the other pane took two clicks.
//
// Now, while two or more hosted windows are visible in a Margin window on the current Space, an event tap on left
// presses (Accessibility, which Margin has; no keyboard tap, so no Input Monitoring) holds a press that lands in a pane
// whose window doesn't have the keys, makes that window key through Accessibility (HostSystem.swift `AXPaneFocus`: its
// app made the front app when it's another, the window its app's main one and raised; never a click), and lets the
// press go on once it is. The lab: every kind of click delivered once (a link, Shift+click, a button, a text field, a
// double-click with its dblclick, a drag-select, across apps both ways), 6-13 ms within one app, 25-80 ms across apps,
// about 60 ms the first time.
//
// The press is held IN the callback (the lab's variant c'), not swallowed and posted again (its variant c): the event
// stream waits meanwhile, so every event keeps its order (a key typed right after the click reaches the pane clicked;
// a re-post lets keys, scrolls and a trackpad's pressure overtake the held press), only presses come through the tap
// (a re-post needs every drag and release too, a round trip each for every drag while a split is up), and nothing is
// copied or posted. All input waits while it focuses, so the wait is capped (`cap`, 120 ms; the lab's slowest was 80):
// not key by then, the press goes on as before (it only focuses; the pane is focused the usual way after).
//
// Left alone, as before: Margin's own UI over the page (its hits: a divider, a stacked pane's band, the card's bar, a
// menu, the palette; the dim around a card; PassThrough.pageGets), the pane that has the keys, ⌘- and ⌃-clicks (Safari
// takes those in a window without the keys already), a press with another button held, a press while a field of
// Margin's has the keys, and a press on any other window over the pane (a menu, a popup, a sheet, the Dock, a banner:
// the window server's list read for that press only). Drags, releases, moves and scrolls never reach the tap.
//
// All panes active (PanesActive.swift): the split's panes of other apps are kept active by records, so AppKit in them
// takes itself for the active app (Accessibility's AXFrontmost reads true, its pane's window focused) while the window
// server's front process, which has the keyboard, is another. A press on such a pane is still a change of the front
// app: never "key already" unless that app is the window server's front one too (`frontProcess`), and that app is made
// the front one by the window server (`makeFront`: AppKit's own activation, which AXFrontmost asks for, may be taken
// for done), its window then made main and raised by Accessibility as before. The keyboard follows the click; the app
// that had it is kept active from then on.
//
// Costs: no tap at all unless two or more hosted windows are visible in a Margin window on the current Space (one pane,
// nothing hosted, another Space current: none). With one: a round trip per left press anywhere, a held press's focus,
// nothing per move. On a thread and run loop of its own, never the main thread's (Margin busy never holds the input);
// macOS turns a tap off whose callback is too slow (about 1 s), and it's turned on again at once.

import AppKit
import ApplicationServices

// What the tap decides with: the hosting Margin window's panes and its UI over them, as that window last published
// them (MarginWindowController `paneScene`, on the main thread as its holes change), read on the tap's thread.
nonisolated struct PaneClickScene: Equatable, Sendable {
    struct Pane: Equatable, Sendable {
        var rect: CGRect // its hole (top-left coordinates): where the pointer goes through to it
        var pid: pid_t
        var window: Int // the window server's number
        var card = false // the preview card's: while one is open only its page counts
    }
    var panes: [Pane] = [] // back to front
    var focused: Int? // the window with the keys, as Margin has it (the engine's focused host)
    var slot: Slot? // Margin's page slot: its hits over the page and the holes (PassThrough.pageGets)
    var marginWindows: [Int] = [] // Margin's own windows over the panes (its window, its panel, its backdrop): never a cover
    var fieldHasKeys = false // a field of Margin's has the keys (the palette): presses as before
    var kept: Set<pid_t> = [] // apps kept active (PanesActive.swift): their own word that they're active isn't the window server's
}

// Another window over a pane at a press's point (the window server's list), never one of Margin's own.
nonisolated struct PaneClickCover: Equatable, Sendable {
    var window: Int
    var pid: pid_t
    var layer: Int
}

nonisolated enum PaneClick {
    // A window at the assistive-technology level or above (screen dimmers, keep-awake and zoom overlays, the shielding
    // and cursor levels): by convention one that lets the pointer through, never a cover. The real Mac, 2026-11-21: a
    // keep-awake app's two full-screen windows at layer 2147483628 over every pane, and every held press let go for them.
    // A menu (101), a sheet or panel (3-8), the Dock (20), a system dialog (1000) still cover.
    static let overlayLayer = Int(CGWindowLevelForKey(.assistiveTechHighWindow))
    static func overlay(layer: Int) -> Bool { layer >= overlayLayer }

    enum Pass: Equatable, Sendable {
        case noPanes // no split up (no scene, or no pane in it)
        case field // a field of Margin's has the keys
        case button // another button held
        case margin // Margin's own UI there (or no pane's hole)
        case modifier // ⌘ or ⌃ held: Safari takes those without the keys already
        case focused // the pane with the keys
    }
    enum Decision: Equatable, Sendable {
        case pass(Pass)
        case covered(PaneClickScene.Pane, PaneClickCover) // another window over the pane there: as before
        case hold(PaneClickScene.Pane) // its window made key, then the press goes on
    }

    // What a left press at `point` (top left) does. `focused`: the window with the keys as the tap knows it (Margin's, or
    // the one it just gave them). `cover`: the window server's read of another window over the pane at the point, asked
    // last and only for a press it would hold.
    static func decide(_ point: CGPoint, flags: CGEventFlags, otherButtons: Bool, scene: PaneClickScene?, focused: Int?,
                       cover: (PaneClickScene.Pane) -> PaneClickCover?) -> Decision {
        guard let scene, !scene.panes.isEmpty else { return .pass(.noPanes) }
        if scene.fieldHasKeys { return .pass(.field) }
        guard point.x.isFinite, point.y.isFinite else { return .pass(.margin) } // (no press of a person's)
        if otherButtons { return .pass(.button) }
        guard PassThrough.pageGets(point, scene.slot) else { return .pass(.margin) }
        // (A card open: its page alone, whatever else is listed.)
        let panes = scene.panes.contains { $0.card } ? scene.panes.filter(\.card) : scene.panes
        guard let pane = panes.last(where: { $0.rect.contains(point) }), pane.pid > 0, pane.window > 0 else { return .pass(.margin) }
        if !flags.intersection([.maskCommand, .maskControl]).isEmpty { return .pass(.modifier) }
        if pane.window == focused { return .pass(.focused) }
        if let c = cover(pane) { return .covered(pane, c) }
        return .hold(pane)
    }
}

// What came of a press the tap looked at on a pane without the keys (said to the main thread: the log, the bookkeeping).
nonisolated struct PaneClickResult: Equatable, Sendable {
    enum Outcome: Equatable, Sendable {
        case delivered(already: Bool) // its window key (already: it was, Margin's word was behind), the press let go to it
        case notKey // not key within the cap: the press let go as before (it only focuses)
        case covered(PaneClickCover) // another window over the pane at the point: let go as before
    }
    var window: Int
    var pid: pid_t
    var outcome: Outcome
    var ms: Double // from the press's arrival to its window key (or the give-up)
    var crossApp = false // its app made the front app (another app had the keys)
    var number = 0 // the press's event number (the window server's mouseEventNumber)
    var server = false // ...by the window server (its app was kept active: PanesActive.swift)
}

// A pane's window made key, as the tap's thread asks it (HostSystem.swift `AXPaneFocus`; a test's stand-in). Every call
// is synchronous and bounded by `until` (a time of `now`'s clock).
nonisolated protocol PaneFocusing: AnyObject, Sendable {
    func now() -> Double // seconds, monotonic
    func pause(_ seconds: Double)
    // Whether the app is the front app, and its focused window (nil: none or unread); nil: unread.
    func keyState(pid: pid_t, until: Double) -> (front: Bool, window: Int?)?
    // Its app made the front app (`frontmost`), the window its app's main one and raised. True: asked.
    func focus(pid: pid_t, window: Int, frontmost: Bool, until: Double) -> Bool
    // Another window over `window` at `point` (top left), none of `except`; nil: none.
    func cover(at point: CGPoint, above window: Int, except: [Int]) -> PaneClickCover?
    // The panes' windows' elements looked up ahead (off the tap's thread), the others' dropped.
    func warm(_ panes: [PaneClickScene.Pane])
    // The window server's front process (nil: unread, or no such read: Accessibility's word alone, as before).
    func frontProcess() -> pid_t?
    // The app made the window server's front process and `window` its key one (an app kept active). True: taken.
    func makeFront(pid: pid_t, window: Int) -> Bool
}

extension PaneFocusing {
    nonisolated func frontProcess() -> pid_t? { nil }
    nonisolated func makeFront(pid: pid_t, window: Int) -> Bool { false }
}

// The hold, apart from the event tap (the tests drive it with a stand-in focuser and a pipe of presses). A press comes in
// on the tap's thread; the scene comes from the main thread; the claims are read there.
nonisolated final class PaneClickCore: @unchecked Sendable {
    struct Press: Sendable {
        var point: CGPoint // top left
        var flags: CGEventFlags
        var number: Int // its mouseEventNumber (0: none)
        var otherButtons: Bool // the right or middle button held as it came
    }
    let focuser: PaneFocusing
    let report: @Sendable (PaneClickResult) -> Void
    var cap = 0.12 // the longest a press is held (all input waits meanwhile)
    var every = 0.001 // the key read's period while it's held
    var claimFor = 1.0 // how long a claim waits for its press's own monitor on the main thread
    var givenFor = 2.0 // how long the window just given the keys counts as focused ahead of Margin's word
    private let lock = NSLock()
    private var scene: PaneClickScene?
    private var given: (window: Int, at: Double)?
    private var claims: [(number: Int, point: CGPoint, at: Double)] = []

    init(focuser: PaneFocusing, report: @escaping @Sendable (PaneClickResult) -> Void) {
        self.focuser = focuser
        self.report = report
    }

    // The main thread's word (nil: no split up: every press passes). The panes' elements looked up ahead when they change.
    func update(_ next: PaneClickScene?) {
        lock.lock()
        let changed = next?.panes.map(\.window) != scene?.panes.map(\.window)
        scene = next
        // (Margin's word caught up with the window the tap gave the keys, or the split's gone: its own word only.)
        if let g = given, next == nil || next?.focused == g.window { given = nil }
        lock.unlock()
        if changed { focuser.warm(next?.panes ?? []) }
    }

    var current: PaneClickScene? {
        lock.lock()
        defer { lock.unlock() }
        return scene
    }

    // A left press, on the tap's thread. Held (this returns once its pane's window is key, or after `cap`) when it lands
    // in a pane without the keys; the result said (`report`) for each press it held or found covered, nil otherwise.
    @discardableResult func pressed(_ p: Press) -> PaneClickResult? {
        let t0 = focuser.now()
        lock.lock()
        let scene = self.scene
        if let g = given, t0 - g.at > givenFor { given = nil }
        let focused = given?.window ?? scene?.focused
        lock.unlock()
        let except = scene?.marginWindows ?? []
        let decision = PaneClick.decide(p.point, flags: p.flags, otherButtons: p.otherButtons, scene: scene, focused: focused) { pane in
            self.focuser.cover(at: p.point, above: pane.window, except: except)
        }
        switch decision {
        case .pass:
            return nil
        case .covered(let pane, let c):
            return said(PaneClickResult(window: pane.window, pid: pane.pid, outcome: .covered(c), ms: ms(since: t0), number: p.number))
        case .hold(let pane):
            let until = t0 + cap
            let kept = scene?.kept.contains(pane.pid) == true
            // (Its app the front one: Accessibility's word, and the window server's when it reads; a kept app's own word
            // alone never counts.)
            func front(_ s: (front: Bool, window: Int?)) -> Bool { s.front && (focuser.frontProcess().map { $0 == pane.pid } ?? !kept) }
            // (Key already, Margin's word behind: let go at once, Margin told.)
            let state = focuser.keyState(pid: pane.pid, until: until)
            if let state, front(state), state.window == pane.window { return given(pane, p, t0, already: true, crossApp: false) }
            let crossApp = !(state.map(front) ?? false)
            // (Kept active, or taking itself for the active app while it isn't the window server's front one: the window
            // server makes it the front one, Accessibility then its window main and raised.)
            let server = crossApp && (kept || state?.front == true) && focuser.makeFront(pid: pane.pid, window: pane.window)
            _ = focuser.focus(pid: pane.pid, window: pane.window, frontmost: crossApp && !server, until: until)
            while focuser.now() < until {
                if let s = focuser.keyState(pid: pane.pid, until: until), front(s), s.window == pane.window {
                    return given(pane, p, t0, already: false, crossApp: crossApp, server: server)
                }
                let left = until - focuser.now()
                if left > 0 { focuser.pause(min(every, left)) }
            }
            return said(PaneClickResult(window: pane.window, pid: pane.pid, outcome: .notKey, ms: ms(since: t0), crossApp: crossApp, number: p.number, server: server))
        }
    }

    private func ms(since t0: Double) -> Double { ((focuser.now() - t0) * 1000 * 10).rounded() / 10 }

    private func said(_ r: PaneClickResult) -> PaneClickResult {
        report(r)
        return r
    }

    private func given(_ pane: PaneClickScene.Pane, _ p: Press, _ t0: Double, already: Bool, crossApp: Bool, server: Bool = false) -> PaneClickResult {
        let now = focuser.now()
        lock.lock()
        given = (pane.window, now)
        claims.removeAll { now - $0.at > claimFor }
        claims.append((p.number, p.point, now))
        if claims.count > 8 { claims.removeFirst(claims.count - 8) }
        lock.unlock()
        return said(PaneClickResult(window: pane.window, pid: pane.pid, outcome: .delivered(already: already), ms: ms(since: t0), crossApp: crossApp, number: p.number, server: server))
    }

    // On the main thread, for each press its monitor hears in a pane: whether it's one the tap gave its pane's window
    // the keys for (by its event number; one with none, by its point within 4 pt), then forgotten. True: focused already,
    // the monitor's own path leaves it (fronting the layout again around it would flip the app in front mid-click).
    func claimed(number: Int, at point: CGPoint) -> Bool {
        let now = focuser.now()
        lock.lock()
        defer { lock.unlock() }
        claims.removeAll { now - $0.at > claimFor }
        let i = claims.firstIndex { c in
            if number != 0, c.number != 0 { return c.number == number }
            return hypot(c.point.x - point.x, c.point.y - point.y) <= 4
        }
        guard let i else { return false }
        claims.remove(at: i)
        return true
    }
}

// What Margin's windows hold of the tap (MarginWindows: the real one, a test's stand-in).
nonisolated protocol PaneClickTapping: AnyObject {
    func start()
    func stop()
    func update(_ scene: PaneClickScene?)
    func claimed(number: Int, at point: CGPoint) -> Bool
}

// The event tap: a session tap at the head, active, on left presses only, on a thread of its own with its own run loop.
nonisolated final class PaneClickTap: PaneClickTapping, @unchecked Sendable {
    let core: PaneClickCore
    private let said: @Sendable (String) -> Void // its own lines (on, not made, turned on again), for the main thread's log
    private let lock = NSLock()
    private var thread: Thread?
    private var loop: CFRunLoop?
    private var port: CFMachPort?
    private var stopped = false
    private var turnedOn = 0

    init(core: PaneClickCore, said: @escaping @Sendable (String) -> Void) {
        self.core = core
        self.said = said
    }

    func start() {
        lock.lock()
        defer { lock.unlock() }
        guard thread == nil, !stopped else { return }
        let t = Thread { [self] in self.run() }
        t.name = "margin.pane-click-tap"
        t.qualityOfService = .userInteractive
        thread = t
        t.start()
    }

    // (The thread holds the tap until `stop`; the callback's pointer to it is the thread's own reference.)
    // Left presses only: drags, releases, moves, scrolls and keys never come through it (macOS adds its own word when it
    // turns the tap off).
    static let mask = CGEventMask(1) << CGEventMask(CGEventType.leftMouseDown.rawValue)

    private func run() {
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: Self.mask,
                                           callback: paneClickTapCallback, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            said("pane clicks: the event tap wasn't made (Accessibility refused it?): a first click in another pane only focuses it, as before")
            return
        }
        let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        let loop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(loop, source, .commonModes)
        lock.lock()
        let early = stopped
        if !early {
            self.port = port
            self.loop = loop
        }
        lock.unlock()
        if !early {
            CGEvent.tapEnable(tap: port, enable: true)
            said("pane clicks: on (an event tap on left presses, its own thread): a first click in another pane goes through")
            CFRunLoopRun()
        }
        CGEvent.tapEnable(tap: port, enable: false)
        CFRunLoopRemoveSource(loop, source, .commonModes)
        CFMachPortInvalidate(port)
        lock.lock()
        self.port = nil
        self.loop = nil
        lock.unlock()
    }

    // Off at once (no press reaches it from here), its thread ended once its run loop takes the stop.
    func stop() {
        lock.lock()
        stopped = true
        let port = self.port, loop = self.loop
        lock.unlock()
        if let port { CGEvent.tapEnable(tap: port, enable: false) }
        // (A block on its run loop: taken even if it isn't running yet, unlike CFRunLoopStop alone.)
        if let loop {
            CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(CFRunLoopGetCurrent()) }
            CFRunLoopWakeUp(loop)
        }
    }

    func update(_ scene: PaneClickScene?) { core.update(scene) }
    func claimed(number: Int, at point: CGPoint) -> Bool { core.claimed(number: number, at: point) }

    // On its thread: a press (held while its pane's window is made key), or macOS's word that it turned the tap off.
    fileprivate func heard(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock()
            let port = stopped ? nil : self.port
            turnedOn += 1
            let n = turnedOn
            lock.unlock()
            guard let port else { return }
            CGEvent.tapEnable(tap: port, enable: true)
            if n == 1 || n % 100 == 0 {
                said("pane clicks: macOS turned the event tap off (\(type == .tapDisabledByTimeout ? "too slow" : "user input")): on again (\(n) so far)")
            }
            return
        }
        guard type == .leftMouseDown else { return }
        let other = CGEventSource.buttonState(.combinedSessionState, button: .right) || CGEventSource.buttonState(.combinedSessionState, button: .center)
        core.pressed(PaneClickCore.Press(point: event.location, flags: event.flags, number: Int(event.getIntegerValueField(.mouseEventNumber)), otherButtons: other))
    }
}

// The tap's callback (C): every event goes on, as it came; a press only after its pane's window is key (or the cap).
nonisolated private func paneClickTapCallback(_ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent, _ info: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if let info { Unmanaged<PaneClickTap>.fromOpaque(info).takeUnretainedValue().heard(type, event) }
    return Unmanaged.passUnretained(event)
}
