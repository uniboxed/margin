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
    func open(app target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult
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
    func appRuns(bundleId: String) -> Bool?
    // A drag of the sidebar's edge began (true) or is over (false): true back, the one shown follows it live (HostEngine
    // `dragging`: its tile's rect, a window-mode window's frame); then each page area of the drag (`follow`), at most one
    // change a display frame. False: it doesn't (the page area's changes held until the drag is over, as before).
    func dragging(_ on: Bool) -> Bool
    func follow(_ placement: HostPlacement)
    // The one shown fills the page area as it follows (a tile): the hole is the page area meanwhile. Not (a window-mode
    // window, which can be smaller, centred): the hole its bounds, read again as it moves.
    var shownFillsPage: Bool { get }
}

extension HostedEngine {
    // (A stand-in that doesn't play them: nothing started or prepared, nothing hidden.)
    func hideWoken(bundleId: String) {}
    func stopHidingWoken(bundleId: String) {}
    func releaseWoken(bundleId: String) {}
    func wokenWindows(bundleId: String) -> Int { 0 }
    func appRuns(bundleId: String) -> Bool? { nil }
    func dragging(_ on: Bool) -> Bool { false }
    func follow(_ placement: HostPlacement) {}
    var shownFillsPage: Bool { false }
    var preparesOutOfSight: Bool { false }
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
    func cover(_ number: Int?) // a window of the engine's in its Space not shown yet (a new app's, read), nil: no more
    func yield(to number: Int?) // another app's window opened in its Space: let in front until it's gone (nil)
    func frontRead(_ read: HostEngine.FrontRead) // the poll's read at rest of it and the hosted window: in front, kept so
    func push(_ json: String)
}

extension HostedWindow {
    func setShowing(_ label: String?) { setShowing(label, app: nil, slow: false) }
    func setShowing(_ label: String?, slow: Bool) { setShowing(label, app: nil, slow: slow) }
    func setShowing(_ label: String?, app: String?) { setShowing(label, app: app, slow: false) }
    func setLoading(_ label: String?) { setLoading(label, app: nil) }
    func followsPage(_ on: Bool) {}
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
    func openProfileWindow(_ profile: String) -> Bool
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
        var wokenGrace = 5.0 // a window opened to wake a profile, still open this long after its copy linked with no request under way: closed
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
    // A Margin window by its id, or (nil) the one in front.
    var window: (Int?) -> HostedWindow? = { _ in nil }
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
    private(set) var safariWindows: [String: Int] = [:]
    private(set) var hostingWindow: Int?
    // Each Margin window's item shown when macOS took the window out of full screen: hosted again once it's back in.
    private(set) var resume: [Int: String] = [:]
    // What the loading animation names for a host (the app's name; Safari).
    private var labels: [HostID: String] = [:]
    // The loading bar (setLoadingTabs): the engine's slow step now (its host), the item each host is being shown for,
    // each web item's tab in its Safari window (the copy's id, from hostShow), the tabs each profile's copy says are
    // loading in its hosted window (its `loading` push), and what each Margin window was told last.
    private var appLoading: HostID?
    private var showing: [HostID: String] = [:]
    private(set) var safariTabs: [String: Int] = [:]
    private var copyLoading: [String: Set<Int>] = [:]
    private(set) var loadingSaid: [Int: [Int]] = [:]
    // Each Margin window's item asked to be shown and not shown yet (the newest): drawn in front at once.
    private(set) var requested: [Int: String] = [:]
    static let showRequests: Set<String> = ["activateTab", "newTab", "restoreArchive", "setSpace", "openPin"]
    // The first run's space (the library was empty), for the UI's editor once a window's page is drawn.
    var firstSpace: String?
    // The UI's numbers for open items (it takes only numbers for open tabs), this session's.
    private var numbers: [String: Int] = [:]
    private var items: [Int: String] = [:]
    private var nextNumber = 1
    // What was done, newest last (the tests read it; numbers, item ids and bundle ids only).
    private(set) var done: [String] = []
    private var tail: Task<Void, Never>?

    init(library: Library, engine: HostedEngine, links: HostedLinks, options: Options = Options()) {
        self.library = library
        self.engine = engine
        self.links = links
        self.options = options
    }

    // ---- one at a time ----

    private func enqueue(_ body: @escaping () async -> Void) {
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

    private func note(_ line: String) {
        done.append(line)
        if done.count > 200 { done.removeFirst(done.count - 200) }
        Diagnostics.note("hosted: \(line)")
    }

    // ---- the library's requests ----

    func library(_ library: Library, wants request: LibraryRequest) {
        // The item in front in its window at once (the sidebar's switch highlight lands as it's asked: an app's switch
        // takes seconds, and the highlight went back to the item left meanwhile, "back on a tab it had passed").
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
            guard let item = r.item else { return } // (a space with no items: nothing to show)
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
            let out = library.perform("addItem", payload)
            guard out.ok, let item = (out.result as? JSONObject)?["tabId"] as? String else { return note("openPin: no item made (\(out.error ?? "?"))") }
            await show(item, url: r.url, target: r.target, windowId: r.windowId)
        case "closeTab":
            guard let item = r.item else { return }
            let windows = shown.filter { $0.value == item }.map(\.key)
            let next = r.body["next"] as? String
            if let next, let window = windows.first, requested[window] == nil { requested[window] = next } // (in front at once)
            await close(item, target: r.target)
            if let next, let window = windows.first {
                await show(next, url: nil, target: library.target(ofItem: next), windowId: window)
            }
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
        // (Shown or not, it's no longer one asked for: a failure draws the item shown before in front again.)
        var drawn = false
        defer { if requested[w.id] == item { requested[w.id] = nil; if !drawn { onChange?() } } }
        guard let target = target ?? library.target(ofItem: item) else { return note("\(item): no target") }
        let address = url ?? (library.items().first { $0.id == item }?.value["url"] as? String) ?? ""
        switch target {
        case .app(let bundle, let name):
            labels[HostTarget.app(bundle).id] = appName(bundle) ?? (name.isEmpty ? nil : name) ?? bundle
            showing[HostTarget.app(bundle).id] = item
            defer { showing[HostTarget.app(bundle).id] = nil; refreshLoading() }
            if engine.shown != HostTarget.app(bundle).id || hostingWindow != w.id { w.setShowing(labels[HostTarget.app(bundle).id], app: bundle) }
            defer { w.setShowing(nil) }
            guard await host(.app(bundle), in: w) else { return }
            open[item] = OpenItem(host: HostTarget.app(bundle).id, profile: nil)
        case .web(let browser, let profile):
            guard browser == "safari" else { return note("\(item): \(browser) isn't hosted yet") }
            let p = resolve(profile)
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
            let comes = engine.shown != id || hostingWindow != w.id
            let there = safariWindows[p] != nil && engine.isHosted(id)
            if comes {
                let title = (library.items().first { $0.id == item }?.value["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                w.setShowing(title ?? "Safari", app: safariIdentifier)
                if !there { guard await host(.safariWindow(p), in: w) else { return } }
            }
            guard let windowId = safariWindows[p] else { return note("\(item): no Safari window of its profile") }
            let (result, error) = await links.request(profile: p, "hostShow", ["windowId": windowId, "itemId": item, "url": address.isEmpty ? "about:blank" : address])
            guard let result else { return note("\(item): its tab wasn't shown (\(error ?? "no answer"))") }
            open[item] = OpenItem(host: id, profile: p)
            if let tab = int(result["tabId"]) { safariTabs[item] = tab }
            if comes, there { guard await host(.safariWindow(p), in: w) else { return } }
            note("\(item): shown in Safari window \(windowId)")
        }
        shown[w.id] = item
        if requested[w.id] == item { requested[w.id] = nil }
        drawn = true
        onChange?()
    }

    // The engine's open (the first time) or show, into `w`'s page area; Margin's window made ready first. False: not shown.
    private func host(_ target: HostTarget, in w: HostedWindow) async -> Bool {
        guard let (placement, space) = await prepare(w, for: target) else { settleHosting(); return false }
        // (Hosted already, or not: opened or shown again with Margin's window's placement and Space as they are now,
        // which change when its window left full screen and came back.)
        let result = await engine.open(app: target, in: placement, marginWindow: w.number, marginSpace: space)
        switch result {
        case .shown(let id, let placed):
            note("\(id): shown\(placed ? "" : " (not fitted to the page area)")")
            return true
        case .failed(let step, let why):
            note("\(target.id): \(step.rawValue) failed: \(why)")
            settleHosting()
            return false
        }
    }

    // Margin's window ready to host in its page area: in full screen (it always is; asked once more if it isn't, a
    // safety check), its page drawing its own layout for hosting, its page area measured. Nil: it couldn't be.
    private func prepare(_ w: HostedWindow, for target: HostTarget) async -> (HostPlacement, UInt64)? {
        if let other = hostingWindow, other != w.id, let was = window(other) {
            // (One Margin window hosts at a time: the one shown in the other parked first.)
            await engine.parkShown(why: "another Margin window hosts")
            shown[other] = nil
            hostingWindow = nil
            was.setHosted(nil)
            was.setShowing(nil)
            was.setHosting(false)
        }
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
        appLoading = id
        defer { refreshLoading() }
        guard let wid = hostingWindow, let w = window(wid) else { return }
        w.setLoading(id.map { labels[$0] ?? $0.description }, app: id?.iconApp)
    }

    // A Safari profile's copy's `loading` push (background/page-loads.ts: its tabs loading in one of its windows): kept
    // for the window Margin hosts for that profile, the bar drawn for its items' tabs.
    func copyLoading(profile: String, windowId: Int?, tabIds: [Int]) {
        guard let windowId, safariWindows[profile] == windowId else { return }
        let next = Set(tabIds)
        guard next != copyLoading[profile] ?? [] else { return }
        copyLoading[profile] = next
        refreshLoading()
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
        Task { await self.engine.activateShown(at: point) }
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
        }
    }

    func resumeLast(_ w: HostedWindow) {
        guard options.resumesLast, !resumed, hostingWindow == nil, engine.shown == nil else { return }
        resumed = true
        guard let (item, target, name) = lastItem(ofWindow: w.id) else { return }
        resuming = w.id
        hostingWindow = w.id
        requested[w.id] = item
        w.setHosting(true)
        if case .app(let bundle, _) = target { w.setShowing(name, app: bundle, slow: true) } else { w.setShowing(name, app: safariIdentifier, slow: true) }
        note("Margin's window \(w.id): the item it showed last (\(item)) shown again, behind the loader from its first frame")
        onChange?()
        enqueue {
            defer {
                self.resuming = nil
                w.setShowing(nil)
                // (Something else asked for meanwhile: its own show decides; else nothing shown is the launcher.)
                if self.requested[w.id] == nil || self.requested[w.id] == item { self.requested[w.id] = nil; self.settleHosting() }
            }
            // (Something else asked for meanwhile ends the wait: its own show is next in line, not held up by this one.)
            let ready = await self.wait(self.options.prepareWindowWait) { (w.isFullScreen && w.hostedPlacement != nil) || self.requested[w.id] != item }
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
    private func settleHosting() {
        guard engine.shown == nil, let id = hostingWindow, resuming != id else { return }
        hostingWindow = nil
        shown[id] = nil
        window(id)?.setHosted(nil)
        window(id)?.cover(nil)
        window(id)?.setLoading(nil)
        window(id)?.setShowing(nil)
        window(id)?.setHosting(false)
        refreshLoading()
        onChange?()
    }

    // ---- closing ----

    func close(_ item: String, target: ItemTarget?) async {
        let target = target ?? library.target(ofItem: item)
        let had = open.removeValue(forKey: item)
        safariTabs[item] = nil
        for (w, i) in shown where i == item { shown[w] = nil }
        defer { refreshLoading() }
        switch target {
        case .app(let bundle, _)?:
            let id = HostTarget.app(bundle).id
            if engine.isHosted(id), !open.values.contains(where: { $0.host == id }) { await engine.close(id) }
        case .web(_, let profile)?:
            let p = had?.profile ?? resolve(profile)
            if had != nil { _ = await links.request(profile: p, "hostClose", ["itemId": item]) }
        case nil:
            break
        }
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
        guard options.preparesBrowser else { return }
        let started = now()
        let browser = DefaultBrowser.resolve(setting)
        func skip(_ why: String) { note("browser not prepared: \(why)") }
        // 1. a Margin window in full screen, its page area measured.
        guard await wait(options.prepareWindowWait, { self.window(nil).map { $0.isFullScreen && $0.idlePlacement != nil } ?? false }), let w = window(nil) else {
            return skip("no Margin window in full screen with its page area within \(Int(options.prepareWindowWait)) s")
        }
        let space = library.space(ofWindow: w.id) ?? library.spaces().first?.id
        let spaceProfile = (library.spaces().first { $0.id == space }?.value["profile"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        // 2. the browser running, its copy linked (outside the session's and the engine's queues: the person's picks
        // meanwhile aren't held up).
        guard browser.name == "safari" else { return skip("\(browser.name) isn't hosted yet") }
        guard engine.preparesOutOfSight else { return skip("the early full screen isn't available, so it can't be made ready out of sight") }
        guard await engine.start(bundleId: browser.bundleId) != nil else { return skip("\(browser.bundleId) couldn't be started with no Dock icon") }
        let p = resolve(spaceProfile)
        // (A profile with no window is woken through Safari's menu only for a preparation that can still happen: nothing
        // shown, nothing on its way, nothing asked for. 2026-11-17 14:05: woken 0.9 s after Maps was shown, the
        // preparation then given up and the woken window left open over Maps.)
        let wanted = { self.engine.shown == nil && self.resuming == nil && self.requested.isEmpty }
        guard await safariLinked(p, wakeIf: wanted) else {
            await closeWoken(p, why: " (its preparation given up)")
            return skip(wanted() ? "its extension didn't link" : "something is shown in Margin's window (its profile not woken for it)")
        }
        let target = HostTarget.safariWindow(p)
        // 3. its window made ready out of sight, one at a time with the person's requests.
        enqueue {
            // (Given up below, a window opened to wake its profile is closed: it was only for this.)
            @MainActor func skip(_ why: String) async { await self.closeWoken(p, why: " (its preparation given up)"); self.note("browser not prepared: \(why)") }
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
    // Mission Control). Only in a Safari Margin started; only windows that were there before their profile's copy
    // started (Margin's own are made after); once per link; closed by their copy. A Safari the person opened is never
    // touched. Called from the shell's poll.
    func sweepRestoredSafariWindows() {
        // (A window opened to wake a profile, still open `wokenGrace` after its copy linked with nothing asked of it: what
        // it was for went another way. Closed, whoever started Safari.)
        for (p, at) in wokenLinkedAt.sorted(by: { $0.key < $1.key }) where now() - at >= options.wokenGrace && !requesting.contains(p) {
            wokenLinkedAt[p] = nil
            Task { [weak self] in await self?.closeWoken(p, why: " (left open: closed later)") }
        }
        guard options.closesRestoredSafariWindows else { return }
        guard options.safariBundles.contains(where: { engine.launchedPid(bundleId: $0) != nil }) else { swept = [:]; return }
        for p in links.safariProfiles() where !requesting.contains(p) {
            guard let epoch = links.linkEpoch(of: p), swept[p] != epoch, let restored = links.restoredWindowIds(of: p) else { continue }
            swept[p] = epoch
            let ours = Set(safariWindows.values).union(made_)
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
        let ranAtStart = engine.appRuns(bundleId: safariIdentifier) == true
        let seenBefore = engine.wokenWindows(bundleId: safariIdentifier)
        var presses = 0, pressedAt = started, saidAt = started
        // (Its own copies first: a Safari just started has no menus and no copies for a while, ~4–12 s to the first link,
        // and the profile may be among the windows it restores. Pressed once one has linked and it isn't this profile's,
        // or after `firstCopiesPace` with none.)
        if links.safariProfiles().isEmpty { note("a Safari profile not linked yet: Safari's own copies waited for first (a window it restores links by itself)") }
        while !links.safariProfiles().contains(p) {
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
                if links.openProfileWindow(p) {
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
    private var wokenLinkedAt: [String: Double] = [:] // ...and when its copy linked

    // The windows opened only to wake a profile, closed by its copy (Margin opened them; they hold no page of the
    // person's), whatever happened to what they were for: Margin's window made for it (`except`), the preparation given
    // up, or left open past `wokenGrace` (the poll). One not closed is tried again by the poll. All closed: the private
    // Space they were parked in released.
    func closeWoken(_ p: String, except made: Int? = nil, why: String = "") async {
        guard let ids = wokenByMenu.removeValue(forKey: p) else { return }
        wokenLinkedAt[p] = nil
        var left: [Int] = []
        for id in ids where id != made && !made_.contains(id) {
            let (_, error) = await links.request(profile: p, "closeWindow", ["windowId": id])
            if error != nil, links.windowIds(of: p).contains(id) { left.append(id) }
            note("the window opened to wake the profile closed\(why): \(error ?? "ok")")
        }
        if !left.isEmpty, wokenByMenu[p] == nil {
            wokenByMenu[p] = left
            wokenLinkedAt[p] = now()
        }
        if wokenByMenu.isEmpty { engine.releaseWoken(bundleId: safariIdentifier) }
    }

    func requestSafariWindow(_ profile: String?) async -> HostSafariWindow? {
        let p = resolve(profile)
        requesting.insert(p) // (the restored-window sweep leaves this profile alone meanwhile)
        defer { requesting.remove(p) }
        // (A window made ready out of sight: a blank page, nothing loaded in it. Focused, as every window Margin asks of
        // Safari: a Safari Margin started is hidden, and asked for an unfocused window there it answers its id but never
        // orders it in, so the window server never lists it (the real Mac, 2026-11-16). The engine unhides it first and
        // keeps Margin's Space current while it's made; Margin is activated again after.)
        if wokenByMenu[p] != nil { engine.stopHidingWoken(bundleId: safariIdentifier) } // (the window asked for now is Margin's own: never parked so)
        let payload: JSONObject = preparingProfile == p ? ["fullscreen": false, "url": "about:blank"] : ["fullscreen": false]
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
        safariWindows[p] = made.windowId
        made_.insert(made.windowId)
        note("Safari window \(made.windowId) made for hosting")
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
        if safariWindows[p] == windowId { safariWindows[p] = nil }
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

    // What the engine says happened outside Margin: an app or its window gone, its items have no page any more.
    func hostEvent(_ event: HostEvent) {
        switch event {
        case .unshown(let id):
            // Parked with nothing in its place (Margin's window left full screen, its window strayed): its items keep
            // their page, none is shown.
            for (w, i) in shown where open[i]?.host == id { shown[w] = nil }
        case .quitByUser(let id), .windowClosed(let id), .closed(let id):
            let items = open.filter { $0.value.host == id }.map(\.key)
            for item in items { open[item] = nil; safariTabs[item] = nil }
            for (w, i) in shown where items.contains(i) { shown[w] = nil }
            for p in safariWindows.keys where HostTarget.safariWindow(p).id == id { safariWindows[p] = nil; copyLoading[p] = nil }
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
            return engine.follow(p) // (a window-mode window's hole read again as it moves: the engine says so)
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
        let placed = await engine.pageRectChanged(placement)
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
    func sidebarResizing(_ window: HostedWindow, _ on: Bool) {
        if on {
            guard resizing == nil else { return }
            resizing = window.id
            guard window.id == hostingWindow, engine.shown != nil else { return }
            following = engine.dragging(true)
            window.followsPage(following && engine.shownFillsPage)
            note("the sidebar's edge dragged in Margin's window \(window.id): \(following ? "the hosted window follows it live" : "the page area's changes held until it's let go")")
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
            let (result, _) = await self.links.request(profile: p, "hostShow", ["windowId": self.safariWindows[p] ?? -1, "itemId": item, "url": (self.library.items().first { $0.id == item }?.value["url"] as? String) ?? "about:blank"])
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

    // The library's snapshot (stored values' shape) with the items that have a page as open tabs of the Margin
    // window hosting them, the one shown active there.
    func live(_ snapshot: JSONObject) -> JSONObject {
        let windowId = hostingWindow ?? shown.keys.min() ?? requested.keys.min() ?? 1
        // In front: the item asked for (not shown yet), else the one shown.
        let front = requested[windowId] ?? shown[windowId]
        let listed = Set(open.keys).union(front.map { [$0] } ?? [])
        guard var openTabs = snapshot["openTabs"] as? JSONObject, !listed.isEmpty else { return snapshot }
        var kept = openTabs["keptTabs"] as? JSONObject ?? [:]
        var tabs: JSONObject = [:], tabSpace: JSONObject = [:]
        var index = 0
        for item in listed.sorted() {
            guard let k = kept[item] as? JSONObject, let space = k["spaceId"] as? String else { continue }
            let n = number(ofItem: item)
            tabs[String(n)] = [
                "id": n, "windowId": windowId, "index": index, "title": k["title"] ?? "", "url": k["url"] ?? "", "favIconUrl": k["favIconUrl"] ?? "",
                "active": front == item, "lastActive": k["lastActive"] ?? 0, "mid": item, "order": k["order"] ?? 0,
            ]
            tabSpace[String(n)] = space
            kept[item] = nil
            index += 1
        }
        openTabs["tabs"] = tabs
        openTabs["tabSpace"] = tabSpace
        openTabs["keptTabs"] = kept
        var out = snapshot
        out["openTabs"] = openTabs
        return out
    }

    // ---- helpers ----

    // A web item's Safari profile: its own, else the default profile's copy (or, when only others have linked, the first).
    func resolve(_ profile: String?) -> String {
        if let profile { return profile }
        let linked = links.safariProfiles()
        if linked.isEmpty || linked.contains(Self.defaultSafariProfile) { return Self.defaultSafariProfile }
        return linked.sorted()[0]
    }

    private func wait(_ seconds: Double, _ done: () -> Bool) async -> Bool {
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
        case "closeTab" where payload["tabId"] == nil:
            // ⌘W: the item shown in that window.
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
