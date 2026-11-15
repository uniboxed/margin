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
//   the sidebar's tile once the hosted tile comes in (`willTile`), and the engine is given the page area worked out
//   from the tiles. Nothing hosted any more: its whole width again.
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
    func open(app target: HostTarget, in pageRect: CGRect, marginWindow: Int, marginSpace: UInt64) async -> HostResult
    func show(_ id: HostID) async -> HostResult
    func close(_ id: HostID) async
    func pageRectChanged(_ rect: CGRect) async -> Bool
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
    var hostedPageRect: CGRect? { get } // the page area while hosting (top left), nil until worked out
    var pageAreaWhyNot: String { get } // why there's none yet, for the log
    func toFullScreen()
    func setHosting(_ on: Bool)
    func tile() // the sidebar's tile now (the hosted window's tile is coming in)
    func push(_ json: String)
}

extension MarginWindowController: HostedWindow {
    var number: Int { window.windowNumber }
    // (Only from a layout its page measured in full screen, a moment after it was told the sidebar is all it draws:
    // a layout from before is followed by that one.)
    var hostedPageRect: CGRect? { hosting && layout?.mode == "fullscreen" && Diagnostics.now() - hostingSince >= 0.25 ? window.pageRect : nil }
    var pageAreaWhyNot: String {
        if !hosting { return "not hosting" }
        guard let layout else { return "no layout from its page" }
        if layout.mode != "fullscreen" { return "its page's layout says \(layout.mode)" }
        return window.pageRect == nil ? "the window has no page rect (display \(hostDisplay.map { "\(Int($0.width))×\(Int($0.height))" } ?? "unknown"), layout \(Int(layout.left))/\(Int(layout.top))/\(Int(layout.right))/\(Int(layout.bottom)))" : "too soon"
    }
    func toFullScreen() { if !isFullScreen { toggleFullScreen() } }
}

// The extension's Safari copies, as the session asks them (the shell's links; a test's stand-in). `profile`: the
// copy's own id (its link key's second part).
protocol HostedLinks: AnyObject {
    func safariProfiles() -> [String] // the Safari copies linked now
    func request(profile: String, _ type: String, _ payload: JSONObject) async -> (result: JSONObject?, error: String?)
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
        enqueue { await self.handle(request) }
    }

    private func handle(_ r: LibraryRequest) async {
        switch r.type {
        case "activateTab", "newTab", "restoreArchive", "setSpace":
            guard let item = r.item else { return } // (a space with no items: nothing to show)
            await show(item, url: r.url, target: r.target, windowId: r.windowId)
        case "openPin":
            if let item = r.item { return await show(item, url: r.url, target: r.target, windowId: r.windowId) }
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
            await close(item, target: r.target)
            if let next = r.body["next"] as? String, let window = windows.first {
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
        guard let target = target ?? library.target(ofItem: item) else { return note("\(item): no target") }
        guard let w = window(windowId) else { return note("\(item): no Margin window to show it in") }
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
        onChange?()
    }

    // The engine's open (the first time) or show, into `w`'s page area; Margin's window made ready first. False: not shown.
    private func host(_ target: HostTarget, in w: HostedWindow) async -> Bool {
        guard let (rect, space) = await prepare(w) else { return false }
        let result = engine.isHosted(target.id) ? await engine.show(target.id) : await engine.open(app: target, in: rect, marginWindow: w.number, marginSpace: space)
        switch result {
        case .shown(let id, let placed):
            note("\(id): shown\(placed ? "" : " (not fitted to the page area)")")
            return true
        case .failed(let step, let why):
            note("\(target.id): \(step.rawValue) failed: \(why)")
            if !engine.hasHosts { stopHosting() }
            return false
        }
    }

    // Margin's window ready to host beside it: in full screen (v1: its own Space; windowed hosting is later), the
    // sidebar's tile, its page area worked out. Nil: it couldn't be.
    private func prepare(_ w: HostedWindow) async -> (CGRect, UInt64)? {
        if let other = hostingWindow, other != w.id, let was = window(other) {
            was.setHosting(false) // (one Margin window hosts at a time)
        }
        if !w.isFullScreen {
            note("Margin's window \(w.id) to full screen first (hosting needs its own Space)")
            w.toFullScreen()
            guard await wait(options.fullScreenWait, { w.isFullScreen }) else {
                note("Margin's window \(w.id) didn't go full screen: nothing hosted")
                return nil
            }
        }
        w.setHosting(true)
        hostingWindow = w.id
        guard await wait(options.pageWait, { w.hostedPageRect != nil }), let rect = w.hostedPageRect else {
            note("Margin's window \(w.id): no page area (\(w.pageAreaWhyNot))")
            return nil
        }
        return (rect, engine.fullScreenSpace(ofWindow: w.number) ?? 0)
    }

    // Margin's window left full screen while hosting (the person's ⌃⌘F, its green button): its whole width again; what
    // the engine hosts is left to it (its poll sees a window gone, the next show takes Margin's window to full screen).
    func leftFullScreen(_ w: HostedWindow) {
        guard w.id == hostingWindow else { return }
        note("Margin's window \(w.id) left full screen while hosting: its whole width again")
        hostingWindow = nil
        w.setHosting(false)
        shown[w.id] = nil
        onChange?()
    }

    // The engine is moving a host's tile into Margin's Space: the hosting window becomes the sidebar's tile.
    func willTile() {
        guard let id = hostingWindow else { return }
        window(id)?.tile()
    }

    private func stopHosting() {
        guard let id = hostingWindow else { return }
        hostingWindow = nil
        window(id)?.setHosting(false)
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
        if !engine.hasHosts { stopHosting() }
        onChange?()
    }

    // ---- the engine's Safari windows (HostEngine's requestSafariWindow, closeSafariWindow, safariLinked) ----

    func safariLinked(_ profile: String?) async -> Bool {
        let p = resolve(profile)
        return await wait(options.linkWait) { self.links.safariProfiles().contains(p) }
    }

    func requestSafariWindow(_ profile: String?) async -> Bool {
        let p = resolve(profile)
        let (result, error) = await links.request(profile: p, "newWindow", ["fullscreen": false])
        guard let made = result.flatMap({ SpaceWindowAnswer($0) }) else {
            note("Safari window for a profile: not made (\(error ?? "no answer"))")
            return false
        }
        safariWindows[p] = made.windowId
        note("Safari window \(made.windowId) made for hosting")
        return true
    }

    func closeSafariWindow(_ number: Int) async -> Bool {
        guard case .safariWindow(let profile)? = engine.target(ofWindow: number), let p = profile, let windowId = safariWindows[p] else { return false }
        safariWindows[p] = nil
        let (result, _) = await links.request(profile: p, "closeWindow", ["windowId": windowId])
        return result != nil
    }

    // What the engine says happened outside Margin: an app or its window gone, its items have no page any more.
    func hostEvent(_ event: HostEvent) {
        let gone: HostID
        switch event {
        case .quitByUser(let id), .windowClosed(let id), .closed(let id): gone = id
        default: return
        }
        let items = open.filter { $0.value.host == gone }.map(\.key)
        guard !items.isEmpty || safariWindows.keys.contains(where: { HostTarget.safariWindow($0).id == gone }) else { return }
        for item in items { open[item] = nil }
        for (w, i) in shown where items.contains(i) { shown[w] = nil }
        for p in safariWindows.keys where HostTarget.safariWindow(p).id == gone { safariWindows[p] = nil }
        if !engine.hasHosts { stopHosting() }
        onChange?()
    }

    // ---- the page area moved (the sidebar's width, another theme, another display) ----

    func pageRectChanged(_ window: HostedWindow, _ rect: CGRect?) {
        guard window.id == hostingWindow, let rect, engine.shown != nil else { return }
        enqueue {
            let placed = await self.engine.pageRectChanged(rect)
            self.note("page area changed: \(Int(rect.width))×\(Int(rect.height))\(placed ? "" : " (not fitted)")")
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
        guard var openTabs = snapshot["openTabs"] as? JSONObject, !open.isEmpty else { return snapshot }
        var kept = openTabs["keptTabs"] as? JSONObject ?? [:]
        var tabs: JSONObject = [:], tabSpace: JSONObject = [:]
        let windowId = hostingWindow ?? shown.keys.min() ?? 1
        var index = 0
        for item in open.keys.sorted() {
            guard let k = kept[item] as? JSONObject, let space = k["spaceId"] as? String else { continue }
            let n = number(ofItem: item)
            tabs[String(n)] = [
                "id": n, "windowId": windowId, "index": index, "title": k["title"] ?? "", "url": k["url"] ?? "", "favIconUrl": k["favIconUrl"] ?? "",
                "active": shown[windowId] == item, "lastActive": k["lastActive"] ?? 0, "mid": item, "order": k["order"] ?? 0,
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
