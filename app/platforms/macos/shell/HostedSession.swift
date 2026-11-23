// Margin as the app, joined up (docs/MARGIN-APP.md; DECISIONS.md "Margin as the app: the parts joined"): the
// library's items shown in Margin's window by the host engine.
//
// - The library (Library.swift) says what needs a browser or an app (its requests: activateTab, newTab, closeTab,
//   setSpace, openPin, clearToday, restoreArchive); this is its delegate, and does each one, one at a time, in order.
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
}

extension HostedEngine {
    // (A stand-in that doesn't play them: nothing started or prepared, nothing hidden.)
    func hideWoken(bundleId: String) {}
    func stopHidingWoken(bundleId: String) {}
    func releaseWoken(bundleId: String) {}
    func wokenWindows(bundleId: String) -> Int { 0 }
    func wokenParked(bundleId: String) -> [Int] { [] }
    func appRuns(bundleId: String) -> Bool? { nil }
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
    // An item being shown and not ready yet (its name), nil: it is: `loading` only if that takes longer than a grace;
    // `slow`: known to take a while (the last item, at launch): `loading` at once. `app` as setLoading's.
    func setShowing(_ label: String?, app: String?, slow: Bool)
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
}

extension HostedWindow {
    func setShowing(_ label: String?) { setShowing(label, app: nil, slow: false) }
    func setShowing(_ label: String?, slow: Bool) { setShowing(label, app: nil, slow: slow) }
    func setShowing(_ label: String?, app: String?) { setShowing(label, app: app, slow: false) }
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

// The app whose icon a host's loader shows: an app's own, a Safari window's Safari.
extension HostID {
    var iconApp: String { raw.hasPrefix("app:") ? String(raw.dropFirst("app:".count)) : safariIdentifier }
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
}

final class HostedSession: LibraryDelegate {
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
        var cycleWindow = 1.0 // (Tirth, 2026-11-20) a pick this soon after the next/previous-tab key in its window: a cycle's
        var cycleHold = 0.35 // ...an app not running yet held this long before it's started: one only passed over is never started
        var paneIdle = 900.0 // (docs/PEEK-SPLIT.md §4) a split's pane window of a profile unused this long: closed
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
    // others with their roles and rects, the focused one (`shown[w]`). None: one item shown, as before.
    private(set) var layout: [Int: HostedLayout] = [:]
    private(set) var hostingWindow: Int? {
        get { field(.hostingWindow) { $0.first?.i0 } }
        set { setOne(.hostingWindow, old: hostingWindow, newValue) { CoreRow(i0: $0) } }
    }
    // Each Margin window's own page shown (ItemTarget.margin's page: Settings), drawn by the window itself, and the items
    // of Margin's pages shown this session (open tabs in the UI, as items with a page are: `live`).
    private(set) var marginPages: [Int: String] {
        get { field(.marginPages) { Self.intText($0) } }
        set { setMap(.marginPages, old: marginPages, newValue) { CoreRow(i0: $0, s0: $1) } }
    }
    private(set) var marginOpen: Set<String> {
        get { field(.marginOpen) { Self.texts($0) } }
        set { setSet(.marginOpen, old: marginOpen, newValue) }
    }
    // When each Margin window's next/previous-tab key was last pressed (its repeats too): the picks a cycle makes.
    private var cycledAt: [Int: Double] {
        get { field(.cycledAt) { rows in Dictionary(rows.map { ($0.i0, $0.f) }, uniquingKeysWith: { a, _ in a }) } }
        set { setMap(.cycledAt, old: cycledAt, newValue) { CoreRow(i0: $0, f: $1 ?? 0) } }
    }
    // Each Margin window's item shown when macOS took the window out of full screen: hosted again once it's back in.
    private(set) var resume: [Int: String] = [:]
    // What the loading animation names for a host (the app's name; Safari).
    var labels: [HostID: String] {
        get { field(.labels) { Self.hostText($0) } }
        set { setMap(.labels, old: labels, newValue) { CoreRow(s0: $0.raw, s1: $1) } }
    }
    // The loading bar (setLoadingTabs): the engine's slow step now (its host), the item each host is being shown for,
    // each web item's tab in its Safari window (the copy's id, from hostShow), the tabs each profile's copy says are
    // loading in its hosted window (its `loading` push), and what each Margin window was told last.
    private var appLoading: HostID?
    private var showing: [HostID: String] {
        get { field(.showing) { Self.hostText($0) } }
        set { setMap(.showing, old: showing, newValue) { CoreRow(s0: $0.raw, s1: $1) } }
    }
    private(set) var safariTabs: [String: Int] {
        get { field(.safariTabs) { rows in Dictionary(rows.compactMap { r in r.s0.map { ($0, r.i0) } }, uniquingKeysWith: { a, _ in a }) } }
        set { setMap(.safariTabs, old: safariTabs, newValue) { CoreRow(i0: $1 ?? 0, s0: $0) } }
    }
    private(set) var safariMuted: Set<String> {
        get { field(.safariMuted) { Self.texts($0) } }
        set { setSet(.safariMuted, old: safariMuted, newValue) }
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
    private var copyLoading: [String: Set<Int>] = [:]
    private(set) var loadingSaid: [Int: [Int]] = [:]
    // Each Margin window's item asked to be shown and not shown yet (the newest): drawn in front at once.
    var requested: [Int: String] {
        get { field(.requested) { Self.intText($0) } }
        set { setMap(.requested, old: requested, newValue) { CoreRow(i0: $0, s0: $1) } }
    }
    // The first run's space (the library was empty), for the UI's editor once a window's page is drawn.
    var firstSpace: String?
    // The UI's numbers for open items (it takes only numbers for open tabs), this session's.
    private var numbers: [String: Int] = [:]
    private var items: [Int: String] = [:]
    private var nextNumber = 1
    // What was done, newest last (the tests read it; numbers, item ids and bundle ids only): the core's, the last 200.
    var done: [String] {
        let rev = core.rev(.done)
        if rev != doneKept.rev { doneKept = (rev, core.done) }
        return doneKept.lines
    }
    private var doneKept: (rev: UInt64, lines: [String]) = (0, [])
    // The preview cards and Quick Tab (HostedPeek.swift, docs/PEEK-SPLIT.md §2, §3): each profile's card, when each card
    // window was last used (closed after `cardIdle` unused), the Margin windows with Quick Tab's field up, the card
    // whose window's first open is under way (its own loader, never the page card's).
    var cards: [String: PeekCard] = [:]
    var cardUsedAt: [String: Double] = [:]
    var littleArcs: [Int: String] = [:]
    var cardLoading: HostID?

    init(library: Library, engine: HostedEngine, links: HostedLinks, options: Options = Options()) {
        self.library = library
        self.engine = engine
        self.links = links
        self.options = options
        core = SessionCore(library: library, options: options.json)
        core.owner = self
    }

    // ---- the core (core/session/, SessionCore.swift: docs/CORE-REFACTOR.md step 3) ----

    // The session's object in margin-core: the one queue the core's flows and the Swift's jobs take their turns in, the
    // state they share, the log. Its ports (`port`, `now`) call back here during a call.
    let core: SessionCore
    // The core's fields as last read, by their revisions (`fresh`).
    // The core's fields as last read, by their revisions (`field`): read again only when one changed there, and
    // written as the difference (`setMap`, `setSet`, `setOne`), the value written kept with the revision it made. Rows
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
    }
    private func setMap<K: Hashable, V: Equatable>(_ f: SessionCore.Field, old: [K: V], _ new: [K: V], row: (K, V?) -> CoreRow) {
        write(f, new, puts: new.filter { old[$0.key] != $0.value }.map { row($0.key, $0.value) }, dels: old.keys.filter { new[$0] == nil }.map { row($0, nil) })
    }
    private func setSet(_ f: SessionCore.Field, old: Set<String>, _ new: Set<String>) {
        write(f, new, puts: new.subtracting(old).map { CoreRow(s0: $0) }, dels: old.subtracting(new).map { CoreRow(s0: $0) })
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

    // A command started (session/mod.rs `Command`): a copy's request, a library edit (answered now, in the same turn: its
    // requests reach this delegate first, as when a flow here performed it), a Swift job's turn.
    private func start(_ c: JSONObject) {
        guard let id = (c["id"] as? NSNumber)?.uint64Value else { return }
        switch c["op"] as? String {
        case "ask":
            let profile = c["profile"] as? String ?? "", kind = c["kind"] as? String ?? "", payload = c["payload"] as? JSONObject ?? [:]
            startNow {
                let (result, error) = await self.links.request(profile: profile, kind, payload)
                self.drive(self.core.answer(id, ["result": result ?? NSNull(), "error": error ?? NSNull()]))
            }
        case "perform":
            let out = library.perform(c["action"] as? String ?? "", c["payload"] as? JSONObject ?? [:])
            let result = out.result.flatMap { JSONSerialization.isValidJSONObject([$0]) ? $0 : nil } ?? NSNull()
            drive(core.answer(id, ["ok": out.ok, "result": result, "error": out.error ?? NSNull()]))
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
                guard let target = Self.hostTarget(args["target"]), let placement = int(args["placement"]).flatMap({ placements.removeValue(forKey: $0) }),
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
            default:
                drive(core.answer(id, ["error": "not an engine operation"]))
            }
        case "waker":
            let args = c["args"] as? JSONObject ?? [:], profile = args["profile"] as? String ?? ""
            switch c["name"] as? String {
            case "ensureLinked":
                startNow {
                    let linked = await self.waker.linked(profile)
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
        case "swift":
            // (The flows of the parts not moved yet, docs/CORE-REFACTOR.md step 3's later commits.)
            let args = c["args"] as? JSONObject ?? [:]
            switch c["name"] as? String {
            case "prepare":
                guard let w = held(int(args["window"])), let target = Self.hostTarget(args["target"]) else { drive(core.answer(id, [:])); return }
                startNow {
                    let made = await self.prepare(w, for: target)
                    // (The placement kept here, the core given its number: it only passes it to the engine's open.)
                    let answer: JSONObject = made.map { made in
                        self.nextPlacement += 1
                        self.placements[self.nextPlacement] = made.0
                        return ["placement": self.nextPlacement, "space": NSNumber(value: made.1)]
                    } ?? [:]
                    self.drive(self.core.answer(id, answer))
                }
            case "showSplit":
                guard let w = held(int(args["window"])), let split = (args["split"] as? String).flatMap({ library.split($0) }), let focus = args["focus"] as? String else {
                    drive(core.answer(id, ["shown": false]))
                    return
                }
                startNow {
                    let shown = await self.showSplit(split, focus: focus, in: w)
                    self.drive(self.core.answer(id, ["shown": shown]))
                }
            default:
                drive(core.answer(id, ["error": "not a swift flow"]))
            }
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
        guard let at else { return }
        timerGen += 1
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

    // The core's ports (session/mod.rs `Ports`), answered during its call: Margin's windows, the engine's reads, the
    // links', the OS's.
    func port(_ ask: JSONObject) -> JSONObject {
        switch ask["port"] as? String {
        case "window":
            guard let w = window(int(ask["id"])) else { return [:] }
            if seen[w.id] !== w { seen[w.id] = w }
            return ["id": w.id]
        case "windowIds": return ["ids": windowIds()]
        case "engineShown": return engine.shown.map { ["host": $0.raw] } ?? [:]
        case "isHosted": return ["hosted": (ask["host"] as? String).map { engine.isHosted(HostID(raw: $0)) } ?? false]
        case "safariProfiles": return ["profiles": links.safariProfiles()]
        case "linkEpoch": return (ask["profile"] as? String).flatMap { links.linkEpoch(of: $0) }.map { ["epoch": $0] } ?? [:]
        case "appName": return (ask["bundle"] as? String).flatMap { appName($0) }.map { ["name": $0] } ?? [:]
        case "appRuns": return (ask["bundle"] as? String).flatMap { engine.appRuns(bundleId: $0) }.map { ["runs": $0] } ?? [:]
        case "showsAlone": return ["alone": engine.showsAlone(HostID(raw: ask["host"] as? String ?? ""))]
        case "stopHidingWoken": engine.stopHidingWoken(bundleId: ask["bundle"] as? String ?? safariIdentifier); return [:]
        case "windowIdsOf": return ["ids": links.windowIds(of: ask["profile"] as? String ?? "")]
        case "wall": return ["now": Date().timeIntervalSince1970]
        case "setShowing":
            held(int(ask["window"]))?.setShowing(ask["label"] as? String, app: ask["app"] as? String, slow: ask["slow"] as? Bool == true)
            return [:]
        case "setMarginPage": held(int(ask["window"]))?.setMarginPage(ask["page"] as? String); return [:]
        case "push": if let json = ask["json"] as? String { held(int(ask["window"]))?.push(json) }; return [:]
        case "changed": onChange?(); return [:]
        case "log":
            if let text = ask["text"] as? String { if ask["warn"] as? Bool == true { Diagnostics.warn(text) } else { Diagnostics.note(text) } }
            return [:]
        case "wokenByMenu": return ["woken": wokenByMenu[ask["profile"] as? String ?? ""] != nil]
        case "unopenable": return ["unopenable": unopenable.contains(ask["profile"] as? String ?? "")]
        case "swift": return ["value": swiftCall(ask["call"] as? String ?? "", ask["args"] as? JSONObject ?? [:]) ?? NSNull()]
        default: return [:]
        }
    }

    // The typed ports (margin-ffi session.rs `PortKind`), the ones a show asks: a number back (`SessionCore.none`:
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
        case .setShowing?: held(w)?.setShowing(text(), app: SessionCore.text(a.b), slow: a.flag)
        case .setMarginPage?: held(w)?.setMarginPage(text())
        case .push?: if let json = text() { held(w)?.push(json) }
        case .changed?: onChange?()
        case .wokenByMenu?: return wokenByMenu[text() ?? ""] != nil ? 1 : 0
        case .unopenable?: return unopenable.contains(text() ?? "") ? 1 : 0
        case .log?: if let t = text() { if a.flag { Diagnostics.warn(t) } else { Diagnostics.note(t) } }
        case .cardLeaving?: if let win = held(w) { cardLeaving(win, for: text()) }
        case .cardReturning?: if let win = held(w), let item = text() { cardReturning(win, to: item) }
        case .pinnedOrFavorite?: return pinnedOrFavorite(text() ?? "") ? 1 : 0
        case .settleHosting?: settleHosting()
        case .refreshLoading?: refreshLoading()
        case .leaveMarginPage?: if let win = held(w) { leaveMarginPage(win) }
        case .hasLayout?: return w.map { layout[$0] != nil } == true ? 1 : 0
        case .clearLayout?: if let w { layout[w] = nil }
        case .clearElsewhere?: if let win = held(w), elsewhere[win.id] != nil { elsewhere[win.id] = nil; win.setElsewhere(nil, app: nil) }
        case .forgetElsewhere?: forgetElsewhere(item: text())
        case nil: Diagnostics.warn("hosted: the core asked for port \(kind), which isn't one")
        }
        return 0
    }

    // A Margin window the core named, as its flow had it: one closed since is still the one told (Swift's flows held
    // the window they were for), until nothing is under way (`drive`).
    private var seen: [Int: HostedWindow] = [:]
    private func held(_ id: Int?) -> HostedWindow? {
        guard let id else { return nil }
        return window(id) ?? seen[id]
    }

    // The Swift flows of the parts not moved yet, as the core's flows call them (session/mod.rs `Ports::swift`).
    private func swiftCall(_ call: String, _ a: JSONObject) -> Any? {
        let w = held(int(a["window"]))
        switch call {
        case "cardLeaving": if let w { cardLeaving(w, for: a["item"] as? String) }
        case "cardReturning": if let w, let item = a["item"] as? String { cardReturning(w, to: item) }
        case "pinnedOrFavorite": return pinnedOrFavorite(a["item"] as? String ?? "")
        case "cardUrl":
            guard let c = cards[a["profile"] as? String ?? ""], Self.webAddress(c.url) else { return nil }
            return c.url
        case "settleHosting": settleHosting()
        case "refreshLoading": refreshLoading()
        case "leaveMarginPage": if let w { leaveMarginPage(w) }
        case "hasLayout": return int(a["window"]).map { layout[$0] != nil } ?? false
        case "clearLayout": if let id = int(a["window"]) { layout[id] = nil }
        case "layoutsWith":
            let item = a["item"] as? String ?? ""
            return layout.filter { $0.value.items.contains(item) }.map(\.key)
        case "clearElsewhere": if let w, elsewhere[w.id] != nil { elsewhere[w.id] = nil; w.setElsewhere(nil, app: nil) }
        case "forgetElsewhere": forgetElsewhere(item: a["item"] as? String)
        case "paneFor":
            guard let p = a["profile"] as? String, let role = (a["role"] as? String).flatMap(SafariRole.init(name:)) else { return nil }
            let k = SafariKey(p, role)
            return ["address": paneAddressFor[k] ?? NSNull(), "item": paneItemFor[k] ?? NSNull()] as JSONObject
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

    // The placements Margin's windows were made ready with (the interim `prepare`), by the number the core passes on to
    // the engine's open (one each: taken there).
    private var placements: [Int: HostPlacement] = [:]
    private var nextPlacement = 0

    // A host target and an engine's result as the core's commands carry them.
    private static func hostTarget(_ v: Any?) -> HostTarget? {
        guard let o = v as? JSONObject else { return nil }
        switch o["kind"] as? String {
        case "app": return (o["bundle"] as? String).map { .app($0) }
        case "safari": return (o["role"] as? String).flatMap(SafariRole.init(name:)).map { .safariWindow(o["profile"] as? String, $0) }
        default: return nil
        }
    }
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

    // ---- the library's requests ----

    func library(_ library: Library, wants request: LibraryRequest) {
        // (The core's, core/session/requests.rs: the item in front in its window at once, then handled in the queue.)
        guard JSONSerialization.isValidJSONObject(request.body) else { return Diagnostics.warn("hosted: a library request that isn't JSON") }
        drive(core.input(["type": "library", "request": request.body]))
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

    struct LayoutPart { let item: String; let target: HostTarget; let profile: String?; let url: String; let role: HostRole; var rect: CGRect? }

    // ---- split view (docs/PEEK-SPLIT.md §4) ----

    // A split's item picked in `w`: the whole split shown, `focus` with the keys. Its panes are the split's items that
    // can be hosted (web pages in Safari, Mac apps: each app once); fewer than two: false (the item is shown alone).
    // Main is the pane that keeps its window (the window's layout of this split already: its main; else the split's
    // first web pane, which uses its profile's main window, else its first pane); the others are panes, a profile's
    // other web panes in `#pane1`…`#pane3`. Each pane's rect is its `<m-pane>` as the window's page lays the split out
    // (asked for by the item in front: `requested`, drawn in the sidebar's capsule at once). True: shown.
    private func showSplit(_ split: Library.Split, focus: String, in w: HostedWindow) async -> Bool {
        var panes: [String] = [], apps: Set<String> = [], webs: [String] = []
        for id in split.panes {
            switch library.target(ofItem: id) {
            case .app(let bundle, _)?: if apps.insert(bundle).inserted { panes.append(id) } else { note("split \(split.id): \(id): \(bundle) is in it already (an app is one pane)") }
            case .web(let browser, _)? where browser == "safari": panes.append(id); webs.append(id)
            default: note("split \(split.id): \(id): can't be a pane (not hosted beside others)")
            }
        }
        guard panes.count >= 2, panes.contains(focus) else { note("split \(split.id): fewer than two panes to show: \(focus) alone"); return false }
        if requested[w.id] != focus { requested[w.id] = focus; onChange?() } // (the page lays the split out for the item in front)
        let had = layout[w.id].flatMap { $0.split == split.id && panes.contains($0.main) ? $0.main : nil }
        let main = had ?? webs.first ?? panes[0]
        // (A web pane's window not made yet is opened at its page, or blank when its tab is open elsewhere (moved in, the
        // blank page closed then: background/hosted.ts): never Safari's empty new-tab page, whose address field keeps
        // Safari's toolbar down over the page: `requestSafariWindow`.)
        for id in webs { paneAddress[id] = open[id] == nil ? library.items().first { $0.id == id }?.value["url"] as? String : "about:blank" }
        // (Its tab open elsewhere: the window made around that tab by the copy (`newWindow { itemId }`), so it never has a
        // blank page first, whose address field keeps Safari's toolbar down; an older copy ignores it and opens blank.)
        for id in webs where open[id] != nil { paneItem[id] = id }
        defer { paneItem = [:] }
        defer { paneAddress = [:] }
        await applyLayout(w.id, main: main, mainRect: nil, extras: panes.filter { $0 != main }.map { HostedLayout.Extra(item: $0, role: .pane, rect: .zero) },
                          focused: focus, split: (split.id, split.panes))
        guard layout[w.id]?.split == split.id else { return false }
        refreshPaneMinimums(w)
        return true
    }
    // The address each web pane being laid out opens at, for its window's first page (`requestSafariWindow`).
    private var paneAddress: [String: String?] = [:]
    private var paneAddressFor: [SafariKey: String] = [:]
    // A web pane whose tab is open in another of Margin's windows: its window made around that tab (`newWindow { itemId }`).
    private var paneItem: [String: String] = [:]
    private var paneItemFor: [SafariKey: String] = [:]

    // The split's panes as `w`'s page lays them out now, each pane's rect by its item (`items` in that order: the
    // split's, as the page has them), waited for (`pageWait`), the page asked to measure again at each look; nil: not
    // laid out so in time.
    private func paneRects(_ w: HostedWindow, split: String, items: [String]) async -> [String: CGRect]? {
        func now() -> [String: CGRect]? {
            guard let pl = w.paneLayout, pl.split == split, pl.panes.map(\.item) == items else { return nil }
            return Dictionary(uniqueKeysWithValues: pl.panes.map { ($0.item, $0.rect) })
        }
        if let r = now() { return r }
        guard await wait(options.pageWait, { if now() != nil { return true }; w.remeasure(); return false }) else { return nil }
        return now()
    }
    // Each visible host's rect in `w`'s split as its page lays it out now (by its item's host): what a drag's frame and a
    // change of the page area place them at. Empty: no split shown there, or the page's isn't it.
    private func paneHostRects(_ w: HostedWindow) -> [HostID: CGRect] {
        guard let l = layout[w.id], let split = l.split, let pl = w.paneLayout, pl.split == split else { return [:] }
        var out: [HostID: CGRect] = [:]
        for p in pl.panes where l.items.contains(p.item) { if let h = open[p.item]?.host { out[h] = p.rect } }
        return out
    }
    // Every app's windows' known minimum as the page names their panes: a web page's (Safari's) as `web`, an app's by its
    // bundle id (behaviors/split.ts `paneFloors`), whether a window of it is open or not.
    func pageAppMinimums() -> [String: CGSize] {
        var out: [String: CGSize] = [:]
        for (bundle, m) in engine.knownAppMinimums { out[bundle == safariIdentifier ? "web" : bundle] = m }
        return out
    }
    // An app's known minimum changed (HostEngine `onAppMinimums`): told to the Margin window hosting.
    func appMinimumsChanged() { window(hostingWindow)?.setAppMinimums(pageAppMinimums()) }
    // Each pane's window's minimum told to `w`'s page (its divider stops there): the engine's, as learnt.
    private func refreshPaneMinimums(_ w: HostedWindow) {
        var out: [String: CGSize] = [:]
        if let l = layout[w.id], l.split != nil {
            for item in l.items { if let h = open[item]?.host, let m = engine.minimum(of: h) { out[item] = m } }
        }
        w.setPaneMinimums(out)
    }

    func applyLayout(_ windowId: Int?, main: String, mainRect: CGRect?, extras: [HostedLayout.Extra], focused: String?, split: (id: String, items: [String])? = nil) async {
        guard let w = window(windowId) else { return note("layout: no Margin window to lay it out in") }
        let hadItems = Set(layout[w.id]?.items ?? [])
        let hadFocus = layout[w.id]?.focused
        var parts: [LayoutPart] = []
        var mainUsed: Set<String> = [], panes: [String: Int] = [:]
        let asked: [(item: String, role: HostRole, rect: CGRect?)] = [(main, .main, mainRect)] + extras.map { ($0.item, $0.role, $0.rect) }
        for (i, a) in asked.enumerated() {
            // (The preview card: its profile's card window at the card's page, HostedPeek.swift.)
            if i > 0, let card = cardPart(a.item, rect: a.rect) { parts.append(card); continue }
            guard let t = library.target(ofItem: a.item) else { note("layout: \(a.item): no target"); if i == 0 { return }; continue }
            let url = (library.items().first { $0.id == a.item }?.value["url"] as? String) ?? ""
            switch t {
            case .app(let bundle, let name):
                labels[HostTarget.app(bundle).id] = appName(bundle) ?? (name.isEmpty ? nil : name) ?? bundle
                parts.append(LayoutPart(item: a.item, target: .app(bundle), profile: nil, url: url, role: a.role, rect: a.rect))
            case .web(let browser, let profile):
                guard browser == "safari" else { note("layout: \(a.item): \(browser) isn't hosted yet"); if i == 0 { return }; continue }
                let p = await profileFallback(resolve(profile), space: library.space(ofItem: a.item))
                let role: SafariRole
                if a.role == .card { role = .card } else if !mainUsed.contains(p) { role = .main; mainUsed.insert(p) } else {
                    let n = (panes[p] ?? 0) + 1
                    guard n <= 3 else { note("layout: \(a.item): a profile's fourth pane: not laid out (three at most)"); continue }
                    panes[p] = n
                    role = .pane(n)
                }
                if role != .main, role != .card, let address = paneAddress[a.item] ?? nil { paneAddressFor[SafariKey(p, role)] = address }
                if role != .main, role != .card { paneItemFor[SafariKey(p, role)] = paneItem[a.item] }
                labels[HostTarget.safariWindow(p, role).id] = "Safari"
                parts.append(LayoutPart(item: a.item, target: .safariWindow(p, role), profile: p, url: url, role: a.role, rect: a.rect))
            case .margin:
                note("layout: \(a.item): Margin's own page isn't laid out beside others")
                if i == 0 { return }
            }
        }
        guard let lead = parts.first, lead.item == main else { return }
        // (A web item whose window is there already: its tab in front first, out of sight, as a show does.)
        func showTab(_ part: LayoutPart) async -> Bool {
            guard let p = part.profile, case .safariWindow(_, let role) = part.target, let windowId = safariWindows[SafariKey(p, role)] else { return false }
            let (result, error) = await links.request(profile: p, "hostShow", cardShowPayload(part.item, windowId: windowId) ?? ["windowId": windowId, "itemId": part.item, "url": part.url.isEmpty ? "about:blank" : part.url, "pinned": pinnedOrFavorite(part.item)])
            guard let result else { note("layout: \(part.item): its tab wasn't shown (\(error ?? "no answer"))"); return false }
            open[part.item] = OpenItem(host: part.target.id, profile: p)
            if let tab = int(result["tabId"]) { safariTabs[part.item] = tab }
            return true
        }
        var tabbed: Set<String> = []
        for part in parts where part.profile != nil && engine.isHosted(part.target.id) { if await showTab(part) { tabbed.insert(part.item) } }
        defer { paneAddressFor = [:]; paneItemFor = [:] }
        guard let (placement, space) = await prepare(w, for: lead.target) else { settleHosting(); return }
        // (A split: every pane's rect as the page lays the split out, docs/PEEK-SPLIT.md §4.)
        if let split {
            guard let rects = await paneRects(w, split: split.id, items: split.items) else {
                note("layout: split \(split.id): Margin's window \(w.id)'s page didn't lay its panes out within \(options.pageWait) s: not shown")
                settleHosting()
                return
            }
            // (The preview card over the split keeps its own rect, its <m-preview-page>'s: it's no pane. HostedPeek.swift.)
            for i in parts.indices where parts[i].role != .card { parts[i].rect = rects[parts[i].item] }
            guard parts.allSatisfy({ $0.rect != nil }) else { note("layout: split \(split.id): a pane with no rect from the page: not shown"); settleHosting(); return }
            // (Room, before any window moves: every pane within the page area and at its window's known minimum. One that
            // isn't can't be placed (a rect past the display's edge has no full-screen plan), and trying made and dropped
            // its window's own Space at each ask. The real screen, 2026-11-21 19:32:02: Notes (701) added beside a Safari
            // tab (574) in 1264 pt, Safari's pane laid out at 949…1523, past the page area; Safari failed five times, the
            // split shown as an empty page. The ones coming in go, the person told, the item shown before kept.)
            if let out = Self.noRoom(parts.map { ($0.item, $0.role, $0.rect, Self.paneLeast) }, page: placement.page, had: hadItems) {
                note("layout: split \(split.id): no room in the page area \(Int(placement.page.width))×\(Int(placement.page.height)) (\(parts.filter { $0.role != .card }.map { p in "\(p.item) \(p.rect.map { "\(Int($0.minX))…\(Int($0.maxX))×\(Int($0.height))" } ?? "-") " }.joined(separator: ", ")), each pane 220 at least): nothing moved")
                let keep = hadFocus.flatMap { f in parts.contains { $0.item == f } && !out.contains(f) ? f : nil } ?? main
                leaveSplit(split.id, out.map { ($0, .failed(.place, Self.noRoomReason)) }, focus: keep, in: w)
                settleHosting()
                return
            }
        }
        let first = parts[0]
        var wanted: [HostExtra] = []
        for part in parts.dropFirst() { if let r = part.rect { wanted.append(HostExtra(target: part.target, role: part.role, rect: r)) } }
        let focusPart = focused.flatMap { f in parts.first { $0.item == f } }
        // (A split's pane opened or placed again beside the panes shown: its loader over its own box, not the page area's;
        // main's too when this split is what the window shows already. `paneLoadingStep`.)
        if let split, engine.shown != nil {
            let again = layout[w.id]?.split == split.id
            panesLaying[w.id] = Dictionary(parts.enumerated().filter { $0.offset > 0 ? $0.element.role == .pane : again }.map { ($0.element.target.id, $0.element.item) }, uniquingKeysWith: { a, _ in a })
        }
        defer { panesLaying[w.id] = nil }
        // (A pane whose window is made now: its loader kept over its box until its tab is in and its window's own
        // full-screen toolbar rests: `revealHeld`. The real screen, 2026-11-21 14:30:00: lifted as the engine was done,
        // before the copy moved the pane's tab in, Safari's toolbar out over the new pane's page for ~150 ms meanwhile.)
        let made = panesLaying[w.id] == nil ? [] : parts.dropFirst().filter { $0.role == .pane && $0.profile != nil && !engine.isHosted($0.target.id) }.map(\.target.id)
        if !made.isEmpty { revealHeld.insert(w.id) }
        defer { releaseReveal(w.id) }
        let results = await engine.setLayout(main: first.target, mainRect: first.rect, extras: wanted, focused: focusPart?.target.id, in: placement, marginWindow: w.number, marginSpace: space)
        var shownItems: [String] = []
        for part in parts {
            guard case .shown? = results[part.target.id] else { note("layout: \(part.item): not shown (\(results[part.target.id].map { "\($0)" } ?? "not laid out"))"); continue }
            if part.profile != nil, !tabbed.contains(part.item) { guard await showTab(part) else { continue } }
            if part.profile == nil { open[part.item] = OpenItem(host: part.target.id, profile: nil) }
            shownItems.append(part.item)
        }
        if !made.isEmpty {
            let new = made.filter { id in parts.contains { $0.target.id == id && shownItems.contains($0.item) } }
            // (Its page given the keys first, under its loader: a window Safari made keeps them in its address field and
            // its toolbar down over the page whatever made it, at its page or around its tab: the real screen, 2026-11-21.)
            _ = await engine.focusPages(new)
            _ = await engine.toolbarsRest(new)
            releaseReveal(w.id)
        }
        guard shownItems.contains(main) else {
            // (A split's main that found no room beside the panes coming in: they go, so main is laid out again alone.)
            if let split, case .failed(_, let why)? = results[first.target.id], Self.isNoRoom(why) {
                let incoming = parts.dropFirst().filter { $0.role == .pane && !hadItems.contains($0.item) }
                let keep = hadFocus.flatMap { f in parts.contains { $0.item == f } && !incoming.contains { $0.item == f } ? f : nil } ?? main
                if !incoming.isEmpty { leaveSplit(split.id, incoming.map { ($0.item, .failed(.place, Self.noRoomReason)) }, focus: keep, in: w) }
            }
            settleHosting(); onChange?(); return
        }
        let focus = focused.flatMap { shownItems.contains($0) ? $0 : nil } ?? main
        // (A split's pane that didn't come: out of it, the rest laid out again: `leaveSplit`.)
        if let split {
            // (The ones coming in first: a pane shown before that failed only beside a newcomer goes back to its rect once
            // the newcomer is out.)
            let failed = parts.dropFirst().filter { $0.role == .pane && !shownItems.contains($0.item) }
            let new = failed.filter { !hadItems.contains($0.item) }
            let out = new.isEmpty ? failed : new
            // (The pane that had the keys before keeps them, when the one asked to have them is what failed.)
            let keep = focused.map { f in out.contains { $0.item == f } } == true ? hadFocus.flatMap { shownItems.contains($0) ? $0 : nil } ?? focus : focus
            if !out.isEmpty { leaveSplit(split.id, out.map { ($0.item, results[$0.target.id]) }, focus: keep, in: w) }
        }
        let others = parts.dropFirst().filter { shownItems.contains($0.item) }
        layout[w.id] = others.isEmpty ? nil : HostedLayout(main: main, mainRect: first.rect, extras: others.map { HostedLayout.Extra(item: $0.item, role: $0.role, rect: $0.rect ?? .zero) }, focused: focus, split: split?.id)
        if split != nil, others.isEmpty { w.setPaneMinimums([:]) }
        if marginPages[w.id] != nil { marginPages[w.id] = nil; w.setMarginPage(nil) }
        // (A card focused: the item under it stays the window's item shown, the sidebar's highlight (a split's focused
        // pane, as it was); the card isn't one.)
        shown[w.id] = Self.isCardItem(focus) ? (shown[w.id].flatMap { shownItems.contains($0) && !Self.isCardItem($0) ? $0 : nil } ?? main) : focus
        if requested[w.id] == main || requested[w.id] == focus { requested[w.id] = nil }
        onChange?()
        note("layout: \(shownItems.count) item(s) shown in Margin's window \(w.id), \(focus) focused")
        if w.id == hostingWindow { w.setPaneCuts(paneCutsJSON(shownList)) }
    }

    // A pane's least size, Arc's 220×220 (the core's session/layout.rs `PANE_LEAST`). A pane's window may be wider:
    // it's shown cut (docs/PEEK-SPLIT.md §4b).
    nonisolated static let paneLeast: CGSize = {
        let n = (SessionRules.constants["paneLeast"] as? [NSNumber])?.map(\.doubleValue) ?? []
        return n.count == 2 ? CGSize(width: n[0], height: n[1]) : .zero
    }()

    // Why a pane didn't come, as `leaveSplit` and the toast say it, and whether a failure's words mean no room for it
    // (the core's `NO_ROOM_REASON`, `is_no_room`).
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

    // Panes of a split shown in `w` that didn't come (their window refused its rect, below its app's minimum; or it
    // didn't open): out of the split at once, in the library (decided 2026-11-21: the page lays out the library's split,
    // so a pane only marked failed would stay an empty box, its dividers dragging nothing; the item itself stays in its
    // space, open, and can be added again), the person told why (a toast), the rest laid out again by the show the
    // removal asks for, `focus` keeping the keys. The real screen, 2026-11-21 13:26:54: a third Safari pane failed, the
    // page kept three boxes, one empty, and two drags did nothing.
    private func leaveSplit(_ split: String, _ failed: [(item: String, result: HostResult?)], focus: String, in w: HostedWindow) {
        var room = false
        var names: [String] = []
        for (item, result) in failed {
            var why = "not laid out"
            if case .failed(_, let reason)? = result { why = reason }
            let noRoom = Self.isNoRoom(why)
            room = room || noRoom
            let title = (library.items().first { $0.id == item }?.value["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            names.append(title ?? (noRoom ? "that pane" : "a pane"))
            note("split \(split): \(item): out of the split (\(noRoom ? "no room for it" : "it didn't open"): \(why)); the rest laid out again")
            _ = library.perform("removeFromSplit", ["windowId": w.id, "tabId": item, "focus": focus])
        }
        let name = names.count == 1 ? "“\(String(names[0].prefix(60)))”" : "\(names.count) panes"
        let text = room ? "Not enough room for \(name) in Split View" : "\(name) couldn't open in Split View"
        if let t = jsonString(text) { w.push(#"{"type":"toast","text":"# + t + "}") }
    }

    // A host gone, or parked with nothing in its place: out of every layout (one that was main ends that layout).
    private func forgetInLayouts(_ id: HostID) {
        for (wid, var l) in layout {
            if open[l.main]?.host == id { layout[wid] = nil; continue }
            let before = l.extras.count
            l.extras.removeAll { open[$0.item]?.host == id }
            guard l.extras.count != before else { continue }
            if !l.items.contains(l.focused) { l.focused = l.main }
            layout[wid] = l.extras.isEmpty ? nil : l
        }
    }

    // Margin's window ready to host in its page area: in full screen (it always is; asked once more if it isn't, a
    // safety check), its page drawing its own layout for hosting, its page area measured. Nil: it couldn't be.
    private func prepare(_ w: HostedWindow, for target: HostTarget) async -> (HostPlacement, UInt64)? {
        if let other = hostingWindow, other != w.id, let was = window(other) {
            // (One Margin window hosts at a time: the one shown in the other parked first. That window keeps its item as a
            // card, faded, and takes it back once it's in front: `focused`.)
            let item = shown[other]
            // (A web item's page pictured first, while its window still shows it: its card there is that, faded.)
            var picture: String?
            if let item { picture = await pagePicture(of: item) }
            await engine.parkShown(why: "another Margin window hosts")
            shown[other] = nil
            hostingWindow = nil
            was.setHosted(nil)
            was.setShowing(nil)
            was.setHosting(false)
            if let item { showElsewhere(item, in: was, picture: picture) }
        }
        // (This window's own card stays until it hosts (below): cleared before, its launcher was drawn in between.)
        if !w.isFullScreen {
            note("Margin's window \(w.id) not in full screen (it always is while hosting is on: \(w.fullScreenState)): asked")
            w.toFullScreen()
            guard await wait(options.fullScreenWait, { w.isFullScreen }) else {
                note("Margin's window \(w.id) didn't go full screen (\(w.fullScreenState)): nothing hosted")
                return nil
            }
        }
        if await !wait(1.5, { w.layoutMode == "fullscreen" }) {
            note("Margin's window \(w.id): no full-screen layout from its page in 1.5 s (\(w.layoutMode ?? "none")): its last one is used")
        }
        w.setHosting(true)
        hostingWindow = w.id
        w.setAppMinimums(pageAppMinimums())
        // (Its card, if it had one, goes now that it hosts: straight to the loader, never its launcher for a frame.)
        if elsewhere[w.id] != nil { elsewhere[w.id] = nil; w.setElsewhere(nil, app: nil) }
        // (Asked to measure again at every look: a size the window took may not have been drawn yet.)
        guard await wait(options.pageWait, { if w.hostedPlacement != nil { return true }; w.remeasure(); return false }), let placement = w.hostedPlacement else {
            note("Margin's window \(w.id): no page area (\(w.pageAreaWhyNot))")
            return nil
        }
        return (placement, engine.fullScreenSpace(ofWindow: w.number) ?? 0)
    }

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
    // window's page card is opaque, with the theme's loader and the app's name.
    func loading(_ id: HostID?) {
        if cardLoadingStep(id) { return }
        appLoading = id
        defer { refreshLoading() }
        guard let wid = hostingWindow, let w = window(wid) else { return }
        if paneLoadingStep(id) { w.setLoading(nil); return }
        w.setLoading(id.map { labels[$0] ?? $0.description }, app: id?.iconApp)
    }

    // The split's panes being laid out in each Margin window now, by their hosts (applyLayout, around the engine's
    // setLayout), and the pane whose slow step is under way (its window, its host).
    var panesLaying: [Int: [HostID: String]] = [:]
    private var paneLoadingAt: (window: Int, host: HostID)?
    // Margin windows whose new pane keeps its loader after the engine's slow step is over (applyLayout: until its tab is
    // shown and its toolbar rests), and the hold let go.
    private var revealHeld: Set<Int> = []
    private func releaseReveal(_ wid: Int) {
        guard revealHeld.remove(wid) != nil, let had = paneLoadingAt, had.window == wid, appLoading != had.host else { return }
        window(wid)?.setPaneLoading(nil, label: nil, app: nil)
        paneLoadingAt = nil
    }
    // The engine's slow step for a split's pane opening (or placed again) beside the panes shown (docs/PEEK-SPLIT.md
    // §4): its loader over its own box (the window's `setPaneLoading`: its item, a web page's title or the app's name,
    // its icon), the other panes shown and usable; never the page area's loader over all of them (2026-11-21: Notes
    // added covered the whole page with "Opening Notes…" for 2.2 s). True: it was a pane's (or one just over).
    func paneLoadingStep(_ id: HostID?) -> Bool {
        let wid = hostingWindow
        let item = id.flatMap { id in wid.flatMap { panesLaying[$0]?[id] } }
        var was = false
        if let had = paneLoadingAt, item == nil || had.window != wid || had.host != id {
            if id == nil, revealHeld.contains(had.window) { return true } // (kept: `releaseReveal`)
            window(had.window)?.setPaneLoading(nil, label: nil, app: nil)
            paneLoadingAt = nil
            was = id == nil
        }
        guard let id, let item, let wid, let w = window(wid) else { return was }
        paneLoadingAt = (wid, id)
        let title = (library.items().first { $0.id == item }?.value["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let label = id.raw.hasPrefix("app:") ? labels[id] ?? id.description : title ?? labels[id] ?? "Safari"
        w.setPaneLoading(item, label: label, app: id.iconApp)
        return true
    }

    // A Safari profile's copy's `loading` push (background/page-loads.ts: its tabs loading in one of its windows): kept
    // for the window Margin hosts for that profile, the bar drawn for its items' tabs.
    func copyLoading(profile: String, windowId: Int?, tabIds: [Int]) {
        guard let windowId, safariWindows[SafariKey(profile)] == windowId else { return }
        let next = Set(tabIds)
        guard next != copyLoading[profile] ?? [] else { return }
        copyLoading[profile] = next
        refreshLoading()
    }

    // A push of a Safari profile's copy for its UI (UIPush.swift: only the types passed on, checked and cut there), for
    // a window Margin hosts for that profile, any role (the person's own windows: not Margin's), to the Margin window it
    // belongs in. Its tabs named by the UI's numbers for their items (`uiNumber`); one that isn't an item open in
    // Margin is left out. Which window (DECISIONS.md, the mini player): the Margin window showing the space of the
    // item it's about (the first source: the copy lists playing ones first, the newest first), the hosting one or
    // the one in front first among several; none showing it: the hosting window, else the one in front. A standing
    // push (`media`) is taken back from the window that had it when another gets it (its empty one).
    func copyPush(profile: String, windowId: Int?, msg: JSONObject) {
        guard let windowId, safariWindows.contains(where: { $0.key.profile == profile && $0.value == windowId }), let type = msg["type"] as? String else { return }
        var items: [String] = []
        guard let page = UIPush.page(msg, tab: { entry in
            guard let (item, n) = self.uiNumber(profile: profile, entry: entry) else { return nil }
            items.append(item)
            return n
        }) else { return }
        let ids = windowIds()
        let showing = items.first.flatMap { library.space(ofItem: $0) }.map { space in ids.filter { library.space(ofWindow: $0) == space } } ?? []
        let front = window(nil)?.id
        let pick = showing.first { $0 == hostingWindow } ?? showing.first { $0 == front } ?? showing.min() ?? hostingWindow ?? front
        guard let pick, let target = window(pick), let json = jsonString(page) else { return }
        if UIPush.standing.contains(type) {
            if let had = standingTo[type], had != pick, let empty = UIPush.empty(type).flatMap({ jsonString($0) }) { window(had)?.push(empty) }
            let isEmpty = (page.values.compactMap { $0 as? [Any] }.allSatisfy { $0.isEmpty })
            standingTo[type] = isEmpty ? nil : pick
        }
        target.push(json)
    }
    // The Margin window each standing push was last given to (with something in it).
    private var standingTo: [String: Int] = [:]

    // The item a copy's tab shows, and the UI's number for it: the item the copy names (its tag: background/hosted.ts),
    // else the item whose tab it is (hostShow's answer), else the open item of that profile at its address (a copy
    // started again knows no tags until the next hostShow, and Safari's tab ids change as it restarts). The tab is
    // kept as that item's (`hostMedia` names it). Nil: not one of Margin's items open in that profile.
    private func uiNumber(profile: String, entry: JSONObject) -> (String, Int)? {
        let tab = int(entry["tabId"])
        let ofProfile = { (item: String) in self.open[item]?.profile == profile }
        var item = (entry["itemId"] as? String).flatMap { ofProfile($0) ? $0 : nil }
        if item == nil, let tab { item = safariTabs.first { $0.value == tab && ofProfile($0.key) }?.key }
        if item == nil, let url = entry["url"] as? String, !url.isEmpty {
            let plain = { (u: String) in u.replacingOccurrences(of: #"#.*$"#, with: "", options: .regularExpression).replacingOccurrences(of: #"/$"#, with: "", options: .regularExpression) }
            let values = Dictionary(library.items().map { ($0.id, $0.value) }, uniquingKeysWith: { a, _ in a })
            item = open.keys.sorted().first { ofProfile($0) && (values[$0]?["url"] as? String).map(plain) == plain(url) }
        }
        guard let item else { return nil }
        if let tab { safariTabs[item] = tab }
        return (item, number(ofItem: item))
    }

    // The items loading now, by the UI's numbers, told to the hosting Margin window when they change: the item an app is
    // being opened (or placed again) for while the engine's slow step runs, and every web item whose tab its copy says
    // is loading. Nothing hosted: none.
    private func refreshLoading() {
        var items: Set<String> = []
        if let wid = hostingWindow {
            if let id = appLoading, let item = showing[id] ?? shown[wid].flatMap({ open[$0]?.host == id ? $0 : nil }) { items.insert(item) }
            for (item, o) in open {
                guard let p = o.profile, let tab = safariTabs[item], copyLoading[p]?.contains(tab) == true else { continue }
                items.insert(item)
            }
        }
        for (wid, said) in loadingSaid where wid != hostingWindow && !said.isEmpty {
            loadingSaid[wid] = []
            window(wid)?.setLoadingTabs([])
        }
        guard let wid = hostingWindow, let w = window(wid) else { return }
        let numbers = items.map { number(ofItem: $0) }.sorted()
        guard numbers != loadingSaid[wid] ?? [] else { return }
        loadingSaid[wid] = numbers
        w.setLoadingTabs(numbers)
    }

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

    // A card open in Margin's window `w`: a press on the page area around its content (Margin's window caught it). Preview
    // closes the card then (docs/PEEK-SPLIT.md §2: `onCardDismiss`); nothing else is done here.
    var onCardDismiss: ((Int) -> Void)?
    func caughtPress(_ w: HostedWindow, at point: CGPoint) {
        guard w.id == hostingWindow, layout[w.id]?.extras.contains(where: { $0.role == .card }) == true else { return }
        note("Margin's window \(w.id): a press on the page around the card")
        if let onCardDismiss { onCardDismiss(w.id) } else { closeCard(windowId: w.id, why: "a press on the dimmed page around it") }
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
    // last quit (the library's `selected`, the newest if several), and nothing else of the page area first: called as
    // the window is made, before its page loads, so its page's hello already says hosting and `loading` with the item's
    // name (no launcher for a frame) and the sidebar has its row lit. The show itself waits for the window to be in full
    // screen with its page area measured, then runs as any pick: an app's first open, or a web item (its browser made
    // ready at launch if that got there first, else started now: the loader stays the 4-5 s a cold Safari takes).
    // No selected item, or one that can't be hosted: the launcher, as before. A show that fails: the launcher.
    // `defaults write com.unibox.margin MarginResumeLast -bool NO`: never (the launcher at every launch; the on-screen
    // checks set it, so nothing of the person's is opened by them).
    private(set) var resuming: Int? // the Margin window whose last item is being shown at launch (it keeps hosting meanwhile)
    private var resumed = false

    // ---- an item in another Margin window (Tirth, 2026-11-18) ----

    // One Margin window hosts at a time. Another one's item stays on it as a card, faded ("… is in another window. Click to show it here.", the
    // page's words); the window brought in front (`focused`, a click on it) takes the item back: the app's one window
    // follows the window in use. Each window's item, by window.
    private(set) var elsewhere: [Int: String] = [:]
    private func showElsewhere(_ item: String, in w: HostedWindow, picture: String? = nil) {
        guard let value = library.items().first(where: { $0.id == item })?.value else { return }
        elsewhere[w.id] = item
        let target = library.target(ofItem: item)
        let name: String
        let app: String
        switch target {
        case .app(let bundle, let n)?: name = appName(bundle) ?? n; app = bundle
        default: name = (value["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (value["url"] as? String) ?? "the page"; app = safariIdentifier
        }
        w.setElsewhere(String(name.prefix(120)), app: app, picture: picture)
        note("Margin's window \(w.id): its item \(item) shown in another window now: its card\(picture != nil ? " with its page's picture" : ""), until it's in front again")
    }
    // A web item's page as its Safari window shows it now (the copy's `hostPicture`), or nil: not a web item, its copy
    // not linked, no picture, or none within `pictureWait` (the move doesn't wait longer: the card alone then).
    private func pagePicture(of item: String) async -> String? {
        guard options.pictureWait > 0, let open = open[item], let p = open.profile, open.host == HostTarget.safariWindow(p).id,
              let windowId = safariWindows[SafariKey(p)] else { return nil }
        let first = FirstOf<String?>()
        let links = links
        return await withCheckedContinuation { (k: CheckedContinuation<String?, Never>) in
            first.then = { k.resume(returning: $0) }
            Task { @MainActor in
                let (result, _) = await links.request(profile: p, "hostPicture", ["windowId": windowId, "itemId": item])
                let data = result?["data"] as? String
                first.give(data.flatMap { $0.hasPrefix("data:image/jpeg;base64,") || $0.hasPrefix("data:image/png;base64,") ? $0 : nil })
            }
            Task { @MainActor [wait = options.pictureWait] in
                try? await Task.sleep(for: .seconds(wait))
                first.give(nil)
            }
        }
    }
    // A Margin window brought in front: its item from another window shown here again.
    func focused(_ windowId: Int) {
        guard let item = elsewhere[windowId], hostingWindow != windowId, let w = window(windowId) else { return }
        guard library.items().contains(where: { $0.id == item }) else {
            elsewhere[windowId] = nil
            return w.setElsewhere(nil, app: nil)
        }
        requested[windowId] = item
        onChange?()
        let target = library.target(ofItem: item)
        enqueue {
            guard self.requested[windowId] == item, self.hostingWindow != windowId else { return }
            await self.show(item, url: nil, target: target, windowId: windowId)
            if self.requested[windowId] == item { self.requested[windowId] = nil }
        }
    }
    // A Margin window closing while it hosts (its close button): only that window goes (Margin keeps running, its items
    // stay open, tabs of their spaces). What it shows is parked first, while its Space is still there; `done` closes it.
    // Not queued behind the session's own work: the engine takes it next.
    func windowClosing(_ w: HostedWindow, then done: @escaping () -> Void) {
        guard w.id == hostingWindow, engine.shown != nil else { return done() }
        note("Margin's window \(w.id) closing while it hosts: the one shown parked first")
        Task {
            await self.engine.parkShown(why: "its Margin window closed")
            done()
        }
    }

    // A Margin window closed: what the session kept for it goes (its card, its item shown, asked for or to resume, its
    // Margin page). It hosted: nothing hosts until another window shows something (parked already by `windowClosing`;
    // now if that didn't get there in time). The window in front next takes its own item back (`focused`).
    func windowClosed(_ id: Int) {
        note("Margin's window \(id) closed: its items stay open (parked)\(elsewhere[id].map { ", its card for \($0) gone" } ?? "")")
        forgetElsewhere(windowId: id)
        requested[id] = nil
        shown[id] = nil
        marginPages[id] = nil
        resume[id] = nil
        cycledAt[id] = nil
        standingTo = standingTo.filter { $0.value != id }
        if hostingWindow == id {
            hostingWindow = nil
            if engine.shown != nil { Task { await self.engine.parkShown(why: "its Margin window closed") } }
        }
        refreshLoading()
        loadingSaid[id] = nil
        onChange?()
    }

    // A window gone, or its item closed: its card goes.
    func forgetElsewhere(windowId: Int? = nil, item: String? = nil) {
        for (w, i) in elsewhere where w == windowId || i == item {
            elsewhere[w] = nil
            window(w)?.setElsewhere(nil, app: nil)
        }
    }

    // ---- the start (Tirth, 2026-11-18): the default browser first, behind "Getting you started" ----

    // The person's default browser always starts with Margin, its window made ready out of sight, before the item a
    // window showed last (an app or a page): ⌘T and a search work at once whatever that item was. Margin's window says
    // "Getting you started" meanwhile, then that item's name while it opens. `waiting`: the preparation hasn't run;
    // `preparing`: under way; `done`: ready, or not done (no browser Margin hosts, turned off, failed, the person picked
    // something else first). Never held longer than `startupWait`.
    enum Startup: Equatable { case waiting, preparing, done }
    private(set) var startup = Startup.waiting
    static let startupLabel = "Getting you started"
    private var startupWaiting = false // a window's last item waits for the preparation (it wakes the browser's profile)
    // The start screen (Tirth, 2026-11-19): while the default browser gets ready, Margin's window is the start screen
    // alone, the theme's loader over the whole window (no sidebar, no app's icon, no words), nothing of Margin's usable
    // (its page ignores the keys, ⌘N opens no window). Held up, what's wrong is said there with Try again and Continue
    // without Safari: still not ready after `startupWait`, or given up because the browser's extension didn't link.
    private(set) var startupShown = false
    private(set) var startupStuck: String? // what the start screen says is wrong now
    private var startupFailure: String? // the preparation given up for a reason the person can fix (said on the screen)
    private var startupSkipped = false // Continue without Safari
    private(set) var startupRetries = 0 // Try again, each time
    private var preparedSetting: String? // the default browser setting the preparation ran with (Try again runs it again)
    static let startupSlow = "Safari is taking longer than usual to start."
    static let startupNoLink = "Safari started, but Margin’s Safari extension didn’t connect. Check that Margin is turned on in Safari › Settings › Extensions."

    // The start screen's Try again: the preparation run again if it was given up, else waited for again (its limit anew).
    func startupRetry() {
        guard startupShown, startupStuck != nil else { return }
        startupRetries += 1
        note("the start screen: Try again (\(startupRetries))")
        guard startup == .done, startupFailure != nil else { return }
        startupFailure = nil
        startup = .waiting
        Task { await self.prepareBrowser(setting: self.preparedSetting) }
    }

    // The start screen's Continue without Safari: Margin usable now, the browser made ready when it can be (a web item
    // opens it then).
    func startupSkip() {
        guard startupShown, startupStuck != nil, !startupSkipped else { return }
        startupSkipped = true
        note("the start screen: Continue without Safari")
    }

    // Until the browser is ready, Continue without Safari is picked, or another item is asked for: `startupWait`, then
    // (still not ready) what's wrong said with the two choices, waited on as long as it takes; given up because its
    // extension didn't link: said at once.
    private func holdStartup(_ w: HostedWindow, last: String?) async {
        var limit = options.startupWait
        let moved = { last.map { self.requested[w.id] != $0 } ?? false }
        while true {
            _ = await wait(limit) { self.startup == .done || self.startupSkipped || moved() }
            if startupSkipped || moved() || (startup == .done && startupFailure == nil) { break }
            let why = startupFailure ?? Self.startupSlow
            if startupStuck != why {
                startupStuck = why
                w.setStartupStuck(why)
                note("the start screen held up: \(startupFailure == nil ? "the default browser not ready within \(Int(limit)) s" : "its extension didn't link"): Try again or Continue without Safari")
            }
            let retries = startupRetries
            _ = await wait(.infinity) { self.startupSkipped || moved() || self.startupRetries != retries || (self.startup == .done && self.startupFailure == nil) }
            if startupRetries != retries, !startupSkipped, !moved() {
                startupStuck = nil
                w.setStartupStuck(nil)
                limit = options.startupWait
            }
        }
        if startupStuck != nil { startupStuck = nil; w.setStartupStuck(nil) }
    }
    func preparationOver() {
        guard startup != .done else { return }
        startup = .done
        onChange?()
    }
    static let resumeKey = "MarginResumeLast"
    static func resumesLast(setting: Any?) -> Bool { setting as? Bool != false }

    // The item a Margin window showed last, of its space's items (the core's session/start.rs `last_item`: the one
    // selected, the newest used if several, if it can be hosted); its target and the name its loader says (an app's
    // own name first, when it has one).
    func lastItem(ofWindow id: Int) -> (item: String, target: ItemTarget, name: String)? {
        let space = library.space(ofWindow: id) ?? library.spaces().first?.id
        let items: [Any] = library.items(space: space).map { ["id": $0.id, "value": $0.value, "target": library.target(ofItem: $0.id)?.json as Any? ?? NSNull()] }
        let out = SessionRules.call(["rule": "lastItem", "items": items])
        guard let item = out["item"] as? String, let name = out["name"] as? String, let target = library.target(ofItem: item) else { return nil }
        return (item, target, (out["app"] as? String).flatMap { appName($0) } ?? name)
    }

    // The app whose icon the loader shows for an item (the core's `loader_app`).
    static func loaderApp(_ target: ItemTarget) -> String? {
        SessionRules.call(["rule": "loaderApp", "target": target.json])["app"] as? String
    }

    func resumeLast(_ w: HostedWindow) {
        guard !resumed, hostingWindow == nil, engine.shown == nil else { return }
        resumed = true
        // (MarginResumeLast NO: no item shown again, the start screen still: nothing's usable before the browser is.)
        let last = options.resumesLast ? lastItem(ofWindow: w.id) : nil
        let gate = options.preparesBrowser && startup != .done
        if let last, case .margin(let page) = last.target, !gate {
            // Margin's own page (Settings) shown last: drawn by the window itself from its page's first frame (its
            // hello says it), nothing hosted, nothing to wait for.
            marginPages[w.id] = page
            marginOpen.insert(last.item)
            shown[w.id] = last.item
            w.setMarginPage(page)
            note("Margin's window \(w.id): the item it showed last (\(last.item)), Margin's \(page) page, shown again")
            onChange?()
            return
        }
        guard last != nil || gate else { return }
        resuming = w.id
        hostingWindow = w.id
        if let last { requested[w.id] = last.item }
        w.setHosting(true)
        if gate {
            startupWaiting = true
            startupShown = true
            w.setShowing(Self.startupLabel, app: safariIdentifier, slow: true)
            note("Margin's window \(w.id): \"\(Self.startupLabel)\" while the default browser starts\(last.map { ", then the item it showed last (\($0.item))" } ?? "")")
        } else if let (item, target, name) = last {
            w.setShowing(name, app: Self.loaderApp(target), slow: true)
            note("Margin's window \(w.id): the item it showed last (\(item)) shown again, behind the loader from its first frame")
        }
        onChange?()
        Task { @MainActor in
            if gate {
                // (Outside the session's queue: the preparation's own step is in it.)
                await self.holdStartup(w, last: last?.item)
                self.startupWaiting = false
                self.startupShown = false
                if self.startup != .done { self.note("the start screen left before the default browser was ready (Continue without Safari): the browser when it's ready") }
            }
            guard let (item, target, name) = last, self.requested[w.id] == item else {
                // (No item to show again, or another picked meanwhile: the loader goes, its own show decides.)
                self.resuming = nil
                if last == nil { self.settleHosting() } else { w.setShowing(nil) }
                return
            }
            if gate { w.setShowing(name, app: Self.loaderApp(target), slow: true) }
            self.resumeShow(w, item: item, target: target)
        }
    }

    private func resumeShow(_ w: HostedWindow, item: String, target: ItemTarget) {
        enqueue {
            defer {
                self.resuming = nil
                w.setShowing(nil)
                // (Something else asked for meanwhile: its own show decides; else nothing shown is the launcher.)
                if self.requested[w.id] == nil || self.requested[w.id] == item { self.requested[w.id] = nil; self.settleHosting() }
            }
            // (Something else asked for meanwhile ends the wait: its own show is next in line, not held up by this one.)
            // (Margin's own page needs no page area to host into: drawn at once.)
            let own: Bool = { if case .margin = target { return true }; return false }()
            let ready = own ? true : await self.wait(self.options.prepareWindowWait) { (w.isFullScreen && w.hostedPlacement != nil) || self.requested[w.id] != item }
            if self.overtaken(item, windowId: w.id) { return }
            guard self.requested[w.id] == item else { return }
            guard ready else {
                // (Margin's window not up in time: the launcher for now, and the item hosted once the window is in full
                // screen, as after macOS took it out: `enteredFullScreen`.)
                if !w.isFullScreen { self.resume[w.id] = item }
                return self.note("\(item): not shown at launch: Margin's window \(w.id) wasn't in full screen with its page area within \(Int(self.options.prepareWindowWait)) s\(w.isFullScreen ? "" : ": shown once it is")")
            }
            await self.show(item, url: nil, target: target, windowId: w.id)
        }
    }

    // Margin's window hosts only while the engine shows something in it: nothing shown, its launcher in the page area
    // again (after each of the session's steps, and the engine's events, once the engine is done). Not while its last
    // item is still on its way at launch (`resuming`).
    func settleHosting() {
        guard engine.shown == nil, let id = hostingWindow, resuming != id else { return }
        // (Another item asked for and not shown yet: its show is next and decides; no launcher for a frame in between.)
        if let next = requested[id], next != shown[id] { return }
        hostingWindow = nil
        if marginPages[id] == nil { shown[id] = nil } // (Margin's own page shown there: still the one shown)
        window(id)?.setHosted(nil)
        window(id)?.cover(nil)
        // (Hosting off before the loader's words go: words cleared on a card still loading draw "Opening…" for a frame.)
        window(id)?.setHosting(false)
        window(id)?.setLoading(nil)
        window(id)?.setShowing(nil)
        refreshLoading()
        onChange?()
    }

    // ---- the launcher asked for ----

    // The palette's Settings or Archive in Margin's window (the UI's openLauncher). Settings (Tirth, 2026-11-20): its
    // own tab, `margin://settings`, the space's one shown again or a new one (library.ts openMarginPage), drawn by
    // Margin's window in its page area (`show`, ItemTarget.margin). Archive: the launcher in the page area, the item
    // shown there parked (its row shows it again). Until 2026-11-19 refused while hosting, and nothing happened.
    func openLauncher(windowId: Int?, settings: Bool) {
        guard let id = window(windowId)?.id else { return note("the launcher asked for: no Margin window") }
        if settings {
            let out = library.perform("openMarginPage", ["windowId": id, "page": "settings"])
            return note("Margin's window \(id): Settings asked for\(out.ok ? "" : ", refused (\(out.error ?? "?"))")")
        }
        enqueue {
            if self.engine.shown != nil, self.hostingWindow == id { await self.engine.parkShown(why: "the launcher asked for in Margin's window") }
            self.settleHosting()
            if let w = self.window(id) { self.leaveMarginPage(w) }
            self.note("Margin's window \(id): its launcher in the page area")
        }
    }

    // Margin's own page a window shows, gone: its launcher in the page area (nothing shown there now).
    private func leaveMarginPage(_ w: HostedWindow) {
        guard marginPages[w.id] != nil else { return }
        marginPages[w.id] = nil
        w.setMarginPage(nil)
        if hostingWindow != w.id { shown[w.id] = nil }
        onChange?()
    }

    // ---- closing ----

    func close(_ item: String, target: ItemTarget?) async {
        _ = await call("close", ["item": item, "target": target?.json ?? NSNull()])
    }

    // ---- the default browser made ready at launch ----

    // Decided by Tirth (2026-11-16): the person's default browser (`DefaultBrowser`) is made ready
    // in the background at Margin's launch, so the first web item is a switch-in plus its page load: started with no
    // Dock icon if it isn't running (the person's running one used as it is, never restarted), its copy for the profile
    // web items will use linked (the front Margin window's space's profile, else the default one), Margin's window asked
    // of it (a blank page) and taken all the way to ready by the engine's early full screen, then parked out of sight
    // (never seen on screen, in Mission Control or the Dock). Not possible out of sight (no early full screen, something
    // shown): not prepared, said; its first use opens it as before. Another profile's window: on its first use, as before.
    // Called by the shell once the library and the engine are up; it never delays Margin's own window.
    func prepareBrowser(setting: String?) async {
        guard options.preparesBrowser else { return preparationOver() }
        preparedSetting = setting
        startup = .preparing
        let started = now()
        let browser = DefaultBrowser.resolve(setting)
        func skip(_ why: String) { note("browser not prepared: \(why)"); preparationOver() }
        guard browser.name == "safari" else { return skip("\(browser.name) isn't hosted yet") }
        guard engine.preparesOutOfSight else { return skip("the early full screen isn't available, so it can't be made ready out of sight") }
        // 1. the browser started at once, beside Margin's own window going full screen, not after it (the real Mac,
        // 2026-11-18: Margin's window took 2.7 s; Safari then takes ~1.3 s to its first window and 2.5–3 s to its
        // extension whatever Margin's window does: step 0's timings, docs/ARCHITECTURE-PLAN.md).
        let starting = Task { await self.engine.start(bundleId: browser.bundleId) }
        // 2. a Margin window in full screen, its page area measured.
        guard await wait(options.prepareWindowWait, { self.window(nil).map { $0.isFullScreen && $0.idlePlacement != nil } ?? false }), let w = window(nil) else {
            return skip("no Margin window in full screen with its page area within \(Int(options.prepareWindowWait)) s")
        }
        let space = library.space(ofWindow: w.id) ?? library.spaces().first?.id
        let spaceProfile = (library.spaces().first { $0.id == space }?.value["profile"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        // 3. its copy linked (outside the session's and the engine's queues: the person's picks meanwhile aren't held up).
        guard await starting.value != nil else { return skip("\(browser.bundleId) couldn't be started with no Dock icon") }
        var p = resolve(spaceProfile)
        // (A profile with no window is woken through Safari's menu only for a preparation that can still happen: nothing
        // shown, nothing on its way, nothing asked for. 2026-11-17 14:05: woken 0.9 s after Maps was shown, the
        // preparation then given up and the woken window left open over Maps.)
        let wanted = { self.engine.shown == nil && (self.startupWaiting || (self.resuming == nil && self.requested.isEmpty)) }
        var linked = await safariLinked(p, wakeIf: wanted)
        // (One Margin can't open, its name unknown: the default profile made ready instead, never the start held up for
        // it; its page says so when it's shown, `profileFallback`. 2026-11-18 23:02: four presses, 15 s, nothing.)
        if !linked, unopenable.contains(p), p != Self.defaultSafariProfile {
            note("browser: the space's Safari profile can't be opened (its name unknown): the default profile made ready instead")
            p = Self.defaultSafariProfile
            linked = await safariLinked(p, wakeIf: wanted)
        }
        guard linked else {
            await closeWoken(p, why: " (its preparation given up)")
            // (Said on the start screen while it's up: the person can turn the extension on, then Try again.)
            if wanted(), startupShown { startupFailure = Self.startupNoLink }
            return skip(wanted() ? "its extension didn't link" : "something is shown in Margin's window (its profile not woken for it)")
        }
        let target = HostTarget.safariWindow(p)
        // 4. its window made ready out of sight, one at a time with the person's requests.
        enqueue {
            // (Given up below, a window opened to wake its profile is closed: it was only for this.)
            @MainActor func skip(_ why: String) async { await self.closeWoken(p, why: " (its preparation given up)"); self.note("browser not prepared: \(why)"); self.preparationOver() }
            guard !self.engine.isHosted(target.id) else { return await skip("its window is hosted already") }
            guard self.engine.shown == nil else { return await skip("something is shown in Margin's window") }
            guard let mw = self.window(w.id), let placement = mw.idlePlacement, let marginSpace = self.engine.fullScreenSpace(ofWindow: mw.number) else {
                return await skip("Margin's window isn't in full screen with its page area")
            }
            let wasActive = self.marginActive()
            self.preparingWindow = mw.id
            self.preparingProfile = p
            let t0 = self.now()
            let result = await self.engine.prepare(target, in: placement, marginWindow: mw.number, marginSpace: marginSpace)
            self.preparingWindow = nil
            self.preparingProfile = nil
            if wasActive, !self.marginActive() { self.activateMargin() }
            switch result {
            case .shown:
                self.note("browser prepared in \(Int(((self.now() - started) * 1000).rounded())) ms (its window \(Int(((self.now() - t0) * 1000).rounded())) ms), parked out of sight")
                self.preparationOver()
            case .failed(let step, let why):
                await skip("\(step.rawValue): \(why)")
            }
        }
    }
    // The Margin window a browser's window is made ready over (covered by it), and its profile.
    private(set) var preparingWindow: Int? {
        get { field(.preparingWindow) { $0.first?.i0 } }
        set { setOne(.preparingWindow, old: preparingWindow, newValue) { CoreRow(i0: $0) } }
    }
    private var preparingProfile: String? {
        get { field(.preparingProfile) { $0.first?.s0 } }
        set { setOne(.preparingProfile, old: preparingProfile, newValue) { CoreRow(s0: $0) } }
    }

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
            for k in safariWindows.keys where HostTarget.safariWindow(k.profile, k.role).id == id { safariWindows[k] = nil; if k.role == .main { copyLoading[k.profile] = nil } }
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

    // Taken once per run of changes (a theme's layout reports come in bursts): the newest placement, when its turn comes.
    // Held while the sidebar's edge is dragged (`resizing`): one placing when the drag is over.
    private var placing = false
    func pageRectChanged(_ window: HostedWindow) {
        // (A drag the one shown follows live: each page area of it to the engine at once; Margin's own once it's over.)
        if following, resizing == window.id, window.id == hostingWindow, let p = window.hostedPlacement {
            // (A split's panes too, each at its `<m-pane>` in this frame: docs/PEEK-SPLIT.md §4.)
            // (The preview card too, at its <m-preview-page> in this frame: HostedPeek.swift.)
            let rects = paneHostRects(window).merging(cardHostRects(window)) { a, _ in a }
            return rects.isEmpty ? engine.follow(p) : engine.follow(p, rects: rects) // (a window-mode window's hole read again as it moves: the engine says so)
        }
        guard window.id == hostingWindow, engine.shown != nil, resizing != window.id, !placing else { return }
        placing = true
        enqueue {
            self.placing = false
            // (Asked before a drag began, its turn come during it: the drag's end places.)
            guard self.resizing != window.id else { return }
            await self.placeAgain(window)
        }
    }

    // The hosted window placed for the page area as it is now. Never at the cost of the item (bug of 2026-11-17: a
    // second placing failed and the window was lost): the engine keeps a window that didn't leave full screen shown at
    // the frame it had (`placed` false, still shown: the hole follows its bounds, the theme's frame colour in any gap,
    // placed again when it's next shown); one that left full screen and didn't come back in at the new size is hosted
    // still, out of sight: shown again once, `refitRetryAfter` later (Safari may be mid-transition), behind the loader;
    // failing that too, the launcher, its item kept in the sidebar (a click shows it again).
    private func placeAgain(_ window: HostedWindow) async {
        guard window.id == hostingWindow, let id = engine.shown, let placement = window.hostedPlacement else { return }
        // (A split shown: each pane's window at its `<m-pane>` as laid out now, its rects kept with the layout.)
        // (The preview card over it too, at its <m-preview-page> as laid out now: kept in the layout with the panes.)
        let rects = paneHostRects(window).merging(cardHostRects(window)) { a, _ in a }
        cardPlaced(window, rects: rects)
        if !rects.isEmpty, var l = layout[window.id] {
            if let h = open[l.main]?.host, let r = rects[h] { l.mainRect = r }
            for i in l.extras.indices { if let h = open[l.extras[i].item]?.host, let r = rects[h] { l.extras[i].rect = r } }
            layout[window.id] = l
        }
        let placed = rects.isEmpty ? await engine.pageRectChanged(placement) : await engine.pageRectChanged(placement, rects: rects)
        window.hostedMoved()
        let kept = !placed && engine.shown == id
        note("page area changed: \(Int(placement.page.width))×\(Int(placement.page.height))\(placed ? "" : kept ? " (not fitted: shown at the frame it had)" : " (not fitted)")")
        guard !placed, engine.shown == nil, engine.isHosted(id) else { return }
        window.setShowing(labels[id] ?? id.description, app: id.iconApp)
        defer { window.setShowing(nil); settleHosting() }
        await sleep(options.refitRetryAfter)
        guard hostingWindow == window.id, engine.shown == nil, engine.isHosted(id), requested[window.id] == nil else { return }
        let result = await engine.show(id)
        if case .failed(let step, let why) = result {
            note("\(id): not shown again after its placing failed (\(step.rawValue): \(why)): hosted still, out of sight; its item is kept")
        } else {
            note("\(id): shown again after its placing failed")
        }
    }

    // The Margin window whose sidebar's edge is being dragged (its page area's changes held while it hosts, or followed
    // live: `following`).
    private(set) var resizing: Int?
    private(set) var following = false

    // A change of a Margin window's sidebar's width began (a drag of its edge: the page says so at the first change of
    // the width), or is over (its last layout reported first: ui/behaviors/resize.ts). Begun: the page area's changes
    // are held from now on; the sidebar slides over the hosted window as it is (Margin's window is in front of it).
    // Over: the hosted window placed once, at the page area as it is now (a window by Accessibility; a full-screen
    // member out of full screen and in, behind the loader). Nothing shown: nothing to place.
    func sidebarResizing(_ window: HostedWindow, _ on: Bool, divider: Bool = false) {
        if on {
            guard resizing == nil else { return }
            resizing = window.id
            guard window.id == hostingWindow, engine.shown != nil else { return }
            following = engine.dragging(true)
            // (A split's panes follow too: the holes are their rects meanwhile, the engine says them each frame.)
            window.followsPage(following && (engine.shownFillsPage || layout[window.id]?.split != nil))
            note(Self.dragLine(divider: divider, window: window.id, following: following, engine.liveFollowers()))
            return
        }
        guard resizing == window.id else { return }
        resizing = nil
        if following {
            following = false
            _ = engine.dragging(false)
            window.followsPage(false)
        }
        guard window.id == hostingWindow, engine.shown != nil else { return }
        enqueue { await self.placeAgain(window) }
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

    // ---- what the UI draws ----

    // The UI's number for an item with a page, and back.
    func number(ofItem item: String) -> Int {
        if let n = numbers[item] { return n }
        let n = nextNumber
        nextNumber += 1
        numbers[item] = n
        items[n] = item
        return n
    }
    func item(ofTab number: Int) -> String? { items[number] }
    // An open item's row number, as the UI has it (nil: not open, or never numbered). DEV-HOOK: the dev hook's `ui`.
    func openRow(ofItem item: String) -> Int? { open[item] != nil || marginOpen.contains(item) ? numbers[item] : nil }

    // The library's snapshot (stored values' shape) with the items that have a page as open tabs of the Margin
    // window hosting them, the one shown active there.
    func live(_ snapshot: JSONObject) -> JSONObject {
        let windowId = hostingWindow ?? shown.keys.min() ?? requested.keys.min() ?? 1
        // In front: the item asked for (not shown yet), else the one shown.
        let front = requested[windowId] ?? shown[windowId]
        let listed = Set(open.keys).union(marginOpen).union(front.map { [$0] } ?? [])
        guard var openTabs = snapshot["openTabs"] as? JSONObject, !listed.isEmpty else { return snapshot }
        var kept = openTabs["keptTabs"] as? JSONObject ?? [:]
        var tabs: JSONObject = [:], tabSpace: JSONObject = [:]
        var index = 0
        for item in listed.sorted() {
            guard let k = kept[item] as? JSONObject, let space = k["spaceId"] as? String else { continue }
            let n = number(ofItem: item)
            let audio = safariAudio[item]
            tabs[String(n)] = Self.liveTab(k, number: n, item: item, windowId: windowId, index: index, active: front == item,
                                           audible: audio?.audible ?? false, muted: audio?.muted ?? safariMuted.contains(item))
            tabSpace[String(n)] = space
            kept[item] = nil
            index += 1
        }
        // (Several visible in that window, docs/PEEK-SPLIT.md §1: the others marked `visible`, the focused one `active`.)
        for item in layout[windowId]?.items ?? [] where item != front {
            if let n = numbers[item], var t = tabs[String(n)] as? JSONObject { t["visible"] = true; tabs[String(n)] = t }
        }
        openTabs["tabs"] = tabs
        openTabs["tabSpace"] = tabSpace
        openTabs["keptTabs"] = kept
        var out = snapshot
        out["openTabs"] = openTabs
        return out
    }

    // An open item's tab as the UI takes it (state/model.ts tabRecord's shape): its page (`k`, the library's item as a
    // kept tab), and what binds it, as the item has it: the pin or favorite it's the tab of (sticky pins, favorites:
    // their rows find it by them, and its close isn't an archive) and the name the person gave it; whether it plays
    // sound and is muted (the mini player, the Mute/Unmute row: the copy's, `safariAudio`). Only fields with a value.
    static func liveTab(_ k: JSONObject, number n: Int, item: String, windowId: Int, index: Int, active: Bool, audible: Bool, muted: Bool) -> JSONObject {
        var tab: JSONObject = [
            "id": n, "windowId": windowId, "index": index, "title": k["title"] ?? "", "url": k["url"] ?? "", "favIconUrl": k["favIconUrl"] ?? "",
            "active": active, "lastActive": k["lastActive"] ?? 0, "mid": item, "order": k["order"] ?? 0,
        ]
        for key in ["pinnedBy", "favoriteId", "customTitle"] {
            if let value = k[key] as? String, !value.isEmpty { tab[key] = value }
        }
        if audible { tab["audible"] = true }
        if muted { tab["muted"] = true }
        return tab
    }

    // A Safari copy's tabs, as its state says them now (`openTabs.tabs`, the shell's mirror of it: Shell.linkReceived):
    // for each item with a tab in that profile's hosted window (`safariTabs`), whether it plays sound and is muted. The
    // windows draw again when that changed.
    func copyTabs(profile: String, tabs: JSONObject) {
        var changed = false
        for (item, tab) in safariTabs where open[item]?.profile == profile {
            let record = tabs[String(tab)] as? JSONObject
            let now = record.map { (audible: $0["audible"] as? Bool == true, muted: $0["muted"] as? Bool == true) }
            if now?.audible != safariAudio[item]?.audible || now?.muted != safariAudio[item]?.muted {
                safariAudio[item] = now
                changed = true
            }
        }
        if changed { onChange?() }
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
// items, with what the session has open; settings, theme settings and site icons still a profile's (read only,
// changed in memory: DataSetWindowSource).
final class LibraryWindowSource: MarginWindowSource {
    let library: Library
    let session: HostedSession
    let profileSource: DataSetWindowSource
    var onChange: (() -> Void)?
    // Requests the UI makes that need nothing here (its scroll, the copy's own waking).
    static let quiet: Set<String> = ["sidebarScroll", "setSidebarScroll", "wakeSleeping", "windowState", "cancelNewTab", "noticeAction"]

    init(library: Library, session: HostedSession, profileSource: DataSetWindowSource) {
        self.library = library
        self.session = session
        self.profileSource = profileSource
        library.observe { [weak self] _ in self?.onChange?() }
        profileSource.onChange = { [weak self] in self?.onChange?() }
        let before = session.onChange
        session.onChange = { [weak self] in before?(); self?.onChange?() }
    }

    func snapshot() -> JSONObject {
        var s = library.snapshot()
        let profile = profileSource.snapshot()
        s["settings"] = profile["settings"] ?? JSONObject()
        s["favicons"] = profile["favicons"] ?? JSONObject()
        return session.live(s)
    }

    @discardableResult func perform(_ type: String, _ payload: JSONObject) -> JSONObject? {
        var payload = payload
        payload["hint"] = nil
        let windowId = int(payload["windowId"])
        // An open item's row: the UI's number for it, the item's id here.
        if let n = int(payload["tabId"]), let item = session.item(ofTab: n) { payload["tabId"] = item }
        if let n = int(payload["nextTo"]), let item = session.item(ofTab: n) { payload["nextTo"] = item }
        switch type {
        case "updateSettings", "updateThemeSettings":
            return profileSource.perform(type, payload)
        case "copyUrl":
            if let url = payload["url"] as? String, !url.isEmpty {
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.setString(url, forType: .string)
            }
            return ["ok": true, "result": true]
        case "app.open":
            guard let id = payload["bundleId"] as? String, AppCatalog.isBundleId(id) else { return ["ok": false, "error": "not a bundle id"] }
            session.openApp(id, windowId: windowId)
            return nil
        case "search":
            let query = (payload["query"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !query.isEmpty else { return nil }
            let settings = profileSource.snapshot()["settings"] as? JSONObject
            return answer(library.perform("newTab", ["windowId": windowId ?? NSNull(), "url": Self.searchUrl(query, settings: settings), "title": query]))
        case "goBack", "goForward", "reload":
            session.navigate(type, windowId: windowId)
            return nil
        case "startup.retry":
            session.startupRetry()
            return nil
        case "startup.skip":
            session.startupSkip()
            return nil
        case "openLauncher":
            session.openLauncher(windowId: windowId, settings: payload["settings"] as? Bool == true)
            return nil
        case "addFavorite":
            // Which favorites it joins: the person's setting (the profile's settings), whatever the page sent; the library
            // takes the scope from it and the window's space (library.ts addFavorite), never a scope a page names.
            let settings = profileSource.snapshot()["settings"] as? JSONObject
            payload["favoritesScope"] = settings?["favoritesScope"] as? String == "profile" ? "profile" : "global"
            payload["scope"] = nil
        // The preview card and Quick Tab (ui/behaviors/card.ts → HostedPeek.swift).
        case "peek.close":
            session.closeCard(windowId: windowId, why: "its close", tellPage: false)
            return ["ok": true, "result": true]
        case "peek.expand":
            session.expandCard(windowId: windowId, spaceId: payload["spaceId"] as? String)
            return ["ok": true, "result": true]
        case "peek.back", "peek.forward":
            session.cardHistory(windowId: windowId, back: type == "peek.back")
            return ["ok": true, "result": true]
        case "peek.littleArc":
            session.littleArcOpened(windowId: windowId, spaceId: payload["spaceId"] as? String)
            return ["ok": true, "result": true]
        case "peek.go":
            // An address as it was typed, or a search: its address from the engine Safari searches with (the palette's).
            let query = (payload["query"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let url = (payload["url"] as? String).flatMap { HostedSession.webAddress($0) ? $0 : nil }
                ?? (query.isEmpty ? nil : Self.searchUrl(String(query.prefix(1000)), settings: profileSource.snapshot()["settings"] as? JSONObject))
            guard let url else { return ["ok": false, "error": "no address"] }
            session.littleArcGo(windowId: windowId, url: url, spaceId: payload["spaceId"] as? String)
            return ["ok": true, "result": true]
        case "closeTab" where payload["tabId"] == nil:
            // ⌘W: the card in that window (or Quick Tab's field), never the item under it; else the item shown there.
            if session.closeCardForKey(windowId: windowId) { return ["ok": true, "result": true] }
            guard let w = windowId, let item = session.shown[w] else { return nil }
            payload["tabId"] = item
        default:
            if Self.quiet.contains(type) { return ["ok": true, "result": NSNull()] }
        }
        return answer(library.perform(type, payload))
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
         "cycleWindow": cycleWindow, "cycleHold": cycleHold, "paneIdle": paneIdle]
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

// The first of several answers, given once (a request raced against its time limit).
@MainActor final class FirstOf<T> {
    var then: ((T) -> Void)?
    private var given = false
    func give(_ value: T) {
        guard !given, let then else { return }
        given = true
        self.then = nil
        then(value)
    }
}
