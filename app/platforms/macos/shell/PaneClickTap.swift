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
// A press on Margin's own panel never takes the keyboard (docs/SIDEBAR-PRESS.md, GitHub #29): the same tap. The window
// server moved the keyboard to Margin at every press in its panel (a non-activating panel that refuses to be key
// included), so the hosted app's window resigned key and drew its unfocused look until Margin handed the keys back
// (`pressSettle`, 185-193 ms on the real screen). Now a press of any button on Margin's UI in a Margin window that shows
// an app with no field of Margin's wanting the keys (the core's way, core/page/press.rs `press_way`, over the scene's
// copy of its slot: `PanelPress`) is taken here and delivered to Margin's panel as an event made afresh from it, at the
// panel's own point, put in AppKit's own queue in Margin (`PanelEvents`: public calls only; never the window server's own
// record of the press, which carries its word that the click keys the panel), with its drags and release after it, and
// any other button's press until the last is up; so the window server never routes it and never moves the keyboard,
// and AppKit in Margin neither keys the panel nor takes Margin for active. The panel's web view gets the click, the
// double-click, the drag, the right-click's menu as before; a field the press focuses takes the keys then
// (MarginWindowController `takeKeys`), and only then. As before: a press through the hole, on the window's own buttons
// while windowed, with another button held, on another window over the panel there (a hosted app's menu, the Dock, a
// notification or Notification Center, Margin's quit prompt: the window server's list read for that press only; an
// overlay at the assistive-technology level and above lets it through, as for a pane), and every press when the part is
// off (`MarginSidebarTap` NO): routed, the keys handed back after it as before.
//
// One tap, two modes said apart in the log: `press tap: on` / `off` (the tap itself: while a Margin window on the
// current Space hosts), and `pane clicks: on` / `off` (a split shown while the tap is running: the first click in
// another pane goes through), each once as it changes.
//
// Costs: no tap at all unless a Margin window on the current Space shows a hosted app, or two or more hosted windows
// (nothing hosted, another Space current: none). With one: a round trip per press anywhere (any button), the core's way
// for it (about 11 ns, ffi tests/press_cost.rs), the window server's list for a press on Margin's UI, a held press's
// focus; one round trip per drag and release (a comparison for those of a press it didn't take); nothing per move,
// scroll or key. On a thread and run loop of its own, never the main thread's (Margin busy never holds the input);
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
        // Cut and lying under another pane (docs/PEEK-SPLIT.md §4b): a press on it goes to its window as the window
        // server's records, never routed (routed, its window would be raised over the pane beside it). Its window's frame.
        var tucked = false
        var frame: CGRect = .zero
    }
    var panes: [Pane] = [] // back to front
    var focused: Int? // the window with the keys, as Margin has it (the engine's focused host)
    var slot: Slot? // Margin's page slot: its hits over the page and the holes (PassThrough.pageGets)
    var marginWindows: [Int] = [] // Margin's own windows over the panes (its window, its panel, its backdrop): never a cover
    var fieldHasKeys = false // a field of Margin's has the keys (the palette): presses as before
    var kept: Set<pid_t> = [] // apps kept active (PanesActive.swift): their own word that they're active isn't the window server's
    // Margin's own panels (docs/SIDEBAR-PRESS.md): every Margin window on the current Space that hosts, as it last
    // published itself (MarginWindowController `panelScene`); none while the records aren't there or the part is off.
    struct Panel: Equatable, Sendable {
        var window: Int // the panel's number (the window server's)
        var pid: pid_t // Margin's own
        var content: CGRect // the window's content, the panel exactly over it (top left)
        var slot: Slot? // where the pointer goes through to what it hosts (nil: nowhere)
        var controls: CGRect? // the theme's window controls, in the content (the window's own buttons under them while windowed)
        var fullScreen = true
        var keysStay = false // the core's: an app shown, no field of Margin's (core/page/press.rs `keys_stay`)
    }
    var panels: [Panel] = []
}

// A press on Margin's own panel (docs/SIDEBAR-PRESS.md): its way, the core's (core/page/press.rs `press_way`), and the
// panel a press is delivered to (nil: it goes on as it came).
nonisolated enum PanelPress {
    enum Way: UInt8, Equatable, Sendable { case outside = 0, through, ui, routed }
    static func way(_ point: CGPoint, _ panel: PaneClickScene.Panel) -> Way {
        PassThrough.pressWay(point, content: panel.content, slot: panel.slot, controls: panel.controls, fullScreen: panel.fullScreen, keysStay: panel.keysStay)
    }
    static func target(_ point: CGPoint, scene: PaneClickScene?, otherButtons: Bool) -> PaneClickScene.Panel? {
        guard let scene, !otherButtons, point.x.isFinite, point.y.isFinite,
              let panel = scene.panels.first(where: { $0.content.contains(point) }), panel.window > 0, panel.pid > 0 else { return nil }
        return way(point, panel) == .ui ? panel : nil
    }
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
        case tuck(PaneClickScene.Pane) // a cut pane under another (docs/PEEK-SPLIT.md §4b): delivered to its window, never routed
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
        // (A cut pane under another: every press of it its window's as records, whatever its modifiers and whether it has
        // the keys (routed, its window would be raised over the pane beside it); a window over it there still lets it go.)
        if pane.tucked, !pane.card { return cover(pane).map { .covered(pane, $0) } ?? .tuck(pane) }
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
    var tucked = false // a cut pane's press, delivered to its window as records (never routed): docs/PEEK-SPLIT.md §4b
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
    // A cut pane (docs/PEEK-SPLIT.md §4b): its app made the front one and `window` its key one without a raise; a mouse
    // event delivered to `window` as its own record at its point less `origin` (never routed: never raised); its
    // window's top left now. False, nil: none (the press routed as before).
    func focusWithoutRaise(pid: pid_t, window: Int) -> Bool
    func deliver(_ event: CGEvent, pid: pid_t, window: Int, origin: CGPoint) -> Bool
    func windowOrigin(_ window: Int) -> CGPoint?
    // A press on Margin's own panel (docs/SIDEBAR-PRESS.md): an event made afresh from it for the panel `window` of `pid`
    // whose content is at `content` (top left), posted to that process (`PanelEvents`); never the window server's own
    // record of it. True: posted.
    func deliverToPanel(_ event: CGEvent, pid: pid_t, window: Int, content: CGRect) -> Bool
    // The window server's own record of an event, read (nil: unread): said once, for the first press on the panel.
    func record(of event: CGEvent) -> [UInt8]?
}

extension PaneFocusing {
    nonisolated func frontProcess() -> pid_t? { nil }
    nonisolated func makeFront(pid: pid_t, window: Int) -> Bool { false }
    nonisolated func focusWithoutRaise(pid: pid_t, window: Int) -> Bool { false }
    nonisolated func deliver(_ event: CGEvent, pid: pid_t, window: Int, origin: CGPoint) -> Bool { false }
    nonisolated func windowOrigin(_ window: Int) -> CGPoint? { nil }
    nonisolated func deliverToPanel(_ event: CGEvent, pid: pid_t, window: Int, content: CGRect) -> Bool { false }
    nonisolated func record(of event: CGEvent) -> [UInt8]? { nil }
}

// A press on Margin's own panel, and its drags and release, as the press tap delivers them (docs/SIDEBAR-PRESS.md):
// made afresh for the panel, with the press's own public fields (its type, its point in the panel, its modifiers, its
// event number, its click count, its pressure, its button, its movement), and put in AppKit's own queue in Margin
// (`queue`), the window server never told: through it (the press's own record, the first build; a press made afresh
// and `postToPid`, the second), a cut pane's click right after two arrow presses never reached its app (the screen run
// of 2026-11-25). Whether the panel then becomes key is AppKit's own question to the view the press hits
// (OverlayWebView `needsPanelToBecomeKey`: its left-mouse-down handling of a non-activating panel,
// `_NSShowNonActivatingKeyWindow`, keyed it on WebKit's yes whatever its `canBecomeKey`, the same run's DIAG lines). The
// first press's record is said in the log (its bytes 0x38-0x3b), never posted. All public API.
nonisolated enum PanelEvents {
    // The event made for the panel `window` whose content is at `content` (top left); nil: not a mouse button's event.
    static func make(from e: CGEvent, window: Int, content: CGRect) -> CGEvent? {
        let mouse: [CGEventType] = [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged,
                                    .otherMouseDown, .otherMouseUp, .otherMouseDragged]
        guard mouse.contains(e.type), let kind = NSEvent.EventType(rawValue: UInt(e.type.rawValue)), window > 0 else { return nil }
        let at = e.location
        // (AppKit's window coordinates: from the panel's bottom left.)
        let local = NSPoint(x: at.x - content.minX, y: content.height - (at.y - content.minY))
        guard let made = NSEvent.mouseEvent(with: kind, location: local, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(e.flags.rawValue)),
                                            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window, context: nil,
                                            eventNumber: Int(e.getIntegerValueField(.mouseEventNumber)), clickCount: Int(e.getIntegerValueField(.mouseEventClickState)),
                                            pressure: Float(e.getDoubleValueField(.mouseEventPressure)))?.cgEvent else { return nil }
        for field: CGEventField in [.mouseEventButtonNumber, .mouseEventDeltaX, .mouseEventDeltaY] { made.setIntegerValueField(field, value: e.getIntegerValueField(field)) }
        return made
    }

    // Made and put in AppKit's own queue in this process, the window server never told (the screen run of 2026-11-25:
    // posted to the process through the window server, a press made afresh still keyed the panel and took Margin for
    // active; the off-screen lab never showed it, its window being off every display). From any thread: the event put
    // in the main run loop's common modes (AppKit's tracking loops among them) in the order the tap delivers them, then
    // AppKit's queue. True: put.
    static func queue(_ e: CGEvent, window: Int, content: CGRect) -> Bool {
        guard let made = make(from: e, window: window, content: content), let event = NSEvent(cgEvent: made) else { return false }
        nonisolated(unsafe) let handed = event
        let main = CFRunLoopGetMain()
        CFRunLoopPerformBlock(main, CFRunLoopMode.commonModes.rawValue) { MainActor.assumeIsolated { NSApp.postEvent(handed, atStart: false) } }
        CFRunLoopWakeUp(main)
        return true
    }
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
    // A press taken under way: a cut pane's (its drags and release to the same window as records until its button is
    // up), or one on Margin's panel (every button's drags and releases, and another button's press there, until the
    // last is up).
    private struct Redirect {
        var pid: pid_t
        var window: Int
        var origin: CGPoint
        var buttons: Set<Int64>
        var panel: Bool
        var content: CGRect = .zero // (a panel's: its content, top left)
    }
    // (Where a press under way's events go: a cut pane's window as records, a panel as events made afresh.)
    private func send(_ e: CGEvent, _ r: Redirect) -> Bool {
        r.panel ? focuser.deliverToPanel(e, pid: r.pid, window: r.window, content: r.content) : focuser.deliver(e, pid: r.pid, window: r.window, origin: r.origin)
    }
    private var redirect: Redirect?
    // Whether a mouse button is held now (a press under way whose release the tap never heard, macOS having turned it
    // off a moment, is dropped at the next press). A test's stand-in answers its own.
    // (Only the left, right and middle buttons are read; a fourth or fifth is taken as held.)
    var buttonHeld: @Sendable (Int64) -> Bool = { b in
        guard let m = CGMouseButton(rawValue: UInt32(truncatingIfNeeded: b)) else { return true }
        return CGEventSource.buttonState(.combinedSessionState, button: m)
    }
    // The presses delivered to a panel, by their event number (a press's release has its number), the last 16, for
    // `pressEnded` (`claimedPanel`); how many in all; the first said and every 500th (`said`).
    private var panelClaims: [Int] = []
    private(set) var panelPresses = 0
    var said: (@Sendable (String) -> Void)?

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

    // Any mouse button's event on the tap's thread (a press, a drag, a release): true, taken here (delivered to a cut pane's
    // window as its own record: never routed, so never raised over the pane beside it, docs/PEEK-SPLIT.md §4b); false, it
    // goes on as it came (a left press first through `pressed`, which may hold it while its pane's window is made key).
    func event(_ type: CGEventType, _ e: CGEvent, otherButtons: Bool = false) -> Bool {
        let button = e.getIntegerValueField(.mouseEventButtonNumber)
        let down = type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown
        let up = type == .leftMouseUp || type == .rightMouseUp || type == .otherMouseUp
        lock.lock()
        var r = redirect
        lock.unlock()
        // (A press under way whose release the tap never heard: its button pressed again, or one of its buttons no
        // longer held. Dropped: this press decided afresh.)
        if let under = r, down, under.buttons.contains(button) || !under.buttons.allSatisfy(buttonHeld) {
            lock.lock(); redirect = nil; lock.unlock()
            r = nil
        }
        // (One under way: its own buttons' drags and releases, then over at the last.)
        if let r, !down {
            guard r.buttons.contains(button) else { return false }
            let taken = send(e, r)
            if up {
                lock.lock()
                redirect?.buttons.remove(button)
                if redirect?.buttons.isEmpty == true { redirect = nil }
                lock.unlock()
            }
            return taken
        }
        guard down else { return false }
        // (A press on Margin's panel under way: another button's press is the panel's too.)
        if let r, r.panel {
            guard send(e, r) else { return false }
            lock.lock(); redirect?.buttons.insert(button); lock.unlock()
            return true
        }
        let p = Press(point: e.location, flags: e.flags, number: Int(e.getIntegerValueField(.mouseEventNumber)), otherButtons: otherButtons)
        // A press on Margin's own UI with an app shown (docs/SIDEBAR-PRESS.md): delivered to the panel as an event made
        // afresh (`PanelEvents`), the keyboard where it is; covered there by another window: as it came.
        lock.lock()
        let now = self.scene
        lock.unlock()
        if r == nil, let panel = PanelPress.target(p.point, scene: now, otherButtons: otherButtons) {
            if focuser.cover(at: p.point, above: panel.window, except: now?.marginWindows ?? []) == nil,
               focuser.deliverToPanel(e, pid: panel.pid, window: panel.window, content: panel.content) {
                lock.lock()
                redirect = Redirect(pid: panel.pid, window: panel.window, origin: panel.content.origin, buttons: [button], panel: true, content: panel.content)
                panelClaims.append(p.number)
                if panelClaims.count > 16 { panelClaims.removeFirst(panelClaims.count - 16) }
                panelPresses += 1
                let n = panelPresses
                lock.unlock()
                if n == 1 || n % 500 == 0 {
                    // (The first: what the window server's own record of it said, never posted: its bytes 0x38-0x3b, where
                    // a click's make-key flag is, 0x3a.)
                    let own = n == 1 ? focuser.record(of: e).map { r in " (the window server's own record of it, not posted: 0x38-0x3b " + r.dropFirst(0x38).prefix(4).map { String(format: "%02x", $0) }.joined(separator: " ") + ")" } ?? "" : ""
                    said?("sidebar presses: delivered to Margin's panel as events made afresh, the keyboard left with the app shown (\(n) so far)\(own)")
                }
                return true
            }
            return false
        }
        let t0 = focuser.now()
        lock.lock()
        let scene = self.scene
        if let g = given, t0 - g.at > givenFor { given = nil }
        let focused = given?.window ?? scene?.focused
        lock.unlock()
        // (Only a cut pane's presses are taken here; any other press as before: a left one held by `pressed`.)
        let except = scene?.marginWindows ?? []
        let decision = PaneClick.decide(p.point, flags: p.flags, otherButtons: type == .leftMouseDown ? p.otherButtons : false, scene: scene, focused: focused) { pane in
            self.focuser.cover(at: p.point, above: pane.window, except: except)
        }
        guard case .tuck(let pane) = decision else {
            if type == .leftMouseDown { pressed(p) }
            return false
        }
        // (Its window key first, without a raise, when it isn't: the press waits, `cap` at most, as a held one does.)
        let until = t0 + cap
        var crossApp = false
        if let s = focuser.keyState(pid: pane.pid, until: until), s.front, s.window == pane.window, focuser.frontProcess().map({ $0 == pane.pid }) ?? true {} else {
            crossApp = true
            _ = focuser.focusWithoutRaise(pid: pane.pid, window: pane.window)
            while focuser.now() < until {
                if let s = focuser.keyState(pid: pane.pid, until: until), s.front, s.window == pane.window { break }
                let left = until - focuser.now()
                if left > 0 { focuser.pause(min(every, left)) }
            }
        }
        let origin = focuser.windowOrigin(pane.window) ?? pane.frame.origin
        guard focuser.deliver(e, pid: pane.pid, window: pane.window, origin: origin) else {
            // (Not delivered (no records): routed as before, a left one held by `pressed`.)
            if type == .leftMouseDown { pressed(p) }
            return false
        }
        lock.lock()
        redirect = Redirect(pid: pane.pid, window: pane.window, origin: origin, buttons: [button], panel: false)
        given = (pane.window, focuser.now())
        lock.unlock()
        _ = said(PaneClickResult(window: pane.window, pid: pane.pid, outcome: .delivered(already: !crossApp), ms: ms(since: t0), crossApp: crossApp, number: p.number, tucked: true))
        return true
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
        case .tuck:
            return nil // (`event`'s, never routed)
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

    // On the main thread, for each release of a press in Margin's panel (MarginWindowController `pressEnded`): whether
    // it's a press the tap delivered there (by its event number; one with none, the last such one), then forgotten.
    // True: the keyboard never moved, nothing to hand back.
    func claimedPanel(number: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let i = number != 0 ? panelClaims.lastIndex(of: number) : (panelClaims.last == 0 ? panelClaims.count - 1 : nil) else { return false }
        panelClaims.remove(at: i)
        return true
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
    func claimedPanel(number: Int) -> Bool
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
    // Presses, drags and releases of every button: a cut pane's press and the drags and release after it are delivered to
    // its window as records (docs/PEEK-SPLIT.md §4b); every other one goes on at once (one comparison).
    static let mask = [CGEventType.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged,
                       .otherMouseDown, .otherMouseUp, .otherMouseDragged].reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }

    private func run() {
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: Self.mask,
                                           callback: paneClickTapCallback, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            said("press tap: the event tap wasn't made (Accessibility refused it?): a press on Margin's sidebar hands the keys back after it, and a first click in another pane only focuses it, as before")
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
            said("press tap: on (an event tap on mouse presses and the drags and releases of a press it took, its own thread): a press on Margin's sidebar keeps the app shown's keyboard")
            splitSaid(running: true)
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
        splitSaid(running: false)
        if let port { CGEvent.tapEnable(tap: port, enable: false) }
        // (A block on its run loop: taken even if it isn't running yet, unlike CFRunLoopStop alone.)
        if let loop {
            CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(CFRunLoopGetCurrent()) }
            CFRunLoopWakeUp(loop)
        }
    }

    func update(_ scene: PaneClickScene?) {
        core.update(scene)
        splitSaid(running: nil)
    }
    func claimed(number: Int, at point: CGPoint) -> Bool { core.claimed(number: number, at: point) }

    // `pane clicks: on` while the tap runs and its scene has a split's panes, `off` once either is over: said once each
    // way, from whichever thread saw the change (the main thread's scene, the tap's own thread starting). `running`: the
    // tap's thread's own word (nil: as it is).
    private var running = false
    private var splitOn = false
    func splitSaid(running now: Bool?) {
        lock.lock()
        if let now { running = now }
        let on = running && !stopped && !(core.current?.panes.isEmpty ?? true)
        let changed = on != splitOn
        splitOn = on
        lock.unlock()
        guard changed else { return }
        said(on ? "pane clicks: on (a split shown, the press tap's): a first click in another pane goes through"
                : "pane clicks: off (no split shown, or the press tap off)")
    }
    func claimedPanel(number: Int) -> Bool { core.claimedPanel(number: number) }

    // On its thread: a press (held while its pane's window is made key, or a cut pane's taken), a drag or a release (a cut
    // pane's taken), or macOS's word that it turned the tap off. True: taken (not passed on).
    fileprivate func heard(_ type: CGEventType, _ event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock()
            let port = stopped ? nil : self.port
            turnedOn += 1
            let n = turnedOn
            lock.unlock()
            guard let port else { return false }
            CGEvent.tapEnable(tap: port, enable: true)
            if n == 1 || n % 100 == 0 {
                said("press tap: macOS turned the event tap off (\(type == .tapDisabledByTimeout ? "too slow" : "user input")): on again (\(n) so far)")
            }
            return false
        }
        // (Another button held as a press comes: the left's, the right's or the middle's other than its own.)
        let held = { (b: CGMouseButton) in CGEventSource.buttonState(.combinedSessionState, button: b) }
        let other: Bool
        switch type {
        case .leftMouseDown: other = held(.right) || held(.center)
        case .rightMouseDown: other = held(.left) || held(.center)
        case .otherMouseDown: other = held(.left) || held(.right)
        default: other = false
        }
        return core.event(type, event, otherButtons: other)
    }
}

// The tap's callback (C): every event goes on, as it came; a press only after its pane's window is key (or the cap).
nonisolated private func paneClickTapCallback(_ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent, _ info: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if let info, Unmanaged<PaneClickTap>.fromOpaque(info).takeUnretainedValue().heard(type, event) { return nil }
    return Unmanaged.passUnretained(event)
}
