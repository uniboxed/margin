// Which window server window is which of the extension's windows (PLAN.md
// §5), as lasting bindings learned from evidence, never guessed
// (WindowBinder), and whether an overlay is stacked just above its browser
// window (WindowMatcher.stackedAbove).
//
// The extension knows its windows by id (per copy, so per profile), with
// their bounds, state, which one its copy calls focused, and when its copy
// heard each one focused and created (`focusedAt`, `createdAt`: the same
// machine's clock). The window server knows them by number, with bounds,
// whether each is on screen and the order front to back, but not whose they
// are: every Safari profile's windows are one process's. Two full-screen
// windows on one display have the same bounds, and copies' `focused` flags lag
// and disagree while a Space changes (a real session's log, 2026-11-05: two profiles'
// windows swapped for 650 ms when focus broke the tie). So:
//
//  - A binding, once made, holds while both windows exist. It never changes
//    on a focus flag. It goes when the extension's window closes, the window
//    server's goes, the copy goes (or a new copy of Margin starts, whose ids
//    may be new), and it moves only on strong evidence: two separate focus
//    changes both saying so, or its bounds matching one other free window
//    alone, steadily, while its own don't.
//  - Bindings are learned only from evidence, between windows not bound yet:
//    made by Margin (the app's own request, the profile switch's
//    openSpaceWindow, answered with its id, and the one new window server
//    window since); created together (a copy's windows.onCreated and a new window server
//    window, each alone at that time); focus moved (a copy's onFocusChanged
//    and the browser's front window changing at about that time, each alone);
//    the only free window with its bounds (on both sides); visible (the only
//    window on screen with its bounds, every window with them a reported one,
//    and its page alone saying it's shown, every other free one's hidden or, the
//    pages settled, silent, said since the last Space change or window come on or
//    gone off screen); settled focus (within
//    one copy: the only window it calls focused, the same front window for a
//    while, and as many browser windows with those bounds as it reports).
//    A copy's focused flag is about its own windows only (each profile's copy
//    calls its own last focused window focused), so it never tells one
//    profile's window from another's: their pages do (a real session's log, 2026-11-05
//    21:52: three profiles' full-screen windows never bound in 4 minutes).
//  - A window it can't tell yet gets no binding, so no overlay is drawn over
//    it (it says so in the log, once per reason) rather than the wrong one.
//  - A binding its pages contradict (its page hidden while its window is the
//    one on screen, another profile's page shown) goes after `hiddenDrop`.
//  - The window server's list blips (a real session's log, 2026-11-05: a bound window
//    missing from one read and listed again 42 ms later, and reads without any
//    of Safari's windows next to Space changes). A window server number is the
//    same window for the whole login session, so a bound window missing from a
//    read keeps its binding (`absentNumbers`, still counted as bound) for
//    `Timing.absent`; it goes at once only when the extension's window closes,
//    the copy goes or the browser isn't running. A read that lost every window
//    the last one had (or every bound one), or that has no list at all, tells
//    nothing: nothing is learned or forgotten from it. And no binding is made
//    by elimination on a read where a window listed just before is missing.
//  - Parked windows (docs/HANDOFF.md §2.2: hidden in a private Space Margin
//    made, their numbers the parking registry's, given to each `update`): a
//    bound one never drops for being missing from the reads, off screen, or
//    its copy not linked a while; it still drops when its copy (the same one)
//    stops listing it, the browser isn't running, or a new copy starts, and
//    the registry then binds the new id by `expectParked`. They're left out of
//    every rule: the read that tells nothing, the front window, elimination
//    (neither bound nor counted as a rival), created together, focus moved,
//    moved, visible, hidden and settled focus. A parked window is still Safari's
//    window with its normal bounds, and a person's own window may share them.
//
// Every binding made, moved or dropped is one log line with why.

import CoreGraphics
import Foundation

// One of an extension copy's windows: its link (Hello.key) and its id there.
nonisolated struct WindowKey: Hashable, Comparable, CustomStringConvertible {
    let link: String
    let windowId: Int
    static func < (a: WindowKey, b: WindowKey) -> Bool { (a.link, a.windowId) < (b.link, b.windowId) }
    var description: String { "\(link)#\(windowId)" }
}

// A window as the extension reports it (`windows`, docs/PROTOCOL.md).
struct ViewportTimes: Equatable { var resized: Double?; var said: Double?; var heard: Double? }

struct ExtWindow: Equatable {
    let key: WindowKey
    let bounds: CGRect?
    let state: String // normal, fullscreen, maximized, minimized
    let focused: Bool
    let activeTabId: Int?
    // Seconds since 1970 (the copy's Date.now(), the same clock as the app's): when its copy last heard
    // windows.onFocusChanged name it, and windows.onCreated (nil: not heard since the copy started).
    var focusedAt: Double?
    var createdAt: Double?
    // Where its tab in front's page area sits in it (top left, from the window's corner, in points),
    // when that's less than the whole window: the docked Web Inspector (or Safari's sidebar) takes
    // the rest (background/link.ts `viewport`). Nil: the whole window.
    var viewport: CGRect?
    // Whether the page measured where its area starts (from a pointer event: content/core.ts
    // pointerOrigin) rather than taking the missing width to be on the left.
    var viewportMeasured = false
    // When the page was resized, said its area, and its copy heard it (seconds since 1970; nil: not said): for the
    // log's delay when Margin draws in a new area (seen 2026-11-07: the layout late beside the inspector).
    var viewportTimes: ViewportTimes?
    // A window its copy had parked before Safari quit, restored by Safari as a normal window (the copy's
    // background/parked-restore.ts): the app closes it (Shell.closeRestoredParked).
    var wasParked = false
    // Its tab in front in full screen (a page's own, or Safari's video full screen: content/core.ts): Margin's layout
    // leaves the window meanwhile (Shell.track).
    var pageFullscreen = false
    // Whether its tab in front's page says it's shown (document.visibilityState), and when it last said
    // so (seconds since 1970). Nil: not known (no word from that page), never taken as hidden.
    var visible: Bool?
    var visibleAt: Double?
    // When its copy last heard windows.onFocusChanged with WINDOW_ID_NONE (none of its windows focused).
    var blurredAt: Double?

    init(key: WindowKey, bounds: CGRect?, state: String, focused: Bool, activeTabId: Int?, focusedAt: Double? = nil, createdAt: Double? = nil, viewport: CGRect? = nil,
         visible: Bool? = nil, visibleAt: Double? = nil, blurredAt: Double? = nil) {
        (self.key, self.bounds, self.state, self.focused, self.activeTabId, self.focusedAt, self.createdAt, self.viewport) = (key, bounds, state, focused, activeTabId, focusedAt, createdAt, viewport)
        (self.visible, self.visibleAt, self.blurredAt) = (visible, visibleAt, blurredAt)
    }

    private static func viewport(_ v: Any?) -> CGRect? {
        guard let o = v as? JSONObject, let x = num(o["x"]), let y = num(o["y"]), let w = num(o["width"]), let h = num(o["height"]),
              [x, y, w, h].allSatisfy(\.isFinite), w > 0, h > 0 else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    static func parse(_ list: [JSONObject], link: String) -> [ExtWindow] {
        list.compactMap { w in
            guard let id = int(w["windowId"] ?? w["id"]) else { return nil }
            var bounds: CGRect?
            if let l = num(w["left"]), let t = num(w["top"]), let width = num(w["width"]), let height = num(w["height"]), width > 0, height > 0 {
                bounds = CGRect(x: l, y: t, width: width, height: height)
            }
            let ms = { (v: Any?) in num(v).flatMap { $0 > 0 ? $0 / 1000 : nil } }
            let visibleAt = ms(w["visibleAt"])
            let visible = visibleAt == nil ? nil : w["visible"] as? Bool
            var e = ExtWindow(key: WindowKey(link: link, windowId: id), bounds: bounds, state: w["state"] as? String ?? "normal",
                              focused: w["focused"] as? Bool ?? false, activeTabId: int(w["activeTabId"]),
                              focusedAt: ms(w["focusedAt"]), createdAt: ms(w["createdAt"]), viewport: viewport(w["viewport"]),
                              visible: visible, visibleAt: visible == nil ? nil : visibleAt, blurredAt: ms(w["blurredAt"]))
            e.viewportMeasured = e.viewport != nil && (w["viewport"] as? JSONObject)?["measured"] as? Bool == true
            e.wasParked = w["wasParked"] as? Bool == true
            e.pageFullscreen = w["pageFullscreen"] as? Bool == true
            if e.viewport != nil, let t = w["viewportTimes"] as? JSONObject { e.viewportTimes = ViewportTimes(resized: ms(t["resized"]), said: ms(t["said"]), heard: ms(t["heard"])) }
            return e
        }
    }
}

nonisolated enum WindowMatcher {
    // How far each edge may be off (points): browsers round, and a window being animated lags a poll.
    static let tolerance: CGFloat = 8
    // The smallest window that can be a browser window (not a popover, a sheet, a tooltip).
    static let minSize: CGFloat = 120

    static func close(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = tolerance) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance && abs(a.maxX - b.maxX) <= tolerance && abs(a.maxY - b.maxY) <= tolerance
    }

    // The browser's windows a binding can be: normal ones (layer 0), drawn, browser-sized.
    static func candidates(_ server: [ServerWindow], pids: Set<pid_t>) -> [ServerWindow] {
        server.filter { pids.contains($0.pid) && $0.layer == 0 && $0.alpha > 0 && $0.bounds.width >= minSize && $0.bounds.height >= minSize }
    }

    /// A full-screen browser window's toolbar, which Safari draws as a window of its own (a real
    /// Safari, 2026-11-05, recorded with the window server's list): the same process, layer 0, the
    /// window's left edge and width, short (52 pt; more with a tab bar or Favorites), parked just
    /// above the window's top (y = top − its height) and sliding down over the window's top when
    /// revealed; listed above the window. Margin's overlay goes between the two, so the toolbar
    /// slides over Margin as it does over the page. The nearest such window above it, if any.
    static let toolbarMaxHeight: CGFloat = 160
    static func fullScreenToolbar(_ list: [ServerWindow], browser: ServerWindow, spacesOf: (Int) -> [UInt64]? = { _ in nil }) -> ServerWindow? {
        let b = browser.bounds
        let browserSpaces = spacesOf(browser.number).map(Set.init)
        let candidates = list.filter { w in
            w.number != browser.number && w.pid == browser.pid && w.layer == 0 && w.order < browser.order
                && abs(w.bounds.minX - b.minX) <= 1 && abs(w.bounds.width - b.width) <= 1
                && w.bounds.height > 0 && w.bounds.height <= toolbarMaxHeight
                && w.bounds.minY >= b.minY - w.bounds.height - 1 && w.bounds.minY <= b.minY + 1
        }
        var matching: [ServerWindow] = [], unknown: [ServerWindow] = []
        for w in candidates {
            if let browserSpaces, !browserSpaces.isEmpty, let spaces = spacesOf(w.number) {
                if !browserSpaces.isDisjoint(with: spaces) { matching.append(w) }
            } else { unknown.append(w) }
        }
        // Geometry alone can select another profile's hidden toolbar. Prefer known
        // membership in this window's Space; unknown reads keep the geometry fallback.
        return (matching.isEmpty ? unknown : matching).max { $0.order < $1.order }
    }

    /// Whether `overlay` is just above `browser` in the window server's list:
    /// both on screen, the overlay nearer the front, and no other normal or
    /// higher window (any app's, another overlay) between them.
    /// And below the browser window's full-screen toolbar (`toolbar`, fullScreenToolbar), when it has one.
    /// `own`: the overlay's own windows that go between it and the browser window (its catcher, Overlay.swift).
    static func stackedAbove(_ list: [ServerWindow], overlay: Int, browser: Int, toolbar: Int? = nil, own: Set<Int> = []) -> Bool {
        if let toolbar {
            let all = list.sorted { $0.order < $1.order }
            if let t = all.firstIndex(where: { $0.number == toolbar }), let o = all.firstIndex(where: { $0.number == overlay }), t > o { return false }
        }
        let shown = list.filter(\.onScreen).sorted { $0.order < $1.order }
        guard let o = shown.firstIndex(where: { $0.number == overlay }), let b = shown.firstIndex(where: { $0.number == browser }), o < b else { return false }
        let browserPid = shown[b].pid
        // The browser's own small windows (a popover above its window) don't count.
        return !shown[(o + 1)..<b].contains { !own.contains($0.number) && $0.layer >= 0 && $0.alpha > 0 && !($0.pid == browserPid && $0.layer > 0) && $0.bounds.intersects(shown[b].bounds) }
    }

    /// The same question asked exactly: `aboveBrowser`, the on-screen windows in front of the browser's window (front to
    /// back), `aboveToolbar` the same for its full-screen toolbar. The overlay is in front of its window, behind the
    /// toolbar, with nothing but its own windows, the browser's small ones and see-through ones between.
    static func stackedAboveExactly(aboveBrowser: [ServerWindow], aboveToolbar: [ServerWindow]?, overlay: Int, browser: CGRect, browserPid: pid_t, own: Set<Int> = []) -> Bool {
        guard let o = aboveBrowser.firstIndex(where: { $0.number == overlay }) else { return false }
        if let aboveToolbar, aboveToolbar.contains(where: { $0.number == overlay }) { return false }
        return !aboveBrowser[(o + 1)...].contains { !own.contains($0.number) && $0.layer >= 0 && $0.alpha > 0 && !($0.pid == browserPid && $0.layer > 0) && $0.bounds.intersects(browser) }
    }

    static func describe(_ r: CGRect) -> String { "\(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))×\(Int(r.height))" }

    // A time as the log shows it (local, to the millisecond).
    static func clock(_ t: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f.string(from: Date(timeIntervalSince1970: t))
    }
}

/// One browser's bindings (Safari's, Chrome's): each extension window to the
/// number of the window server window it is. `update` once per read of the
/// window server; it returns every binding.
final class WindowBinder {
    struct Timing {
        // A focus or a creation and the window server's change it goes with: this far apart at most (seconds),
        // beyond the reads either side of the change.
        var slack: Double = 0.5
        // Nothing else of the kind this near it (another focus, another front window, another new window).
        var alone: Double = 1.0
        // A change seen across a longer gap between reads says too little about when it happened.
        var maxGap: Double = 1.0
        // Across reads that told nothing (or that missed the front window), a shorter one: others may have
        // come and gone unseen in it.
        var blind: Double = 0.3
        // A copy's report may come this late (a busy background): an event is weighed only once this has passed
        // after `alone`, so the others near it have come.
        var reportLag: Double = 1.0
        // Settled focus: the same only-focused window and front window this long…
        var settle: Double = 1.0
        // …with the front window the same this long (copies' flags may lag a switch by about a second).
        var quiet: Double = 5.0
        // A new window's bounds may take this long to agree with its new extension window's (full screen opening).
        var created: Double = 5.0
        // A bound window whose bounds match another free window, not its own, this long (both still): moved.
        var moved: Double = 2.0
        // A focus change against a binding is remembered this long, for a second one to move it.
        var conflict: Double = 120
        // Events kept this long.
        var history: Double = 20
        // A window missing from the window server's list this long is gone (a bound one's binding goes, a
        // closed one's number may be bound again); shorter, it's a blip: the same window when it's back.
        var absent: Double = 3.0
        // A copy that reported and now neither reports nor is held (its link gone for good: the socket guard,
        // its background torn down, its last window closed) is taken as away this long, then forgotten: a
        // window of its may still be the one listed while one of a reporting copy's is missing.
        var away: Double = 5.0
        // No front window (the browser not in front, none on screen) for less than this, between two reads with
        // one: a blip, not a front change, for focus moved.
        var frontBlip: Double = 0.5
        // The visible rule. A page's word that it's shown or hidden may come this long after the Space change
        // or new front window that caused it (WebKit's occlusion, a busy background): only a word said after
        // the last such change, and this long after the one before, is taken as about the windows now.
        var visibleLag: Double = 1.0
        // What the pages say holds this long, over reads that told something, before a window is bound by it.
        var visibleHold: Double = 0.3
        // A page that has said nothing (its tab not loaded yet, a page Margin can't run in) doesn't stop the page
        // that says it's shown from binding its window, once this long has passed after `visibleLag` from the last
        // change: a page shown before it (newly said in the change, its window the one going) has said it's hidden
        // and been heard by then (a real session's log, 2026-11-06 21:24: five profiles' restored full-screen windows, one
        // page that never spoke, nothing drawn).
        var visibleQuiet: Double = 1.0
        // A bound window on screen whose page has said it's hidden this long, while another profile's
        // same-bounds window's page says it's shown: not its window, the binding goes.
        var hiddenDrop: Double = 2.0
        // ...but not this soon after a Space change.
        var hiddenQuiet: Double = 1.0
        // Visible at once: a page's word that it's shown counts for a window come on screen if it was said no
        // more than this before the read the window was first seen on screen after (the two clocks, the page's
        // and the app's, are the same machine's).
        var visibleFresh: Double = 0.1
    }

    struct Binding: Equatable {
        let number: Int
        let why: String
        let at: Double
    }

    let browser: String
    var timing: Timing
    var log: (String) -> Void
    private(set) var bindings: [WindowKey: Binding] = [:]

    private struct Seen { let at: Double; let after: Double; let before: Bool } // first listed between `after` and `at`; `before`: there at the first read
    // `timed`: false for one seen across reads that told nothing (or with the front window missing) for longer than `blind`.
    private struct Change { let at: Double; let after: Double; let number: Int?; var timed = true }
    // `contradicted`: the copy's report that carried it called another of its windows focused.
    private struct Event { let key: WindowKey; let at: Double; var contradicted = false; var decided = false }
    private struct Pending { let key: WindowKey; let number: Int; let until: Double; let why: String }

    private var reads = 0
    private var lastRead: Double = 0
    private var seen: [Int: Seen] = [:]
    private var retired: Set<Int> = [] // a window server window whose extension window closed: never bound again
    private var serverMoved: [Int: (bounds: CGRect, at: Double)] = [:]
    private var extMoved: [WindowKey: (bounds: CGRect, at: Double)] = [:]
    private var front: Int?
    private var frontSince: Double? // when the front window last changed (the first read, for one in front from before)
    private var changes: [Change] = []
    private var focusHeard: [WindowKey: Double] = [:]
    private var createHeard: [WindowKey: Double] = [:]
    private var focusEvents: [Event] = []
    private var createEvents: [Event] = []
    private var pending: [Pending] = []
    private var conflicts: [WindowKey: (number: Int, at: Double)] = [:]
    private var settling: (key: WindowKey, number: Int, since: Double)?
    private var drift: [WindowKey: (number: Int, since: Double)] = [:]
    // `bounds`: the window's bounds as the request's answer gave them (openSpaceWindow's, HANDOFF.md §1.6),
    // used until its copy's list has it; `answered`: when the answer came.
    private struct Made { let key: WindowKey; let since: Double; let answered: Double; let until: Double; let why: String; let bounds: CGRect? }
    private var made: [Made] = [] // windows Margin's own request made (the profile switch's openSpaceWindow)
    // Bound from an answer's bounds before the copy listed the window: not taken as closed in the browser
    // until this time (its list may lag the answer).
    private var awaitingList: [WindowKey: Double] = [:]
    // Parked windows the parking registry knows again after a new copy (expectParked): bound at the next
    // read with the key in its copy's list. `until`: set at the first read after it was asked.
    private struct ParkedExpect { let key: WindowKey; let number: Int; let why: String; var until: Double? }
    private var parkedExpects: [ParkedExpect] = []
    // Each parked binding's reason for being kept that the log said last (said again only when it changes).
    private var parkedKept: [WindowKey: String] = [:]
    private var copyOf: [String: String] = [:] // each link's copy (instanceId), last seen
    private var waitingSaid: [WindowKey: String] = [:]
    // Blips. A number listed before and missing since this read (bound, closed or only seen); the
    // browser-sized windows of the last read and of the last read that told something; when that was.
    private var unlisted: [Int: Double] = [:]
    private var absentSaid: Set<Int> = []
    private var lastBig: Set<Int> = []
    private var reliableBig: Set<Int> = []
    private var lastReliable: Double = 0
    private var collapsedSince: Double?
    private var collapsedReads = 0
    // The browser's layer-0 windows in the last read that told something (for the collapse's line).
    private var lastMineCount: Int?
    private var freshAt: Double = -.infinity // a browser-sized window never listed before was last first listed
    // The front window missing (and nothing else in front) since the read after `frontMissingAfter`.
    private var frontMissingAfter: Double?
    // Each window server window's settled bounds: the last it kept for `moved` with no Space change meanwhile.
    private var settledBounds: [Int: CGRect] = [:]
    // Each link that has reported, and when it last reported or was held: one neither reporting nor held now
    // may have windows unseen, for `Timing.away` (then it's taken as gone for good: the socket guard, its
    // background torn down, its last window closed; its windows still open are counted by their bounds).
    // Forgotten when the browser isn't running.
    private var linksSeen: [String: Double] = [:]
    private var firstReadAt: Double?
    // Reads that told something (whole lists, nothing missing), in a row since.
    private var steadySince: Double?
    private var steadyReads = 0
    // Changes that change which pages are shown: the browser's windows coming on or going off screen, and
    // Space changes. (Not the front window alone: the browser coming to the front, or another of the windows
    // on screen coming forward, shows and hides no page. A real session's log, 2026-11-06 21:24:50: Safari brought to
    // the front over the Space already showing made the shown page's word stale.) `at`: when it may have begun
    // (the read before a window was seen come or go; a Space change when it was heard); `latest`: the latest
    // it can have happened (the read it was seen in, the Space change heard). A Space change heard within
    // `visibleLag` after windows came or went, with no other since, is taken as the same one (macOS says the
    // Space changed once its slide is over); so is a window come on screen that may have come before a Space
    // change heard since the read before it (both seen in one read). Windows going off screen within
    // `visibleLag` of the last change are the end of it (a slide: the new window on screen first, then the
    // old one off): the window come on screen at its start, whose page said it's shown then, still counts.
    // `front`: seen in the window server's list; `went`: the windows gone off screen in it.
    private struct Transition { var at: Double; var latest: Double; var space: Bool; var front: Bool; var went: Set<Int> = [] }
    private var transitions: [Transition] = []
    private var lastSpaceChange: Double = -.infinity
    // The browser's windows on screen in the last read that told something.
    private var lastOnScreen: Set<Int> = []
    // Since when each of them has been on screen (the read before it was first seen there; -infinity: on screen
    // at the first read), and the latest each may have been on screen (the read it was last seen there, or the
    // first one that saw it gone): for the visible rule at once.
    private var onScreenSince: [Int: Double] = [:]
    private var lastOn: [Int: Double] = [:]
    // The visible rule's evidence for each free window on screen, held since; why it didn't bind (said once).
    private var seeing: [Int: (key: WindowKey, since: Double)] = [:]
    private var visibleSaid: [Int: String] = [:]
    private var hiddenSince: [WindowKey: Double] = [:]
    private var settledSaid: String?
    private var visibleOffSaid: String?
    // The front window's changes not logged yet (logged at most once a second).
    private var frontNoted: [String] = []
    private var frontNotedAt: Double = -.infinity
    /// Bound windows the last read didn't list (kept, for `Timing.absent`): the shell keeps their overlays where they are, unseen.
    private(set) var absentNumbers: Set<Int> = []
    /// The last read told nothing (no list, or none of the browser's windows in it): bindings kept as they were.
    private(set) var lastReadCollapsed = false

    init(browser: String, timing: Timing = Timing(), log: @escaping (String) -> Void = { Diagnostics.note($0) }) {
        self.browser = browser
        self.timing = timing
        self.log = log
    }

    var numbers: [WindowKey: Int] { bindings.mapValues(\.number) }
    // The front window's changes it has noted (for the tests).
    var frontChanges: [Int?] { changes.map(\.number) }

    /// The app's own request made this window (asked at `since`, answered `now` with its id): it's bound
    /// to the one new window the window server lists from about then, once their bounds agree: its
    /// copy's list's bounds, or the bounds the answer gave (`bounds`, openSpaceWindow's), so it binds
    /// before the copy's list catches up (HANDOFF.md §1.6).
    func expect(_ key: WindowKey, since: Double, now: Double, why: String, bounds: CGRect? = nil) {
        guard bindings[key] == nil else { return }
        made.removeAll { $0.key == key }
        made.append(Made(key: key, since: since, answered: now, until: now + timing.created, why: why, bounds: bounds))
    }

    /// A parked window (`number`, the parking registry's) is this key: its copy's new id after a new copy
    /// (ParkingRegistry.rebind, HANDOFF.md §2.2). Bound at the next read whose copy lists the key, like
    /// `expect`, unless the window is a closed one's, the key is already another window's, or the number
    /// stays another key's for `Timing.created`. Each outcome is one log line.
    func expectParked(_ key: WindowKey, number: Int, why: String) {
        parkedExpects.removeAll { $0.key == key || $0.number == number }
        parkedExpects.append(ParkedExpect(key: key, number: number, why: why))
    }

    /// What ParkingRegistry.rebind returned, each expected as above.
    func expectParked(_ rebound: [WindowKey: Int], why: String) {
        for (key, number) in rebound.sorted(by: { $0.key < $1.key }) { expectParked(key, number: number, why: why) }
    }

    /// - now: seconds since 1970 (the extension's clock).
    /// - ext: the windows of the copies that report (their state is here).
    /// - reporting: those copies' links; `copies`: each one's identity (its
    ///   instanceId): a new one may have new window ids, so its bindings go.
    /// - held: links whose bindings stay as they are though they say nothing
    ///   now (dropped a moment ago, or linked again without their state yet).
    /// - server: the window server's list; `pids`: the browser's processes;
    ///   `browserInFront`: it's the active app; `listed`: false when the
    ///   window server gave no list at all (`server` is then empty).
    /// - spaceChangedAt: when the active Space last changed (NSWorkspace's
    ///   activeSpaceDidChange, the same clock as `now`; -infinity: not since start).
    /// - parked: the parking registry's window numbers (HANDOFF.md §2.2): kept
    ///   bound while missing or off screen, and left out of every rule.
    @discardableResult
    func update(now: Double, ext: [ExtWindow], reporting: Set<String>, copies: [String: String] = [:], held: Set<String> = [],
                server: [ServerWindow], pids: Set<pid_t>, browserInFront: Bool, listed: Bool = true, spaceChangedAt: Double = -.infinity,
                parked: Set<Int> = [], exact: [Int: String] = [:]) -> [WindowKey: Int] {
        let first = reads == 0 // the first read that told something
        defer { lastRead = now; noteFront(now) }
        let T = timing
        if firstReadAt == nil { firstReadAt = now }
        if pids.isEmpty { linksSeen = [:] }
        for link in reporting { linksSeen[link] = now }
        for link in held where linksSeen[link] != nil { linksSeen[link] = now } // (kept while held)
        linksSeen = linksSeen.filter { now - $0.value < T.away }
        // A Space change: the same transition as a new front window just before it, or one of its own.
        if spaceChangedAt > lastSpaceChange {
            lastSpaceChange = spaceChangedAt
            if let i = transitions.indices.last, transitions[i].front, !transitions[i].space, spaceChangedAt - transitions[i].latest <= T.visibleLag {
                transitions[i].space = true
                transitions[i].latest = max(transitions[i].latest, spaceChangedAt)
            } else {
                transitions.append(Transition(at: spaceChangedAt, latest: spaceChangedAt, space: true, front: false))
                transitions = Array(transitions.suffix(4))
            }
        }

        // ---- the window server's side ----
        let mine = server.filter { pids.contains($0.pid) && $0.layer == 0 }
        var present: [Int: ServerWindow] = [:]
        for w in mine where present[w.number] == nil { present[w.number] = w }
        // (Parked windows are no rule's: never a candidate, never counted among the browser-sized ones.)
        let candidates = WindowMatcher.candidates(server, pids: pids).filter { !parked.contains($0.number) }
        let big = Set(mine.filter { !parked.contains($0.number) && $0.bounds.width >= WindowMatcher.minSize && $0.bounds.height >= WindowMatcher.minSize }.map(\.number))
        let boundBefore = Set(bindings.values.map(\.number))
        // A key bound to a parked window, or one the registry is about to bind (expectParked): its window is
        // in no user Space, so the reported windows' side of every rule leaves it out too.
        let expectedParked = Set(parkedExpects.map(\.key))
        func parkedKey(_ key: WindowKey) -> Bool { expectedParked.contains(key) || bindings[key].map { parked.contains($0.number) } ?? false }

        // A read that tells nothing (a real session's log, 2026-11-05: reads without any of Safari's windows, next
        // to Space changes, each back a read later): no list at all, or none of the browser-sized windows
        // the last read that told something had, or none of the bound ones, or none at all, and no new
        // one, while the browser runs and its copies still have windows. Nothing is learned or forgotten
        // from it, for `absent` at most.
        let reported = Set(ext.filter { reporting.contains($0.key.link) }.map(\.key))
        let extHas = !held.isEmpty || ext.contains { reporting.contains($0.key.link) && $0.state != "minimized" && !parkedKey($0.key) }
        let liveBound = Set(bindings.filter { !parked.contains($0.value.number) && (!reporting.contains($0.key.link) || reported.contains($0.key)) }.map(\.value.number))
        let fresh = big.contains { seen[$0] == nil }
        let lostAll = big.isEmpty || (!reliableBig.isEmpty && reliableBig.isDisjoint(with: big)) || (!liveBound.isEmpty && liveBound.allSatisfy { present[$0] == nil })
        var collapsed = !pids.isEmpty && extHas && (!listed || (lostAll && !fresh))
        if collapsed {
            if let since = collapsedSince {
                if now - since >= T.absent {
                    if lastReadCollapsed { log("\(browser): the window server's list has been without the browser's windows for \(Int(T.absent)) s: taken as it is") }
                    collapsed = false
                }
            } else {
                collapsedSince = now
                let theirs = server.filter { pids.contains($0.pid) }.count
                let each = boundBefore.sorted().map { n -> String in
                    guard let w = server.first(where: { $0.number == n }) else { return "window \(n) not listed" }
                    return "window \(n) at layer \(w.layer), alpha \(String(format: "%.2f", w.alpha)), \(w.onScreen ? "on" : "off") screen"
                }
                let was = lastMineCount.map { "; the last read that told something had \($0) at layer 0" } ?? ""
                let source = !listed ? "nil" : server.isEmpty ? "an empty list" : "a list"
                log("\(browser): \(listed ? "a read of the window server without the browser's windows" : "the window server gave no list") (\(server.count) entries, \(theirs) the browser's, \(mine.count) at layer 0\(each.isEmpty ? "" : "; " + each.joined(separator: ", "))): bindings kept, nothing learned from it\(was); the source gave \(source)")
            }
            collapsedReads += 1
        } else {
            // The end of an episode of reads that told nothing: how long it lasted, one line.
            if let since = collapsedSince {
                log("\(browser): the window server's list has the browser's windows again after \(Int(((now - since) * 1000).rounded())) ms (\(collapsedReads) read\(collapsedReads == 1 ? "" : "s") told nothing)")
            }
            collapsedSince = nil
            collapsedReads = 0
        }
        lastReadCollapsed = collapsed
        if !collapsed { reads += 1; lastMineCount = mine.count }
        // Since when something may have changed: the last read that told something.
        let after = first ? now : lastReliable
        // A window listed before and missing now: since when. Back, it's the same window (its number is
        // the window's for the login session); missing `absent`, it's gone.
        // (Not a parked window: missing is what it may be, for as long as it's parked.)
        unlisted = unlisted.filter { !parked.contains($0.key) }
        for n in Set(seen.keys).union(retired).union(boundBefore) where present[n] == nil && unlisted[n] == nil && !parked.contains(n) { unlisted[n] = now }
        for n in present.keys.sorted() where unlisted[n] != nil {
            // A bound window the log said was missing: when it's back (a blip), one line.
            if absentSaid.contains(n), let since = unlisted[n], let key = bindings.first(where: { $0.value.number == n })?.key {
                log("\(key): window \(n) back after \(Int(((now - since) * 1000).rounded())) ms")
            }
            unlisted[n] = nil
            absentSaid.remove(n)
        }
        func missing(_ n: Int) -> Bool { present[n] == nil && (unlisted[n].map { now - $0 < T.absent } ?? false) }
        if !collapsed {
            // A parked window is kept as seen however long it's missing: when it's shown again it's the same
            // window, never a new one (made by Margin, created together). One never listed is taken as there before.
            func keep(_ n: Int) -> Bool { present[n] != nil || missing(n) || parked.contains(n) }
            for w in mine where seen[w.number] == nil { seen[w.number] = Seen(at: now, after: after, before: first) }
            for n in parked.sorted() where seen[n] == nil { seen[n] = Seen(at: now, after: after, before: true) }
            seen = seen.filter { keep($0.key) }
            retired = retired.filter(keep)
            for w in mine where serverMoved[w.number]?.bounds != w.bounds { serverMoved[w.number] = (w.bounds, now) }
            serverMoved = serverMoved.filter { keep($0.key) }
            for (n, m) in serverMoved where now - max(m.at, spaceChangedAt) >= T.moved { settledBounds[n] = m.bounds }
            settledBounds = settledBounds.filter { keep($0.key) }
        }

        let nowFront = browserInFront ? candidates.filter(\.onScreen).min(by: { $0.order < $1.order })?.number : nil
        if collapsed {
            // Nothing learned.
        } else if first {
            // In front since before the first read: when isn't known, so taken as now (settled focus waits `quiet`).
            front = nowFront
            frontSince = now
            // When it came to the front isn't known: a change at some time before, which no focus can be told against.
            if nowFront != nil { changes.append(Change(at: now, after: now - T.history, number: nowFront)) }
        } else if nowFront != front {
            if nowFront == nil, let f = front, missing(f) {
                // The front window missing from this read and nothing else in front: not a change until it's
                // back (none) or gone (a change some time since it was last listed).
                if frontMissingAfter == nil { frontMissingAfter = after }
            } else {
                let since = frontMissingAfter ?? after
                let unseen = frontMissingAfter != nil || lastReliable < lastRead
                changes.append(Change(at: now, after: since, number: nowFront, timed: !unseen || now - since <= T.blind))
                front = nowFront
                frontSince = now
                frontMissingAfter = nil
                frontNoted.append("\(nowFront.map(String.init) ?? "none") at \(WindowMatcher.clock(now))")
            }
        } else {
            frontMissingAfter = nil
        }
        if !collapsed {
            // The browser's windows on screen (one missing from this read as it was). One come on screen: a
            // transition from when it may have begun; a Space change heard since then (in this read, or across
            // reads that told nothing) may have come after it: the same transition, from the earlier of the two
            // (a real session's log, 2026-11-05 21:53:03: the front window changed 166 ms before the Space change was
            // heard, and one read saw both). Only gone off screen: the end of the last change if it's that near
            // (a slide), else a transition of its own.
            let onNow = Set(candidates.filter(\.onScreen).map(\.number)).union(lastOnScreen.filter { present[$0] == nil && missing($0) })
            if !first {
                let gone = lastOnScreen.subtracting(onNow)
                let came = !onNow.subtracting(lastOnScreen).isEmpty, went = !gone.isEmpty
                if came || went {
                    if let i = transitions.indices.last, came ? after <= transitions[i].latest : after <= transitions[i].latest + T.visibleLag {
                        transitions[i].front = true
                        if came { transitions[i].at = min(transitions[i].at, after) }
                        transitions[i].latest = max(transitions[i].latest, now)
                        transitions[i].went.formUnion(gone)
                    } else {
                        transitions.append(Transition(at: after, latest: now, space: false, front: true, went: gone))
                        transitions = Array(transitions.suffix(4))
                    }
                }
            }
            for n in onNow where onScreenSince[n] == nil { onScreenSince[n] = first ? -.infinity : after }
            for n in Array(onScreenSince.keys) where !onNow.contains(n) { onScreenSince[n] = nil }
            for n in onNow.union(lastOnScreen) { lastOn[n] = now }
            lastOn = lastOn.filter { present[$0.key] != nil || missing($0.key) }
            lastOnScreen = onNow
        }

        // ---- the extension's side ----
        var byKey: [WindowKey: ExtWindow] = [:]
        for e in ext where reporting.contains(e.key.link) { byKey[e.key] = e }
        let byKeyList = byKey.values.sorted { $0.key < $1.key }
        for e in byKeyList {
            if let b = e.bounds, extMoved[e.key]?.bounds != b { extMoved[e.key] = (b, now) }
            if let t = e.focusedAt, focusHeard[e.key] != t {
                focusHeard[e.key] = t
                let other = byKeyList.contains { $0.key.link == e.key.link && $0.key != e.key && $0.focused }
                focusEvents.append(Event(key: e.key, at: t, contradicted: other))
            }
            if let t = e.createdAt, createHeard[e.key] != t { createHeard[e.key] = t; createEvents.append(Event(key: e.key, at: t)) }
        }
        let gone = { (key: WindowKey) in reporting.contains(key.link) && byKey[key] == nil }
        extMoved = extMoved.filter { !gone($0.key) }
        focusHeard = focusHeard.filter { !gone($0.key) }
        createHeard = createHeard.filter { !gone($0.key) }
        changes.removeAll { $0.at < now - T.history }
        focusEvents.removeAll { $0.at < now - T.history }
        createEvents.removeAll { $0.at < now - T.history }

        // ---- bindings that no longer hold ----
        // (The extension's own word holds on any read: a window closed, a copy gone or new.)
        for (link, copy) in copies where reporting.contains(link) {
            if let before = copyOf[link], before != copy {
                for key in bindings.keys.sorted() where key.link == link { drop(key, "a new copy of Margin started in its profile (its window ids may be new)") }
            }
            copyOf[link] = copy
        }
        for (key, b) in bindings.sorted(by: { $0.key < $1.key }) {
            // Bound from its answer's bounds, its copy's list not caught up yet: not closed.
            if gone(key), let until = awaitingList[key], now < until { continue }
            if parked.contains(b.number) {
                // Parked: only the copy's word, the browser gone, or a new copy (above) drops it.
                var kept: String?
                if pids.isEmpty {
                    drop(key, "window \(b.number), parked, is gone (the browser isn't running)")
                } else if !reporting.contains(key.link) && !held.contains(key.link) {
                    kept = "its copy isn't linked"
                } else if gone(key) {
                    retired.insert(b.number)
                    drop(key, "closed in the browser (window \(b.number) was parked)")
                } else if present[b.number] == nil {
                    kept = "not listed by the window server"
                } else if present[b.number]?.onScreen == false {
                    kept = "off screen"
                }
                if let kept {
                    if parkedKept[key] != kept { parkedKept[key] = kept; log("\(key): window \(b.number) kept while parked: \(kept)") }
                } else {
                    parkedKept[key] = nil
                }
                continue
            }
            if !reporting.contains(key.link) && !held.contains(key.link) {
                drop(key, "its copy isn't linked")
            } else if gone(key) {
                retired.insert(b.number)
                drop(key, "closed in the browser")
            } else if present[b.number] == nil {
                if pids.isEmpty {
                    drop(key, "window \(b.number) is gone from the window server (the browser isn't running)")
                } else if !collapsed, !missing(b.number) {
                    drop(key, "window \(b.number) is gone from the window server (not listed for \(Int(T.absent)) s)")
                } else if !absentSaid.contains(b.number) {
                    absentSaid.insert(b.number)
                    log("\(key): window \(b.number) missing from one read (kept for \(Int(T.absent)) s)")
                }
            }
        }
        for key in awaitingList.keys where byKey[key] != nil || bindings[key] == nil { awaitingList[key] = nil }
        parkedKept = parkedKept.filter { bindings[$0.key].map { parked.contains($0.number) } ?? false }
        conflicts = conflicts.filter { byKey[$0.key] != nil && now - $0.value.at < T.conflict }
        if !collapsed {
            unlisted = unlisted.filter { now - $0.value < T.absent }
            absentSaid = absentSaid.filter { unlisted[$0] != nil }
        }

        // ---- parked windows the registry knows again (expectParked) ----
        // Its own record, not the window server's read: so on any read, after the drops above (a new copy's
        // old bindings gone first).
        var expecting: [ParkedExpect] = []
        for var p in parkedExpects {
            let until = p.until ?? now + T.created
            p.until = until
            let line = "\(p.key): parked window \(p.number) (\(p.why))"
            let holder = bindings.first { $0.value.number == p.number && $0.key != p.key }?.key
            if bindings[p.key]?.number == p.number {
                continue
            } else if pids.isEmpty {
                log("\(line) not bound: the browser isn't running")
            } else if retired.contains(p.number) {
                log("\(line) not bound: it's a closed window's")
            } else if let b = bindings[p.key] {
                log("\(line) not bound: it's window \(b.number)")
            } else if reporting.contains(p.key.link), byKey[p.key] == nil {
                log("\(line) not bound: its copy doesn't list it")
            } else if byKey[p.key] == nil || holder != nil {
                if now >= until {
                    log("\(line) not bound in \(Int(T.created)) s: \(holder.map { "window \(p.number) is \($0)'s" } ?? "its copy hasn't reported")")
                } else {
                    expecting.append(p)
                }
            } else {
                bind(p.key, p.number, now, "parked: \(p.why)")
            }
        }
        parkedExpects = expecting
        parkedKept = parkedKept.filter { bindings[$0.key].map { parked.contains($0.number) } ?? false }

        // (A parked window missing isn't a blip kept for `absent`: it isn't counted here.)
        absentNumbers = Set(bindings.values.map(\.number).filter { present[$0] == nil && !parked.contains($0) })
        if collapsed { steadySince = nil; steadyReads = 0; return numbers }
        // A browser-sized window the last read listed is missing: no binding by elimination this read
        // (unless a new one came with it: a window replaced, a real change).
        let lostSome = !reliableBig.subtracting(big).isEmpty && !fresh
        if fresh { freshAt = now }
        reliableBig = big
        lastReliable = now
        // Reads that told something and missed nothing, in a row: steady, over `visibleHold`.
        if !lostSome, !unlisted.keys.contains(where: { missing($0) && !retired.contains($0) }) {
            if steadySince == nil { (steadySince, steadyReads) = (now, 0) }
            steadyReads += 1
        } else {
            (steadySince, steadyReads) = (nil, 0)
        }
        let steady = steadyReads >= 2 && now - (steadySince ?? now) >= T.visibleHold

        // Free: not bound (a missing bound window is still bound), not a closed window's.
        var bound: Set<Int> { Set(bindings.values.map(\.number)) }
        func freeServer() -> [ServerWindow] { let b = bound; return candidates.filter { !b.contains($0.number) && !retired.contains($0.number) } }
        func freeExt() -> [ExtWindow] { byKey.values.filter { bindings[$0.key] == nil && !parkedKey($0.key) && $0.state != "minimized" && $0.bounds != nil }.sorted { $0.key < $1.key } }
        func fits(_ e: ExtWindow, _ w: ServerWindow) -> Bool { e.bounds.map { WindowMatcher.close($0, w.bounds) } ?? false }
        // Free windows missing from this read, by the bounds they were last listed with: any of them could
        // be the one with those bounds. (Not one gone before a new window came: that's a window replaced.)
        func missingFree(_ r: CGRect) -> Int {
            let b = bound
            return unlisted.filter { n, since in since > freshAt && missing(n) && !b.contains(n) && !retired.contains(n) && (serverMoved[n].map { WindowMatcher.close($0.bounds, r) } ?? false) }.count
        }

        // A window has bounds `r` if it's there now, or it settled there and hasn't settled anywhere else
        // since (a window offset for a moment, in a swipe or Mission Control, still has its own).
        func has(_ n: Int, _ r: CGRect) -> Bool {
            (present[n].map { WindowMatcher.close($0.bounds, r) } ?? false) || (settledBounds[n].map { WindowMatcher.close($0, r) } ?? false)
        }
        // How many of the browser's windows have `r` (bound ones too, missing ones by their last bounds), and how
        // many windows the reporting copies have with it: equal, every window with those bounds is a reported one.
        func serverHaving(_ r: CGRect) -> Int {
            let b = bound
            let listed = candidates.filter { has($0.number, r) }.count
            let gone = unlisted.filter { n, since in missing(n) && present[n] == nil && !retired.contains(n) && (b.contains(n) || since > freshAt) && (serverMoved[n].map { WindowMatcher.close($0.bounds, r) } ?? false) }.count
            return listed + gone
        }
        func extFitting(_ r: CGRect) -> [ExtWindow] { byKey.values.filter { !parkedKey($0.key) && $0.state != "minimized" && ($0.bounds.map { WindowMatcher.close($0, r) } ?? false) }.sorted { $0.key < $1.key } }

        // ---- moved: a bound window whose bounds match one other free window alone, steadily ----
        // Only when the extension's window itself moved since it was bound (a window offset by the window
        // server alone is in a swipe, Mission Control or full screen's animation), its own window has settled
        // elsewhere, the other has kept those bounds all along, and every window with them is a reported one
        // (a Private window, or another profile's without Margin, with the same bounds isn't taken for it).
        for (key, b) in bindings.sorted(by: { $0.key < $1.key }) {
            guard !parked.contains(b.number), let e = byKey[key], e.state != "minimized", let eb = e.bounds, let own = present[b.number] else { drift[key] = nil; continue }
            if WindowMatcher.close(eb, own.bounds) { drift[key] = nil; continue }
            let others = freeServer().filter { WindowMatcher.close(eb, $0.bounds) }
            guard others.count == 1, missingFree(eb) == 0, let other = others.first, freeExt().allSatisfy({ !fits($0, other) }),
                  (extMoved[key]?.at ?? -.infinity) > b.at else { drift[key] = nil; continue }
            guard let d = drift[key], d.number == other.number else { drift[key] = (other.number, now); continue }
            let still = now - (extMoved[key]?.at ?? now) >= T.moved && now - (serverMoved[other.number]?.at ?? now) >= T.moved
            guard now - d.since >= T.moved, still else { continue }
            let ownSettled = settledBounds[b.number].map { !WindowMatcher.close($0, eb) } ?? false
            let otherKept = settledBounds[other.number].map { WindowMatcher.close($0, eb) } ?? false
            guard ownSettled, otherKept, serverHaving(eb) == extFitting(eb).count else { continue }
            drift[key] = nil
            bindings[key] = nil
            bind(key, other.number, now, "its bounds (\(WindowMatcher.describe(eb))) have matched window \(other.number) alone for \(Int(T.moved)) s, not window \(b.number)'s (\(WindowMatcher.describe(own.bounds)))", was: b.number)
        }

        // ---- exact: Accessibility names each window's profile (SafariAX.swift) ----
        // `exact`: window number → the link of the profile its title names. A binding to another profile's key is
        // wrong and goes; a window is bound to its profile's one free window there (or the one free window of
        // its profile with its bounds and state, when the profile has several), with nothing else to wait for.
        if !exact.isEmpty {
            for (number, link) in exact.sorted(by: { $0.key < $1.key }) where !parked.contains(number) && present[number] != nil {
                if let (key, _) = bindings.first(where: { $0.value.number == number }), key.link != link {
                    drop(key, "Accessibility says window \(number) is \(link)'s")
                }
            }
            for (number, link) in exact.sorted(by: { $0.key < $1.key }) where !parked.contains(number) && !retired.contains(number) {
                guard let w = present[number], !bound.contains(number) else { continue }
                let free = byKey.values.filter { $0.key.link == link && bindings[$0.key] == nil && !parkedKey($0.key) && $0.state != "minimized" }.sorted { $0.key < $1.key }
                // The profile's windows the window server lists and no binding has: one, and one of its copy's free.
                let unbound = exact.filter { $0.value == link && present[$0.key] != nil && !parked.contains($0.key) && !bound.contains($0.key) }.count
                if free.count == 1, unbound == 1 {
                    bind(free[0].key, number, now, "Accessibility: its title names \(link), the profile's one window")
                } else if free.count > 1 {
                    let fitting = free.filter { e in (e.bounds.map { WindowMatcher.close($0, w.bounds) } ?? false) || (e.bounds.map { has(number, $0) } ?? false) }
                    let sameSize = exact.filter { $0.value == link && !bound.contains($0.key) && (present[$0.key].map { WindowMatcher.close($0.bounds, w.bounds) } ?? false) }.count
                    if fitting.count == 1, sameSize == 1 {
                        bind(fitting[0].key, number, now, "Accessibility: its title names \(link), the one of its windows with these bounds")
                    }
                }
            }
        }

        // ---- made by Margin's own request ----
        for m in made where bindings[m.key] == nil {
            // Its copy's list may lag the answer: the bounds the answer gave stand in until it lists it.
            let e = byKey[m.key]
            guard e != nil || (m.bounds != nil && reporting.contains(m.key.link)) else { continue }
            let new = freeServer().filter { w in seen[w.number].map { !$0.before && $0.at >= m.since - T.slack } ?? false }
            let rivals = made.filter { $0.key != m.key && bindings[$0.key] == nil && now < $0.until }
            func fitsMade(_ r: CGRect?, _ w: ServerWindow) -> Bool { r.map { WindowMatcher.close($0, w.bounds) } ?? false }
            guard new.count == 1, rivals.isEmpty, let w = new.first, fitsMade(e?.bounds, w) || fitsMade(m.bounds, w) else { continue }
            let by = fitsMade(e?.bounds, w) ? "" : " (by the bounds its answer gave, \(WindowMatcher.describe(m.bounds!))\(e == nil ? ", before its copy listed it" : ""))"
            bind(m.key, w.number, now, "\(m.why) at \(WindowMatcher.clock(m.since)), and window \(w.number), first listed at \(WindowMatcher.clock(seen[w.number]!.at)), is the only new window since\(by)")
            if e == nil { awaitingList[m.key] = m.answered + T.alone + T.reportLag }
        }
        for m in made where bindings[m.key] == nil && now >= m.until {
            log("\(m.key): \(m.why), but no one new window with its bounds came in \(Int(T.created)) s: left to the other rules")
        }
        made.removeAll { bindings[$0.key] != nil || now >= $0.until || (gone($0.key) && now > $0.since + T.alone + T.reportLag) }

        // ---- created together ----
        for i in createEvents.indices where !createEvents[i].decided && now >= createEvents[i].at + T.alone + T.reportLag {
            createEvents[i].decided = true
            let ev = createEvents[i]
            guard bindings[ev.key] == nil, byKey[ev.key] != nil, !parkedKey(ev.key) else { continue }
            let bound = bound
            let new = seen.filter { !$0.value.before && $0.value.at - $0.value.after <= T.maxGap && !bound.contains($0.key) && !retired.contains($0.key) && !parked.contains($0.key) }
            let near = new.filter { ev.at >= $0.value.after - T.alone && ev.at <= $0.value.at + T.alone }
            let at = near.filter { ev.at >= $0.value.after - T.slack && ev.at <= $0.value.at + T.slack }
            let others = createEvents.filter { $0.key != ev.key && abs($0.at - ev.at) <= T.alone }
            guard near.count == 1, at.count == 1, others.isEmpty, let (number, s) = at.first.map({ ($0.key, $0.value) }) else {
                if !near.isEmpty || !others.isEmpty {
                    log("\(ev.key): created at \(WindowMatcher.clock(ev.at)) with \(near.count) new window(s) and \(others.count) other new browser window(s) about then: not told apart that way")
                }
                continue
            }
            pending.append(Pending(key: ev.key, number: number, until: now + T.created,
                                   why: "created together: its copy heard it created at \(WindowMatcher.clock(ev.at)), and window \(number) was first listed by \(WindowMatcher.clock(s.at)), each alone then"))
        }
        for p in pending {
            guard bindings[p.key] == nil, !bound.contains(p.number), let e = byKey[p.key], let w = present[p.number], !retired.contains(p.number) else { continue }
            if candidates.contains(where: { $0.number == p.number }), fits(e, w) {
                bind(p.key, p.number, now, p.why)
            } else if now >= p.until {
                log("\(p.key): created with window \(p.number), but their bounds never agreed (\(e.bounds.map(WindowMatcher.describe) ?? "none") and \(WindowMatcher.describe(w.bounds))): not bound")
            }
        }
        pending.removeAll { p in bindings[p.key] != nil || bound.contains(p.number) || byKey[p.key] == nil || (present[p.number] == nil && !missing(p.number)) || retired.contains(p.number) || parked.contains(p.number) || now >= p.until }

        // ---- focus moved ----
        // The front changes it's weighed against, less blips: no front window for under `frontBlip` between
        // two with one, and the change back to the window that was in front before it.
        var steadyChanges: [Change] = []
        let ch = changes
        for (i, c) in ch.enumerated() {
            let blip = { (j: Int) in j > 0 && j + 1 < ch.count && ch[j].number == nil && ch[j + 1].at - ch[j].at < T.frontBlip }
            if blip(i) { continue }
            if i >= 2, blip(i - 1), c.number == ch[i - 2].number { continue }
            steadyChanges.append(c)
        }
        for i in focusEvents.indices where !focusEvents[i].decided && now >= focusEvents[i].at + T.alone + T.reportLag {
            focusEvents[i].decided = true
            let ev = focusEvents[i]
            let heard = "\(ev.key): focus heard at \(WindowMatcher.clock(ev.at)) not used"
            guard let e = byKey[ev.key], e.state != "minimized" else { log("\(heard): \(byKey[ev.key] == nil ? "its copy no longer reports it" : "it's minimized")"); continue }
            // A parked window focused stays parked and unseen (HANDOFF.md §2.6): its focus says nothing of which window is in front.
            guard !parkedKey(ev.key) else { log("\(heard): its window is parked"); continue }
            guard !ev.contradicted else { log("\(heard): contradicted (its copy called another of its windows focused in that report)"); continue }
            let usable = steadyChanges.filter { $0.timed && $0.at - $0.after <= T.maxGap }
            let near = steadyChanges.filter { ev.at >= $0.after - T.alone && ev.at <= $0.at + T.alone }
            let at = usable.filter { $0.number != nil && ev.at >= $0.after - T.slack && ev.at <= $0.at + T.slack }
            let others = focusEvents.filter { $0.key != ev.key && abs($0.at - ev.at) <= T.alone }
            let fronts = { (list: [Change]) in list.map { $0.number.map(String.init) ?? "none" }.joined(separator: ", ") }
            guard others.isEmpty else { log("\(heard): others (\(others.count) other focus change(s) heard within \(Int(T.alone)) s: \(others.map { $0.key.description }.sorted().joined(separator: ", ")))"); continue }
            guard near.count == 1 else { log("\(heard): near count \(near.count) (front changes within \(Int(T.alone)) s: \(fronts(near)))"); continue }
            guard at.count == 1, let change = at.first, let number = change.number else { log("\(heard): at count \(at.count) (no one timed front change to a window within \(T.slack) s; near: \(fronts(near)))"); continue }
            guard !retired.contains(number) else { log("\(heard): window \(number), in front then, was a closed window's"); continue }
            // Its window missing from this read: weighed again when it's back (or gone).
            guard let w = present[number] else { if missing(number) { focusEvents[i].decided = false }; continue }
            // (Its bounds, or the ones it settled in: a window offset for a moment, in a Space's slide, still has
            // its own. A real session's log, 2026-11-06 21:25:22: the focus change that told it was lost to one.)
            guard fits(e, w) || (e.bounds.map { has(number, $0) } ?? false) else { log("\(heard): doesn't fit window \(number) (\(e.bounds.map(WindowMatcher.describe) ?? "no bounds") and \(WindowMatcher.describe(w.bounds)))"); continue }
            let why = "focus moved to it at \(WindowMatcher.clock(ev.at)) and window \(number) came to the front by \(WindowMatcher.clock(change.at)), each alone then"
            let holder = bindings.first { $0.value.number == number && $0.key != ev.key }?.key
            if bindings[ev.key]?.number == number {
                conflicts[ev.key] = nil
                log("\(ev.key): focus heard at \(WindowMatcher.clock(ev.at)) agrees with its binding (window \(number) came to the front by \(WindowMatcher.clock(change.at)))")
            } else if bindings[ev.key] == nil && holder == nil {
                bind(ev.key, number, now, why)
            } else if let c = conflicts[ev.key], c.number == number, ev.at - c.at > T.alone {
                conflicts[ev.key] = nil
                let was = bindings[ev.key]?.number
                if let holder { drop(holder, "two focus changes say window \(number) is \(ev.key)'s") }
                bindings[ev.key] = nil
                bind(ev.key, number, now, "two focus changes said so (\(WindowMatcher.clock(c.at)), \(WindowMatcher.clock(ev.at))); the last: " + why, was: was)
            } else {
                conflicts[ev.key] = (number, ev.at)
                let mine = bindings[ev.key].map { "it is window \($0.number)" } ?? "it isn't bound"
                log("\(ev.key): \(why), but \(mine)\(holder.map { " and window \(number) is \($0)'s" } ?? ""): kept (a second focus change saying so would move it)")
            }
        }

        // What the pages say (the visible rule, below), as of now: only a word said after the last Space change
        // or new front window (and `visibleLag` after the one before: a page's word may come that late), or,
        // with none since Margin.app started, any word.
        let lastChange = transitions.last
        let threshold: Double = lastChange.map { c in max(c.at, transitions.dropLast().last.map { $0.latest + T.visibleLag } ?? -.infinity) } ?? -.infinity
        func saidSince(_ e: ExtWindow) -> Bool { (e.visibleAt ?? -.infinity) > threshold && e.visible != nil }
        // Hidden: said since the last change, or before it once every page has had its time to say since
        // (a page that was hidden and still says so needn't say it again).
        let settledPages = lastChange.map { now - $0.latest >= T.visibleLag } ?? true
        func hiddenNow(_ e: ExtWindow) -> Bool { e.visible == false && (saidSince(e) || settledPages) }
        // The pages say `e` isn't `w`: its page hidden (said since the last change) while `w` is the one on screen
        // with its bounds, and another profile's window with them says it's shown.
        func pagesDeny(_ e: ExtWindow, _ w: ServerWindow) -> Bool {
            e.visible == false && saidSince(e) && w.onScreen && candidates.filter({ $0.onScreen && WindowMatcher.close($0.bounds, w.bounds) }).count == 1
                && extFitting(w.bounds).contains { $0.key.link != e.key.link && $0.visible == true && saidSince($0) }
        }

        // ---- the only free window with its bounds ----
        // (Not on a read that lost a window the last one listed: the window it'd pick may be standing in for that one.)
        // (And counting windows offset for a moment by their settled bounds. Full-screen bounds, which every
        // profile's full-screen window on a display shares: only while every window with them is a reported one,
        // no link is held and no copy has stopped reporting in the last `away`: a held or missing copy's window
        // may be the one listed while this one's is missing. Otherwise at once, as ever.)
        let copiesAway = !held.isEmpty || linksSeen.keys.contains { !reporting.contains($0) }
        func eliminate() {
            guard !lostSome else { return }
            var changed = true
            while changed {
                changed = false
                let server = freeServer(), free = freeExt()
                for e in free {
                    let windows = server.filter { has($0.number, e.bounds!) }
                    guard windows.count == 1, let w = windows.first, fits(e, w), free.filter({ fits($0, w) }).count == 1, missingFree(e.bounds!) == 0, !pagesDeny(e, w) else { continue }
                    let group = extFitting(w.bounds)
                    if group.contains(where: { $0.state == "fullscreen" }), copiesAway || serverHaving(w.bounds) != group.count { continue }
                    let others = bindings.values.filter { n in !parked.contains(n.number) && (present[n.number].map { WindowMatcher.close($0.bounds, w.bounds) } ?? false) }.count
                    bind(e.key, w.number, now, "the only free window with its bounds (\(WindowMatcher.describe(w.bounds)))" + (others > 0 ? "; \(others) other(s) with them already bound" : ""))
                    changed = true
                    break
                }
            }
        }
        eliminate()

        // ---- visible at once: a window come on screen, and the one page that newly says it's shown ----
        // (a real session's log, 2026-11-06 23:30:19-29: three profiles' full-screen windows, swiped between: macOS says
        // the Space changed only once a slide is over, and a page says it's shown as its window starts sliding
        // in, so the rule below took every word as from before the change, and the two windows not on screen at
        // the start stayed unbound for 10 s, nothing drawn over them.) WebKit says a page is shown only while its
        // window is on screen. So a free window `w` on screen is bound to the free page with its bounds that said
        // it's shown since `w` came on screen (`visibleFresh` before the read before it was seen there), when:
        // that page is the only free one saying it's shown, every other free page with those bounds said it's
        // hidden (its last word), no other free window with those bounds has been on screen within `visibleLag`
        // before that page's word (its page could be the one that said it, late), `w` is the only free window on
        // screen with them, every window with them is a reported one, no link is held, the read misses nothing,
        // and no bound window's page says it's shown while its window isn't on screen (the pages unsettled).
        // A window offset in a slide is weighed by the bounds it settled in, so it's bound as it slides in.
        // Only a window seen coming on screen: one on screen since before Margin.app's first read is left to the
        // rule below (when it came isn't known, so no word can be told newer than it).
        if browserInFront, held.isEmpty, !lostSome, !unlisted.keys.contains(where: { missing($0) && !retired.contains($0) }) {
            for w in freeServer().filter(\.onScreen) {
                guard !bound.contains(w.number), let since = onScreenSince[w.number], since > -.infinity else { continue }
                let r: CGRect
                if !extFitting(w.bounds).isEmpty { r = w.bounds } else if let s = settledBounds[w.number], !extFitting(s).isEmpty { r = s } else { continue }
                let rivals = freeServer().filter { $0.number != w.number && has($0.number, r) }
                guard !rivals.contains(where: \.onScreen) else { continue }
                let group = extFitting(r)
                guard serverHaving(r) == group.count else { continue }
                let free = group.filter { bindings[$0.key] == nil }
                let fresh = free.filter { $0.visible == true && ($0.visibleAt ?? -.infinity) >= since - T.visibleFresh }
                guard fresh.count == 1, let x = fresh.first, let said = x.visibleAt else { continue }
                guard free.allSatisfy({ $0.key == x.key || $0.visible == false }) else { continue }
                guard rivals.allSatisfy({ (lastOn[$0.number] ?? -.infinity) < said - T.visibleLag }) else { continue }
                guard group.allSatisfy({ e in e.visible != true || e.key == x.key || bindings[e.key].map { present[$0.number]?.onScreen == true } == true }) else { continue }
                bind(x.key, w.number, now, "visible at once: its page alone says it's shown (since \(WindowMatcher.clock(said))), window \(w.number) on screen since \(WindowMatcher.clock(since)) the only free one with its bounds (\(WindowMatcher.describe(r)); \(group.count) window(s) with them, all reported), the other free pages hidden")
            }
        }

        // ---- visible: the only page with its bounds that says it's shown, the only window on screen with them ----
        // Each copy knows its own windows only, and their pages say whether they're shown (WebKit marks the
        // pages of a window that isn't on screen hidden). Bound when, for `visibleHold` over steady reads, with
        // the browser in front and no link held: the window is the only one on screen with its bounds, every
        // window with them is a reported one, its page alone says it's shown (said as of now, above), and every
        // other free window's page with them says it's hidden, or has said nothing at all once `visibleQuiet` has
        // passed after the last change's `visibleLag` (a page that was shown and newly said so in the change has
        // said it's hidden by then: the one still saying it's shown is the window on screen; a page that has
        // said nothing is never taken as hidden, nor as shown), or at once when every window the change took off
        // screen is bound (the page whose window went is known, and isn't this one). Not in Margin.app's first
        // `visibleLag` (a switch just before it may not have been said yet). With nothing said, nothing is bound
        // (never guessed).
        let since = lastChange.map { "since \(WindowMatcher.clock($0.at))" } ?? "since Margin.app started"
        var nowSeeing: [Int: (key: WindowKey, since: Double)] = [:]
        // The rule not weighed at all on this read: why, once per change of reason, while a window is free.
        let visibleOff: String? = !browserInFront ? "the browser isn't in front" : !held.isEmpty ? "links held (\(held.sorted().joined(separator: ", ")))" : nil
        if let why = visibleOff, !freeExt().isEmpty {
            if visibleOffSaid != why { visibleOffSaid = why; log("\(browser): the visible rule not weighed: \(why)") }
        } else if visibleOff == nil {
            visibleOffSaid = nil
        }
        if browserInFront, held.isEmpty, now - (firstReadAt ?? now) >= T.visibleLag {
            let server = freeServer().filter(\.onScreen)
            for w in server {
                let group = extFitting(w.bounds)
                guard !group.isEmpty else { continue }
                let shown = candidates.filter { $0.onScreen && WindowMatcher.close($0.bounds, w.bounds) }
                let visible = group.filter { $0.visible == true && saidSince($0) }
                let unsure = group.filter { bindings[$0.key] == nil && !visible.contains($0) && !hiddenNow($0) }
                // Only pages that have said nothing, and the pages long settled since the last change.
                let silent = !unsure.isEmpty && unsure.allSatisfy { $0.visible == nil }
                let wentKnown = lastChange.map { c in c.front && !c.went.isEmpty && c.went.allSatisfy(bound.contains) } ?? false
                let quietFrom = wentKnown ? -.infinity : (lastChange?.latest ?? firstReadAt ?? now) + T.visibleLag + T.visibleQuiet
                let sameServer = serverHaving(w.bounds)
                var reason: String?
                if !steady { reason = "the window server's reads aren't steady yet" }
                else if shown.count != 1 { reason = "\(shown.count) windows with its bounds are on screen" }
                else if sameServer != group.count { reason = "\(sameServer) window(s) have its bounds, \(group.count) reported (a Private window, or a profile without Margin?)" }
                else if visible.count != 1 { reason = visible.isEmpty ? "no page with its bounds says it's shown \(since)" : "\(visible.count) pages say they're shown \(since) (\(visible.map { $0.key.description }.joined(separator: ", ")))" }
                else if bindings[visible[0].key] != nil { reason = "\(visible[0].key) says it's shown, but it's bound to another window" }
                else if !unsure.isEmpty, !silent { reason = "\(unsure.map { $0.key.description }.joined(separator: ", ")) said nothing of being hidden \(since)" }
                else if silent, now < quietFrom { reason = "\(unsure.map { $0.key.description }.joined(separator: ", ")) said nothing yet (the pages settling after the last change)" }
                if let reason {
                    // Said once per window per change, once the pages have had their time to say.
                    let key = "\(lastChange?.at ?? 0) \(reason)"
                    if now - threshold >= T.visibleLag + T.visibleHold, now - (firstReadAt ?? now) >= T.visibleLag + T.visibleHold, visibleSaid[w.number] != key {
                        visibleSaid[w.number] = key
                        log("\(browser): window \(w.number) (on screen, \(WindowMatcher.describe(w.bounds))) not bound from its page: \(reason)")
                    }
                    continue
                }
                let x = visible[0]
                let holding = seeing[w.number].flatMap { $0.key == x.key ? $0.since : nil } ?? now
                nowSeeing[w.number] = (x.key, holding)
                guard now - holding >= T.visibleHold else { continue }
                nowSeeing[w.number] = nil
                visibleSaid[w.number] = nil
                let quiet = silent ? "; \(unsure.map { $0.key.description }.joined(separator: ", ")) said nothing, the others hidden" : ""
                bind(x.key, w.number, now, "visible: its page alone says it's shown (since \(WindowMatcher.clock(x.visibleAt!))), window \(w.number) the only one on screen with its bounds (\(sameServer) window(s) with them, all reported)\(quiet)")
            }
        }
        seeing = nowSeeing
        visibleSaid = visibleSaid.filter { n, _ in candidates.contains { $0.number == n && $0.onScreen } && !bound.contains(n) }

        // A binding its pages say is wrong: its window on screen and its page hidden (said since the last
        // change) for `hiddenDrop`, while another profile's same-bounds window's page says it's shown. Never on
        // pages that said nothing, nor within `hiddenQuiet` of a Space change.
        var hidden: [WindowKey: Double] = [:]
        if browserInFront, steady, now - spaceChangedAt >= T.hiddenQuiet {
            for (key, b) in bindings.sorted(by: { $0.key < $1.key }) {
                guard !parked.contains(b.number), let e = byKey[key], let w = present[b.number], pagesDeny(e, w),
                      let other = extFitting(w.bounds).first(where: { $0.key.link != key.link && $0.visible == true && saidSince($0) }) else { continue }
                let from = hiddenSince[key] ?? now
                hidden[key] = from
                if now - from >= T.hiddenDrop {
                    hidden[key] = nil
                    drop(key, "its page has said it's hidden since \(WindowMatcher.clock(e.visibleAt!)) while window \(b.number) is on screen, and \(other.key)'s page says it's shown (since \(WindowMatcher.clock(other.visibleAt!))): not its window")
                    // And the window whose page says it's shown, bound to one not on screen: not that one either.
                    if let ob = bindings[other.key], present[ob.number]?.onScreen != true {
                        drop(other.key, "its page says it's shown (since \(WindowMatcher.clock(other.visibleAt!))) while window \(ob.number) isn't on screen, and window \(b.number), the only one on screen with its bounds, isn't \(key)'s: not its window")
                    }
                }
            }
        }
        hiddenSince = hidden

        // ---- settled focus ----
        // Within one copy only: its focused flag orders its own windows, never another profile's (each copy
        // calls its own last focused window focused, or none). So only when every window the copies report
        // with the front window's bounds is that one copy's.
        var settledWhy: String?
        let front0 = front.flatMap { f in present[f].map { (f, $0) } }
        if browserInFront, let (f, fw) = front0, !bound.contains(f), !retired.contains(f) {
            let group = byKey.values.filter { $0.state != "minimized" && !parkedKey($0.key) && fits($0, fw) }.sorted { $0.key < $1.key }
            let free = group.filter { bindings[$0.key] == nil }
            let links = Set(group.map(\.key.link))
            let focused = group.filter(\.focused)
            let sameServer = candidates.filter { WindowMatcher.close($0.bounds, fw.bounds) }.count + missingFree(fw.bounds)
            let newest = group.compactMap(\.focusedAt).max()
            if free.isEmpty {
                settledWhy = nil
            } else if !held.isEmpty {
                settledWhy = "links held (\(held.sorted().joined(separator: ", ")))"
            } else if links.count != 1 {
                settledWhy = "the windows with its bounds are \(links.count) copies' (\(links.sorted().joined(separator: ", "))): a copy's focus flags only order its own windows"
            } else if focused.count != 1 {
                settledWhy = "focused count \(focused.count) (\(focused.map { $0.key.description }.joined(separator: ", ")))"
            } else if let x = focused.first, bindings[x.key] != nil {
                settledWhy = "\(x.key), called focused, is bound to another window"
            } else if let x = focused.first, x.blurredAt.map({ $0 > (x.focusedAt ?? -.infinity) }) ?? false {
                settledWhy = "its copy heard none of its windows focused (at \(WindowMatcher.clock(x.blurredAt!))) after \(x.key)"
            } else if let x = focused.first, pagesDeny(x, fw) {
                settledWhy = "\(x.key)'s page says it's hidden"
            } else if sameServer != group.count {
                settledWhy = "sameServer \(sameServer) vs sameExt \(group.count)"
            } else if let x = focused.first, !(newest == nil || x.focusedAt == newest) {
                settledWhy = "\(x.key) is not the newest focus its copy heard"
            }
            if let x = focused.first, settledWhy == nil, !free.isEmpty, focused.count == 1 {
                let recent = frontSince.map { now - $0 < T.quiet } ?? false
                if let s = settling, s.key == x.key, s.number == f {
                    if now - s.since >= T.settle, !recent {
                        bind(x.key, f, now, "settled focus: the only window its copy calls focused for \(String(format: "%.1f", now - s.since)) s, window \(f) in front for \(String(format: "%.1f", now - (frontSince ?? now))) s (\(sameServer) window(s) with its bounds, all its copy's)")
                        settling = nil
                    }
                } else {
                    settling = (x.key, f, now)
                }
            } else {
                settling = nil
            }
        } else {
            settling = nil
        }
        if let why = settledWhy, let f = front {
            let line = "\(browser): settled focus can't bind window \(f): \(why)"
            if settledSaid != line { settledSaid = line; log(line) }
        } else {
            settledSaid = nil
        }
        eliminate()

        // ---- what can't be told yet ----
        // (Not said while a window is missing: it's said, if it still holds, when the list is whole again.)
        if !lostSome, !unlisted.keys.contains(where: { missing($0) && !retired.contains($0) }) {
            let server = freeServer()
            for e in freeExt() {
                let windows = server.filter { fits(e, $0) }.map(\.number).sorted()
                let reason = windows.isEmpty ? "no free window of the browser has its bounds"
                    : windows.count == 1 ? "window \(windows[0]) has its bounds, but so does another of the extension's windows"
                    : "\(windows.count) windows have its bounds (\(windows.map(String.init).joined(separator: ", "))): waiting for a focus change or a creation to tell them apart"
                if waitingSaid[e.key] != reason {
                    waitingSaid[e.key] = reason
                    log("\(e.key) (\(e.state), \(WindowMatcher.describe(e.bounds!))) isn't bound: \(reason); nothing drawn over it")
                }
            }
        }
        waitingSaid = waitingSaid.filter { byKey[$0.key] != nil && bindings[$0.key] == nil }
        absentNumbers = Set(bindings.values.map(\.number).filter { present[$0] == nil && !parked.contains($0) })
        return numbers
    }

    // The front window's changes, one line at most a second (each as its number, or none, and when it was seen).
    private func noteFront(_ now: Double) {
        guard !frontNoted.isEmpty, now - frontNotedAt >= 1 else { return }
        log("\(browser): the front window: \(frontNoted.suffix(12).joined(separator: ", "))\(frontNoted.count > 12 ? " (\(frontNoted.count - 12) before)" : "")")
        frontNoted = []
        frontNotedAt = now
    }

    private func bind(_ key: WindowKey, _ number: Int, _ now: Double, _ why: String, was: Int? = nil) {
        bindings[key] = Binding(number: number, why: why, at: now)
        conflicts[key] = nil
        drift[key] = nil
        waitingSaid[key] = nil
        pending.removeAll { $0.key == key || $0.number == number }
        log("\(key) is window \(number)\(was.map { " (was \($0))" } ?? ""): \(why)")
    }

    private func drop(_ key: WindowKey, _ why: String) {
        guard let b = bindings.removeValue(forKey: key) else { return }
        absentSaid.remove(b.number)
        conflicts[key] = nil
        drift[key] = nil
        parkedKept[key] = nil
        awaitingList[key] = nil
        log("\(key) is no longer window \(b.number): \(why)")
    }
}
