// Margin as the app, joined up (docs/MARGIN-APP.md; DECISIONS.md "Margin as the app: the parts joined"), behind
// `MarginHosted`: the library's items shown in Margin's window by the host engine.
//
// - The library (Library.swift) says what needs a browser or an app (its requests: activateTab, newTab, closeTab,
//   setSpace, openPin, clearToday, restoreArchive); this is its delegate, and does each one, one at a time, in order.
// - An app item: its app opened by the engine the first time (`.app(bundleId)`: started with no Dock icon, its
//   window the second tile of Margin's full-screen Space), shown again by the engine after; closed, the engine closes it.
// - A web item (Safari): one hosted Safari window per Safari profile in use (`.safariWindow(profile)`), made by that
//   profile's copy (`newWindow`, asked by the engine once the copy has linked) and shown by the engine; the item is a
//   tab of it (the copy's `hostShow { windowId, itemId, url }`: its tab used again, or made, and brought to the
//   front). Two web items of one profile: a tab switch only, the engine isn't asked. Closed: `hostClose { itemId }`.
//   Chrome and Edge items: not hosted yet (said in the log).
// - Margin's window while hosting (v1 rule, decided here): it's taken to full screen first (its own Space: the tiles
//   need it; windowed hosting is a later phase), its page drawing the sidebar alone (MarginWindowController.setHosting),
//   the sidebar's tile once the hosted tile comes in (`willTile`), and the engine is given the placement worked out
//   from the tiles (the page area, the display's area, Margin's tile width). It's the sidebar's tile only while the
//   engine shows something in it: nothing shown any more (closed, quit, parked), its whole width again, the theme's
//   launcher in its page area. Leaving full screen (the person's ⌃⌘F, the green button, anything), the one shown is
//   parked at once (`leavingFullScreen`): nothing hosted ever stands alone in a full-screen Space of its own.
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
    func fullScreenSpace(ofWindow number: Int) -> UInt64?
    func target(ofWindow number: Int) -> HostTarget?
}

extension HostEngine: HostedEngine {}

// One of Margin's windows, as the session drives it (MarginWindowController; a test's stand-in).
protocol HostedWindow: AnyObject {
    var id: Int { get }
    var number: Int { get } // the window server's
    var isFullScreen: Bool { get }
    var hostedPlacement: HostPlacement? { get } // the page area, the display's area, its tile's width while hosting; nil until worked out
    var pageAreaWhyNot: String { get } // why there's none yet, for the log
    func toFullScreen()
    var fullScreenState: String { get } // for the log
    var layoutMode: String? { get } // the mode of the page's last layout
    func setHosting(_ on: Bool)
    func tile() // the sidebar's tile now (the hosted window's tile is coming in)
    func push(_ json: String)
}

extension MarginWindowController: HostedWindow {
    var number: Int { window.windowNumber }
    var layoutMode: String? { layout?.mode }
    var pageAreaWhyNot: String {
        if !hosting { return "not hosting" }
        guard let layout else { return "no layout from its page" }
        if !isFullScreen { return "not in full screen" }
        if !layout.outside { return "no layout measured with the sidebar alone yet" }
        if layout.mode != "fullscreen" { return "its last layout is a \(layout.mode) one" }
        return "the window has no page rect (display \(hostDisplay.map { "\(Int($0.width))×\(Int($0.height))" } ?? "unknown"), layout \(Int(layout.left))/\(Int(layout.top))/\(Int(layout.right))/\(Int(layout.bottom)))"
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
}

final class HostedSession: LibraryDelegate {
    struct Options {
        var linkWait = 20.0 // a Safari copy's link (a Safari Margin just started takes ~12 s: docs/MARGIN-APP.md)
        var fullScreenWait = 6.0 // Margin's window into full screen
        var pageWait = 3.0 // its page area worked out (the sidebar's tile measured)
        var every = 0.05
        var safariBundles: Set<String> = [safariIdentifier, "com.apple.SafariTechnologyPreview"]
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

    // Each Margin window's item shown; each item with a page; each Safari profile's hosted window (the copy's id).
    private(set) var shown: [Int: String] = [:]
    private(set) var open: [String: OpenItem] = [:]
    private(set) var safariWindows: [String: Int] = [:]
    private(set) var hostingWindow: Int?
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
        case .app(let bundle, _):
            guard await host(.app(bundle), in: w) else { return }
            open[item] = OpenItem(host: HostTarget.app(bundle).id, profile: nil)
        case .web(let browser, let profile):
            guard browser == "safari" else { return note("\(item): \(browser) isn't hosted yet") }
            let p = resolve(profile)
            let id = HostTarget.safariWindow(p).id
            if engine.shown != id || hostingWindow != w.id {
                guard await host(.safariWindow(p), in: w) else { return }
            }
            guard let windowId = safariWindows[p] else { return note("\(item): no Safari window of its profile") }
            let (result, error) = await links.request(profile: p, "hostShow", ["windowId": windowId, "itemId": item, "url": address.isEmpty ? "about:blank" : address])
            guard result != nil else { return note("\(item): its tab wasn't shown (\(error ?? "no answer"))") }
            open[item] = OpenItem(host: id, profile: p)
            note("\(item): shown in Safari window \(windowId)")
        }
        shown[w.id] = item
        if requested[w.id] == item { requested[w.id] = nil }
        drawn = true
        onChange?()
    }

    // The engine's open (the first time) or show, into `w`'s page area; Margin's window made ready first. False: not shown.
    private func host(_ target: HostTarget, in w: HostedWindow) async -> Bool {
        guard let (placement, space) = await prepare(w) else { settleHosting(); return false }
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

    // Margin's window ready to host beside it: in full screen (v1: its own Space; windowed hosting is later), the
    // sidebar's tile, its page area worked out. Nil: it couldn't be.
    private func prepare(_ w: HostedWindow) async -> (HostPlacement, UInt64)? {
        if let other = hostingWindow, other != w.id, let was = window(other) {
            // (One Margin window hosts at a time: the one shown in the other parked first, so that window's size
            // constraints change only once no hosted tile is beside it.)
            await engine.parkShown(why: "another Margin window hosts")
            shown[other] = nil
            hostingWindow = nil
            was.setHosting(false)
        }
        if !w.isFullScreen {
            note("Margin's window \(w.id) to full screen first (hosting needs its own Space)")
            w.toFullScreen()
            // One more ask if it hasn't started (the first can be dropped while Margin comes forward).
            if await !wait(2, { w.isFullScreen }) {
                note("Margin's window \(w.id) not in full screen after 2 s (\(w.fullScreenState)): asked again")
                w.toFullScreen()
            }
            guard await wait(options.fullScreenWait, { w.isFullScreen }) else {
                note("Margin's window \(w.id) didn't go full screen (\(w.fullScreenState)): nothing hosted")
                return nil
            }
        }
        // The page measured at the full-screen size before it's told to draw the sidebar alone (which leaves nothing
        // to measure): the page area's right inset comes from that layout (seen 2026-11-15: hosting turned on at once
        // kept the windowed layout for good). It comes as soon as the page hears the window's new mode.
        if await !wait(1.5, { w.layoutMode == "fullscreen" }) {
            note("Margin's window \(w.id): no full-screen layout from its page in 1.5 s (\(w.layoutMode ?? "none")): its last one is used")
        }
        w.setHosting(true)
        hostingWindow = w.id
        // (A layout measured with the sidebar alone, in full screen: comes once the page has heard `pageOutside`.)
        guard await wait(options.pageWait, { w.hostedPlacement != nil }), let placement = w.hostedPlacement else {
            note("Margin's window \(w.id): no page area (\(w.pageAreaWhyNot))")
            return nil
        }
        return (placement, engine.fullScreenSpace(ofWindow: w.number) ?? 0)
    }

    // Margin's window about to leave full screen while hosting (the person's ⌃⌘F, its green button, anything): the one
    // shown parked at once, while its tile is still in Margin's Space (macOS would leave it alone in a full-screen
    // Space of its own). Not queued behind the session's own work: the engine takes it next.
    func leavingFullScreen(_ w: HostedWindow) {
        guard w.id == hostingWindow, engine.shown != nil else { return }
        note("Margin's window \(w.id) leaving full screen while hosting: the one shown parked")
        Task { await self.engine.parkShown(why: "Margin's window left full screen") }
    }

    // Margin's window left full screen while hosting: the one shown parked (if leaving didn't already), its whole width
    // again once it's windowed (its size constraints never change while it's a full-screen tile), nothing shown in it.
    // Shown again when an item is: the show takes it to full screen again.
    func leftFullScreen(_ w: HostedWindow) {
        guard w.id == hostingWindow else { return }
        note("Margin's window \(w.id) left full screen while hosting: its whole width again")
        if engine.shown != nil { Task { await self.engine.parkShown(why: "Margin's window left full screen") } }
        hostingWindow = nil
        w.setHosting(false)
        shown[w.id] = nil
        onChange?()
    }

    // The engine is moving a host's tile into Margin's Space (Margin's window alone in it): the hosting window becomes
    // the sidebar's tile, at its width now.
    func willTile() {
        guard let id = hostingWindow else { return }
        window(id)?.tile()
    }

    // Margin's window is the sidebar's tile only while the engine shows something in it: nothing shown, its whole
    // width again (after each of the session's steps, and the engine's events, once the engine is done).
    private func settleHosting() {
        guard engine.shown == nil, let id = hostingWindow else { return }
        hostingWindow = nil
        shown[id] = nil
        window(id)?.setHosting(false)
        onChange?()
    }

    // ---- closing ----

    func close(_ item: String, target: ItemTarget?) async {
        let target = target ?? library.target(ofItem: item)
        let had = open.removeValue(forKey: item)
        for (w, i) in shown where i == item { shown[w] = nil }
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

    // ---- the engine's Safari windows (HostEngine's requestSafariWindow, closeSafariWindow, safariFullScreen, safariLinked) ----

    func safariLinked(_ profile: String?) async -> Bool {
        let p = resolve(profile)
        if links.safariProfiles().contains(p) { return true }
        // Safari is open but this profile has no window, so its copy isn't running (seen 2026-11-15: a space of a
        // profile with no window never linked): one window of it from Safari's menu; Margin closes it again once its
        // own window is made (requestSafariWindow).
        // A Safari just started (by Margin, with no Dock icon) has no menus and no copies for a while (~12 s to the first
        // link, docs/MARGIN-APP.md): its own copies first (the profile may be among them), the menu only after.
        if links.safariProfiles().isEmpty {
            _ = await wait(options.linkWait) { !self.links.safariProfiles().isEmpty }
            if links.safariProfiles().contains(p) { return true }
        }
        // Asked through the menu twice at most (seen 2026-11-15: a press while Safari was still starting did nothing).
        var linked = false
        for attempt in 1...2 where !linked {
            if links.openProfileWindow(p) {
                note("a Safari profile with no window: one opened from Safari's menu so its copy links (try \(attempt))")
                wokenByMenu[p] = []
            }
            linked = await wait(attempt == 1 ? options.linkWait / 2 : options.linkWait) { self.links.safariProfiles().contains(p) }
        }
        guard linked else { return false }
        if wokenByMenu[p] != nil {
            _ = await wait(1.5) { !self.links.windowIds(of: p).isEmpty }
            wokenByMenu[p] = links.windowIds(of: p)
        }
        return true
    }
    private var wokenByMenu: [String: [Int]] = [:] // a profile woken through Safari's menu: the windows it had then

    func requestSafariWindow(_ profile: String?) async -> HostSafariWindow? {
        let p = resolve(profile)
        let (result, error) = await links.request(profile: p, "newWindow", ["fullscreen": false])
        guard let made = result.flatMap({ SpaceWindowAnswer($0) }) else {
            note("Safari window for a profile: not made (\(error ?? "no answer"))")
            return nil
        }
        safariWindows[p] = made.windowId
        note("Safari window \(made.windowId) made for hosting")
        // The window opened only to wake the profile's copy: closed again (Margin opened it; it has no page of the person's).
        if let woken = wokenByMenu.removeValue(forKey: p) {
            for id in woken where id != made.windowId {
                let (_, error) = await links.request(profile: p, "closeWindow", ["windowId": id])
                note("the window opened to wake the profile closed: \(error ?? "ok")")
            }
        }
        return HostSafariWindow(id: made.windowId, bounds: made.bounds)
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
        return true
    }

    // A window a profile's copy made for Margin, into full screen (focused) or out of it, by that copy
    // (`setWindowState`): Accessibility can't while the window is on a Space that isn't current. True: Safari was asked.
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
            for item in items { open[item] = nil }
            for (w, i) in shown where items.contains(i) { shown[w] = nil }
            for p in safariWindows.keys where HostTarget.safariWindow(p).id == id { safariWindows[p] = nil }
        default:
            return
        }
        onChange?()
        // (Whether Margin's window is still a tile is settled once the engine is done: these come mid-operation.)
        enqueue { self.settleHosting() }
    }

    // ---- the page area moved (the sidebar's width, another theme, another display) ----

    // Taken once per run of changes (a theme's layout reports come in bursts): the newest placement, when its turn comes.
    private var placing = false
    func pageRectChanged(_ window: HostedWindow) {
        guard window.id == hostingWindow, engine.shown != nil, !placing else { return }
        placing = true
        enqueue {
            self.placing = false
            guard window.id == self.hostingWindow, self.engine.shown != nil, let placement = window.hostedPlacement else { return }
            let placed = await self.engine.pageRectChanged(placement)
            self.note("page area changed: \(Int(placement.page.width))×\(Int(placement.page.height)), Margin's tile \(Int(placement.tileWidth))\(placed ? "" : " (not fitted)")")
        }
    }

    // ---- the palette ----

    // An installed app picked (`app.open`) in a Margin window (nil: the front one).
    func openApp(_ bundleId: String, windowId: Int?) {
        if Self.isChromium(bundleId) { return note("\(bundleId): Chrome and Edge aren't hosted yet") }
        guard let w = window(windowId) else { return note("\(bundleId): no Margin window") }
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
        enqueue { await self.show(item, url: nil, target: target, windowId: w.id) }
    }

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
    static let quiet: Set<String> = ["sidebarScroll", "setSidebarScroll", "wakeSleeping", "windowState", "cancelNewTab", "paletteDropped", "noticeAction"]

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
