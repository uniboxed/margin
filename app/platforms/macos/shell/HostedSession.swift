// Margin as the app, joined up (docs/MARGIN-APP.md; DECISIONS.md "Margin as the app: the parts joined"): the
// library's items shown in Margin's window by the host engine.
//
// - The library (Library.swift) says what needs a browser or an app (its requests: activateTab, newTab, closeTab,
//   setSpace, openPin, clearToday, restoreArchive); the core's session made here is its sink (inside each perform),
//   and does each one, one at a time, in order.
// - An app item: its app opened by the engine the first time (`.app(bundleId)`: started with no Dock icon, its
//   window full screen and sized to the page area in a Space of its own, then a member of Margin's full-screen Space;
//   Margin's page area shows a loading animation meanwhile), shown again by the engine after (an instant switch);
//   closed, the engine closes it.
// - A web item (Safari): one hosted Safari window per Safari profile in use (`.safariWindow(profile)`), made by that
//   profile's copy (`newWindow`, asked by the engine once the copy has linked) and shown by the engine; the item is a
//   tab of it (the copy's `hostShow { windowId, itemId, url }`: its tab used again, or made, and brought to the
//   front). Two web items of one profile: a tab switch only, the engine isn't asked. Closed: `hostClose { itemId }`.
//   Chrome and Edge items: not hosted yet (said in the log).
// - Margin's window while hosting: always full screen (Tirth, 2026-11-15: MarginWindowController's
//   `alwaysFullScreen`; a window found windowed is asked once more, as a safety check), its whole width, its page
//   drawing its own layout with the sidebar docked (`setHosting`), the engine given the page area from that layout
//   (its placement). Margin's window is in front of what it hosts (decided 2026-11-17: MarginWindowController
//   `keepFront`); the hosted window shows through its page area, a hole while the page card is `shown` (`setHosted`,
//   from the engine's `hostedWindow`). While the engine opens an app for the first time or places it again
//   (`setLoading`, from the engine's `loading`), and while an item's show isn't ready yet (`setShowing`: only after a
//   grace, a switch between prepared windows shows no loader), the page card is opaque with the theme's loader. A press
//   in the page area around a smaller window gives the app the keyboard (`pagePressed`); a field of Margin's letting go
//   of the keys gives them back to the app shown (`fieldClosed`); another window opened in Margin's Space is let in
//   front (`others`). Nothing shown any more (closed, quit, parked): the theme's launcher in its page area again. Taken
//   out of full screen anyway (the green button, Mission Control): the one shown is parked at once
//   (`leavingFullScreen`), the window goes back into full screen by itself, and the item shown is hosted again then
//   (`enteredFullScreen`).
// - A show asked for is the window's item in front at once (`requested`: the sidebar's switch lands as it's asked,
//   while an app can take seconds to come in), and a show overtaken by a newer one for the same window before it
//   started is skipped (fast clicks don't queue a full switch each).
// - An app picked in the palette (`app.open`): an item of the window's space (the one it has for that app, else a new
//   one, `addItem`), then shown. Safari picked: a new web item instead (a blank page, the space's profile). Chrome
//   and Edge picked: not supported yet, nothing done.
// - What the UI draws (`live`): the library's snapshot with the items that have a page (hosted, or a tab of a hosted
//   window) as open tabs of the Margin window they're in (numbered for the UI, which takes only numbers for open
//   tabs: `item(ofTab:)` gives the item back), the one shown in front, so the sidebar highlights it.
//
// - The sidebar's edge dragged while a host is shown (`sidebarResizing`, from the page's word that a change of the
//   width began and that it's over): with live resize (the engine's tiles, docs/HOSTING-CORE.md "Live resize: tiles in
//   Margin's Space"; or a window-mode window, by Accessibility) the hosted window follows each page area of the drag
//   (`follow`: at most one change a display frame, one in flight), the hole the page area as it is meanwhile
//   (`followsPage`), and once it's over the page area it ended on is Margin's (`placeAgain`: the one shown checked at
//   it, the parked ones' tiles sized one at a time after, by the engine's reconciler). Without (no tiles: a plain
//   member): the sidebar slides over the hosted window (Margin's window is in front), the page area's changes are held
//   for the whole drag (such a member can only be placed again out of full screen and in, 1–1.5 s: never one per
//   pointer move), and the hosted window is placed once when it's over, behind the loader. Parked members are placed
//   for the new page area when they're next shown (the engine's own rule).
// - A placing again that fails never drops the item (`placeAgain`): a window that didn't leave full screen stays shown
//   at the frame it had (the engine's), the theme's frame colour in any gap; one that left and didn't come back in is
//   shown again once after a pause, behind the loader, and failing that stays hosted out of sight, its item kept (a
//   click shows it).
//
// One Margin window hosts at a time (the engine has one page area); the others draw the library as kept items.

import AppKit
import MarginCore

// What the session asks of the host engine (HostEngine.swift; a test's stand-in).
protocol HostedEngine: AnyObject {
    // Opens it, or shows it again if it's hosted (always with Margin's window's placement and Space as they are now).
    // `wanted`: still the item asked for (asked while a new app's window is awaited; false: the open is given up,
    // `.failed(.superseded, …)`, for the item picked since).
    func open(app target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64, wanted: (@MainActor () -> Bool)?) async -> HostResult
    func show(_ id: HostID) async -> HostResult
    func close(_ id: HostID) async
    func pageRectChanged(_ placement: HostPlacement) async -> Bool
    func parkShown(why: String) async
    var shown: HostID? { get }
    var hasHosts: Bool { get }
    func isHosted(_ id: HostID) -> Bool
    func mode(of id: HostID) -> HostMode? // how a host is shown (nil: not hosted)
    var shownWindow: Int? { get } // the window of the host shown in Margin's Space (Margin's window in front of it)
    func activateShown(at point: CGPoint?) async // that app in front (a press in Margin's page area around its window; top-left)
    func fullScreenSpace(ofWindow number: Int) -> UInt64?
    func target(ofWindow number: Int) -> HostTarget?
    func launchedPid(bundleId: String) -> pid_t?
    // The person's default browser at Margin's launch: started with no Dock icon if it isn't running (the person's
    // running one used as it is), and its window made ready out of sight (HostEngine `start`, `prepare`).
    var preparesOutOfSight: Bool { get } // a window can be made ready with nothing seen (the early full screen reads)
    func start(bundleId: String) async -> HostApp?
    func prepare(_ target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult
    // A window an app opens only to wake a Safari profile's copy, parked out of sight as it appears (HostEngine
    // `hideWoken`): from the menu's press, no more new ones once Margin asks that profile for its own window, released
    // once it's closed.
    func hideWoken(bundleId: String)
    func stopHidingWoken(bundleId: String)
    func releaseWoken(bundleId: String)
    // The windows the presses have opened so far (each parked out of sight as it's listed, looked for now): the press's
    // evidence that it took. And whether the app runs at all (nil: not known, a stand-in).
    func wokenWindows(bundleId: String) -> Int
    // Those windows parked out of sight and still open (their private Space is kept until there are none).
    func wokenParked(bundleId: String) -> [Int]
    func appRuns(bundleId: String) -> Bool?
    // The full-screen Spaces a running app of this bundle owns (not Margin's), and which of some Spaces the window server
    // still lists (HostEngine): a profile's restored windows' Spaces waited for as they're closed (SafariWaker). Nil: unread.
    func ownFullScreenSpaces(bundleId: String) -> Set<UInt64>?
    func fullScreenSpacesListed(_ spaces: Set<UInt64>) -> Set<UInt64>?
    // Margin quits (HostEngine `quitAll`): nothing is woken, started or pressed any more.
    var quitting: Bool { get }
    // A drag of the sidebar's edge began (true) or is over (false): true back, the one shown follows it live (HostEngine
    // `dragging`: its tile's rect, a window-mode window's frame); then each page area of the drag (`follow`), at most one
    // change a display frame. False: it doesn't (the page area's changes held until the drag is over, as before).
    func dragging(_ on: Bool) -> Bool
    func follow(_ placement: HostPlacement)
    // The one shown fills the page area as it follows (a tile): the hole is the page area meanwhile. Not (a window-mode
    // window, which can be smaller, centred): the hole its bounds, read again as it moves.
    var shownFillsPage: Bool { get }
    // Several visible hosts (docs/PEEK-SPLIT.md §1, HostEngine `setLayout`, `focus`, `visibleHost`): a whole layout at
    // once (main, the others at their rects in their roles, the focused one); the keys to one of them; the one under a
    // press.
    func setLayout(main: HostTarget, mainRect: CGRect?, extras: [HostExtra], focused: HostID?, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> [HostID: HostResult]
    func focus(_ id: HostID) async -> Bool
    // ...its window made key already (the pane click tap's press): Margin's word only, nothing fronted (HostEngine `focus`).
    func focus(_ id: HostID, fronted: Bool) async -> Bool
    func visibleHost(at point: CGPoint) -> HostID?
    // A split's panes (docs/PEEK-SPLIT.md §4): a drag's frame with every visible host's rect in it, as the page measured
    // them; the page area and those rects taken at the drag's end (or any other change); a host's minimum as learnt.
    func follow(_ placement: HostPlacement, rects: [HostID: CGRect])
    func pageRectChanged(_ placement: HostPlacement, rects: [HostID: CGRect]) async -> Bool
    func minimum(of id: HostID) -> CGSize?
    // `id` would be shown today's one-host way: no other host visible, it (if visible) main at the page area (HostEngine
    // `alone`). False: a layout of several is up (a split, a card), or it's at a rect of its own: a show of it is a
    // layout of it alone, never only a tab switch in its window.
    func showsAlone(_ id: HostID) -> Bool
    // The hosted windows visible now, and how many of them follow a drag live (a tile, a window-mode window; a plain
    // member is placed again when it's let go): the log's word for a drag.
    func liveFollowers() -> (follow: Int, visible: Int)
    // Every app's windows' known minimum by bundle id (HostEngine `knownAppMinimums`): told to the page for every pane.
    var knownAppMinimums: [String: CGSize] { get }
    // A new pane's reveal: its own full-screen toolbar out over its page waited for until it rests (HostEngine
    // `toolbarsRest`, bounded); nil: none was out.
    func toolbarsRest(_ ids: [HostID]) async -> String?
    // New Safari windows' pages given their window's keys (out of the address field Safari leaves them in, which keeps
    // its full-screen toolbar down over the page), then the layout's focused host given the keys back (HostEngine
    // `focusPages`); nil: none was a Safari window.
    func focusPages(_ ids: [HostID]) async -> String?
    // A cut pane's arrow (docs/PEEK-SPLIT.md §4b): its window slid to show that side (true: done).
    func slide(_ id: HostID, side: PaneSide) async -> Bool
}

// One of a profile's hosted Safari windows: its profile and its role (docs/PEEK-SPLIT.md §1).
struct SafariKey: Hashable {
    let profile: String
    var role: SafariRole
    init(_ profile: String, _ role: SafariRole = .main) { (self.profile, self.role) = (profile, role) }
}
// (A profile's name alone: its main window, as the map was keyed before.)
extension SafariKey: ExpressibleByStringLiteral {
    init(stringLiteral profile: String) { self.init(profile) }
}

// A Margin window's layout while more than one item is visible (docs/PEEK-SPLIT.md §1): its main item (at the page
// area, or `mainRect`: a split's pane), the others with their roles and rects back to front, the focused one.
struct HostedLayout: Equatable {
    struct Extra: Equatable { var item: String; var role: HostRole; var rect: CGRect }
    var main: String
    var mainRect: CGRect?
    var extras: [Extra]
    var focused: String
    // The split it shows (docs/PEEK-SPLIT.md §4: its panes' rects are its page's `<m-pane>`s), nil: none (the preview card).
    var split: String? = nil
    var items: [String] { [main] + extras.map(\.item) }

    // As the core's `layouts` rows have it (session/state.rs `Layout`): its window, and its parts as JSON text, [main,
    // mainRect, [[item, role, rect]], focused, split].
    // (Written by hand: each layout change writes it, and JSONSerialization costs a few times this. Nil: a rect that
    // isn't finite, which the core wouldn't take either.)
    var cells: String? {
        func text(_ s: String) -> String {
            var out = "\""
            for u in s.unicodeScalars {
                switch u {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case _ where u.value < 0x20: out += String(format: "\\u%04x", u.value)
                default: out.unicodeScalars.append(u)
                }
            }
            return out + "\""
        }
        func rect(_ r: CGRect) -> String? {
            let n = [r.origin.x, r.origin.y, r.size.width, r.size.height].map { Double($0) }
            guard n.allSatisfy(\.isFinite) else { return nil }
            return "[" + n.map { "\($0)" }.joined(separator: ",") + "]"
        }
        var parts: [String] = []
        for e in extras {
            guard let r = rect(e.rect) else { return nil }
            parts.append("[\(text(e.item)),\(text(e.role.rawValue)),\(r)]")
        }
        var head = "null"
        if let m = mainRect {
            guard let r = rect(m) else { return nil }
            head = r
        }
        return "[\(text(main)),\(head),[\(parts.joined(separator: ","))],\(text(focused)),\(split.map(text) ?? "null")]"
    }
    static func decode(_ row: CoreRow) -> (Int, HostedLayout)? {
        guard let text = row.s0, let r = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [Any] else { return nil }
        return decode([row.i0] + r)
    }
    private static func decode(_ r: [Any]) -> (Int, HostedLayout)? {
        func rect(_ v: Any?) -> CGRect? {
            guard let n = v as? [Any], n.count == 4, let x = num(n[0]), let y = num(n[1]), let w = num(n[2]), let h = num(n[3]) else { return nil }
            return CGRect(x: x, y: y, width: w, height: h)
        }
        guard r.count == 6, let window = int(r[0]), let main = r[1] as? String, let list = r[3] as? [[Any]], let focused = r[4] as? String else { return nil }
        let extras = list.compactMap { e -> Extra? in
            guard e.count == 3, let item = e[0] as? String, let role = (e[1] as? String).flatMap(HostRole.init(rawValue:)), let r = rect(e[2]) else { return nil }
            return Extra(item: item, role: role, rect: r)
        }
        return (window, HostedLayout(main: main, mainRect: rect(r[2]), extras: extras, focused: focused, split: r[5] as? String))
    }
}

extension HostedEngine {
    // (A stand-in that doesn't play them: nothing started or prepared, nothing hidden.)
    func hideWoken(bundleId: String) {}
    func stopHidingWoken(bundleId: String) {}
    func releaseWoken(bundleId: String) {}
    func wokenWindows(bundleId: String) -> Int { 0 }
    func wokenParked(bundleId: String) -> [Int] { [] }
    func appRuns(bundleId: String) -> Bool? { nil }
    func ownFullScreenSpaces(bundleId: String) -> Set<UInt64>? { nil }
    func fullScreenSpacesListed(_ spaces: Set<UInt64>) -> Set<UInt64>? { nil }
    var quitting: Bool { false }
    func dragging(_ on: Bool) -> Bool { false }
    func follow(_ placement: HostPlacement) {}
    var shownFillsPage: Bool { false }
    var preparesOutOfSight: Bool { false }
    // (A stand-in with one host at a time: main alone, the others not laid out.)
    func setLayout(main: HostTarget, mainRect: CGRect?, extras: [HostExtra], focused: HostID?, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> [HostID: HostResult] {
        var out = [main.id: await open(app: main, in: placement, marginWindow: marginWindow, marginSpace: marginSpace, wanted: nil)]
        for x in extras { out[x.target.id] = .failed(.place, "one host at a time") }
        return out
    }
    func focus(_ id: HostID) async -> Bool { false }
    func focus(_ id: HostID, fronted: Bool) async -> Bool { fronted ? false : await focus(id) }
    func visibleHost(at point: CGPoint) -> HostID? { nil }
    func follow(_ placement: HostPlacement, rects: [HostID: CGRect]) { follow(placement) }
    func pageRectChanged(_ placement: HostPlacement, rects: [HostID: CGRect]) async -> Bool { await pageRectChanged(placement) }
    func minimum(of id: HostID) -> CGSize? { nil }
    func showsAlone(_ id: HostID) -> Bool { true }
    func liveFollowers() -> (follow: Int, visible: Int) { (shownFillsPage ? 1 : 0, shown == nil ? 0 : 1) }
    var knownAppMinimums: [String: CGSize] { [:] }
    func toolbarsRest(_ ids: [HostID]) async -> String? { nil }
    func focusPages(_ ids: [HostID]) async -> String? { nil }
    func slide(_ id: HostID, side: PaneSide) async -> Bool { false }
    func start(bundleId: String) async -> HostApp? { nil }
    func prepare(_ target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult { .failed(.launch, "no engine to prepare it") }
}

extension HostEngine: HostedEngine {}

// The browser web items open in (UserDefaults `MarginDefaultBrowser`, decided by Tirth 2026-11-16, default "safari"),
// by the setting's value: the core's table (session/choice.rs `default_browser`). Only Safari is hosted now: Chrome
// and Edge join it (and the show's browser check) when they are, with no change to the flow. An unsupported value:
// Safari, said.
enum DefaultBrowser {
    static let key = "MarginDefaultBrowser"
    static func resolve(_ value: String?) -> (name: String, bundleId: String) {
        let out = SessionRules.call(["rule": "defaultBrowser", "setting": value ?? NSNull()])
        if out["supported"] as? Bool != true { Diagnostics.note("hosted: the default browser setting (\(value ?? "")) isn't supported yet: Safari") }
        return (out["name"] as? String ?? "safari", out["bundleId"] as? String ?? safariIdentifier)
    }
}

// One of Margin's windows, as the session drives it (MarginWindowController; a test's stand-in).
protocol HostedWindow: AnyObject {
    var id: Int { get }
    var number: Int { get } // the window server's
    var isFullScreen: Bool { get }
    var hostedPlacement: HostPlacement? { get } // the page area and the display's area while hosting; nil until measured
    // The page area as its page draws it now, not hosting (the launcher's), in full screen, measured at its size; nil
    // until then. A window prepared out of sight is placed there: hosting's own rect when the sidebar is docked in both
    // (Keep open); a hidden sidebar's wider page area means its first show places it again (the engine says so).
    var idlePlacement: HostPlacement? { get }
    var pageAreaWhyNot: String { get } // why there's none yet, for the log
    // Its page asked to measure where `<m-page>` sits now (a size it took without a frame drawn since: no resize event).
    func remeasure()
    func toFullScreen()
    var fullScreenState: String { get } // for the log
    var layoutMode: String? { get } // the mode of the page's last layout
    // While hosting: its own layout, the sidebar docked, no launcher in the page area (the hosted window shows there).
    func setHosting(_ on: Bool)
    // An app opening or placed again in the page area (its name), nil: none: the page card `loading` at once. `app`:
    // the bundle id whose icon the loader shows (the app's; the browser's for a web item), the page's to look up.
    func setLoading(_ label: String?, app: String?)
    // An item being shown and not ready yet (its name), nil: it is: `loading` only if that takes longer than a grace
    // (`pace`, the core's: a quick switch's grace is longer); slow: known to take a while (the last item, at launch):
    // `loading` at once. `app` as setLoading's.
    func setShowing(_ label: String?, app: String?, pace: ShowPace)
    // The items loading, by the UI's numbers for them: the theme's loading bar on the page card's edge for the one in
    // front, and each one's row (host-app.ts `loading`, as a browser copy's `loading` push draws it over a browser).
    func setLoadingTabs(_ numbers: [Int])
    func setHosted(_ number: Int?) // the hosted window shown in its page area (this window in front of it), nil: none
    func hostedMoved() // that window was placed again, or kept where it was: its bounds read again
    func followsPage(_ on: Bool) // the hosted window follows a drag live: the hole is the page area as it is meanwhile
    // The one shown's own minimum width (nil: none): the sidebar's edge stops where the page area would be narrower
    // (its page's resize behaviour, ui/behaviors/resize.ts), as Split View's divider stops at a window's minimum.
    func setPageMinimum(_ width: CGFloat?)
    // Not hosting, its item hosted in another Margin window or parked: the card ("… is in another window. Click to show it here.", faded), nil: none.
    // `picture`: a web item's page as Safari last showed it (a data URL, the copy's `hostPicture`), drawn faded under
    // the card's words; nil: the card alone. In memory only, never logged.
    func setElsewhere(_ label: String?, app: String?, picture: String?)
    // Margin's start held up (its default browser not ready within `startupWait`, or its extension didn't connect):
    // what's wrong, in Margin's words, drawn on the start screen with Try again and Continue without Safari; nil: not.
    func setStartupStuck(_ why: String?)
    // The browser's copy asked to show its item is slow, or no longer (its loader says so; gone with the item). Mechanism.
    func setCopySlow(_ on: Bool)
    func cover(_ number: Int?) // a window of the engine's in its Space not shown yet (a new app's, read), nil: no more
    func yield(to number: Int?) // another app's window opened in its Space: let in front until it's gone (nil)
    func frontRead(_ read: HostEngine.FrontRead) // the poll's read at rest of it and the hosted window: in front, kept so
    // One of Margin's own pages (ItemTarget.margin: "settings") in its page area while nothing's hosted there, nil: the
    // launcher. Its page draws it (ui/host-app.ts `marginPage`); hosting covers it, as it covers the launcher.
    func setMarginPage(_ page: String?)
    func push(_ json: String)
    // Every visible host's window while more than one is (docs/PEEK-SPLIT.md §1: its holes), [] when one is again.
    func setVisibleHosts(_ list: [HostShownWindow])
    // A split's cut panes (docs/PEEK-SPLIT.md §4b), told to its page for their arrows: `{ <item>: { window,
    // left|right|up|down: "slide" } }` (JSON, each side its arrow slides), `{}` for none. Said only when it changes.
    func setPaneCuts(_ json: String)
    // Where its page draws the preview card page (the theme's <m-preview-page>, top-left screen points), nil: none drawn.
    var cardRect: CGRect? { get }
    // A split shown (docs/PEEK-SPLIT.md §4): the panes its page laid out in `<m-page>`, each by its item with its box on
    // the screen (top left), in the split's order (nil: none); each pane's window's minimum told to it (its item's id).
    var paneLayout: (split: String, panes: [PagePane])? { get }
    func setPaneMinimums(_ minimums: [String: CGSize])
    // Every app's windows' known minimum (its bundle id, `web` for the web pages Safari hosts), whether a window of it is
    // open or not: its page lays no pane below its app's and refuses a pane that can't fit before anything is opened.
    func setAppMinimums(_ minimums: [String: CGSize])
    // A split's pane whose window is opening beside the panes shown (its item, its name, the app whose icon its loader
    // shows), nil: none: its page draws a loader over that pane's box only, the others stay shown and usable.
    func setPaneLoading(_ item: String?, label: String?, app: String?)
    // Its page in the core (Margin's own window's PageCore) with its content's and display's frames now: what the
    // session reads at each frame of a drag, typed (docs/CORE-REFACTOR.md step 3 part 7). Nil: a window with no page in
    // the core (a test's), read through `hostedPlacement` and `paneLayout`.
    var pageFrame: (page: OpaquePointer?, content: CGRect, display: CGRect?)? { get }
}

extension HostedWindow {
    var pageFrame: (page: OpaquePointer?, content: CGRect, display: CGRect?)? { nil }
    func setShowing(_ label: String?) { setShowing(label, app: nil, pace: .usual) }
    func setShowing(_ label: String?, slow: Bool) { setShowing(label, app: nil, pace: slow ? .slow : .usual) }
    func setShowing(_ label: String?, app: String?) { setShowing(label, app: app, pace: .usual) }
    func setShowing(_ label: String?, app: String?, slow: Bool) { setShowing(label, app: app, pace: slow ? .slow : .usual) }
    func setLoading(_ label: String?) { setLoading(label, app: nil) }
    func followsPage(_ on: Bool) {}
    func setPageMinimum(_ width: CGFloat?) {}
    func setElsewhere(_ label: String?, app: String?, picture: String?) {}
    func setElsewhere(_ label: String?, app: String?) { setElsewhere(label, app: app, picture: nil) }
    func setStartupStuck(_ why: String?) {}
    func setMarginPage(_ page: String?) {}
    func setVisibleHosts(_ list: [HostShownWindow]) {}
    func setPaneCuts(_ json: String) {}
    var cardRect: CGRect? { nil }
    var paneLayout: (split: String, panes: [PagePane])? { nil }
    func setPaneMinimums(_ minimums: [String: CGSize]) {}
    func setAppMinimums(_ minimums: [String: CGSize]) {}
    func setPaneLoading(_ item: String?, label: String?, app: String?) {}
}


extension MarginWindowController: HostedWindow {
    var number: Int { window.windowNumber }
    var layoutMode: String? { layout?.mode }
    var pageAreaWhyNot: String {
        if !hosting { return "not hosting" }
        guard let layout else { return "no layout from its page" }
        if !isFullScreen { return "not in full screen" }
        if layout.mode != "fullscreen" { return "its last layout is a \(layout.mode) one" }
        if !layout.hosted && !layout.outside { return "its page hasn't measured its layout for hosting yet (its last one is the launcher's)" }
        let content = contentFrame, view = webView.frame.size
        func size(_ s: CGSize) -> String { "\(Int(s.width))×\(Int(s.height))" }
        return "no layout at its size yet (its page measured at \(Int(layout.width))×\(Int(layout.height)), its content \(size(content.size)), its web view \(size(view)))"
    }
    func toFullScreen() { if !isFullScreen { toggleFullScreen() } }
}

// The extension's Safari copies, as the session asks them (the shell's links; a test's stand-in). `profile`: the
// copy's own id (its link key's second part).
protocol HostedLinks: AnyObject {
    func safariProfiles() -> [String] // the Safari copies linked now
    func request(profile: String, _ type: String, _ payload: JSONObject) async -> (result: JSONObject?, error: String?)
    // A profile with no window has no copy running: one of its windows opened from Safari's own File › New Window menu
    // (Accessibility), so its copy starts and links. False: it couldn't be asked.
    // `pressed`: Safari's menu had the profile's item, and it was pressed (false: none by that name, Margin doesn't know
    // the profile's name: Safari's profiles unreadable), told on the main thread once Accessibility answered.
    func openProfileWindow(_ profile: String, pressed: @escaping @MainActor (Bool) -> Void) -> Bool
    // That profile's windows, as its copy lists them.
    func windowIds(of profile: String) -> [Int]
    // Its windows that were there before its copy started (Safari restored them at launch), once its copy has listed its
    // windows; nil: not listed yet.
    func restoredWindowIds(of profile: String) -> [Int]?
    // The epoch of that profile's link now (a new link: a new epoch), nil: not linked.
    func linkEpoch(of profile: String) -> String?
    // A request the session may give up (`asked`: its command's id, session/mod.rs `Command::Ask`), else as `request`;
    // `cancel` gives it up (the session's `Command::Cancel`, its pick overtaken): the link's `cancel`, the copy told, the
    // request returning at once. Mechanism only: the core decides when.
    func request(profile: String, _ type: String, _ payload: JSONObject, asked: UInt64?) async -> (result: JSONObject?, error: String?)
    func cancel(profile: String, asked: UInt64)
    // How long that profile's copy has been slow (the link's `slow`: its oldest request not acked, in seconds), nil: it
    // isn't, or it's not linked. The session's feedback only.
    func slow(of profile: String) -> Double?
}

final class HostedSession {
    struct Options {
        var firstCopiesPace = 10.0 // a Safari with no copy linked yet: its own copies' turn before its menu is pressed for a profile
        var pressPace = 2.0 // Safari's menu pressed again after this (times the presses so far) while no window came of one
        var wakePresses = 4 // ...this many presses at most, each opening nothing: given up
        var linkSayEvery = 5.0 // a profile's copy still not linked: said this often
        var fullScreenWait = 6.0 // Margin's window into full screen
        var pageWait = 3.0 // its page area measured (its layout in full screen, hosting)
        var every = 0.05
        var safariBundles: Set<String> = [safariIdentifier, "com.apple.SafariTechnologyPreview"]
        var closesRestoredSafariWindows = true // (Tirth, 2026-11-15) a Safari Margin started: its restored windows closed
        var preparesBrowser = true // (Tirth, 2026-11-16) the default browser's window made ready out of sight at launch
        var prepareWindowWait = 30.0 // a Margin window in full screen with its page area measured, at launch
        var refitRetryAfter = 1.5 // a placing again that left the window out of full screen: shown again once, this long after
        var resumesLast = true // (Tirth, 2026-11-17) at launch, the item the window showed last is shown again, behind the loader
        var startupWait = 15.0 // (Tirth, 2026-11-18) at launch, how long the default browser's start holds the item shown last
        var pictureWait = 0.4 // a web item's picture for its card in the other window, asked before its window leaves: no longer
        var wokenLate = 3.0 // closed this soon after the link, the profile's windows that came since are the press's too
        var wokenGrace = 5.0 // a window opened to wake a profile, still open this long after its copy linked with no request under way: closed
        var restoredWait = 3.0 // a Safari Margin started: its restored windows of a profile just linked, closed and waited for (with their full-screen Spaces) at most this long
        var cycleWindow = 1.0 // (Tirth, 2026-11-20) a pick this soon after the next/previous-tab key in its window: a cycle's
        var cycleHold = 0.35 // ...an app not running yet held this long before it's started: one only passed over is never started
        var paneIdle = 900.0 // (docs/PEEK-SPLIT.md §4) a split's pane window of a profile unused this long: closed
        var quitWait: Double? // the engine's own (HostEngine.Options.quitWait), set as they're joined: at quit, a copy's request it waits for no longer
    }

    // Where an item's page is: its host, and for a web item its profile.
    struct OpenItem: Equatable {
        let host: HostID
        let profile: String?
    }

    static let defaultSafariProfile = BrowserProfiles.defaultProfile // the default profile's copy

    // (The Swift struct the tests change after init; each change sent whole to the core, which reads what its flows use.)
    var options: Options { didSet { drive(core.input(["type": "options", "options": options.json])) } }
    let library: Library
    let engine: HostedEngine
    let links: HostedLinks
    // A Margin window by its id, or (nil) the one in front; every Margin window's id.
    var window: (Int?) -> HostedWindow? = { _ in nil }
    var windowIds: () -> [Int] = { [] }
    // An installed app's name (the catalog's), for a new app item.
    var appName: (String) -> String? = { _ in nil }
    // The live state changed (what's open, what's shown): the windows draw again.
    var onChange: (() -> Void)?
    var sleep: (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
    var now: () -> Double = { ProcessInfo.processInfo.systemUptime }
    // Whether Margin is the active app, and making it so again (a browser's window made ready may take the focus).
    var marginActive: () -> Bool = { false }
    var activateMargin: () -> Void = {}

    // Each Margin window's item shown; each item with a page; each Safari profile's hosted window (the copy's id).
    // (The core's, core/session/state.rs: read again only when its revision changed, written as the difference, both
    // as typed rows.)
    private(set) var shown: [Int: String] {
        get { field(.shown) { Self.intText($0) } }
        set { setMap(.shown, old: shown, newValue) { CoreRow(i0: $0, s0: $1) } }
    }
    private(set) var open: [String: OpenItem] {
        get { field(.open) { rows in Dictionary(rows.compactMap { r in r.s0.flatMap { i in r.s1.map { (i, OpenItem(host: HostID(raw: $0), profile: r.s2)) } } }, uniquingKeysWith: { a, _ in a }) } }
        set { setMap(.open, old: open, newValue) { CoreRow(s0: $0, s1: $1?.host.raw, s2: $1?.profile) } }
    }
    // (Each profile's hosted windows by role, docs/PEEK-SPLIT.md §1: its main one, its card, a split's panes.)
    private(set) var safariWindows: [SafariKey: Int] {
        get {
            field(.safariWindows) { rows in
                Dictionary(rows.compactMap { r in r.s0.flatMap { p in r.s1.flatMap(SafariRole.init(name:)).map { (SafariKey(p, $0), r.i0) } } }, uniquingKeysWith: { a, _ in a })
            }
        }
        set { setMap(.safariWindows, old: safariWindows, newValue) { CoreRow(i0: $1 ?? 0, s0: $0.profile, s1: $0.role.description) } }
    }
    // Each Margin window's layout while more than its item shown is visible (the preview card, a split's panes): main, the
    // others with their roles and rects, the focused one (`shown[w]`). None: one item shown, as before. (The core's
    // field, `layouts`, its flows' (layouts.rs, card.rs); written here only by a press that focuses a pane.)
    private(set) var layout: [Int: HostedLayout] {
        get { field(.layouts) { rows in Dictionary(rows.compactMap { HostedLayout.decode($0) }, uniquingKeysWith: { a, _ in a }) } }
        set { setMap(.layouts, old: layout, newValue) { w, l in CoreRow(i0: w, s0: l?.cells) } }
    }
    private(set) var hostingWindow: Int? {
        get { field(.hostingWindow) { $0.first?.i0 } }
        set { setOne(.hostingWindow, old: hostingWindow, newValue) { CoreRow(i0: $0) } }
    }
    // Each Margin window's own page shown (ItemTarget.margin's page: Settings), drawn by the window itself.
    var marginPages: [Int: String] { field(.marginPages) { Self.intText($0) } }
    // Each Margin window's item shown when macOS took the window out of full screen: hosted again once it's back in.
    // (The core's: the start writes it too.)
    private(set) var resume: [Int: String] {
        get { field(.resume) { Self.intText($0) } }
        set { setMap(.resume, old: resume, newValue) { CoreRow(i0: $0, s0: $1) } }
    }
    // The item each host is being shown for (the loading bar's own, the core's: core/session/loading.rs), each web
    // item's tab in its Safari window (the copy's id, from hostShow).
    private var showing: [HostID: String] { field(.showing) { Self.hostText($0) } }
    private(set) var safariTabs: [String: Int] {
        get { field(.safariTabs) { rows in Dictionary(rows.compactMap { r in r.s0.map { ($0, r.i0) } }, uniquingKeysWith: { a, _ in a }) } }
        set { setMap(.safariTabs, old: safariTabs, newValue) { CoreRow(i0: $1 ?? 0, s0: $0) } }
    }
    // Each web item's tab's sound, as its profile's copy says (copyTabs): playing, muted. (None: not heard yet.)
    private(set) var safariAudio: [String: (audible: Bool, muted: Bool)] {
        get {
            field(.safariAudio) { rows in
                Dictionary(rows.compactMap { r -> (String, (audible: Bool, muted: Bool))? in r.s0.map { ($0, (audible: r.b0, muted: r.b1)) } }, uniquingKeysWith: { a, _ in a })
            }
        }
        set {
            let old = safariAudio
            var put: [CoreRow] = []
            for (k, v) in newValue {
                if let o = old[k], o.audible == v.audible, o.muted == v.muted { continue }
                put.append(CoreRow(b0: v.audible, b1: v.muted, s0: k))
            }
            write(.safariAudio, newValue, puts: put, dels: old.keys.filter { newValue[$0] == nil }.map { CoreRow(s0: $0) })
        }
    }
    // Each Margin window's item asked to be shown and not shown yet (the newest): drawn in front at once.
    var requested: [Int: String] {
        get { field(.requested) { Self.intText($0) } }
        set { setMap(.requested, old: requested, newValue) { CoreRow(i0: $0, s0: $1) } }
    }
    // The first run's space (the library was empty), for the UI's editor once a window's page is drawn.
    var firstSpace: String?
    // What was done, newest last (the tests read it; numbers, item ids and bundle ids only): the core's, the last 200.
    var done: [String] {
        let rev = core.rev(.done)
        if rev != doneKept.rev { doneKept = (rev, core.done) }
        return doneKept.lines
    }
    private var doneKept: (rev: UInt64, lines: [String]) = (0, [])
    // The preview cards and Quick Tab (HostedPeek.swift, docs/PEEK-SPLIT.md §2, §3): each profile's card and the Margin
    // windows with Quick Tab's field up, the core's (core/session/card.rs: a card's row its profile and its parts as
    // JSON text, read again only when one changed); the card whose window's first open is under way (its own loader,
    // never the page card's: the loading bar's, part 8).
    var cards: [String: PeekCard] { field(.cards) { rows in Dictionary(rows.compactMap { PeekCard(row: $0) }.map { ($0.profile, $0) }, uniquingKeysWith: { a, _ in a }) } }
    var littleArcs: [Int: String] { field(.littleArcs) { Self.intText($0) } }

    init(library: Library, engine: HostedEngine, links: HostedLinks, options: Options = Options()) {
        self.library = library
        self.engine = engine
        self.links = links
        self.options = options
        core = SessionCore(library: library, options: options.json)
        core.owner = self
        takeLibraryRequests()
    }

    // The session the library's requests' sink in the core (from its start; again, of several sessions over one
    // library: the tests' rigs): a perform's requests reach it inside the perform, and one Swift makes itself, outside
    // the session's calls, then has what they left answered here.
    func takeLibraryRequests() {
        core.takeRequests()
        library.onRequests = { [weak self] in self?.edited() }
    }

    // ---- the core (core/session/, SessionCore.swift: docs/CORE-REFACTOR.md step 3) ----

    // The session's object in margin-core: the one queue the core's flows and the Swift's jobs take their turns in, the
    // state they share, the log. Its ports (`port`, `now`) call back here during a call.
    let core: SessionCore
    // The core's fields as last read, by their revisions (`field`): read again only when one changed there, and
    // written as the difference (`setMap`, `setOne`), the value written kept with the revision it made. Rows
    // both ways, no JSON.
    private var cache: [UInt32: (rev: UInt64, value: Any)] = [:]
    private func field<T>(_ f: SessionCore.Field, _ decode: ([CoreRow]) -> T) -> T {
        let rev = core.rev(f)
        if let c = cache[f.rawValue], c.rev == rev, let v = c.value as? T { return v }
        let v = decode(core.rows(f))
        cache[f.rawValue] = (rev, v)
        return v
    }
    // (What's gone first, then what's put, as a field's edit always did.)
    private func write<T>(_ f: SessionCore.Field, _ value: T, puts: [CoreRow], dels: [CoreRow]) {
        guard !puts.isEmpty || !dels.isEmpty else { return }
        var rev: UInt64 = 0
        for d in dels { rev = core.edit(f, del: true, d) }
        for p in puts { rev = core.edit(f, del: false, p) }
        cache[f.rawValue] = (rev, value)
        // (An item asked for in a window: the start screen held up re-checks on it, in the next turn.)
        if f == .requested, core.ready { runSoon() }
    }
    private func setMap<K: Hashable, V: Equatable>(_ f: SessionCore.Field, old: [K: V], _ new: [K: V], row: (K, V?) -> CoreRow) {
        write(f, new, puts: new.filter { old[$0.key] != $0.value }.map { row($0.key, $0.value) }, dels: old.keys.filter { new[$0] == nil }.map { row($0, nil) })
    }
    private func setOne<V: Equatable>(_ f: SessionCore.Field, old: V?, _ new: V?, row: (V) -> CoreRow) {
        guard old != new else { return }
        write(f, new, puts: new.map { [row($0)] } ?? [], dels: new == nil ? [CoreRow()] : [])
    }
    private static func intText(_ rows: [CoreRow]) -> [Int: String] {
        Dictionary(rows.compactMap { r in r.s0.map { (r.i0, $0) } }, uniquingKeysWith: { a, _ in a })
    }
    private static func hostText(_ rows: [CoreRow]) -> [HostID: String] {
        Dictionary(rows.compactMap { r in r.s0.flatMap { h in r.s1.map { (HostID(raw: h), $0) } } }, uniquingKeysWith: { a, _ in a })
    }
    private static func texts(_ rows: [CoreRow]) -> Set<String> { Set(rows.compactMap(\.s0)) }

    // A call's answer carried out: its log lines said, the timer at its deadline, each command it handed out started at
    // once in order, then the core told they are (its run goes on), until one hands out none; tasks an input made ready
    // run in a task of their own (after the code that asked, as `enqueue`'s did). The first answer back.
    @discardableResult private func drive(_ answer: JSONObject) -> JSONObject {
        var next = answer
        while true {
            for line in next["log"] as? [JSONObject] ?? [] {
                guard let text = line["text"] as? String else { continue }
                if line["warn"] as? Bool == true { Diagnostics.warn(text) } else { Diagnostics.note(text) }
            }
            arm(num(next["deadline"]))
            let starts = next["start"] as? [JSONObject] ?? []
            if starts.isEmpty {
                if next["ready"] as? Bool == true { runSoon() }
                break
            }
            replied = false
            for c in starts { start(c) }
            // (A Swift caller answered: it goes on first, as a Swift call's return did; the run after it, next turn.)
            if replied { runSoon(); break }
            if #available(macOS 26.0, *) {
                next = core.tick(0)
            } else {
                // (Before macOS 26 a task can't start at once: each start is a task, the run goes on in the next one.)
                runSoon()
                break
            }
        }
        // (Nothing under way any more: the windows closed meanwhile are let go, as the Swift flows let go of theirs.)
        if core.idle, calls.isEmpty, !seen.isEmpty { seen = seen.filter { window($0.key) != nil } }
        if let o = opened, resuming != o.id, !startupShown { opened = nil }
        if core.idle, !idleWaiters.isEmpty {
            let waiting = idleWaiters
            idleWaiters = []
            for k in waiting { k.resume() }
        }
        return answer
    }

    // The core's ready tasks run in the next turn of the main actor (once).
    private var runQueued = false
    private var replied = false
    private func runSoon() {
        guard !runQueued else { return }
        runQueued = true
        Task {
            self.runQueued = false
            self.drive(self.core.tick(0))
        }
    }

    // A command started (session/mod.rs `Command`): a copy's request, a Swift job's turn, an engine's operation.
    private func start(_ c: JSONObject) {
        guard let id = (c["id"] as? NSNumber)?.uint64Value else { return }
        switch c["op"] as? String {
        case "ask":
            let profile = c["profile"] as? String ?? "", kind = c["kind"] as? String ?? "", payload = c["payload"] as? JSONObject ?? [:]
            startNow {
                let (result, error) = await self.links.request(profile: profile, kind, payload, asked: id)
                self.drive(self.core.answer(id, ["result": result ?? NSNull(), "error": error ?? NSNull()]))
            }
        case "cancel":
            // (An ask given up, its pick overtaken: the link's cancel. Its own answer, when it comes, is let go.)
            if let ask = (c["ask"] as? NSNumber)?.uint64Value { links.cancel(profile: c["profile"] as? String ?? "", asked: ask) }
            drive(core.answer(id, [:]))
        case "run":
            let body = (c["job"] as? NSNumber).flatMap { jobs.removeValue(forKey: $0.uint64Value) }
            startNow {
                await body?()
                self.drive(self.core.answer(id, [:]))
            }
        case "engine":
            let args = c["args"] as? JSONObject ?? [:]
            switch c["name"] as? String {
            case "open":
                guard let target = Self.hostTarget(args["target"]), let placement = placement(args["placement"]),
                      let wid = int(args["window"]) else {
                    drive(core.answer(id, ["failed": HostStep.margin.rawValue, "why": "the core's open wasn't one"]))
                    return
                }
                let space = (args["space"] as? NSNumber)?.uint64Value ?? 0, item = args["item"] as? String ?? ""
                let number = held(wid)?.number ?? -1
                startNow {
                    let result = await self.engine.open(app: target, in: placement, marginWindow: number, marginSpace: space, wanted: {
                        self.core.openWanted(window: wid, item: item)
                    })
                    self.drive(self.core.answer(id, Self.json(result)))
                }
            case "parkShown":
                let why = args["why"] as? String ?? ""
                startNow {
                    await self.engine.parkShown(why: why)
                    self.drive(self.core.answer(id, [:]))
                }
            case "close":
                let host = HostID(raw: args["host"] as? String ?? "")
                startNow {
                    await self.engine.close(host)
                    self.drive(self.core.answer(id, [:]))
                }
            case "show":
                let host = HostID(raw: args["host"] as? String ?? "")
                startNow {
                    let result = await self.engine.show(host)
                    self.drive(self.core.answer(id, Self.json(result)))
                }
            case "setLayout":
                guard let main = Self.hostTarget(args["main"]), let placement = placement(args["placement"]), let number = int(args["window"]) else {
                    drive(core.answer(id, ["results": []]))
                    return
                }
                let extras = (args["extras"] as? [JSONObject] ?? []).compactMap { e -> HostExtra? in
                    guard let t = Self.hostTarget(e["target"]), let role = (e["role"] as? String).flatMap(HostRole.init(rawValue:)), let r = Self.rect(e["rect"]) else { return nil }
                    return HostExtra(target: t, role: role, rect: r)
                }
                let mainRect = Self.rect(args["mainRect"]), focused = (args["focused"] as? String).map(HostID.init(raw:))
                let space = (args["space"] as? NSNumber)?.uint64Value ?? 0
                startNow {
                    let results = await self.engine.setLayout(main: main, mainRect: mainRect, extras: extras, focused: focused, in: placement, marginWindow: number, marginSpace: space)
                    // (Each result as the Swift writes it too, for the layout's line.)
                    self.drive(self.core.answer(id, ["results": results.map { [$0.key.raw, Self.json($0.value), "\($0.value)"] }]))
                }
            case "focusPages", "toolbarsRest":
                let hosts = (args["hosts"] as? [String] ?? []).map(HostID.init(raw:)), focus = c["name"] as? String == "focusPages"
                startNow {
                    _ = focus ? await self.engine.focusPages(hosts) : await self.engine.toolbarsRest(hosts)
                    self.drive(self.core.answer(id, [:]))
                }
            case "pageRectChanged":
                guard let placement = placement(args["placement"]) else { drive(core.answer(id, ["placed": false])); return }
                let rects = (args["rects"] as? [[Any]]).map { Self.hostRects($0) }
                startNow {
                    let placed = if let rects { await self.engine.pageRectChanged(placement, rects: rects) } else { await self.engine.pageRectChanged(placement) }
                    self.drive(self.core.answer(id, ["placed": placed]))
                }
            case "start":
                let bundle = args["bundle"] as? String ?? ""
                startNow {
                    let app = await self.engine.start(bundleId: bundle)
                    self.drive(self.core.answer(id, ["started": app != nil]))
                }
            case "prepare":
                // (At that window's launcher's page area, as the core checked it just now.)
                guard let target = Self.hostTarget(args["target"]), let mw = held(int(args["window"])), let placement = mw.idlePlacement else {
                    drive(core.answer(id, ["failed": HostStep.margin.rawValue, "why": "the core's prepare wasn't one"]))
                    return
                }
                let space = (args["space"] as? NSNumber)?.uint64Value ?? 0
                startNow {
                    let result = await self.engine.prepare(target, in: placement, marginWindow: mw.number, marginSpace: space)
                    self.drive(self.core.answer(id, Self.json(result)))
                }
            default:
                drive(core.answer(id, ["error": "not an engine operation"]))
            }
        case "waker":
            let args = c["args"] as? JSONObject ?? [:], profile = args["profile"] as? String ?? ""
            switch c["name"] as? String {
            case "ensureLinked":
                // (The launch's preparation: woken only while it can still happen, the core's `prepare_wanted`.)
                let prepare = args["prepare"] as? Bool == true
                startNow {
                    let linked = await self.waker.linked(profile, wakeIf: prepare ? { self.core.prepareWanted } : nil)
                    self.drive(self.core.answer(id, ["linked": linked]))
                }
            case "closeWoken":
                let except = int(args["except"]), why = args["why"] as? String ?? ""
                startNow {
                    await self.waker.closeWoken(profile, except: except, why: why)
                    self.drive(self.core.answer(id, [:]))
                }
            default:
                drive(core.answer(id, ["error": "not the waker's"]))
            }
        case "done":
            if let then = (c["then"] as? NSNumber).flatMap({ thens.removeValue(forKey: $0.uint64Value) }) { then() }
            drive(core.answer(id, [:]))
        case "reply":
            if let to = (c["to"] as? NSNumber)?.uint64Value, let k = calls.removeValue(forKey: to) {
                replied = true
                k.resume(returning: c["value"] is NSNull ? nil : c["value"])
            }
            drive(core.answer(id, [:]))
        default:
            drive(core.answer(id, ["error": "not a command"]))
        }
    }

    // An operation started at once: its synchronous part now, as `await` ran it (macOS 26 and later; before, a task).
    private func startNow(_ op: @escaping () async -> Void) {
        if #available(macOS 26.0, *) { Task.immediate { await op() } } else { Task { await op() } }
    }

    // The one timer, at the core's earliest deadline: slept with `sleep` (a test's own), then that deadline ticked.
    private var timerAt: Double?
    private var timerGen = 0
    private var timer: Task<Void, Never>?
    private func arm(_ at: Double?) {
        guard at != timerAt else { return }
        timer?.cancel()
        timer = nil
        timerAt = at
        // (A timer let go, its deadline dropped, never ticks: a cancelled sleep ends early, and its tick would move the
        // core's time to a deadline still ahead.)
        timerGen += 1
        guard let at else { return }
        let gen = timerGen
        timer = Task { [weak self] in
            guard let self else { return }
            await self.sleep(max(0, at - self.now()))
            guard self.timerGen == gen else { return }
            self.timer = nil
            self.timerAt = nil
            self.drive(self.core.tick(max(self.now(), at)))
        }
    }

    // The core's rare ports (session/mod.rs `Ports`), as JSON, answered during its call: the ones margin-ffi has no typed
    // kind for (every other one is `typedPort`'s: SessionCore always gives the typed call, so the core never asks them
    // here). Margin's windows' facts and acts, the engine's minimums and the drag, the Swift step, the settings, the OS's.
    func port(_ ask: JSONObject) -> JSONObject {
        switch ask["port"] as? String {
        case "windowFullScreenState": return ["state": held(int(ask["window"]))?.fullScreenState ?? ""]
        case "windowWhyNot": return ["why": held(int(ask["window"]))?.pageAreaWhyNot ?? ""]
        case "paneLayout":
            guard let pl = held(int(ask["window"]))?.paneLayout else { return [:] }
            return ["split": pl.split, "panes": pl.panes.map { [$0.item] + Self.json($0.rect) }]
        case "remeasure": held(int(ask["window"]))?.remeasure(); return [:]
        case "toFullScreen": held(int(ask["window"]))?.toFullScreen(); return [:]
        case "setHosted": held(int(ask["window"]))?.setHosted(int(ask["number"])); return [:]
        case "setPaneMinimums": held(int(ask["window"]))?.setPaneMinimums(Self.sizes(ask["minimums"])); return [:]
        case "followsPage": held(int(ask["window"]))?.followsPage(ask["on"] as? Bool == true); return [:]
        case "hostedMoved": held(int(ask["window"]))?.hostedMoved(); return [:]
        case "minimum": return engine.minimum(of: HostID(raw: ask["host"] as? String ?? "")).map { ["size": [Double($0.width), Double($0.height)]] } ?? [:]
        case "dragging": return ["follows": engine.dragging(ask["on"] as? Bool == true)]
        case "shownFillsPage": return ["fills": engine.shownFillsPage]
        case "liveFollowers": let n = engine.liveFollowers(); return ["follow": n.follow, "visible": n.visible]
        case "swift": return ["value": swiftCall(ask["call"] as? String ?? "", ask["args"] as? JSONObject ?? [:]) ?? NSNull()]
        case "setCopySlow": held(int(ask["window"]))?.setCopySlow(ask["on"] as? Bool == true); return [:]
        case "settings": return ["settings": uiSettings() ?? NSNull()]
        case "linkSlow": return links.slow(of: ask["profile"] as? String ?? "").map { ["secs": $0] } ?? [:]
        case "idna": return ["ok": (ask["host"] as? String).map(SessionRules.idna) ?? false]
        case "urlHost": return (ask["url"] as? String).flatMap { URL(string: $0)?.host }.map { ["host": $0] } ?? [:]
        default: return [:]
        }
    }

    // The typed ports (margin-ffi session.rs `PortKind`): a number back (`SessionCore.none`:
    // none), texts and lists given back through `out` during the call.
    func typedPort(_ kind: UInt32, _ a: MarginPortArgs, _ out: OpaquePointer?) -> Int64 {
        let none = SessionCore.none
        let text = { SessionCore.text(a.a) }
        let w = a.has_window ? Int(a.window) : nil
        switch SessionCore.PortKind(rawValue: kind) {
        case .window?:
            guard let win = window(w) else { return none }
            if seen[win.id] !== win { seen[win.id] = win }
            return Int64(win.id)
        case .windowIds?: for id in windowIds() { SessionCore.give(id, out) }
        case .engineShown?: if let h = engine.shown { SessionCore.give(h.raw, out) }
        case .isHosted?: return engine.isHosted(HostID(raw: text() ?? "")) ? 1 : 0
        case .safariProfiles?: for p in links.safariProfiles() { SessionCore.give(p, out) }
        case .linkEpoch?: if let e = links.linkEpoch(of: text() ?? "") { SessionCore.give(e, out) }
        case .appName?: if let n = appName(text() ?? "") { SessionCore.give(n, out) }
        case .appRuns?: return engine.appRuns(bundleId: text() ?? "").map { $0 ? 1 : 0 } ?? none
        case .showsAlone?: return engine.showsAlone(HostID(raw: text() ?? "")) ? 1 : 0
        case .stopHidingWoken?: engine.stopHidingWoken(bundleId: text() ?? safariIdentifier)
        case .windowIdsOf?: for id in links.windowIds(of: text() ?? "") { SessionCore.give(id, out) }
        case .setShowing?: held(w)?.setShowing(text(), app: SessionCore.text(a.b), pace: a.flag ? .slow : SessionCore.text(a.c) == "quick" ? .quick : .usual)
        case .setMarginPage?: held(w)?.setMarginPage(text())
        case .push?: if let json = text() { held(w)?.push(json) }
        case .changed?: onChange?()
        case .wokenByMenu?: return wokenByMenu[text() ?? ""] != nil ? 1 : 0
        case .unopenable?: return unopenable.contains(text() ?? "") ? 1 : 0
        case .log?: if let t = text() { if a.flag { Diagnostics.warn(t) } else { Diagnostics.note(t) } }
        case .wall?: return SessionCore.bits(Date().timeIntervalSince1970)
        case .cardRect?: return SessionCore.give(held(w)?.cardRect, out)
        case .hostedPage?: return SessionCore.give(held(w)?.hostedPlacement?.page, out)
        // (Margin's window made ready to host: a show's.)
        case .windowNumber?: return held(w).map { Int64($0.number) } ?? none
        case .windowFullScreen?: return held(w)?.isFullScreen == true ? 1 : 0
        case .windowLayoutMode?: if let m = held(w)?.layoutMode { SessionCore.give(m, out) }
        case .hostedPlacement?:
            guard let p = held(w)?.hostedPlacement else { return none }
            for r in [p.page, p.area, p.display] { for v in Self.json(r) { margin_port_out_float(out, v) } }
            return Int64(keep(p))
        case .setHosting?: held(w)?.setHosting(a.flag)
        case .fullScreenSpace?: return w.flatMap { engine.fullScreenSpace(ofWindow: $0) }.map { Int64(bitPattern: $0) } ?? none
        case .knownAppMinimums?:
            for (bundle, m) in engine.knownAppMinimums {
                SessionCore.give(bundle, out)
                margin_port_out_float(out, Double(m.width))
                margin_port_out_float(out, Double(m.height))
            }
        case .setAppMinimums?:
            // (The names one a line, their sizes' numbers after, as the core writes them.)
            let names = (text() ?? "").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            let sizes = (SessionCore.text(a.b) ?? "").split(separator: " ").compactMap { Double($0) }
            var m: [String: CGSize] = [:]
            if text()?.isEmpty == false, sizes.count == names.count * 2 {
                for (i, n) in names.enumerated() { m[n] = CGSize(width: sizes[2 * i], height: sizes[2 * i + 1]) }
            }
            held(w)?.setAppMinimums(m)
        case .setLoading?: held(w)?.setLoading(text(), app: SessionCore.text(a.b))
        case .setPaneLoading?: held(w)?.setPaneLoading(text(), label: SessionCore.text(a.b), app: SessionCore.text(a.c))
        case .setLoadingTabs?: held(w)?.setLoadingTabs((text() ?? "").split(separator: ",").compactMap { Int($0) })
        case .setElsewhere?: held(w)?.setElsewhere(text(), app: SessionCore.text(a.b), picture: SessionCore.text(a.c))
        case .setStartupStuck?: held(w)?.setStartupStuck(text())
        case .clearCover?: held(w)?.cover(nil)
        case .hasHostedPlacement?: return held(w)?.hostedPlacement != nil ? 1 : 0
        case .hasIdlePlacement?: return held(w)?.idlePlacement != nil ? 1 : 0
        case .preparesOutOfSight?: return engine.preparesOutOfSight ? 1 : 0
        case .marginActive?: return marginActive() ? 1 : 0
        case .activateMargin?: activateMargin()
        case .engineShows?: return engine.shown != nil ? 1 : 0
        case nil: Diagnostics.warn("hosted: the core asked for port \(kind), which isn't one")
        }
        return 0
    }

    // A Margin window the core named, as its flow had it: one closed since is still the one told (Swift's flows held
    // the window they were for), until nothing is under way (`drive`).
    private var seen: [Int: HostedWindow] = [:]
    private func held(_ id: Int?) -> HostedWindow? {
        guard let id else { return nil }
        return window(id) ?? seen[id] ?? (opened?.id == id ? opened : nil)
    }

    // The one Swift step the core calls by name (session/mod.rs `Ports::swift`): a split's cut panes said again, from the
    // engine's last visible list (`shownList`, the Mac's windows: kept Swift).
    private func swiftCall(_ call: String, _ a: JSONObject) -> Any? {
        let w = held(int(a["window"]))
        switch call {
        case "paneCuts": if let w { w.setPaneCuts(paneCutsJSON(shownList)) }
        default: Diagnostics.warn("hosted: the core asked for \(call), which isn't a Swift flow")
        }
        return nil
    }

    // A flow of the core's called from Swift (session/hosting.rs `call_flow`): run now, as the Swift call ran its first
    // part at once, its answer (the core's `Reply`) given back here.
    private var calls: [UInt64: CheckedContinuation<Any?, Never>] = [:]
    private var nextCall: UInt64 = 0
    private func call(_ flow: String, _ args: JSONObject) async -> Any? {
        nextCall += 1
        let id = nextCall
        return await withCheckedContinuation { k in
            calls[id] = k
            drive(core.input(["type": "call", "id": id, "flow": flow, "args": args]))
        }
    }

    // The placements Margin's windows gave the core, by the token it passes back with them to the engine's operations
    // (the engine given the window's own value, not one made again of JSON numbers): the last 16 kept.
    private var placements: [(token: Int, placement: HostPlacement)] = []
    private var nextPlacement = 0
    private func keep(_ p: HostPlacement) -> Int {
        nextPlacement += 1
        placements.append((nextPlacement, p))
        if placements.count > 16 { placements.removeFirst() }
        return nextPlacement
    }
    // A placement as the core's commands carry it: its token's, else its numbers.
    private func placement(_ v: Any?) -> HostPlacement? {
        guard let o = v as? JSONObject else { return nil }
        if let t = int(o["token"]), let p = placements.last(where: { $0.token == t })?.placement { return p }
        guard let page = Self.rect(o["page"]), let area = Self.rect(o["area"]) else { return nil }
        return HostPlacement(page: page, area: area, display: Self.rect(o["display"]) ?? .zero)
    }
    private static func sizes(_ v: Any?) -> [String: CGSize] {
        var out: [String: CGSize] = [:]
        for r in v as? [[Any]] ?? [] where r.count == 3 {
            if let k = r[0] as? String, let w = num(r[1]), let h = num(r[2]) { out[k] = CGSize(width: w, height: h) }
        }
        return out
    }
    private static func hostRects(_ rows: [[Any]]) -> [HostID: CGRect] {
        var out: [HostID: CGRect] = [:]
        for r in rows where r.count == 5 {
            if let h = r[0] as? String, let rect = Self.rect(Array(r[1...])) { out[HostID(raw: h)] = rect }
        }
        return out
    }

    // A host target and an engine's result as the core's commands carry them.
    private static func hostTarget(_ v: Any?) -> HostTarget? {
        guard let o = v as? JSONObject else { return nil }
        switch o["kind"] as? String {
        case "app": return (o["bundle"] as? String).map { .app($0) }
        case "safari": return (o["role"] as? String).flatMap(SafariRole.init(name:)).map { .safariWindow(o["profile"] as? String, $0) }
        default: return nil
        }
    }
    private static func rect(_ v: Any?) -> CGRect? {
        guard let r = v as? [Any], r.count == 4, let x = num(r[0]), let y = num(r[1]), let w = num(r[2]), let h = num(r[3]) else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }
    // A rect as it is (never standardized: the core compares as CGRect does), as the core's rows and commands carry it.
    nonisolated static func json(_ c: CGRect) -> [Double] { [Double(c.origin.x), Double(c.origin.y), Double(c.size.width), Double(c.size.height)] }
    private static func json(_ r: HostResult) -> JSONObject {
        switch r {
        case .shown(let id, let placed): return ["shown": id.raw, "placed": placed]
        case .failed(let step, let why): return ["failed": step.rawValue, "why": why]
        }
    }

    // ---- one at a time ----

    // A Swift job in the session's queue (the core's: one queue for its flows and these), started when its turn comes.
    func enqueue(_ body: @escaping () async -> Void) {
        nextJob += 1
        jobs[nextJob] = body
        drive(core.input(["type": "enqueue", "job": nextJob]))
    }
    private var jobs: [UInt64: () async -> Void] = [:]
    private var nextJob: UInt64 = 0

    // Everything asked so far, done (the tests wait for it).
    func idle() async {
        while !core.idle { await withCheckedContinuation { idleWaiters.append($0) } }
    }
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []

    // A line of what was done: the core's log (the last 200 kept, `done`).
    func note(_ line: String) { drive(core.input(["type": "note", "line": line])) }

    // A page's click for a preview (the copy's `peekOpen { id, url, source, tabId, notAfter }`, HostedPeek.swift):
    // answered at once (`peekAnswer`). Typed: the push's id, address and time as the core reads them, nothing in JSON.
    func peekOpen(profile: String, windowId: Int?, msg: JSONObject) {
        drive(core.peekOpen(profile: profile, window: windowId, id: msg["id"] as? String, url: msg["url"] as? String, notAfter: num(msg["notAfter"]) ?? 0))
    }

    // The preview card's and Quick Tab's word to the core (core/session/card.rs `peek_input`): its reply, if it has one.
    @discardableResult func peek(_ kind: String, _ args: JSONObject = [:]) -> Any? {
        var input = args
        input["type"] = "peek"
        input["kind"] = kind
        return drive(core.input(input))["reply"]
    }

    // ---- the library's requests ----

    // A library request given to the session as an input (`library`: handled as the sink's are), for one the rules
    // don't make (the tests' odd shapes); the library's own reach the session inside its perform.
    func request(_ body: JSONObject) {
        guard JSONSerialization.isValidJSONObject(body) else { return Diagnostics.warn("hosted: a library request that isn't JSON") }
        drive(core.input(["type": "library", "request": body]))
    }

    // A library edit Swift made itself (a UI request, the first run's space, a test): its requests reached the core's
    // session inside it (the item in front at once, its handling queued: core/session/requests.rs); what they left
    // answered now (their lines, what they made ready run in the next turn), as their input did for the delegate.
    func edited() {
        drive(core.input(["type": "edited"]))
    }

    // A show overtaken before it started by a newer one for its window (fast clicks): skipped (the core's).
    private func overtaken(_ item: String, windowId: Int?) -> Bool {
        (drive(core.input(["type": "overtaken", "item": item, "window": windowId ?? NSNull()]))["reply"] as? Bool) == true
    }

    // ---- showing ----

    // An item in a Margin window's page area (nil: the front window): its app or its Safari profile's window shown,
    // and for a web item its tab in front there (the core's, core/session/requests.rs).
    func show(_ item: String, url: String?, target: ItemTarget?, windowId: Int?) async {
        _ = await call("show", ["item": item, "url": url ?? NSNull(), "target": target?.json ?? NSNull(), "window": windowId ?? NSNull()])
    }

    // The next/previous-tab key pressed in Margin's window `windowId` (each press and repeat; the shell's runHosted).
    func cycled(windowId: Int) { drive(core.input(["type": "cycled", "window": windowId])) }

    // ---- several visible items (docs/PEEK-SPLIT.md §1) ----

    // A whole layout of a Margin window's page area at once: `main` (at the page area, or `mainRect`: a split's pane),
    // each of `extras` at its rect in its role (back to front), `focused` with the keys (nil: main). The API the preview card,
    // Quick Tab and split view call (§2-§4); not wired to the UI yet. A web item's window is its profile's in its role: the
    // layout's first web item of a profile uses its main window, a card its card window, the other panes `#pane1`…`#pane3`
    // (asked of its copy by the engine, `requestSafariWindow(role:)`); its tab shown there by the copy's `hostShow`,
    // which moves it from another of the profile's windows. In the session's queue, after what was asked before it.
    func setLayout(window windowId: Int?, main: String, mainRect: CGRect? = nil, extras: [HostedLayout.Extra], focused: String? = nil) async {
        await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
            enqueue { await self.applyLayout(windowId, main: main, mainRect: mainRect, extras: extras, focused: focused); k.resume() }
        }
    }

    // A whole layout of a Margin window's page area (`main` at the page area or `mainRect`, `extras` at theirs, `focused`
    // with the keys, a split's panes at its page's `<m-pane>`s): the core's (core/session/layouts.rs), run now as the
    // Swift call ran its first part at once. `setLayout` calls it (the tests' API).
    func applyLayout(_ windowId: Int?, main: String, mainRect: CGRect?, extras: [HostedLayout.Extra], focused: String?, split: (id: String, items: [String])? = nil) async {
        func r(_ c: CGRect) -> [Any] { [Double(c.origin.x), Double(c.origin.y), Double(c.size.width), Double(c.size.height)] }
        let args: JSONObject = [
            "window": windowId ?? NSNull(), "main": main, "mainRect": mainRect.map(r) ?? NSNull(),
            "extras": extras.map { [$0.item, $0.role.rawValue] + r($0.rect) }, "focused": focused ?? NSNull(),
            "split": split.map { ["id": $0.id, "items": $0.items] as JSONObject } ?? NSNull(),
        ]
        _ = await call("applyLayout", args)
    }

    // An app's known minimum changed (HostEngine `onAppMinimums`): every app's told to the Margin window hosting (the
    // core's).
    func appMinimumsChanged() { drive(core.input(["type": "appMinimumsChanged"])) }
    // Each pane's window's minimum told to `w`'s page (its divider stops there): the core's.
    private func refreshPaneMinimums(_ w: HostedWindow) {
        hold(w)
        drive(core.input(["type": "refreshPaneMinimums", "window": w.id]))
    }

    // A pane's least size, Arc's 220×220 (the core's session/layout.rs `PANE_LEAST`). A pane's window may be wider:
    // it's shown cut (docs/PEEK-SPLIT.md §4b).
    nonisolated static let paneLeast: CGSize = {
        let n = (SessionRules.constants["paneLeast"] as? [NSNumber])?.map(\.doubleValue) ?? []
        return n.count == 2 ? CGSize(width: n[0], height: n[1]) : .zero
    }()

    // Why a pane didn't come, as the toast says it, and whether a failure's words mean no room for it (the core's
    // `NO_ROOM_REASON`, `is_no_room`; the tests read them).
    static let noRoomReason = SessionRules.constants["noRoomReason"] as? String ?? ""
    static func isNoRoom(_ why: String) -> Bool { KeysCore.bytes(why) { margin_session_is_no_room($0, $1) } }

    // The panes that must leave a split laid out at these rects (nil: every pane fits): the core's `no_room`.
    nonisolated static func noRoom(_ panes: [(item: String, role: HostRole, rect: CGRect?, least: CGSize?)], page: CGRect, had: Set<String>) -> [String]? {
        let rooms = panes.map { p in
            MarginPaneRoom(role: p.role == .main ? 0 : p.role == .pane ? 1 : 2, has_rect: p.rect != nil, rect: (p.rect ?? CGRect.zero).marginRect,
                           has_least: p.least != nil, least: MarginSize(width: Double(p.least?.width ?? 0), height: Double(p.least?.height ?? 0)), had: had.contains(p.item))
        }
        var leave = [Bool](repeating: false, count: panes.count)
        guard margin_session_no_room(rooms, rooms.count, page.marginRect, &leave) else { return nil }
        return zip(panes, leave).filter(\.1).map(\.0.item)
    }

    // A host gone, or parked with nothing in its place: out of every layout (the core's).
    private func forgetInLayouts(_ id: HostID) { drive(core.input(["type": "forgetInLayouts", "host": id.raw])) }

    // A Margin window the core is to tell (its id), held as the Swift flows held theirs until nothing is under way.
    private func hold(_ w: HostedWindow) { if seen[w.id] !== w { seen[w.id] = w } }

    // Margin's window about to leave full screen while hosting (macOS's green button, Mission Control: Margin itself
    // never asks): the one shown parked at once, while it's still in Margin's Space. Not queued behind the session's own
    // work: the engine takes it next.
    func leavingFullScreen(_ w: HostedWindow) {
        guard w.id == hostingWindow, engine.shown != nil else { return }
        note("Margin's window \(w.id) leaving full screen while hosting: the one shown parked")
        Task { await self.engine.parkShown(why: "Margin's window left full screen") }
    }

    // Margin's window left full screen while hosting: the one shown parked (if leaving didn't already), nothing shown in
    // it; it goes back into full screen by itself (always full screen), and the item shown is hosted again then.
    func leftFullScreen(_ w: HostedWindow) {
        guard w.id == hostingWindow else { return }
        note("Margin's window \(w.id) left full screen while hosting: nothing shown in it until it's back in full screen")
        if engine.shown != nil { Task { await self.engine.parkShown(why: "Margin's window left full screen") } }
        if let item = requested[w.id] ?? shown[w.id] { resume[w.id] = item }
        hostingWindow = nil
        w.setHosted(nil)
        w.cover(nil)
        w.setLoading(nil)
        w.setShowing(nil)
        w.setHosting(false)
        shown[w.id] = nil
        refreshLoading()
        onChange?()
    }

    // Margin's window in full screen again (after macOS took it out): the item it showed hosted again.
    func enteredFullScreen(_ w: HostedWindow) {
        guard let item = resume.removeValue(forKey: w.id) else { return }
        note("Margin's window \(w.id) back in full screen: \(item) hosted again")
        requested[w.id] = item
        onChange?()
        enqueue {
            if self.overtaken(item, windowId: w.id) { return }
            await self.show(item, url: nil, target: self.library.target(ofItem: item), windowId: w.id)
            self.settleHosting()
        }
    }

    // The engine's slow step for a host started (its first open, its placing again: nil when it's over): the hosting
    // window's page card is opaque, with the theme's loader and the app's name; a split's pane's own loader; the bar
    // (the core's, core/session/loading.rs).
    func loading(_ id: HostID?) { drive(core.loading(id?.raw)) }

    // A Safari profile's copy's `loading` push (background/page-loads.ts: its tabs loading in one of its windows), as
    // the tests give it: the core's, as the copy's push comes (`copyMessage`).
    func copyLoading(profile: String, windowId: Int?, tabIds: [Int]) {
        guard let json = jsonString(["type": "loading", "tabIds": tabIds]) else { return }
        copyMessage(browser: "safari", profile: profile, windowId: windowId, text: json)
    }

    // A push of a Safari profile's copy for its UI (UIPush.swift's types), as the tests give it: the core's, as the
    // copy's push comes (`copyMessage`); any other type isn't the page's.
    func copyPush(profile: String, windowId: Int?, msg: JSONObject) {
        guard let type = msg["type"] as? String, UIPush.forwarded.contains(type), let json = jsonString(SessionRules.json(msg)) else { return }
        copyMessage(browser: "safari", profile: profile, windowId: windowId, text: json)
    }

    // A copy's push as it came (its message's JSON text, never a dictionary: Shell.linkReceived): the core's
    // (core/session/route.rs): the loading bar's, the UI's to the Margin window it belongs in (the mini player's
    // window, the standing push taken back), its tabs named by the UI's numbers, and the preview card's (card.rs: a
    // page's click answered at once, the copy giving up on one, the card's page, Esc and ⌘↩ in it).
    func copyMessage(browser: String, profile: String, windowId: Int?, text: String) {
        var text = text
        drive(text.withUTF8 { core.copyMessage(browser: browser, profile: profile, window: windowId, $0) })
    }

    // The items loading now, by the UI's numbers, told to the hosting Margin window when they change (the core's).
    private func refreshLoading() { drive(core.refreshLoading()) }

    // A window of the engine's in Margin's Space that isn't shown yet (HostEngine `cover`: a new app's, read; a
    // browser's made ready out of sight): told to the Margin window it's under.
    func cover(_ number: Int?) {
        guard let id = hostingWindow ?? preparingWindow, let w = window(id) else { return }
        w.cover(number)
    }

    // The engine's host shown (its window), or none: the hosting Margin window is in front of it, its page area the hole.
    func hosted(_ number: Int?) {
        guard let id = hostingWindow, let w = window(id) else { return }
        w.setHosted(number)
    }

    // Every visible host's window (HostEngine `hostedWindows`), while more than one is: told to the Margin window hosting.
    func hostedWindows(_ list: [HostShownWindow]) {
        guard let id = hostingWindow, let w = window(id) else { return }
        w.setVisibleHosts(list)
        shownList = list
        w.setPaneCuts(paneCutsJSON(list))
    }

    // The engine's last word on the visible windows (`hostedWindows`): its cut panes told again once a layout's new items
    // are known (the engine says it at the layout's end, before the session has the items of the windows it opened).
    private var shownList: [HostShownWindow] = []

    // A split's cut panes by their items, for the page's arrows (docs/PEEK-SPLIT.md §4b): `{}` for none.
    func paneCutsJSON(_ list: [HostShownWindow]) -> String {
        var out: [String] = []
        for s in list {
            guard let cut = s.cut, let target = engine.target(ofWindow: s.window), let item = open.first(where: { $0.value.host == target.id })?.key, let key = jsonString(item) else { continue }
            let sides = PaneSide.allCases.filter { cut.sides.contains($0) }.map { #""\#($0.rawValue)":"slide""# }
            out.append(#"\#(key):{"window":\#(s.window)\#(sides.isEmpty ? "" : "," + sides.joined(separator: ","))}"#)
        }
        return "{" + out.sorted().joined(separator: ",") + "}"
    }

    // A cut pane's arrow pressed in its page (`split.slide`: its item, the side): the engine slides its window to show
    // that side (docs/PEEK-SPLIT.md §4b). The focus stays where it is (a press on Margin's own control).
    func slidePane(_ item: String, side: String, in w: HostedWindow) {
        guard w.id == hostingWindow, layout[w.id]?.items.contains(item) == true, let id = open[item]?.host, let s = PaneSide(rawValue: side) else { return }
        Task { _ = await self.engine.slide(id, side: s) }
    }

    // The one shown's own minimum width (HostEngine `onMinimum`; nil: none): told to the Margin window hosting it.
    func minimum(_ width: CGFloat?) {
        guard let id = hostingWindow, let w = window(id) else { return }
        w.setPageMinimum(width)
        if layout[id]?.split != nil { refreshPaneMinimums(w) }
    }

    // A hosted app moved to a safer way of hosting (HostEngine `onRoute`: the loop guard stopped it, its full screen failed):
    // the Margin window hosting it says so in its notice (shared/notices.ts `route-simpler`), the app's name filled in.
    func routeChanged(_ id: HostID, _ route: String) {
        guard let w = window(hostingWindow ?? preparingWindow) else { return }
        let bundle = id.raw.hasPrefix("app:") ? String(id.raw.dropFirst("app:".count)) : "com.apple.Safari"
        let name = appName(bundle) ?? (bundle == "com.apple.Safari" ? "Safari" : bundle)
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": "hostNote", "kind": "route-simpler", "app": name, "route": route]),
              let json = String(data: data, encoding: .utf8) else { return }
        w.push(json)
    }

    // An app closed while it was asking something didn't quit (HostEngine `onAsking`): said in the sidebar.
    func appAsking(_ id: HostID) {
        guard let w = window(hostingWindow ?? preparingWindow) ?? window(nil) else { return }
        let bundle = id.raw.hasPrefix("app:") ? String(id.raw.dropFirst("app:".count)) : id.raw
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": "hostNote", "kind": "app-asking", "app": appName(bundle) ?? bundle]),
              let json = String(data: data, encoding: .utf8) else { return }
        w.push(json)
    }

    // Another app's normal window on screen in Margin's Space that came while nothing was being opened (HostEngine
    // `others`: a hosted app's Settings, a second document), or none any more: the Margin window there lets it in front.
    func others(_ number: Int?) {
        guard let w = window(hostingWindow ?? preparingWindow) else { return }
        w.yield(to: number)
    }

    // The engine's poll at rest: what the window server's on-screen list has of the hosting Margin window and the one
    // shown (HostEngine `front`): that window checks it's in front of it.
    func front(_ read: HostEngine.FrontRead) {
        guard let id = hostingWindow, let w = window(id) else { return }
        w.frontRead(read)
    }

    // A field of Margin's (the palette) let go of the keys with a host shown: that app has them again.
    func fieldClosed(_ w: HostedWindow) {
        guard w.id == hostingWindow, engine.shownWindow != nil else { return }
        Task { await self.engine.activateShown(at: nil) }
    }

    // A press in a Margin window's page area while a host is shown there (around its window: on it, the app has it
    // already): that app given the keyboard (activated, its window raised), never a click.
    // `point`: where (top-left coordinates): a press on the hosted window itself is the app's already.
    func pagePressed(_ w: HostedWindow, at point: CGPoint? = nil) {
        guard w.id == hostingWindow, engine.shownWindow != nil else { return }
        // (Several visible: a press in another one's pane focuses it, docs/PEEK-SPLIT.md §1; never main raised over a card.)
        if let point, layout[w.id] != nil, let id = engine.visibleHost(at: point), id != engine.shown {
            return pressedHost(id, in: w)
        }
        Task { await self.engine.activateShown(at: point) }
    }

    // A card open in Margin's window `w`: a press on the page area around its content (Margin's window caught it): the
    // card closed (docs/PEEK-SPLIT.md §2); nothing else is done here.
    func caughtPress(_ w: HostedWindow, at point: CGPoint) {
        guard w.id == hostingWindow, layout[w.id]?.extras.contains(where: { $0.role == .card }) == true else { return }
        note("Margin's window \(w.id): a press on the page around the card")
        closeCard(windowId: w.id, why: "a press on the dimmed page around it")
    }

    // A visible host pressed in Margin's window `w` (its window's own press, or one in its pane around a smaller window):
    // focused, its item the window's item shown (the sidebar's highlight). `fronted`: its window has the keys already
    // (the pane click tap's press): the engine fronts nothing (`focus(_:fronted:)`), the rest the same.
    func pressedHost(_ id: HostID, in w: HostedWindow, fronted: Bool = false) {
        guard w.id == hostingWindow, var l = layout[w.id], let item = l.items.first(where: { open[$0]?.host == id }) else { return }
        Task {
            guard await self.engine.focus(id, fronted: fronted), self.layout[w.id] != nil else { return }
            l.focused = item
            self.layout[w.id] = l
            self.shown[w.id] = item
            self.onChange?()
        }
    }

    // The pane click tap's word on a press in a pane without the keys (PaneClickTap.swift), one line each: its window made
    // key for it and the press let go to it (focused here as a press is, its item the window's shown, nothing fronted
    // again: the monitor's own press leaves it), or let go as before (not key in time, or another window over the pane
    // there: the monitor's press focuses it the usual way).
    func paneClicked(_ w: HostedWindow, _ r: PaneClickResult) {
        let id = engine.target(ofWindow: r.window)?.id
        let who = id.map { "host: \($0)" } ?? "host: window \(r.window)"
        let had = engine.shown.map { " while \($0) had the keys" } ?? ""
        switch r.outcome {
        case .delivered(let already):
            Diagnostics.note(already ? "\(who): a click in its pane\(had): its window \(r.window) key already (\(r.ms) ms; Margin's word behind): the click delivered"
                                     : "\(who): a click in its pane\(had): its window \(r.window) key in \(r.ms) ms (\(r.crossApp ? (r.server ? "its app, kept active, made the front app by the window server" : "its app made the front app") : "in its own app")): the click delivered")
            if let id, w.id == hostingWindow { pressedHost(id, in: w, fronted: true) }
        case .notKey:
            Diagnostics.note("\(who): a click in its pane\(had): its window \(r.window) not key within \(r.ms) ms: the click let go as before (it only focuses; the pane focused the usual way)")
        case .covered(let c):
            Diagnostics.note("\(who): a click in its pane over another window there (window \(c.window), pid \(c.pid), layer \(c.layer)): let go as before")
        }
    }

    // ---- at launch: the item the window showed last ----

    // Asked by Tirth (2026-11-17): "open Margin and that's it, show a loader until the data is shown". As a browser
    // reopens its last tab: the first Margin window opened in a run shows the item selected in its space when Margin
    // last quit, behind the loader from its first frame; the start screen first while the default browser gets ready.
    // The core's (core/session/start.rs `resume_last`); `defaults write com.unibox.margin MarginResumeLast -bool NO`:
    // never (the launcher at every launch).
    func resumeLast(_ w: HostedWindow) {
        if opened == nil { opened = w } // (as given: held while the core resumes it or its start screen is up)
        drive(core.input(["type": "windowOpened", "window": w.id]))
    }
    // The Margin window whose last item is being shown at launch (it keeps hosting meanwhile): the core's.
    var resuming: Int? { field(.resuming) { $0.first?.i0 } }
    // The window given to `resumeLast`, held as the Swift flow held it (`held`), let go once it's no longer resumed.
    private var opened: HostedWindow?

    // ---- an item in another Margin window (Tirth, 2026-11-18) ----

    // One Margin window hosts at a time. Another one's item stays on it as a card, faded; the window brought in front
    // takes the item back (the core's, core/session/elsewhere.rs). Each window's item, by window.
    var elsewhere: [Int: String] { field(.elsewhere) { Self.intText($0) } }
    // A Margin window brought in front: its item from another window shown here again.
    func focused(_ windowId: Int) { drive(core.input(["type": "windowFocused", "window": windowId])) }
    // A Margin window closing while it hosts (its close button): what it shows parked first, then `done` (it closes).
    func windowClosing(_ w: HostedWindow, then done: @escaping () -> Void) {
        nextThen += 1
        let then = nextThen
        thens[then] = done
        guard drive(core.input(["type": "windowClosing", "window": w.id, "then": then]))["reply"] as? Bool == true else {
            thens[then] = nil
            return done()
        }
    }
    private var thens: [UInt64: () -> Void] = [:]
    private var nextThen: UInt64 = 0
    // A Margin window closed: what the session kept for it goes (the core's, its loading bar's too).
    func windowClosed(_ id: Int) {
        drive(core.input(["type": "windowClosed", "window": id]))
    }

    // ---- the start (Tirth, 2026-11-18): the default browser first, behind "Getting you started" ----

    // The start screen (Tirth, 2026-11-19): while the default browser gets ready, Margin's window is the start screen
    // alone, nothing of Margin's usable; held up, what's wrong is said with Try again and Continue without Safari. The
    // core's (core/session/start.rs); whether it's up (typed: read per key press and menu check) and Try again's count
    // read here.
    var startupShown: Bool { core.startScreen }
    var startupRetries: Int { field(.start) { $0.first?.i0 ?? 0 } }
    static let startupLabel = SessionRules.constants["startupLabel"] as? String ?? ""
    static let startupSlow = SessionRules.constants["startupSlow"] as? String ?? ""
    static let startupNoLink = SessionRules.constants["startupNoLink"] as? String ?? ""

    // The start screen's Try again and Continue without Safari; the preparation over (ready, or not done).
    func startupRetry() { drive(core.input(["type": "startupRetry"])) }
    // A browser copy's link came up or went down (the shell's linkUp/linkDown): the core's waits for a link look again.
    func linkChanged(profile: String) { drive(core.input(["type": "linked", "profile": profile])) }
    // Margin quits (before the engine's quitAll): the core's copy requests made for it aren't waited for once unread.
    func marginQuits() { drive(core.input(["type": "quitting"])) }
    func startupSkip() { drive(core.input(["type": "startupSkip"])) }
    func preparationOver() { drive(core.input(["type": "preparationOver"])) }
    static let resumeKey = "MarginResumeLast"
    static func resumesLast(setting: Any?) -> Bool { setting as? Bool != false }

    // The item a Margin window showed last, of its space's items (the core's `last_item`), its target and the name its
    // loader says.
    func lastItem(ofWindow id: Int) -> (item: String, target: ItemTarget, name: String)? {
        guard let out = drive(core.input(["type": "lastItem", "window": id]))["reply"] as? JSONObject, let item = out["item"] as? String,
              let name = out["name"] as? String, let target = ItemTarget(json: out["target"]) else { return nil }
        return (item, target, name)
    }

    // The app whose icon the loader shows for an item (the core's `loader_app`).
    static func loaderApp(_ target: ItemTarget) -> String? {
        SessionRules.call(["rule": "loaderApp", "target": target.json])["app"] as? String
    }

    // Margin's window hosts only while the engine shows something in it (the core's `settle_hosting`).
    func settleHosting() { drive(core.settle()) }

    // ---- the launcher asked for ----

    // The palette's Settings or Archive in Margin's window (the UI's openLauncher): the core's (`open_launcher`).
    func openLauncher(windowId: Int?, settings: Bool) {
        let args: JSONObject = ["window": windowId ?? NSNull(), "settings": settings]
        drive(core.input(["type": "call", "flow": "openLauncher", "args": args]))
    }

    // ---- closing ----

    func close(_ item: String, target: ItemTarget?) async {
        _ = await call("close", ["item": item, "target": target?.json ?? NSNull()])
    }

    // ---- the default browser made ready at launch ----

    // Decided by Tirth (2026-11-16): the person's default browser made ready in the background at Margin's launch, out
    // of sight (the core's `prepare_browser`, its four steps). Called by the shell once the library and the engine are
    // up; it never delays Margin's own window.
    func prepareBrowser(setting: String?) async {
        _ = await call("prepareBrowser", ["setting": setting ?? NSNull()])
    }
    // The Margin window a browser's window is made ready over (covered by it): the core's.
    private var preparingWindow: Int? { field(.preparingWindow) { $0.first?.i0 } }

    // ---- the engine's Safari windows (HostEngine's requestSafariWindow, closeSafariWindow, safariFullScreen, safariLinked) ----

    // The shell's poll: the idle cards and pane windows closed, then Safari's own windows' sweep (SafariWaker.sweep: the
    // windows opened to wake a profile left open, the windows a Safari Margin started restored from its last session).
    func sweepRestoredSafariWindows() {
        closeIdleCards()
        closeIdlePaneWindows()
        waker.sweep()
    }

    // ---- a split's pane windows (docs/PEEK-SPLIT.md §4) ----

    // A profile's pane windows (`#pane1`…`#pane3`) in no Margin window's layout: since when (the shell's poll). One unused
    // `paneIdle` (15 minutes) is closed by its copy, its tabs with it (an item of it shown again opens its page in the
    // window it's shown in). Margin's own windows all the same: never counted as the person's, never swept.
    private(set) var paneIdleSince: [SafariKey: Double] = [:]
    func closeIdlePaneWindows() {
        let used = Set(layout.values.flatMap(\.items).compactMap { open[$0]?.host })
        for k in safariWindows.keys where k.role.isPane {
            if used.contains(HostTarget.safariWindow(k.profile, k.role).id) { paneIdleSince[k] = nil; continue }
            guard let since = paneIdleSince[k] else { paneIdleSince[k] = now(); continue }
            guard now() - since >= options.paneIdle else { continue }
            paneIdleSince[k] = nil
            note("Safari window of \(k.profile)'s \(k.role) unused for \(Int(options.paneIdle / 60)) minutes: closed")
            closePaneWindow(k)
        }
        paneIdleSince = paneIdleSince.filter { safariWindows[$0.key] != nil }
    }
    // A pane window given back (its copy closes it), in the session's queue; out of every layout first.
    private func closePaneWindow(_ k: SafariKey) {
        let id = HostTarget.safariWindow(k.profile, k.role).id
        enqueue {
            if self.layout.values.contains(where: { $0.items.contains { self.open[$0]?.host == id } }) { return } // (in use again since)
            if self.engine.isHosted(id) { await self.engine.close(id) }
            if let n = self.safariWindows[k] { self.safariWindows[k] = nil; _ = await self.closeSafariWindow(k.profile, n) }
            for (item, o) in self.open where o.host == id { self.open[item] = nil; self.safariTabs[item] = nil }
        }
    }
    // The profiles a window is being asked of right now, every Safari window Margin has made (the copies' ids): never
    // swept. (The core's, written by its window asks.)
    var requesting: Set<String> { field(.requesting) { Self.texts($0) } }
    var made_: Set<Int> { field(.made) { Set($0.map(\.i0)) } }

    // A profile's copy linked, waking it through Safari's menu if it has no window (SafariWaker.linked).
    func safariLinked(_ profile: String?, wakeIf wanted: (() -> Bool)? = nil) async -> Bool {
        await waker.linked(profile, wakeIf: wanted)
    }
    // Whether a show waiting on profile `p`'s link is still wanted: no other item asked for in a Margin window since
    // (the core's, typed: the waker's look).
    func linkWanted(_ p: String) -> Bool { core.linkWanted(p) }
    func secs(since t: Double) -> String { String(format: "%.1f", now() - t) }
    // Safari's own window mechanics (the presses, the woken windows, the restored windows' sweep): SafariWaker.swift.
    private(set) lazy var waker = SafariWaker(session: self)
    var wokenByMenu: [String: [Int]] { waker.wokenByMenu }
    var unopenable: Set<String> { waker.unopenable }
    func profileNamesChanged() {
        waker.namesChanged()
        // Its web items open in the default profile only because theirs couldn't be (profileFallback, before the
        // folder grant): moved into their own now, as the note's Allow says (2026-11-19: the tab stayed in the default
        // profile's window until it was closed). Each one's tab there closed, and one shown in a Margin window shown
        // again (its own profile woken by Safari's menu now that its name is known).
        let fallback = Self.defaultSafariProfile
        let moved = open.compactMap { item, o -> String? in
            guard o.profile == fallback, case .web(let browser, let profile)? = library.target(ofItem: item), browser == "safari", resolve(profile) != fallback else { return nil }
            return item
        }.sorted()
        guard !moved.isEmpty else { return }
        note("Safari's profile names readable: \(moved.count) item(s) open in the default profile moved into their own")
        enqueue {
            for item in moved where self.open[item]?.profile == fallback {
                let windows = self.shown.filter { $0.value == item }.map(\.key).sorted()
                await self.close(item, target: nil)
                if let w = windows.first, self.requested[w] == nil { await self.show(item, url: nil, target: nil, windowId: w) }
            }
            self.settleHosting()
        }
    }

    // The profile a web item of `space` opens in: `p` when it's linked or can be woken; else the default one, said in the
    // sidebar (the core's, core/session/hosting.rs).
    private func profileFallback(_ p: String, space: String?) async -> String {
        await call("profileFallback", ["profile": p, "space": space ?? NSNull()]) as? String ?? p
    }
    // The windows opened only to wake a profile, closed by its copy (SafariWaker.closeWoken).
    func closeWoken(_ p: String, except made: Int? = nil, why: String = "") async {
        await waker.closeWoken(p, except: made, why: why)
    }

    // The engine's asks of the session (core/session/hosting.rs): a window of a profile's copy made for hosting in its
    // role, one closed by its copy, one into full screen or out of it, one brought in front.
    func requestSafariWindow(_ profile: String?, role: SafariRole = .main) async -> HostSafariWindow? {
        guard let made = await call("requestWindow", ["profile": profile ?? NSNull(), "role": role.description]) as? JSONObject, let id = int(made["id"]) else { return nil }
        let b = made["bounds"] as? JSONObject
        let bounds = b.flatMap { b in num(b["x"]).flatMap { x in num(b["y"]).flatMap { y in num(b["width"]).flatMap { w in num(b["height"]).map { CGRect(x: x, y: y, width: w, height: $0) } } } } }
        return HostSafariWindow(id: id, bounds: bounds)
    }

    func closeSafariWindow(_ profile: String?, _ windowId: Int) async -> Bool {
        await call("closeWindow", ["profile": profile ?? NSNull(), "windowId": windowId]) as? Bool == true
    }

    func safariFullScreen(_ profile: String?, _ windowId: Int, _ on: Bool) async -> Bool {
        await call("safariFullScreen", ["profile": profile ?? NSNull(), "windowId": windowId, "on": on]) as? Bool == true
    }

    func safariFocus(_ profile: String?, _ windowId: Int) async -> Bool {
        await call("safariFocus", ["profile": profile ?? NSNull(), "windowId": windowId]) as? Bool == true
    }

    // What the engine says happened outside Margin: an app or its window gone, its items have no page any more.
    func hostEvent(_ event: HostEvent) {
        switch event {
        case .unshown(let id):
            // Parked with nothing in its place (Margin's window left full screen, its window strayed): its items keep
            // their page, none is shown.
            for (w, i) in shown where open[i]?.host == id { shown[w] = nil }
            forgetInLayouts(id)
        case .revealed(let id):
            // (Its window in place mid-way through its show: the item's name off the page card now, not when the show
            // returns; the engine has told the window which window to open onto.)
            if showing[id] != nil, let w = window(hostingWindow) { w.setShowing(nil) }
            return
        case .quitByUser(let id), .windowClosed(let id), .closed(let id):
            // (A profile's main window gone: its pane windows go with it, docs/PEEK-SPLIT.md §4.)
            for k in safariWindows.keys where k.role.isPane && HostTarget.safariWindow(k.profile).id == id {
                note("Safari window of \(k.profile)'s \(k.role): closed with its profile's main window")
                closePaneWindow(k)
            }
            // (Out of every layout first: it finds the layouts by their items' hosts, which go next. A layout whose main went
            // is gone with it; before 2026-11-21 it was kept, its main with no page.)
            forgetInLayouts(id)
            let items = open.filter { $0.value.host == id }.map(\.key)
            for item in items { open[item] = nil; safariTabs[item] = nil; safariAudio[item] = nil }
            for (w, i) in shown where items.contains(i) { shown[w] = nil }
            for k in safariWindows.keys where HostTarget.safariWindow(k.profile, k.role).id == id { safariWindows[k] = nil; if k.role == .main { drive(core.input(["type": "loadingForget", "profile": k.profile])) } }
            cardHostGone(id)
            refreshLoading()
        default:
            return
        }
        onChange?()
        // (Whether Margin's window still hosts is settled once the engine is done: these come mid-operation.)
        enqueue { self.settleHosting() }
    }

    // ---- the page area moved (the sidebar's width, another theme, another display) ----

    // A Margin window's page area changed (its setPageRect; a split's panes laid out again): the core's
    // (core/session/page_area.rs). Every frame of a drag comes here: Margin's own window's page is read in the core and
    // the frame told to the engine through the typed follow, no JSON (`margin_session_page_rect`); a window with no page
    // in the core (a test's) through the ports.
    func pageRectChanged(_ window: HostedWindow) {
        hold(window)
        if let f = window.pageFrame {
            // (Where its page draws the preview card's page, as the window measures it: the core decides if a card is there.)
            let card = window.cardRect?.raw
            let said: UInt8 = withUnsafePointer(to: card ?? MarginRect()) { cp in
                let cardAt = card == nil ? nil : cp
                if var d = f.display?.raw { return margin_session_page_rect(core.pointer, Int64(window.id), f.page, f.content.raw, &d, cardAt) }
                return margin_session_page_rect(core.pointer, Int64(window.id), f.page, f.content.raw, nil, cardAt)
            }
            if said == 2 { runSoon() }
        } else {
            drive(core.input(["type": "pageRect", "window": window.id]))
        }
    }

    // A drag's frame the one shown follows (the core's typed `follow`): the page area, the other visible hosts' rects.
    func follow(_ p: MarginPlacement, _ rects: UnsafeBufferPointer<MarginHostRect>) {
        let placement = HostPlacement(page: CGRect(p.page), area: CGRect(p.area), display: CGRect(p.display))
        guard !rects.isEmpty else { return engine.follow(placement) }
        var out: [HostID: CGRect] = [:]
        for r in rects { out[hostID(r.host, r.len)] = CGRect(r.rect) }
        engine.follow(placement, rects: out)
    }
    // (The ids a drag's frames name, made once: a drag names the same few each frame.)
    private var frameHosts: [HostID] = []
    private func hostID(_ p: UnsafePointer<UInt8>?, _ n: Int) -> HostID {
        let bytes = UnsafeBufferPointer(start: p, count: p == nil ? 0 : n)
        if let had = frameHosts.first(where: { $0.raw.utf8.elementsEqual(bytes) }) { return had }
        let id = HostID(raw: String(decoding: bytes, as: UTF8.self))
        if frameHosts.count >= 16 { frameHosts.removeFirst() }
        frameHosts.append(id)
        return id
    }

    // The Margin window whose sidebar's edge is being dragged, and whether the one shown follows it live (the core's).
    var resizing: Int? { core.drag.window }
    var following: Bool { core.drag.following }

    // A change of a Margin window's sidebar's width began (a drag of its edge or a split's divider: the page says so at
    // the first change of the width), or is over (its last layout reported first: ui/behaviors/resize.ts): the core's.
    func sidebarResizing(_ window: HostedWindow, _ on: Bool, divider: Bool = false) {
        hold(window)
        drive(core.input(["type": "sidebarResizing", "window": window.id, "on": on, "divider": divider]))
    }

    // A drag's line in the log: what's dragged (a split's divider, the sidebar's edge) and how many hosted windows follow
    // it live, the others (plain members) placed again when it's let go.
    static func dragLine(divider: Bool, window: Int, following: Bool, _ counts: (follow: Int, visible: Int)) -> String {
        SessionRules.call(["rule": "dragLine", "divider": divider, "window": window, "following": following, "follow": counts.follow, "visible": counts.visible])["line"] as? String ?? ""
    }

    // ---- the palette ----

    // An installed app picked (`app.open`) in a Margin window (nil: the front one): the core's (requests.rs).
    func openApp(_ bundleId: String, windowId: Int?) {
        let args: JSONObject = ["bundle": bundleId, "window": windowId ?? NSNull()]
        drive(core.input(["type": "call", "flow": "openApp", "args": args]))
    }

    // The official upload, played in Safari: nothing bundled (the core's OWN_APP_SURPRISE; the tests read it here).
    static let ownAppSurprise = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    // A web item's history in its Safari window (the copy's goBack, goForward, reload for its tab): the core's
    // (core/session/navigate.rs).
    func navigate(_ type: String, windowId: Int?) {
        drive(core.input(["type": "navigate", "kind": type, "window": windowId ?? NSNull()]))
    }

    // ---- what the UI asks ----

    // The settings the UI's requests read (the profile source's: a search's engine, the favorites' scope), the core's
    // `settings` port.
    var uiSettings: () -> JSONObject? = { nil }

    // A request the UI makes: its route, the core's (core/session/ui.rs `ui_request`; LibraryWindowSource carries it out).
    func uiRequest(_ type: String, _ payload: JSONObject) -> JSONObject {
        drive(core.input(["type": "ui", "kind": type, "payload": SessionRules.json(payload)]))["reply"] as? JSONObject ?? [:]
    }

    // ---- what the UI draws ----

    // The windows of a copy's that Margin draws (Shell.tellDrawn's `drawn`): a Safari copy's every role's for its profile.
    func drawnWindows(browser: String, profile: String) -> [Int64] { core.drawnWindows(browser: browser, profile: profile) }

    // The UI's number for an item with a page, and back (the core's: given in order of first use).
    func number(ofItem item: String) -> Int { core.number(item) }
    func item(ofTab number: Int) -> String? { core.item(ofTab: number) }
    // An open item's row number, as the UI has it (nil: not open, or never numbered). DEV-HOOK: the dev hook's `ui`.
    func openRow(ofItem item: String) -> Int? { core.openRow(item) }

    // What Margin's windows draw, as its text (the core's, one call a draw: core/session/mod.rs `state_text`): the
    // library's snapshot (stored values' shape) with the items that have a page as open tabs of the Margin window
    // hosting them, the one shown active there (which, their numbers, in front, visible, their sound: `live_plan`; each
    // its tab as the UI takes it, state/model.ts tabRecord's shape: its page, the pin or favorite it's the tab of and
    // the name the person gave it, only with a value), and `tail` (the profile's settings and site icons) spliced in.
    func stateText(tail: String = "") -> String { core.state(tail: tail) }

    // A Safari copy's tabs, as its state says them now (`openTabs`, its JSON's bytes as the link's mirror keeps it:
    // Shell.linkReceived): each item's tab's sound (the core's, core/session/route.rs `copy_tabs`); the windows draw
    // again when that changed.
    func copyTabs(profile: String, openTabs: UnsafeBufferPointer<UInt8>) { drive(core.copyTabs(profile: profile, openTabs)) }
    // (As the tests give it: the copy's `openTabs.tabs`.)
    func copyTabs(profile: String, tabs: JSONObject) {
        guard let data = jsonText(["tabs": SessionRules.json(tabs)]) else { return }
        data.withUnsafeBytes { copyTabs(profile: profile, openTabs: $0.bindMemory(to: UInt8.self)) }
    }

    // ---- helpers ----

    // A web item's Safari profile: its own, else the default profile's copy (or, when only others have linked, the
    // first): the core's session/choice.rs `resolve`.
    func resolve(_ profile: String?) -> String {
        if let profile { return profile }
        return SessionRules.call(["rule": "resolve", "profile": NSNull(), "linked": links.safariProfiles()])["profile"] as? String ?? Self.defaultSafariProfile
    }

    func wait(_ seconds: Double, _ done: () -> Bool) async -> Bool {
        var left = seconds
        while true {
            if done() { return true }
            if left <= 0 { return false }
            await sleep(options.every)
            left -= options.every
        }
    }
}

// What Margin's windows draw with the library on (ShellHostedGlue.swift): the library's spaces, pins, folders and
// items, with what the session has open (the core's text, `stateText`); settings, theme settings and site icons still
// a profile's (read only, changed in memory: DataSetWindowSource's `drawnText`, its text kept between its changes).
final class LibraryWindowSource: MarginWindowSource {
    let library: Library
    let session: HostedSession
    let profileSource: DataSetWindowSource
    var onChange: (() -> Void)?
    // A theme imported or linked (the core's `theme` route, docs/THEME-STORE.md §1): the shell's (ShellThemes.swift
    // `themeAsked`), with the window that asked.
    var onTheme: ((String, JSONObject, Int?) -> Void)?

    init(library: Library, session: HostedSession, profileSource: DataSetWindowSource) {
        self.library = library
        self.session = session
        self.profileSource = profileSource
        library.observe { [weak self] _ in self?.onChange?() }
        profileSource.onChange = { [weak self] in self?.onChange?() }
        let before = session.onChange
        session.onChange = { [weak self] in before?(); self?.onChange?() }
        session.uiSettings = { [weak profileSource] in profileSource?.drawnSettings }
    }

    func stateText() -> String { session.stateText(tail: profileSource.drawnText()) }
    func spaceTheme(window: Int) -> String? { library.spaceTheme(window: window) }
    func spaceAppearance(window: Int) -> SpaceAppearance? { library.spaceAppearance(window: window) }

    // A request the UI makes, routed by the core (core/session/ui.rs `ui_request`: an open item's row by the UI's number
    // mapped back to its item, the settings' own, the pasteboard's, the session's flows, `addFavorite`'s scope from the
    // settings, ⌘W, the requests that need nothing): carried out here as it says.
    @discardableResult func perform(_ type: String, _ payload: JSONObject) -> JSONObject? {
        let reply = session.uiRequest(type, payload)
        switch reply["route"] as? String {
        case "answer":
            if let url = reply["pasteboard"] as? String {
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.setString(url, forType: .string)
            }
            return reply["value"] as? JSONObject
        case "perform":
            return answer(library.perform(reply["action"] as? String ?? type, reply["payload"] as? JSONObject ?? [:]))
        case "settings":
            return profileSource.perform(reply["kind"] as? String ?? type, reply["payload"] as? JSONObject ?? [:])
        case "theme":
            onTheme?(reply["name"] as? String ?? type, reply["payload"] as? JSONObject ?? [:], int(reply["window"]))
            return nil
        default:
            return nil
        }
    }

    private func answer(_ out: LibraryOutcome) -> JSONObject {
        out.ok ? ["ok": true, "result": out.result ?? NSNull()] : ["ok": false, "error": out.error ?? "refused"]
    }

    // The search's address: the engine Safari searches with as the copy learned it (shared/search.ts safariEngine),
    // else Google's, as Safari's default (the core's session/ui.rs `search_url`).
    static func searchUrl(_ query: String, settings: JSONObject?) -> String {
        let learned = (settings?["safariSearch"] as? JSONObject)?["template"] as? String
        return SessionRules.call(["rule": "searchUrl", "query": query, "template": learned ?? NSNull()])["url"] as? String ?? ""
    }
}

extension HostedSession.Options {
    // As the core takes them (core/session/mod.rs `Options`: it reads the ones its flows use).
    var json: JSONObject {
        ["firstCopiesPace": firstCopiesPace, "pressPace": pressPace, "wakePresses": wakePresses, "linkSayEvery": linkSayEvery,
         "fullScreenWait": fullScreenWait, "pageWait": pageWait, "every": every, "safariBundles": safariBundles.sorted(),
         "closesRestoredSafariWindows": closesRestoredSafariWindows, "preparesBrowser": preparesBrowser,
         "prepareWindowWait": prepareWindowWait, "refitRetryAfter": refitRetryAfter, "resumesLast": resumesLast,
         "startupWait": startupWait, "pictureWait": pictureWait, "wokenLate": wokenLate, "wokenGrace": wokenGrace,
         "cycleWindow": cycleWindow, "cycleHold": cycleHold, "paneIdle": paneIdle, "quitWait": quitWait ?? NSNull()]
    }
}

extension SafariRole {
    // From its `description` (`main`, `card`, `pane1`…), as the core names it.
    nonisolated init?(name: String) {
        if name == "main" { self = .main; return }
        guard let role = SafariRole(suffix: Substring(name)) else { return nil }
        self = role
    }
}
