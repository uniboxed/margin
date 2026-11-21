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
    func start(bundleId: String) async -> HostApp? { nil }
    func prepare(_ target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult { .failed(.launch, "no engine to prepare it") }
}

extension HostEngine: HostedEngine {}

// The browser web items open in (UserDefaults `MarginDefaultBrowser`, decided by Tirth 2026-11-16, default "safari"),
// by the setting's value. Only Safari is hosted now: Chrome and Edge join this table (and the show's browser check)
// when they are, with no change to the flow. An unsupported value: Safari, said once.
enum DefaultBrowser {
    static let key = "MarginDefaultBrowser"
    static let fallback = "safari"
    static let supported: [String: String] = ["safari": safariIdentifier]
    static func resolve(_ value: String?) -> (name: String, bundleId: String) {
        let v = (value ?? fallback).trimmingCharacters(in: .whitespaces).lowercased()
        if let bundle = supported[v] { return (v, bundle) }
        Diagnostics.note("hosted: the default browser setting (\(value ?? "")) isn't supported yet: Safari")
        return (fallback, supported[fallback] ?? safariIdentifier)
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

    var options: Options
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
    private(set) var shown: [Int: String] = [:]
    private(set) var open: [String: OpenItem] = [:]
    // (Each profile's hosted windows by role, docs/PEEK-SPLIT.md §1: its main one, its card, a split's panes.)
    private(set) var safariWindows: [SafariKey: Int] = [:]
    // Each Margin window's layout while more than its item shown is visible (the preview card, a split's panes): main, the
    // others with their roles and rects, the focused one (`shown[w]`). None: one item shown, as before.
    private(set) var layout: [Int: HostedLayout] = [:]
    private(set) var hostingWindow: Int?
    // Each Margin window's own page shown (ItemTarget.margin's page: Settings), drawn by the window itself, and the items
    // of Margin's pages shown this session (open tabs in the UI, as items with a page are: `live`).
    private(set) var marginPages: [Int: String] = [:]
    private(set) var marginOpen: Set<String> = []
    // When each Margin window's next/previous-tab key was last pressed (its repeats too): the picks a cycle makes.
    private var cycledAt: [Int: Double] = [:]
    // Each Margin window's item shown when macOS took the window out of full screen: hosted again once it's back in.
    private(set) var resume: [Int: String] = [:]
    // What the loading animation names for a host (the app's name; Safari).
    var labels: [HostID: String] = [:]
    // The loading bar (setLoadingTabs): the engine's slow step now (its host), the item each host is being shown for,
    // each web item's tab in its Safari window (the copy's id, from hostShow), the tabs each profile's copy says are
    // loading in its hosted window (its `loading` push), and what each Margin window was told last.
    private var appLoading: HostID?
    private var showing: [HostID: String] = [:]
    private(set) var safariTabs: [String: Int] = [:]
    private(set) var safariMuted: Set<String> = []
    // Each web item's tab's sound, as its profile's copy says (copyTabs): playing, muted. (None: not heard yet.)
    private(set) var safariAudio: [String: (audible: Bool, muted: Bool)] = [:]
    private var copyLoading: [String: Set<Int>] = [:]
    private(set) var loadingSaid: [Int: [Int]] = [:]
    // Each Margin window's item asked to be shown and not shown yet (the newest): drawn in front at once.
    var requested: [Int: String] = [:]
    static let showRequests: Set<String> = ["activateTab", "newTab", "restoreArchive", "setSpace", "openPin", "openFavorite", "showSplit"]
    // The first run's space (the library was empty), for the UI's editor once a window's page is drawn.
    var firstSpace: String?
    // The UI's numbers for open items (it takes only numbers for open tabs), this session's.
    private var numbers: [String: Int] = [:]
    private var items: [Int: String] = [:]
    private var nextNumber = 1
    // What was done, newest last (the tests read it; numbers, item ids and bundle ids only).
    private(set) var done: [String] = []
    private var tail: Task<Void, Never>?
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
    }

    // ---- one at a time ----

    func enqueue(_ body: @escaping () async -> Void) {
        let previous = tail
        tail = Task { _ = await previous?.value; await body() }
    }

    // Everything asked so far, done (the tests wait for it).
    func idle() async {
        while let t = tail {
            await t.value
            if tail == t { return }
        }
    }

    func note(_ line: String) {
        done.append(line)
        if done.count > 200 { done.removeFirst(done.count - 200) }
        Diagnostics.note("hosted: \(line)")
    }

    // ---- the library's requests ----

    func library(_ library: Library, wants request: LibraryRequest) {
        // The item in front in its window at once (the sidebar's switch highlight lands as it's asked: an app's switch
        // takes seconds, and the highlight went back to the item left meanwhile, "back on a tab it had passed").
        if Self.showRequests.contains(request.type), let w = window(request.windowId) { cardLeaving(w, for: request.item) }
        if Self.showRequests.contains(request.type), let item = request.item, let w = window(request.windowId), requested[w.id] != item {
            requested[w.id] = item
            onChange?()
        }
        enqueue { await self.handle(request) }
    }

    // A show overtaken before it started by a newer one for its window (fast clicks): skipped.
    private func overtaken(_ item: String, windowId: Int?) -> Bool {
        guard let w = window(windowId), let newest = requested[w.id], newest != item else { return false }
        note("\(item): not shown, \(newest) asked for since")
        return true
    }

    private func handle(_ r: LibraryRequest) async {
        defer { settleHosting() }
        switch r.type {
        case "activateTab", "newTab", "restoreArchive", "setSpace":
            guard let item = r.item else {
                // (A space with no items: nothing to show. Margin's own page of the space left goes: the launcher.)
                if r.type == "setSpace", let w = window(r.windowId) { leaveMarginPage(w) }
                return
            }
            if overtaken(item, windowId: r.windowId) { return }
            await show(item, url: r.url, target: r.target, windowId: r.windowId)
        case "openPin":
            if let item = r.item {
                if overtaken(item, windowId: r.windowId) { return }
                return await show(item, url: r.url, target: r.target, windowId: r.windowId)
            }
            var payload: JSONObject = ["url": r.url ?? "", "front": true]
            if let space = r.spaceId { payload["spaceId"] = space }
            if let w = r.windowId { payload["windowId"] = w }
            if let target = r.target { payload["target"] = target.json }
            if let pin = r.body["pin"] as? String { payload["pinnedBy"] = pin }
            let out = library.perform("addItem", payload)
            guard out.ok, let item = (out.result as? JSONObject)?["tabId"] as? String else { return note("openPin: no item made (\(out.error ?? "?"))") }
            await show(item, url: r.url, target: r.target, windowId: r.windowId)
        case "resetPin":
            guard let url = r.url else { return }
            if let item = r.item {
                if let entry = open[item], let profile = entry.profile {
                    _ = await links.request(profile: profile, "hostNavigate", ["itemId": item, "url": url])
                }
                await show(item, url: url, target: r.target, windowId: r.windowId)
            } else {
                var payload: JSONObject = ["url": url, "front": true]
                if let space = r.spaceId { payload["spaceId"] = space }
                if let w = r.windowId { payload["windowId"] = w }
                if let target = r.target { payload["target"] = target.json }
                if let pin = r.body["pin"] as? String { payload["pinnedBy"] = pin }
                let out = library.perform("addItem", payload)
                guard out.ok, let item = (out.result as? JSONObject)?["tabId"] as? String else { return }
                await show(item, url: url, target: r.target, windowId: r.windowId)
            }
        case "openFavorite":
            if let item = r.item {
                if overtaken(item, windowId: r.windowId) { return }
                return await show(item, url: r.url, target: r.target, windowId: r.windowId)
            }
            var payload: JSONObject = ["url": r.url ?? "", "front": true]
            if let space = r.spaceId { payload["spaceId"] = space }
            if let w = r.windowId { payload["windowId"] = w }
            if let target = r.target { payload["target"] = target.json }
            if let fav = r.body["favorite"] as? String { payload["favoriteId"] = fav }
            let out = library.perform("addItem", payload)
            guard out.ok, let item = (out.result as? JSONObject)?["tabId"] as? String else { return note("openFavorite: no item made (\(out.error ?? "?"))") }
            await show(item, url: r.url, target: r.target, windowId: r.windowId)
        case "resetFavorite":
            guard let url = r.url else { return }
            if let item = r.item {
                if let entry = open[item], let profile = entry.profile {
                    _ = await links.request(profile: profile, "hostNavigate", ["itemId": item, "url": url])
                }
                await show(item, url: url, target: r.target, windowId: r.windowId)
            } else {
                var payload: JSONObject = ["url": url, "front": true]
                if let space = r.spaceId { payload["spaceId"] = space }
                if let w = r.windowId { payload["windowId"] = w }
                if let target = r.target { payload["target"] = target.json }
                if let fav = r.body["favorite"] as? String { payload["favoriteId"] = fav }
                let out = library.perform("addItem", payload)
                guard out.ok, let item = (out.result as? JSONObject)?["tabId"] as? String else { return }
                await show(item, url: url, target: r.target, windowId: r.windowId)
            }
        case "showSplit":
            // (A split made, a pane added, swapped, its axis turned: shown with `item` focused, else the pane the window
            // has focused, else its first; docs/PEEK-SPLIT.md §4.)
            guard let w = window(r.windowId), let id = r.body["splitId"] as? String, let split = library.split(id) else { return note("showSplit: no such split") }
            let focus = r.item.flatMap { split.panes.contains($0) ? $0 : nil } ?? shown[w.id].flatMap { split.panes.contains($0) ? $0 : nil } ?? split.panes[0]
            if overtaken(focus, windowId: w.id) { return }
            await show(focus, url: nil, target: library.target(ofItem: focus), windowId: w.id)
        case "closeTab", "unloadTab":
            guard let item = r.item else { return }
            let windows = shown.filter { $0.value == item }.map(\.key)
            // (A split's pane not focused: the window showing the split shows it again without it, its focus kept.)
            let around = layout.filter { $0.value.items.contains(item) && shown[$0.key] != item }.map(\.key)
            let next = r.body["next"] as? String
            if let next, let window = windows.first, requested[window] == nil { requested[window] = next } // (in front at once)
            safariMuted.remove(item); safariAudio[item] = nil
            await close(item, target: r.target)
            if let next, let window = windows.first {
                await show(next, url: nil, target: library.target(ofItem: next), windowId: window)
            }
            for window in around.sorted() {
                guard let focus = shown[window] else { continue }
                await show(focus, url: nil, target: library.target(ofItem: focus), windowId: window)
            }
        case "muteTab":
            guard let item = r.item, let entry = open[item], let profile = entry.profile else { return }
            let answer = await links.request(profile: profile, "hostMute", ["itemId": item])
            if let muted = answer.result?["muted"] as? Bool {
                if muted { safariMuted.insert(item) } else { safariMuted.remove(item) }
                if let heard = safariAudio[item] { safariAudio[item] = (audible: heard.audible, muted: muted) }
                onChange?()
            }
        case "mediaControl":
            // The mini player's play or pause, previous or next for a web item's page (M2.4): its copy's `hostMedia`,
            // with the tab its `media` push named (the item's tag may be gone from a copy started again).
            guard let item = r.item, let entry = open[item], let profile = entry.profile, let command = r.body["command"] as? String else { return }
            var payload: JSONObject = ["itemId": item, "command": command]
            if let tab = safariTabs[item] { payload["tabId"] = tab }
            let answer = await links.request(profile: profile, "hostMedia", payload)
            note("\(item): the mini player's \(command): \(answer.result?["ok"] as? Bool == true ? "done" : "not done (\(answer.error ?? "its page didn't"))")")
        case "clearToday":
            for item in r.body["items"] as? [String] ?? [] { await close(item, target: nil) }
        default:
            note("\(r.type): nothing to host")
        }
    }

    // ---- showing ----

    // An item in a Margin window's page area (nil: the front window): its app or its Safari profile's window shown,
    // and for a web item its tab in front there.
    func show(_ item: String, url: String?, target: ItemTarget?, windowId: Int?) async {
        guard let w = window(windowId) else { return note("\(item): no Margin window to show it in") }
        // (The preview card there hides with its opener: this show lays the item out alone. HostedPeek.swift.)
        cardLeaving(w, for: item)
        // (Shown or not, it's no longer one asked for: a failure draws the item shown before in front again.)
        var drawn = false
        defer { if requested[w.id] == item { requested[w.id] = nil; if !drawn { onChange?() } } }
        guard let target = target ?? library.target(ofItem: item) else { return note("\(item): no target") }
        // (A split's pane: the whole split, this pane focused, docs/PEEK-SPLIT.md §4; one that can't be: it alone.)
        if let split = library.split(ofItem: item), await showSplit(split, focus: item, in: w) { drawn = true; return }
        let address = url ?? (library.items().first { $0.id == item }?.value["url"] as? String) ?? ""
        switch target {
        case .app(let bundle, let name):
            labels[HostTarget.app(bundle).id] = appName(bundle) ?? (name.isEmpty ? nil : name) ?? bundle
            showing[HostTarget.app(bundle).id] = item
            defer { showing[HostTarget.app(bundle).id] = nil; refreshLoading() }
            if engine.shown != HostTarget.app(bundle).id || hostingWindow != w.id { w.setShowing(labels[HostTarget.app(bundle).id], app: bundle) }
            // (Another item asked for meanwhile: the loader stays for it, never a frame without it in between.)
            defer { if !supersededBy(w, item) { w.setShowing(nil) } }
            // (Picked by the next/previous-tab key, its app not running yet: held a moment first. One the keys only pass
            // over is never started: no launch, no memory, no loading bar on its row. A click is never held.)
            let id = HostTarget.app(bundle).id
            if let at = cycledAt[w.id], now() - at < options.cycleWindow, !engine.isHosted(id), engine.appRuns(bundleId: bundle) == false,
               await wait(options.cycleHold, { self.supersededBy(w, item) }) {
                return note("\(item): passed over by the tab keys (\(bundle) not started)")
            }
            guard await host(.app(bundle), in: w, for: item) else { return }
            open[item] = OpenItem(host: HostTarget.app(bundle).id, profile: nil)
        case .web(let browser, let profile):
            guard browser == "safari" else { return note("\(item): \(browser) isn't hosted yet") }
            let p = await profileFallback(resolve(profile), space: library.space(ofItem: item))
            let id = HostTarget.safariWindow(p).id
            labels[id] = "Safari"
            showing[id] = item
            defer { showing[id] = nil; refreshLoading() }
            // Its window not the one shown: Margin's window told the item is being shown until it is. A window that's
            // there already (parked) gets its tab in front first, while it's out of sight (the copy's hostShow only
            // touches tabs), then comes in: the right page from the first frame, no other tab's flashed. A window not
            // made yet: the engine's first open (behind the loader), then its tab. A tab switch in the window shown
            // is Safari's own, in sight: nothing said.
            defer { w.setShowing(nil) }
            // (Its window in a layout of several (a split's main pane, a card's opener): never a tab switch only. The
            // engine lays it out alone at the page area, the others parked (docs/PEEK-SPLIT.md §4 "Leaving"; the real
            // screen, 2026-11-21: an item of main's own profile picked while main was focused showed in its pane's rect,
            // the other panes left on screen).
            let laidOut = layout[w.id] != nil || !engine.showsAlone(id)
            let comes = engine.shown != id || hostingWindow != w.id || laidOut
            let there = safariWindows[SafariKey(p)] != nil && engine.isHosted(id)
            if comes {
                let title = (library.items().first { $0.id == item }?.value["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                w.setShowing(title ?? "Safari", app: safariIdentifier)
                if !there { guard await host(.safariWindow(p), in: w, for: item) else { return } }
            }
            guard let windowId = safariWindows[SafariKey(p)] else { return note("\(item): no Safari window of its profile") }
            let (result, error) = await links.request(profile: p, "hostShow", ["windowId": windowId, "itemId": item, "url": address.isEmpty ? "about:blank" : address, "pinned": pinnedOrFavorite(item)])
            guard let result else { return note("\(item): its tab wasn't shown (\(error ?? "no answer"))") }
            open[item] = OpenItem(host: id, profile: p)
            if let tab = int(result["tabId"]) { safariTabs[item] = tab }
            if comes, there { guard await host(.safariWindow(p), in: w, for: item) else { return } }
            note("\(item): shown in Safari window \(windowId)")
        case .margin(let page):
            // One of Margin's own pages (Settings): drawn by Margin's window itself in its page area, nothing hosted for
            // it. What this window hosted is parked (its row shows it again), as for the launcher asked for; the
            // hosting's settling after this step (`settleHosting`) keeps this item as the one shown.
            marginPages[w.id] = page
            marginOpen.insert(item)
            w.setMarginPage(page)
            if elsewhere[w.id] != nil { elsewhere[w.id] = nil; w.setElsewhere(nil, app: nil) }
            if engine.shown != nil, hostingWindow == w.id { await engine.parkShown(why: "Margin's \(page) page shown in Margin's window") }
            note("\(item): Margin's \(page) page shown in Margin's window \(w.id)")
        }
        // (Another item shown: Margin's own page this window showed goes. Only now: a show that failed leaves it there.)
        if case .margin = target {} else if marginPages[w.id] != nil {
            marginPages[w.id] = nil
            w.setMarginPage(nil)
        }
        shown[w.id] = item
        layout[w.id] = nil // (one item shown: the engine laid it out alone)
        if requested[w.id] == item { requested[w.id] = nil }
        drawn = true
        onChange?()
        cardReturning(w, to: item)
    }

    // The next/previous-tab key pressed in Margin's window `windowId` (each press and repeat; the shell's runHosted).
    func cycled(windowId: Int) { cycledAt[windowId] = now() }

    // Another item asked for in `w` since `item`'s show began (a pick while it was on its way).
    private func supersededBy(_ w: HostedWindow, _ item: String) -> Bool {
        guard let next = requested[w.id] else { return false }
        return next != item
    }

    // The engine's open (the first time) or show, into `w`'s page area, for `item`; Margin's window made ready first.
    // False: not shown.
    private func host(_ target: HostTarget, in w: HostedWindow, for item: String) async -> Bool {
        guard let (placement, space) = await prepare(w, for: target) else { settleHosting(); return false }
        // (Hosted already, or not: opened or shown again with Margin's window's placement and Space as they are now,
        // which change when its window left full screen and came back. A new app's open that's waiting for its window is
        // given up as soon as another item is picked in this window (Tirth, 2026-11-20): that one starts at once.)
        // (Its window closed meanwhile: not wanted either.)
        let result = await engine.open(app: target, in: placement, marginWindow: w.number, marginSpace: space, wanted: { [weak self] in
            self.map { !$0.supersededBy(w, item) && $0.window(w.id) != nil } ?? false
        })
        switch result {
        case .shown(let id, _) where window(w.id) == nil:
            // (Shown into a window closed while it opened: parked at once, nothing of it left where that window was.)
            note("\(id): shown as Margin's window \(w.id) closed: parked")
            await engine.parkShown(why: "its Margin window closed")
            if hostingWindow == w.id { hostingWindow = nil }
            return false
        case .shown(let id, let placed):
            note("\(id): shown\(placed ? "" : " (not fitted to the page area)")")
            return true
        case .failed(.superseded, _) where window(w.id) == nil:
            note("\(target.id): its open given up: Margin's window \(w.id) closed meanwhile")
            if hostingWindow == w.id { hostingWindow = nil }
            return false
        case .failed(.superseded, _):
            // (Its loading bar goes with its show; Margin's window keeps hosting and its loader for the item picked since.)
            note("\(target.id): its open given up for the item picked since (\(requested[w.id] ?? "?"))")
            return false
        case .failed(let step, let why):
            note("\(target.id): \(step.rawValue) failed: \(why)")
            settleHosting()
            return false
        }
    }

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
        guard shownItems.contains(main) else { settleHosting(); onChange?(); return }
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
            let noRoom = why.contains("below its window's minimum")
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
                                     : "\(who): a click in its pane\(had): its window \(r.window) key in \(r.ms) ms (\(r.crossApp ? "its app made the front app" : "in its own app")): the click delivered")
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

    // The item a Margin window showed last: the one selected in its space (the newest used if several), if it can be
    // hosted; its target and the name its loader says.
    func lastItem(ofWindow id: Int) -> (item: String, target: ItemTarget, name: String)? {
        let space = library.space(ofWindow: id) ?? library.spaces().first?.id
        let last = library.items(space: space).filter { $0.value["selected"] as? Bool == true }
            .max { (num($0.value["lastUsed"]) ?? 0, $1.id) < (num($1.value["lastUsed"]) ?? 0, $0.id) }
        guard let last, let target = library.target(ofItem: last.id) else { return nil }
        switch target {
        case .app(let bundle, let n):
            return (last.id, target, appName(bundle) ?? (n.isEmpty ? bundle : n))
        case .web(let browser, _):
            guard browser == "safari" else { return nil }
            return (last.id, target, (last.value["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Safari")
        case .margin:
            return (last.id, target, (last.value["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Margin")
        }
    }

    // The app whose icon the loader shows for an item: an app's own, Safari for a web item, none for Margin's own page.
    static func loaderApp(_ target: ItemTarget) -> String? {
        switch target {
        case .app(let bundle, _): return bundle
        case .web: return safariIdentifier
        case .margin: return nil
        }
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
        forgetElsewhere(item: item)
        let target = target ?? library.target(ofItem: item)
        let had = open.removeValue(forKey: item)
        safariTabs[item] = nil
        safariAudio[item] = nil
        let showing = shown.filter { $0.value == item }.map(\.key)
        for w in showing { shown[w] = nil }
        defer { refreshLoading() }
        switch target {
        case .app(let bundle, _)?:
            let id = HostTarget.app(bundle).id
            if engine.isHosted(id), !open.values.contains(where: { $0.host == id }) { await engine.close(id) }
        case .web(_, let profile)?:
            let p = had?.profile ?? resolve(profile)
            if had != nil { _ = await links.request(profile: p, "hostClose", ["itemId": item]) }
        case .margin?:
            // (Its windows' page goes with it: the next item shown there, else the launcher.)
            for w in showing where marginPages[w] != nil {
                marginPages[w] = nil
                window(w)?.setMarginPage(nil)
            }
        case nil:
            break
        }
        marginOpen.remove(item)
        note("\(item): closed")
        onChange?()
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
    private(set) var preparingWindow: Int? // the Margin window a browser's window is made ready over (covered by it)
    private var preparingProfile: String?

    // ---- the engine's Safari windows (HostEngine's requestSafariWindow, closeSafariWindow, safariFullScreen, safariLinked) ----

    // Decided by Tirth (2026-11-15): when Safari was started by Margin (no Dock icon), the windows Safari restored from its
    // last session are closed, so they don't come back next time (a restored full-screen one stood as its own Space in
    // Mission Control). Only in a Safari Margin started; only the windows its profile's copy lists at the first look after
    // it links (Safari restores before any copy starts), less Margin's own and the ones opened to wake it; once per link;
    // closed by their copy. A window that comes later (a link opened from another app) is never touched, nor any of a
    // Safari the person opened. Called from the shell's poll.
    func sweepRestoredSafariWindows() {
        closeIdleCards()
        closeIdlePaneWindows()
        // (A window opened to wake a profile, still open `wokenGrace` after its copy linked with nothing asked of it: what
        // it was for went another way. Closed, whoever started Safari.)
        for (p, at) in wokenLinkedAt.sorted(by: { $0.key < $1.key }) where now() - at >= options.wokenGrace && !requesting.contains(p) {
            wokenLinkedAt[p] = nil
            Task { [weak self] in await self?.closeWoken(p, why: " (left open: closed later)") }
        }
        if wokenHeld { releaseWokenSpace() } // (one left open once: released when it's gone)
        guard options.closesRestoredSafariWindows else { return }
        guard options.safariBundles.contains(where: { engine.launchedPid(bundleId: $0) != nil }) else { swept = [:]; return }
        for p in links.safariProfiles() where !requesting.contains(p) {
            guard let epoch = links.linkEpoch(of: p), swept[p] != epoch, let restored = links.restoredWindowIds(of: p) else { continue }
            swept[p] = epoch
            let ours = Set(safariWindows.values).union(made_).union(wokenByMenu[p] ?? []) // (every role's window: main's, a card's, a pane's)
            let close = restored.filter { !ours.contains($0) }
            guard !close.isEmpty else { continue }
            note("Safari started by Margin: \(close.count) window(s) it restored from its last session closed")
            Task { [weak self] in
                guard let self else { return }
                for id in close { _ = await self.links.request(profile: p, "closeWindow", ["windowId": id]) }
            }
        }
    }
    private var swept: [String: String] = [:] // each profile's link epoch already swept

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
    private var requesting: Set<String> = [] // profiles a window is being asked of right now
    private var made_: Set<Int> = [] // every Safari window Margin has made (the copies' ids): never swept

    // A profile's copy linked, waking it through Safari's menu if it has no window. Evidence decides, time only paces
    // (Tirth, 2026-11-17: "time only paces retries and drives feedback"): its link taken the moment it comes (never a
    // fixed wait first); Safari's menu pressed once Safari's own copies have had their turn (a copy of a window it
    // restored links by itself) and pressed again only while no window came of a press (a Safari still starting does
    // nothing at one), never once one did; given up only on evidence: what it was for isn't wanted any more (`wakeIf`,
    // else the show waiting on it overtaken by another pick), Safari quit, or every press opened nothing. While a window
    // came and the copy hasn't linked (2026-11-17: another build of Margin's extension handler in use made Safari refuse
    // its native messages for 15–35 s), it's waited for, said every `linkSayEvery`.
    // `wakeIf`: asked right before each press and at each look; false: not woken, or no longer waited for.
    func safariLinked(_ profile: String?, wakeIf wanted: (() -> Bool)? = nil) async -> Bool {
        let p = resolve(profile)
        if links.safariProfiles().contains(p) { return true }
        let wanted = wanted ?? { self.linkWanted(p) }
        let started = now()
        var ranAtStart = engine.appRuns(bundleId: safariIdentifier) == true
        // Safari not running at all: no copy of its own links and its menu can't be pressed. Started now (no Dock icon, as
        // Margin's start does it), then waited for as usual; one that doesn't start, not waited for. (2026-11-20 13:45:
        // Margin had quit the Safari it started after a failed preparation; the show after it waited 30 s, pressing the
        // menu of a Safari that wasn't there.)
        if engine.appRuns(bundleId: safariIdentifier) == false {
            guard await engine.start(bundleId: safariIdentifier) != nil else {
                note("a Safari profile not linked: Safari isn't running and didn't start: not waited for")
                return false
            }
            note("a Safari profile not linked: Safari wasn't running: started (no Dock icon)")
            ranAtStart = true
        }
        let seenBefore = engine.wokenWindows(bundleId: safariIdentifier)
        var presses = 0, pressedAt = started, saidAt = started
        // (Its own copies first: a Safari just started has no menus and no copies for a while, ~4–12 s to the first link,
        // and the profile may be among the windows it restores. Pressed once one has linked and it isn't this profile's,
        // or after `firstCopiesPace` with none.)
        if links.safariProfiles().isEmpty { note("a Safari profile not linked yet: Safari's own copies waited for first (a window it restores links by itself)") }
        while !links.safariProfiles().contains(p) {
            // (Safari's menu has no item by the name Margin has for it: pressing again can't open it. Said at once, not after
            // four presses and 15 s: the caller opens the default profile instead, `profileFallback`.)
            if unopenable.contains(p) {
                note("a Safari profile with no window: Safari's menu has no item by the name Margin has for it (Safari's profiles not readable: its own names unknown): not woken, \(secs(since: started)) s")
                if wokenByMenu.isEmpty { engine.releaseWoken(bundleId: safariIdentifier) }
                return false
            }
            guard wanted() else {
                note(presses == 0 ? "a Safari profile with no window: not woken (what it was for isn't wanted any more)"
                                  : "a Safari profile woken: its copy no longer waited for (what it was for isn't wanted any more), \(secs(since: started)) s")
                return false
            }
            if ranAtStart, engine.appRuns(bundleId: safariIdentifier) == false {
                note("Safari quit while its profile's copy was waited for (\(secs(since: started)) s)")
                return false
            }
            let t = now()
            let opened = engine.wokenWindows(bundleId: safariIdentifier) - seenBefore // (also parks them out of sight now)
            let press: Bool
            if presses == 0 { press = !links.safariProfiles().isEmpty || t - started >= options.firstCopiesPace }
            else { press = opened == 0 && t - pressedAt >= options.pressPace * Double(presses) }
            if press {
                guard presses < options.wakePresses else {
                    note("a Safari profile with no window: \(presses) presses of Safari's menu opened no window (\(secs(since: started)) s): given up")
                    return false
                }
                presses += 1
                pressedAt = t
                // (The window it opens is parked out of sight as soon as it's listed: it opens in the current Space, Margin's,
                // and would show through the page area over what's shown.)
                engine.hideWoken(bundleId: safariIdentifier)
                if links.openProfileWindow(p, pressed: { [weak self] ok in if !ok { self?.unopenable.insert(p) } }) {
                    note("a Safari profile with no window: one opened from Safari's menu so its copy links (press \(presses)\(presses > 1 ? ": no window came of the one before" : ""))")
                    if wokenByMenu[p] == nil { wokenByMenu[p] = [] }
                } else {
                    note("a Safari profile with no window: Safari's menu couldn't be pressed (press \(presses))")
                    if wokenByMenu.isEmpty { engine.releaseWoken(bundleId: safariIdentifier) } // (nothing pressed: nothing to hide)
                }
            }
            if t - saidAt >= options.linkSayEvery {
                saidAt = t
                note("a Safari profile's copy not linked yet after \(secs(since: started)) s (\(presses == 0 ? "Safari's own copies first" : opened > 0 ? "its window opened: its copy waited for" : "no window of the press yet")); linked: \(links.safariProfiles().count) profile(s)")
            }
            await sleep(options.every)
        }
        note("a Safari profile linked in \(secs(since: started)) s\(presses == 0 ? "" : " (\(presses) press\(presses == 1 ? "" : "es") of Safari's menu)")")
        if wokenByMenu[p] != nil {
            _ = await wait(1.5) { !self.links.windowIds(of: p).isEmpty }
            wokenByMenu[p] = links.windowIds(of: p)
            wokenAtLink[p] = Set(links.windowIds(of: p))
            wokenLinkedAt[p] = now()
        }
        return true
    }
    // Whether a show waiting on profile `p`'s link is still wanted: no other item asked for in a Margin window since
    // (the person's next pick, or the next item the suite hosts, overtakes it). Nothing being shown for it: wanted.
    private func linkWanted(_ p: String) -> Bool {
        if preparingProfile == p { return requested.isEmpty } // (the launch's preparation: until the person asks for something)
        guard let item = showing[HostTarget.safariWindow(p).id] else { return true }
        return requested.values.allSatisfy { $0 == item }
    }
    private func secs(since t: Double) -> String { String(format: "%.1f", now() - t) }
    private(set) var wokenByMenu: [String: [Int]] = [:] // a profile woken through Safari's menu: the windows it had then
    // Profiles Safari's menu has no item for by the names Margin has (Safari's profiles unreadable: its own names
    // unknown): not pressed again; a page of theirs opens in the default profile (`profileFallback`). Forgotten when
    // Safari's names are read (the person allowed Safari's folder, SafariFolderGrant).
    private(set) var unopenable: Set<String> = []
    func profileNamesChanged() {
        unopenable = []
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
    // sidebar with the folder grant's Allow (Tirth, 2026-11-18: a quiet fallback and a small note, the start never held
    // up by a profile Margin can't open).
    private func profileFallback(_ p: String, space: String?) async -> String {
        let fallback = Self.defaultSafariProfile
        guard p != fallback, !links.safariProfiles().contains(p) else { return p }
        if !unopenable.contains(p), await safariLinked(p) { return p }
        guard unopenable.contains(p) else { return p } // (not woken for another reason: the show goes on and says it)
        note("a Safari profile Margin can't open (its name unknown): the default profile used instead")
        let name = space.flatMap { id in library.spaces().first { $0.id == id }?.value["name"] as? String }
        if let w = window(hostingWindow ?? preparingWindow) ?? window(nil),
           let data = try? JSONSerialization.data(withJSONObject: ["type": "hostNote", "kind": "safari-profile", "space": String((name ?? "").prefix(60))]),
           let json = String(data: data, encoding: .utf8) {
            w.push(json)
        }
        return fallback
    }
    private var wokenLinkedAt: [String: Double] = [:] // ...and when its copy linked
    // ...and the windows its copy had then. A copy can link through a window Safari restored before the press's window is
    // reported (2026-11-20 11:17:35: linked through restored 96 at .340, the press's 152 reported at .642): the press's
    // window then isn't among them, and is found at the close as one that came since (`wokenLate`).
    private var wokenAtLink: [String: Set<Int>] = [:]

    // The windows opened only to wake a profile, closed by its copy (Margin opened them; they hold no page of the
    // person's), whatever happened to what they were for: Margin's window made for it (`except`), the preparation given
    // up, or left open past `wokenGrace` (the poll). One not closed is tried again by the poll. All closed: the private
    // Space they were parked in released.
    // Closed within `wokenLate` of the link, a window of the profile that came since and isn't Margin's is the press's
    // too (the copy linked through a restored one first): closed with them. Later, only those known at the link: a
    // window that comes later (a link opened from another app) is the person's. The private Space is released only once
    // every window parked in it is closed: retired with one still in it, macOS puts that one in the current Space,
    // Margin's, over the page area (2026-11-20: Safari's page drawn over Maps until another tab was picked).
    func closeWoken(_ p: String, except made: Int? = nil, why: String = "") async {
        guard var ids = wokenByMenu.removeValue(forKey: p) else { return }
        let linkedAt = wokenLinkedAt.removeValue(forKey: p)
        let atLink = wokenAtLink.removeValue(forKey: p) ?? Set(ids)
        if let linkedAt, now() - linkedAt <= options.wokenLate {
            let ours = Set(safariWindows.values).union(made_).union(made.map { [$0] } ?? [])
            let late = links.windowIds(of: p).filter { !atLink.contains($0) && !ours.contains($0) && !ids.contains($0) }
            if !late.isEmpty { note("the window opened to wake the profile: \(late.count) more that came after its copy linked (it linked through another)"); ids += late }
        }
        var left: [Int] = []
        for id in ids where id != made && !made_.contains(id) {
            let (_, error) = await links.request(profile: p, "closeWindow", ["windowId": id])
            if error != nil, links.windowIds(of: p).contains(id) { left.append(id) }
            note("the window opened to wake the profile closed\(why): \(error ?? "ok")")
        }
        if !left.isEmpty, wokenByMenu[p] == nil {
            wokenByMenu[p] = left
            wokenAtLink[p] = Set(left)
            wokenLinkedAt[p] = now()
        }
        releaseWokenSpace()
    }
    // The private Space the woken windows were parked in, released once nothing's woken any more and none of them is
    // still open (else the poll looks again: `sweepRestoredSafariWindows`).
    private func releaseWokenSpace() {
        guard wokenByMenu.isEmpty else { return }
        let open = engine.wokenParked(bundleId: safariIdentifier)
        guard open.isEmpty else {
            if !wokenHeld { wokenHeld = true; note("the private Space of the windows opened to wake a profile kept: \(open.count) of them still open (never let into Margin's Space)") }
            return
        }
        wokenHeld = false
        engine.releaseWoken(bundleId: safariIdentifier)
    }
    private var wokenHeld = false

    func requestSafariWindow(_ profile: String?, role: SafariRole = .main) async -> HostSafariWindow? {
        let p = resolve(profile)
        requesting.insert(p) // (the restored-window sweep leaves this profile alone meanwhile)
        defer { requesting.remove(p) }
        // (A window made ready out of sight: a blank page, nothing loaded in it. Focused, as every window Margin asks of
        // Safari: a Safari Margin started is hidden, and asked for an unfocused window there it answers its id but never
        // orders it in, so the window server never lists it (the real Mac, 2026-11-16). The engine unhides it first and
        // keeps Margin's Space current while it's made; Margin is activated again after.)
        if wokenByMenu[p] != nil { engine.stopHidingWoken(bundleId: safariIdentifier) } // (the window asked for now is Margin's own: never parked so)
        // (A card's or a pane's window in full screen from the start, in a Space of its own, under the engine's freeze from
        // the ask: Safari made one so anyway while its key window was full screen (the real screen, 2026-11-21), and
        // macOS's switch to that Space was seen. Its Space is then taken by the early path: HostEngine `openNew`.)
        var payload: JSONObject = preparingProfile == p ? ["fullscreen": false, "url": "about:blank"] : ["fullscreen": role != .main]
        // (The preview card window: opened at the card's page, never Safari's empty new-tab page, whose address field keeps
        // Safari's toolbar down over the page: background/hosted.ts.)
        if role == .card, let c = cards[p], Self.webAddress(c.url) { payload["url"] = c.url }
        // (A split's pane window: opened at its pane's page, docs/PEEK-SPLIT.md §4; never the new-tab page.)
        if role.isPane, let address = paneAddressFor[SafariKey(p, role)], address == "about:blank" || address.lowercased().hasPrefix("http") { payload["url"] = address }
        if role.isPane, let item = paneItemFor[SafariKey(p, role)] { payload["itemId"] = item }
        var askedEpoch = links.linkEpoch(of: p) // (the link the ask went on: one replaced while it was answered counts as back)
        var (result, error) = await links.request(profile: p, "newWindow", payload)
        // (A copy that isn't the one in charge answers `stale`, and a copy just starting can drop its link: Safari keeps an
        // older copy of Margin running beside a newer one (an update, a second build; 2026-11-17 real-apps: "a newer copy
        // of Margin is running", its links down a moment later, the open failed; three minutes later the same ask was
        // made). Asked again, at most twice, once the profile's link is back or another copy's link replaced it: waited
        // for as long as what it's for is wanted (evidence, not a time: `linkWanted`), said every `linkSayEvery`.)
        for attempt in 1...2 {
            guard result.flatMap({ SpaceWindowAnswer($0) }) == nil, let e = error, Self.askAgain(e) else { break }
            let epoch = askedEpoch
            note("Safari window for a profile: not made (\(e)): asked again once its copy's link is back or another copy's (try \(attempt + 1))")
            let t0 = now()
            var saidAt = t0
            while true {
                let now = links.linkEpoch(of: p)
                if now != nil && now != epoch { break }
                guard linkWanted(p) else { break }
                if self.now() - saidAt >= options.linkSayEvery { saidAt = self.now(); note("Safari window for a profile: its copy's link not back yet after \(secs(since: t0)) s") }
                await sleep(options.every)
            }
            guard let back = links.linkEpoch(of: p), back != epoch else { break }
            askedEpoch = back
            (result, error) = await links.request(profile: p, "newWindow", payload)
        }
        guard let made = result.flatMap({ SpaceWindowAnswer($0) }) else {
            note("Safari window for a profile: not made (\(error ?? "no answer"))")
            return nil
        }
        safariWindows[SafariKey(p, role)] = made.windowId
        made_.insert(made.windowId)
        note("Safari window \(made.windowId) made for hosting\(role == .main ? "" : " (its \(role))")")
        // The window opened only to wake the profile's copy: closed again (Margin opened it; it has no page of the person's).
        await closeWoken(p, except: made.windowId)
        return HostSafariWindow(id: made.windowId, bounds: made.bounds)
    }

    // A window ask answered so by a copy not in charge, or by a link that went: worth asking again once a link is back.
    nonisolated static func askAgain(_ error: String) -> Bool {
        let e = error.lowercased()
        return e.contains("newer copy") || e.contains("not linked") || e.contains("down")
    }

    // A window a profile's copy made for Margin, closed by that copy (by the copy's id). True: the copy asked Safari.
    func closeSafariWindow(_ profile: String?, _ windowId: Int) async -> Bool {
        let p = resolve(profile)
        for (k, id) in safariWindows where k.profile == p && id == windowId { safariWindows[k] = nil }
        let (result, error) = await links.request(profile: p, "closeWindow", ["windowId": windowId])
        guard let result, WindowCallAnswer(result).called else {
            note("Safari window \(windowId): not closed by its copy (\(error ?? "busy"))")
            return false
        }
        // Confirmed by the copy's own list: Safari keeps a closed window's window-server window for a while, in no Space
        // and off screen (seen 2026-11-15), so the window server can't say it's gone.
        let gone = await wait(3) { !self.links.windowIds(of: p).contains(windowId) }
        if !gone { note("Safari window \(windowId): closed by its copy, still in its list after 3 s") }
        return gone
    }

    // A window a profile's copy made for Margin, into full screen (focused) or out of it, by that copy
    // (`setWindowState`): Accessibility can't while the window is on a Space that isn't current. True: Safari was asked
    // (answered at once: what the window did is the engine's to read from the window server).
    func safariFullScreen(_ profile: String?, _ windowId: Int, _ on: Bool) async -> Bool {
        let p = resolve(profile)
        let request = HandoffRequest.setWindowState(windowId: windowId, state: on ? .fullscreen : .normal, focused: on, notAfter: (Date().timeIntervalSince1970 + 2) * 1000)
        let (result, error) = await links.request(profile: p, request.type, request.payload)
        guard let result else {
            note("Safari window \(windowId): \(on ? "full screen" : "normal") not asked of its copy (\(error ?? "no answer"))")
            return false
        }
        let answer = WindowCallAnswer(result)
        note("Safari window \(windowId) \(on ? "to full screen" : "out of full screen") by its copy: \(answer)")
        return answer.called
    }

    // A Safari window Margin hosts brought in front of its app's others by its copy (hostFocusWindow: windows.update focused): the engine's
    // last way when Accessibility can't raise a window Safari made a moment ago (HostEngine.frontVisible). True: done.
    func safariFocus(_ profile: String?, _ windowId: Int) async -> Bool {
        let (result, error) = await links.request(profile: resolve(profile), "hostFocusWindow", ["windowId": windowId, "notAfter": (Date().timeIntervalSince1970 + 2) * 1000])
        note("Safari window \(windowId) brought in front by its copy: \(result != nil ? "done" : error ?? "no answer")")
        return result?["focused"] as? Bool == true
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
        let what = divider ? "a split's divider" : "the sidebar's edge"
        let all = counts.visible
        func windows(_ n: Int) -> String { "\(n) hosted window\(n == 1 ? "" : "s")" }
        let how: String
        if !following || counts.follow == 0 {
            how = "the page area's changes held until it's let go (\(windows(all)) placed again then)"
        } else if counts.follow >= all {
            how = all == 1 ? "the hosted window follows it live" : "\(windows(all)) follow it live"
        } else {
            how = "\(counts.follow) of \(windows(all)) follow it live, the other\(all - counts.follow == 1 ? "" : "s") placed again when it's let go"
        }
        return "\(what) dragged in Margin's window \(window): \(how)"
    }

    // ---- the palette ----

    // An installed app picked (`app.open`) in a Margin window (nil: the front one).
    func openApp(_ bundleId: String, windowId: Int?) {
        if Self.isChromium(bundleId) { return note("\(bundleId): Chrome and Edge aren't hosted yet") }
        guard let w = window(windowId) else { return note("\(bundleId): no Margin window") }
        if AppCatalog.isOwnApp(bundleId) {
            // Margin picked inside Margin: never hosted in itself. A surprise instead, as a new web item.
            library.perform("newTab", ["windowId": w.id, "url": Self.ownAppSurprise, "title": "Margin"])
            return note("Margin picked in its own palette: the surprise")
        }
        if options.safariBundles.contains(bundleId) {
            // Safari itself: a new web item, in the space's Safari profile.
            library.perform("newTab", ["windowId": w.id, "url": "about:blank", "title": "New Tab"])
            return
        }
        let space = library.space(ofWindow: w.id) ?? library.spaces().first?.id
        if let existing = library.items(space: space).first(where: { $0.value["url"] as? String == "app://" + bundleId }) {
            library.perform("activateTab", ["windowId": w.id, "tabId": existing.id])
            return
        }
        let target = ItemTarget.app(bundleId: bundleId, name: appName(bundleId) ?? bundleId)
        var payload: JSONObject = ["windowId": w.id, "target": target.json, "front": true]
        if let space { payload["spaceId"] = space }
        let out = library.perform("addItem", payload)
        guard out.ok, let item = (out.result as? JSONObject)?["tabId"] as? String else { return note("\(bundleId): no item made (\(out.error ?? "?"))") }
        note("\(bundleId): item \(item) added")
        // (In front at once, as a sidebar pick: its row lit and the loading bar its own while it opens.)
        requested[w.id] = item
        onChange?()
        enqueue { await self.show(item, url: nil, target: target, windowId: w.id) }
    }

    // The official upload, played in Safari: nothing bundled.
    static let ownAppSurprise = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

    static func isChromium(_ bundleId: String) -> Bool {
        bundleId.hasPrefix("com.google.Chrome") || bundleId.hasPrefix("com.microsoft.edgemac")
    }

    // A web item's history in its Safari window (the copy's goBack, goForward, reload for its tab).
    func navigate(_ type: String, windowId: Int?) {
        guard let w = window(windowId), let item = shown[w.id], let o = open[item], let p = o.profile else { return }
        enqueue {
            let (result, _) = await self.links.request(profile: p, "hostShow", ["windowId": self.safariWindows[SafariKey(p, o.host.safariRole)] ?? -1, "itemId": item, "url": (self.library.items().first { $0.id == item }?.value["url"] as? String) ?? "about:blank"])
            guard let tab = int(result?["tabId"]) else { return }
            _ = await self.links.request(profile: p, type, ["tabId": tab])
        }
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

    // A web item's Safari profile: its own, else the default profile's copy (or, when only others have linked, the first).
    func resolve(_ profile: String?) -> String {
        if let profile { return profile }
        let linked = links.safariProfiles()
        if linked.isEmpty || linked.contains(Self.defaultSafariProfile) { return Self.defaultSafariProfile }
        return linked.sorted()[0]
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
    // else Google's, as Safari's default.
    static func searchUrl(_ query: String, settings: JSONObject?) -> String {
        let learned = (settings?["safariSearch"] as? JSONObject)?["template"] as? String
        let template = learned.flatMap { $0.contains("%s") && $0.hasPrefix("https://") ? $0 : nil }
            ?? "https://www.google.com/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8"
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return template.replacingOccurrences(of: "%s", with: query.addingPercentEncoding(withAllowedCharacters: allowed) ?? query)
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
