// Margin.app's shell as a whole (PLAN.md §6): what AppDelegate starts and
// stops. It joins the links to Margin's extension copies (ExtensionLink.swift,
// one per browser profile) and each copy's state (StateMirror.swift) to what
// the window server says (WindowServer.swift), and keeps one overlay
// (Overlay.swift) over each of the browser's windows Margin draws around:
//
//  - Nothing happens until a linked browser has come to the front. From then
//    on, the window server's list is read a few times a second (4 while the
//    browser is in front, 1 otherwise), and 30 times a second for a moment
//    after anything that moves windows (an app activated, the Space or the
//    displays changed, a press, a window list from the extension).
//  - Each copy's windows are bound to the window server's, from evidence,
//    never on a guess (WindowMatcher.swift WindowBinder): a window not bound
//    yet gets nothing drawn over it. A window gets an overlay once its copy's state
//    and theme are here; the overlay shows (just above the window, at its
//    bounds) once its page has drawn, while the window is on screen and in
//    full screen (windowed mode is Phase 4: `windowedToo`), and is put back
//    above the window whenever something comes between them.
//  - Each overlay's page draws the theme around the page slot and reports
//    where the slot is (`layout`): sent to the copy as `setLayout` for that
//    window when it changes (LayoutOutbox), and used, with what the theme
//    draws over the slot (`hits`), to let the pointer through to the page
//    (PassThrough.swift).
//  - Margin's keys (Shortcuts.swift) are the app's only while a linked
//    browser is in front with an overlay on its front window, with the
//    combinations that window's copy sent (`keys`: its Settings shortcuts).
//  - A link that drops (not one replaced by a newer link, not a goodbye)
//    leaves its overlays where they are for `reconnectGrace`, dimmed and
//    saying it's reconnecting; the copy linking again in that time takes
//    them back as they are, else they close. The copy's pages go back to
//    drawing their own UI on the same clock (background/link.js GONE_MS).

import AppKit

// What's been sent of each window's layout: only a change goes again, numbered per window.
struct LayoutOutbox {
    private var sent: [Int: PageLayout] = [:]
    private var seq: [Int: Int] = [:]

    // The next number and the layout to send, or nil if it's what was sent last (to half a point).
    mutating func offer(windowId: Int, _ layout: PageLayout) -> (seq: Int, layout: PageLayout)? {
        let rounded = layout.rounded
        guard sent[windowId] != rounded else { return nil }
        sent[windowId] = rounded
        let next = (seq[windowId] ?? 0) + 1
        seq[windowId] = next
        return (next, rounded)
    }

    mutating func forget(windowId: Int) { sent[windowId] = nil }
    mutating func reset() { sent = [:]; seq = [:] }
}

// What a copy pushed for a window that an overlay made later still needs
// (app/PROTOCOL.md "Notices, loading and gestures"): its last notice, for
// NOTICE_FOR, and its last set of tabs loading, given to each overlay's page
// with its hello (`held`). A push reaches only the overlays already there,
// and a copy says a notice as it decides it: often as it links, before the
// app has bound the window or drawn its overlay.
struct HeldPushes {
    static let types: Set<String> = ["notice", "loading"]
    static let noticeFor: TimeInterval = 60
    private var held: [Int: [String: (msg: JSONObject, at: Date)]] = [:] // window (-1: every window) → type → the last push

    mutating func offer(windowId: Int?, _ msg: JSONObject, at: Date = Date()) {
        guard let type = msg["type"] as? String, Self.types.contains(type) else { return }
        held[windowId ?? -1, default: [:]][type] = (msg, at)
    }

    // A window's, oldest first: every window's and its own; a notice only while it's recent.
    func messages(for windowId: Int, at now: Date = Date()) -> [JSONObject] {
        let entries = [-1, windowId].flatMap { (held[$0] ?? [:]).map { (type: $0.key, msg: $0.value.msg, at: $0.value.at) } }
        return entries.filter { $0.type != "notice" || now.timeIntervalSince($0.at) <= Self.noticeFor }.sorted { $0.at < $1.at }.map(\.msg)
    }

    mutating func forget(windowId: Int) { held[windowId] = nil }
}

final class Shell: ExtensionLinkDelegate, OverlayDelegate {
    struct Options {
        var harness = false
        var root: URL? // the overlay's page folder (dist/app); default: the app's Resources/app
        var overlay = OverlayController.Options()
        var restPoll: TimeInterval = 0.25 // a linked browser in front
        var idlePoll: TimeInterval = 1 // not in front
        var burstPoll: TimeInterval = 1.0 / 30
        var burstFor: TimeInterval = 1
        var resyncRetry: TimeInterval = 2
        var pointerEvery: TimeInterval = 1.0 / 30 // the pointer handed to a page passing it through
        var windowedToo = false
        // The lasting data's folder (DataStore.swift). Default: ~/Library/Application Support/Margin/data,
        // or a new temporary folder for a harness (a test never touches the real one).
        var dataRoot: URL?
        var reconnectGrace: TimeInterval = 6 // a dropped link's overlays, kept dimmed (background/link.js GONE_MS)
        var bundleIds = ["safari": safariIdentifier, "chrome": "com.google.Chrome", "edge": "com.microsoft.edgemac"]
        var profileSwitch = ProfileSwitch.Options() // switching to another profile's space (ProfileSwitch.swift)
        var switchClock: SwitchClock = RunLoopClock()
        // Seconds since 1970, the clock the extension's focusedAt and createdAt use (tests set it).
        var clock: () -> Double = { Date().timeIntervalSince1970 }
    }

    final class Link {
        let connection: LinkConnection
        let mirror = StateMirror()
        var assembler = ChunkAssembler()
        var theme: String? // the theme package's JSON (background/theme-package.js ThemeMessage)
        var themeId: String?
        var outbox = LayoutOutbox()
        var resyncTimer: Timer?
        var keys: [String: [String]]? // the copy's shortcuts, once it said
        var held = HeldPushes() // what an overlay made later is given with its hello
        init(_ connection: LinkConnection) { self.connection = connection }
    }

    let link: SocketLink
    // The lasting data, one set per browser profile (DataSync.swift: the read API is there).
    let data: DataSync
    let windowSource: WindowSource
    let apps: AppWatch
    let shortcuts: AppShortcuts
    private let pointer = PointerWatch()
    let options: Options
    private lazy var pages = OverlayPages(root: options.root ?? OverlayPages.appRoot)

    private(set) var links: [String: Link] = [:]
    private(set) var overlays: [WindowKey: OverlayController] = [:]
    private(set) var matches: [WindowKey: Int] = [:]
    // Each browser's window bindings (WindowMatcher.swift).
    private(set) var binders: [String: WindowBinder] = [:]
    // A linked browser has been in front since the first link came up: the shell is at work.
    private(set) var started = false
    private(set) var tracks = 0
    private var pollTimer: Timer?
    private var burstUntil: TimeInterval = 0
    private var trackSoon = false
    private var lastPointerPush: [WindowKey: TimeInterval] = [:]
    private var pointerInside: Set<WindowKey> = []
    private var stopped = false
    // Links that dropped a moment ago: their overlays kept, dimmed, until this timer.
    private var reconnecting: [String: Timer] = [:]
    // Their theme and keys meanwhile: the overlays stay drawn as the link comes back, not hidden until the theme is sent again.
    private var keptForReconnect: [String: (theme: String?, themeId: String?, keys: [String: [String]]?)] = [:]

    // ---- spaces across profiles (ShellProfiles.swift) ----
    var browserProfiles: [String: BrowserProfiles] = [:]
    lazy var switcher = ProfileSwitch(world: self, clock: options.switchClock, options: options.profileSwitch)
    var acrossSent: [WindowKey: String] = [:]
    var acrossQueued = false
    var spaceAim: [WindowKey: (key: SpaceKey, at: Double)] = [:] // the next/previous keys, chained
    var switchNotice: JSONObject?

    init(link: SocketLink, windows: WindowSource, apps: AppWatch, hotKeys: HotKeyRegistrar, options: Options = Options()) {
        self.link = link
        self.windowSource = windows
        self.apps = apps
        self.shortcuts = AppShortcuts(registrar: hotKeys)
        self.options = options
        let dataRoot = options.dataRoot
            ?? (options.harness ? FileManager.default.temporaryDirectory.appendingPathComponent("margin-harness-\(UUID().uuidString)", isDirectory: true) : DataStore.appRoot)
        data = DataSync(store: DataStore(root: dataRoot))
        link.delegate = self
        data.onChange = { [weak self] _, collections in
            if collections.contains("spaces") || collections.contains("tabs") { self?.acrossSoon() }
        }
        apps.onChange = { [weak self] why in self?.burst(why) }
        shortcuts.onCommand = { [weak self] command in self?.run(command) }
        pointer.onMove = { [weak self] at in self?.pointerMoved(at) }
        pointer.onPress = { [weak self] at in self?.pressed(at) }
    }

    // The app's own: Safari through the window server and NSWorkspace, Carbon's hot keys.
    static func forApp() -> Shell {
        Shell(link: SocketLink(), windows: CGWindowSource(), apps: WorkspaceApps(), hotKeys: CarbonHotKeys())
    }

    func start() {
        stopped = false
        link.start()
    }

    func stop(then: @escaping () -> Void) {
        stopped = true
        pollTimer?.invalidate()
        for timer in reconnecting.values { timer.invalidate() }
        reconnecting = [:]
        shortcuts.set(active: false)
        pointer.stop()
        apps.stop()
        for overlay in overlays.values { overlay.close() }
        overlays = [:]
        link.stop(why: "Margin.app quit", then: then)
    }

    // ---- links ----

    func linkUp(_ connection: LinkConnection) {
        let entry = Link(connection)
        entry.mirror.begin(connection.hello)
        links[connection.key] = entry
        data.linkUp(connection)
        if let timer = reconnecting.removeValue(forKey: connection.key) {
            timer.invalidate()
            if let kept = keptForReconnect.removeValue(forKey: connection.key) { (entry.theme, entry.themeId, entry.keys) = kept }
            Diagnostics.note("\(connection.key) is back: its overlays kept")
            for overlay in overlays.values where overlay.key.link == connection.key { overlay.push(raw: #"{"type":"link","state":"linked"}"#) }
        }
        apps.start()
        burst("linked: \(connection.key)")
        acrossSoon()
        switcher.tick()
    }

    func linkReceived(_ connection: LinkConnection, _ message: LinkMessage) {
        guard let entry = links[connection.key], entry.connection === connection else { return }
        switch message {
        case .snapshot, .delta, .windows:
            switch entry.mirror.apply(message) {
            case .applied:
                entry.resyncTimer?.invalidate()
                forward(message, of: entry)
                if case .windows = message { switcher.tick() }
                if case .snapshot = message { acrossSoon() }
                if case .delta(_, _, let changes, _) = message, changes["spaces"] != nil { acrossSoon() }
            case .gap(let expected, let got):
                Diagnostics.warn("\(connection.key): number \(got) came, \(expected) was next: the state asked for again")
                resync(entry)
            case .ignored:
                break
            }
        case .theme(let epoch, let chunk):
            guard epoch == connection.epoch else { return }
            switch entry.assembler.add(chunk) {
            case .complete(let id, let data):
                guard let object = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject, object["id"] as? String == id,
                      object["manifest"] is String, object["html"] is String, object["css"] is String, let text = String(data: data, encoding: .utf8) else {
                    return Diagnostics.warn("\(connection.key): the theme \(id) isn't a theme package: left")
                }
                entry.theme = text
                entry.themeId = id
                Diagnostics.note("\(connection.key): theme \(id) here (\(data.count) bytes)")
                for overlay in overlays(of: entry) { overlay.push(raw: #"{"type":"theme","theme":"# + text + "}") }
                burst("theme")
            case .refused(let why):
                Diagnostics.warn("\(connection.key): a theme refused: \(why)")
            case .waiting:
                break
            }
        case .data(let kind, let body):
            data.received(connection, kind, body)
        case .push(_, let windowId, let msg):
            entry.held.offer(windowId: windowId, msg)
            let json = jsonString(["type": "push", "msg": msg]) ?? ""
            for overlay in overlays(of: entry) where windowId == nil || overlay.key.windowId == windowId { overlay.push(raw: json) }
        case .keys(let epoch, let bindings):
            guard epoch == connection.epoch else { return }
            entry.keys = bindings
            burst("keys")
        default:
            break
        }
    }

    func linkDown(_ connection: LinkConnection, _ why: String) {
        guard let entry = links[connection.key], entry.connection === connection else { return }
        entry.resyncTimer?.invalidate()
        links[connection.key] = nil
        data.linkDown(connection)
        let shown = overlays(of: entry)
        // Dropped (not replaced, not a goodbye, not quitting): kept, dimmed, for a while.
        if why != "replaced", !why.hasPrefix("stopped"), !why.hasPrefix("bye"), options.reconnectGrace > 0, !shown.isEmpty {
            for overlay in shown { overlay.push(raw: #"{"type":"link","state":"reconnecting"}"#) }
            reconnecting[connection.key]?.invalidate()
            let key = connection.key
            keptForReconnect[key] = (entry.theme, entry.themeId, entry.keys)
            reconnecting[key] = Timer.scheduledTimer(withTimeInterval: options.reconnectGrace, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.reconnectGaveUp(key) }
            }
            Diagnostics.note("\(key) dropped (\(why)): its overlays kept, dimmed, for \(Int(options.reconnectGrace)) s")
        } else {
            for overlay in shown {
                overlay.close()
                overlays[overlay.key] = nil
            }
        }
        if links.isEmpty { started = false }
        burst("link down: \(connection.key)")
        acrossSoon()
        switcher.tick()
    }

    // A profile's Margin tabs that aren't open: all of them for a profile not
    // linked, else those no open tab of its copy's state carries (openTabs.tabs[*].mid).
    func notOpenTabs(_ p: DataProfile, space: String? = nil) -> [(id: String, value: JSONObject)] {
        let open: Set<String>
        if let entry = links[p.key], entry.mirror.hasState, let records = (entry.mirror.value("openTabs") as? JSONObject)?["tabs"] as? JSONObject {
            open = Set(records.values.compactMap { ($0 as? JSONObject)?["mid"] as? String })
        } else {
            open = []
        }
        return data.marginTabs(of: p, space: space).filter { !open.contains($0.id) }
    }

    // The copy didn't come back in time: its overlays go.
    private func reconnectGaveUp(_ key: String) {
        reconnecting[key] = nil
        keptForReconnect[key] = nil
        guard links[key] == nil else { return }
        for overlay in overlays.values where overlay.key.link == key {
            overlay.close()
            overlays[overlay.key] = nil
        }
        Diagnostics.note("\(key) didn't come back: its overlays closed")
        burst("gave up on \(key)")
    }

    // Whether a link's overlays are kept for it to come back (tests read it).
    func isReconnecting(_ key: String) -> Bool { reconnecting[key] != nil }

    private func resync(_ entry: Link) {
        entry.connection.send(.resync(epoch: entry.connection.epoch))
        entry.resyncTimer?.invalidate()
        entry.resyncTimer = Timer.scheduledTimer(withTimeInterval: options.resyncRetry, repeats: false) { [weak self, weak entry] _ in
            MainActor.assumeIsolated {
                guard let self, let entry, entry.mirror.isResyncing, self.links[entry.connection.key] === entry else { return }
                self.resync(entry)
            }
        }
    }

    // What came, to each of the copy's overlays (each page keeps its own copy of the state).
    private func forward(_ message: LinkMessage, of entry: Link) {
        let shown = overlays(of: entry)
        switch message {
        case .snapshot:
            guard let state = entry.mirror.stateJSON() else { return }
            let json = #"{"type":"state","state":"# + String(decoding: state, as: UTF8.self) + #","windows":"# + (jsonString(entry.mirror.windows) ?? "[]") + "}"
            for overlay in shown { overlay.push(raw: json) }
            burst("snapshot")
        case .delta(_, _, let changes, let favicons):
            var out: JSONObject = [:]
            for (key, change) in changes {
                switch change {
                case .set(let value): out[key] = ["newValue": value]
                case .removed: out[key] = [String: Any]()
                }
            }
            var message: JSONObject = ["type": "changes", "changes": out]
            if let favicons { message["favicons"] = ["set": favicons.set, "del": favicons.del] }
            guard let json = jsonString(message) else { return }
            for overlay in shown { overlay.push(raw: json) }
        case .windows(_, _, let list):
            let json = jsonString(["type": "windows", "list": list]) ?? ""
            for overlay in shown { overlay.push(raw: json) }
            burst("windows")
        default:
            break
        }
    }

    private func overlays(of entry: Link) -> [OverlayController] {
        overlays.values.filter { $0.key.link == entry.connection.key }.sorted { $0.key < $1.key }
    }

    // ---- following the windows ----

    // Read the window server often for a while (something is moving).
    func burst(_ why: String) {
        burstUntil = Diagnostics.now() + options.burstFor
        soon()
    }

    // A read on the next turn of the run loop (several reasons at once: one read).
    private func soon() {
        guard !trackSoon, !stopped else { return }
        trackSoon = true
        DispatchQueue.main.async { MainActor.assumeIsolated {
            self.trackSoon = false
            self.track()
        } }
    }

    private func linkedPids() -> [String: Set<pid_t>] {
        var out: [String: Set<pid_t>] = [:]
        for entry in links.values {
            let browser = entry.connection.hello.browser
            var pids = options.bundleIds[browser].map { apps.pids(of: $0) } ?? []
            if let pid = entry.connection.hello.pid { pids.insert(pid_t(pid)) }
            out[browser, default: []].formUnion(pids)
        }
        return out
    }

    // One read of the window server, and everything that follows from it.
    func track() {
        pollTimer?.invalidate()
        pollTimer = nil
        guard !stopped else { return }
        let byBrowser = linkedPids()
        let allPids = byBrowser.values.reduce(into: Set<pid_t>()) { $0.formUnion($1) }
        let front = apps.frontPid
        let browserInFront = front.map(allPids.contains) ?? false
        if !started {
            guard browserInFront else { return updateKeys(list: [], allPids: allPids) } // nothing until a linked browser is in front
            started = true
            Diagnostics.note("a linked browser is in front: following its windows")
        }
        tracks += 1
        var own = allPids
        own.insert(ProcessInfo.processInfo.processIdentifier)
        let list = windowSource.windows(of: own)
        let byNumber = Dictionary(list.map { ($0.number, $0) }, uniquingKeysWith: { a, _ in a })

        // Each browser's windows, bound (WindowBinder: it logs every binding made, moved or dropped, and why).
        var next: [WindowKey: Int] = [:]
        var ext: [WindowKey: (ExtWindow, Link)] = [:]
        let wallNow = options.clock()
        for (browser, pids) in byBrowser {
            let all = links.values.filter { $0.connection.hello.browser == browser }
            let entries = all.filter { $0.mirror.hasState }
            let windows = entries.flatMap { entry in ExtWindow.parse(entry.mirror.windows, link: entry.connection.key).map { ($0, entry) } }
            for (w, entry) in windows { ext[w.key] = (w, entry) }
            // Kept as they are: a link without its state yet, one that dropped a moment ago.
            let held = Set(all.filter { !$0.mirror.hasState }.map(\.connection.key)).union(reconnecting.keys.filter { $0.hasPrefix(browser + ":") })
            var copies: [String: String] = [:]
            for entry in entries { copies[entry.connection.key] = entry.connection.hello.instanceId ?? entry.connection.hello.since.map { "\($0)" } ?? entry.connection.epoch }
            let binder = binders[browser] ?? WindowBinder(browser: browser)
            binders[browser] = binder
            let bound = binder.update(now: wallNow, ext: windows.map(\.0), reporting: Set(entries.map(\.connection.key)), copies: copies, held: held,
                                      server: list, pids: pids, browserInFront: front.map(pids.contains) ?? false)
            next.merge(bound) { a, _ in a }
        }
        matches = next

        // The overlays: made when wanted, shown when they can be, closed when their window is gone.
        for (key, (w, entry)) in ext.sorted(by: { $0.key < $1.key }) {
            let wanted = (w.state == "fullscreen" || options.windowedToo) && entry.theme != nil
            // The window a profile switch is making: its overlay's page loads while it goes full screen.
            let early = !wanted && entry.theme != nil && switcher.busy && switcher.target?.profile == key.link && switcher.newWindow == key.windowId
            guard wanted || early else {
                overlays[key]?.hide()
                continue
            }
            let overlay = overlays[key] ?? makeOverlay(key)
            guard wanted, let number = next[key], let server = byNumber[number], server.onScreen else {
                overlay.hide()
                continue
            }
            overlay.browserPid = server.pid
            let wasShown = overlay.isShown && overlay.aboveWindow == number
            overlay.size(to: server.bounds)
            if overlay.show(over: number, frame: server.bounds), wasShown,
               !WindowMatcher.stackedAbove(list, overlay: overlay.windowNumber, browser: number) {
                overlay.reorder()
            }
            if let layout = overlay.layout { layoutChanged(overlay, layout) }
        }
        // (Not a link's that dropped a moment ago, nor one back but without its state yet: kept as they are.)
        for (key, overlay) in overlays where ext[key] == nil && reconnecting[key.link] == nil && links[key.link]?.mirror.hasState != false {
            overlay.close()
            overlays[key] = nil
        }
        if overlays.values.contains(where: \.isShown) { pointer.start() } else { pointer.stop() }
        updateKeys(list: list, allPids: allPids)
        pointerMoved(PointerWatch.location, fromTrack: true)
        if switcher.busy { switcher.tick() }

        // The next read.
        let now = Diagnostics.now()
        let every = now < burstUntil ? options.burstPoll : (browserInFront ? options.restPoll : options.idlePoll)
        guard !links.isEmpty else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: every, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
    }

    // A window the app's own request made (the profile switch's openSpaceWindow, asked at `asked`):
    // its binder binds it to the one new window the window server lists from then (WindowMatcher.swift).
    func windowMade(_ link: String, windowId: Int, asked: Double) {
        guard let browser = links[link]?.connection.hello.browser else { return }
        let binder = binders[browser] ?? WindowBinder(browser: browser)
        binders[browser] = binder
        binder.expect(WindowKey(link: link, windowId: windowId), since: asked, now: options.clock(), why: "made by Margin's openSpaceWindow")
        burst("window made")
    }

    private func makeOverlay(_ key: WindowKey) -> OverlayController {
        let overlay = OverlayController(pages: pages, key: key, options: options.overlay)
        overlay.delegate = self
        overlays[key] = overlay
        overlay.load()
        Diagnostics.note("overlay made for \(key)")
        return overlay
    }

    // The overlay over the front app's frontmost window, if it's a linked browser's.
    func frontOverlay(list: [ServerWindow]? = nil) -> OverlayController? {
        guard let front = apps.frontPid else { return nil }
        let windows = list ?? windowSource.windows(of: [front])
        guard let top = WindowMatcher.candidates(windows, pids: [front]).filter(\.onScreen).min(by: { $0.order < $1.order }) else { return nil }
        return overlays.values.first { $0.isShown && $0.aboveWindow == top.number }
    }

    private func updateKeys(list: [ServerWindow], allPids: Set<pid_t>) {
        let front = list.isEmpty ? nil : frontOverlay(list: list)
        let has = front != nil
        // The front window's copy's combinations (each profile's Settings may differ).
        if let front, let keys = links[front.key.link]?.keys { shortcuts.rebind(ShortcutSet.bindings(from: keys)) }
        shortcuts.set(active: ShortcutSet.active(frontPid: apps.frontPid, linkedPids: allPids, frontWindowHasOverlay: has))
    }

    // ---- the pointer ----

    private func pointerMoved(_ at: CGPoint, fromTrack: Bool = false) {
        let down = PointerWatch.buttonsDown
        let now = Diagnostics.now()
        for overlay in overlays.values where overlay.isShown {
            let ignore = PassThrough.decide(at, overlay.slot, buttonsDown: down, ignoring: overlay.ignoring)
            overlay.setIgnoring(ignore)
            // Handed in wherever it is over the overlay: while it passes through, the
            // overlay's page doesn't hear it; elsewhere it may not either, since
            // Margin.app is never the active app and its web view may hear only
            // clicks (a hidden sidebar's reveal edge, keeping a peeked sidebar out).
            let frame = overlay.frameTopLeft
            if frame.contains(at) {
                pointerInside.insert(overlay.key)
                guard !fromTrack, now - (lastPointerPush[overlay.key] ?? 0) >= options.pointerEvery else { continue }
                lastPointerPush[overlay.key] = now
                overlay.push(raw: #"{"type":"pointer","x":\#(Double(at.x - frame.minX)),"y":\#(Double(at.y - frame.minY))}"#)
            } else if pointerInside.remove(overlay.key) != nil {
                overlay.push(raw: #"{"type":"pointerLeft","x":\#(Double(at.x - frame.minX)),"y":\#(Double(at.y - frame.minY))}"#)
            }
        }
    }

    // A press anywhere: the browser may have been raised above an overlay; a press on the page
    // (or another app) takes the keyboard back from an overlay that had it.
    func pressed(_ at: CGPoint) {
        for overlay in overlays.values where overlay.hasKeyboard && (!overlay.frameTopLeft.contains(at) || PassThrough.pageGets(at, overlay.slot)) {
            overlay.push(raw: #"{"type":"pressOutside"}"#)
            overlay.handBack()
        }
        burst("press")
    }

    // ---- the keys ----

    func run(_ command: AppCommand) {
        guard let overlay = frontOverlay(), let entry = links[overlay.key.link] else { return }
        switch command {
        case .palette:
            overlay.push(raw: #"{"type":"command","name":"palette"}"#)
        case .toggleSidebar:
            overlay.push(raw: #"{"type":"command","name":"toggle-sidebar"}"#)
        case .nextSpace where spaceKey(overlay, 1), .prevSpace where spaceKey(overlay, -1):
            return // across profiles (ShellProfiles.swift)
        case .nextTab, .prevTab, .nextSpace, .prevSpace:
            let windowId = overlay.key.windowId
            Task { _ = try? await entry.connection.request(type: "navigate", payload: ["action": command.rawValue, "windowId": windowId], windowId: windowId) }
        }
    }

    // ---- the overlays' pages ----

    func hello(for overlay: OverlayController) -> String {
        guard let entry = links[overlay.key.link] else { return "null" }
        let hello = entry.connection.hello
        let window = ExtWindow.parse(entry.mirror.windows, link: entry.connection.key).first { $0.key == overlay.key }
        let head: JSONObject = [
            "windowId": overlay.key.windowId, "profile": hello.profile, "browser": hello.browser,
            "mode": window?.state == "fullscreen" ? "fullscreen" : "windowed",
            "platform": ["browser": hello.browser, "os": "mac", "app": true],
        ]
        var json = String((jsonString(head) ?? "{}").dropLast())
        json += #","state":"# + (entry.mirror.stateJSON().map { String(decoding: $0, as: UTF8.self) } ?? "null")
        json += #","windows":"# + (jsonString(entry.mirror.windows) ?? "[]")
        json += #","across":"# + (acrossJSON(for: overlay) ?? "null")
        json += #","held":"# + (jsonString(entry.held.messages(for: overlay.key.windowId)) ?? "[]")
        json += #","theme":"# + (entry.theme ?? "null") + "}"
        return json
    }

    func send(from overlay: OverlayController, type: String, payload: JSONObject) async throws -> JSONObject {
        guard let entry = links[overlay.key.link] else { throw LinkError.down }
        return try await entry.connection.request(type: type, payload: payload, windowId: overlay.key.windowId)
    }

    // Only a layout measured at the window's own size goes (one from before the overlay
    // was sized to it, or mid-resize, is followed by the right one).
    func layoutChanged(_ overlay: OverlayController, _ layout: PageLayout) {
        let size = overlay.frameTopLeft.size
        guard abs(layout.width - size.width) < 1, abs(layout.height - size.height) < 1 else { return }
        guard let entry = links[overlay.key.link], let (seq, rounded) = entry.outbox.offer(windowId: overlay.key.windowId, layout) else { return }
        entry.connection.send(.setLayout(epoch: entry.connection.epoch, windowId: overlay.key.windowId, seq: seq, layout: rounded))
    }

    func overlayChanged(_ overlay: OverlayController, _ why: String) {
        if why == "hits" || why == "layout" { return pointerMoved(PointerWatch.location, fromTrack: true) }
        soon()
    }

    func perform(from overlay: OverlayController, _ name: String, _ arg: Any?) {
        guard let entry = links[overlay.key.link] else { return }
        switch name {
        case "window.fullscreen":
            Task { _ = try? await entry.connection.request(type: "toggleFullscreen", payload: ["windowId": overlay.key.windowId], windowId: overlay.key.windowId) }
        case _ where name.hasPrefix("profile.") || name == "space.move":
            performAcross(from: overlay, name, arg as? JSONObject ?? [:])
        default:
            Diagnostics.note("\(overlay.key): \(name) isn't the app's yet")
        }
    }
}

extension OverlayController {
    // A message already JSON.
    func push(raw json: String) { pushJSON(json) }
}
