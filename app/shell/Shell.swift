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
//  - Each copy's windows are matched to the window server's
//    (WindowMatcher.swift). A window gets an overlay once its copy's state
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
//    browser is in front with an overlay on its front window.

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
        var bundleIds = ["safari": safariIdentifier, "chrome": "com.google.Chrome", "edge": "com.microsoft.edgemac"]
    }

    final class Link {
        let connection: LinkConnection
        let mirror = StateMirror()
        var assembler = ChunkAssembler()
        var theme: String? // the theme package's JSON (background/theme-package.js ThemeMessage)
        var themeId: String?
        var outbox = LayoutOutbox()
        var resyncTimer: Timer?
        init(_ connection: LinkConnection) { self.connection = connection }
    }

    let link: SocketLink
    private let windowSource: WindowSource
    private let apps: AppWatch
    let shortcuts: AppShortcuts
    private let pointer = PointerWatch()
    private let options: Options
    private lazy var pages = OverlayPages(root: options.root ?? OverlayPages.appRoot)

    private(set) var links: [String: Link] = [:]
    private(set) var overlays: [WindowKey: OverlayController] = [:]
    private(set) var matches: [WindowKey: Int] = [:]
    // A linked browser has been in front since the first link came up: the shell is at work.
    private(set) var started = false
    private(set) var tracks = 0
    private var pollTimer: Timer?
    private var burstUntil: TimeInterval = 0
    private var trackSoon = false
    private var lastPointerPush: [WindowKey: TimeInterval] = [:]
    private var pointerInside: Set<WindowKey> = []
    private var stopped = false

    init(link: SocketLink, windows: WindowSource, apps: AppWatch, hotKeys: HotKeyRegistrar, options: Options = Options()) {
        self.link = link
        self.windowSource = windows
        self.apps = apps
        self.shortcuts = AppShortcuts(registrar: hotKeys)
        self.options = options
        link.delegate = self
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
        apps.start()
        burst("linked: \(connection.key)")
    }

    func linkReceived(_ connection: LinkConnection, _ message: LinkMessage) {
        guard let entry = links[connection.key], entry.connection === connection else { return }
        switch message {
        case .snapshot, .delta, .windows:
            switch entry.mirror.apply(message) {
            case .applied:
                entry.resyncTimer?.invalidate()
                forward(message, of: entry)
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
        case .push(_, let windowId, let msg):
            let json = jsonString(["type": "push", "msg": msg]) ?? ""
            for overlay in overlays(of: entry) where windowId == nil || overlay.key.windowId == windowId { overlay.push(raw: json) }
        default:
            break
        }
    }

    func linkDown(_ connection: LinkConnection, _ why: String) {
        guard let entry = links[connection.key], entry.connection === connection else { return }
        entry.resyncTimer?.invalidate()
        links[connection.key] = nil
        for overlay in overlays(of: entry) {
            overlay.close()
            overlays[overlay.key] = nil
        }
        if links.isEmpty { started = false }
        burst("link down: \(connection.key)")
    }

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

        // Each browser's windows, matched.
        var next: [WindowKey: Int] = [:]
        var ext: [WindowKey: (ExtWindow, Link)] = [:]
        for (browser, pids) in byBrowser {
            let entries = links.values.filter { $0.connection.hello.browser == browser && $0.mirror.hasState }
            let windows = entries.flatMap { entry in ExtWindow.parse(entry.mirror.windows, link: entry.connection.key).map { ($0, entry) } }
            for (w, entry) in windows { ext[w.key] = (w, entry) }
            let matched = WindowMatcher.match(ext: windows.map(\.0), server: list, pids: pids, browserInFront: front.map(pids.contains) ?? false, previous: matches)
            next.merge(matched) { a, _ in a }
        }
        for key in next.keys where matches[key] != next[key] {
            Diagnostics.note("\(key) is window \(next[key]!)")
        }
        matches = next

        // The overlays: made when wanted, shown when they can be, closed when their window is gone.
        for (key, (w, entry)) in ext.sorted(by: { $0.key < $1.key }) {
            let wanted = (w.state == "fullscreen" || options.windowedToo) && entry.theme != nil
            guard wanted else {
                overlays[key]?.hide()
                continue
            }
            let overlay = overlays[key] ?? makeOverlay(key)
            guard let number = next[key], let server = byNumber[number], server.onScreen else {
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
        for (key, overlay) in overlays where ext[key] == nil {
            overlay.close()
            overlays[key] = nil
        }
        if overlays.values.contains(where: \.isShown) { pointer.start() } else { pointer.stop() }
        updateKeys(list: list, allPids: allPids)
        pointerMoved(PointerWatch.location, fromTrack: true)

        // The next read.
        let now = Diagnostics.now()
        let every = now < burstUntil ? options.burstPoll : (browserInFront ? options.restPoll : options.idlePoll)
        guard !links.isEmpty else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: every, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.track() }
        }
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
        let has = !list.isEmpty && frontOverlay(list: list) != nil
        shortcuts.set(active: ShortcutSet.active(frontPid: apps.frontPid, linkedPids: allPids, frontWindowHasOverlay: has))
    }

    // ---- the pointer ----

    private func pointerMoved(_ at: CGPoint, fromTrack: Bool = false) {
        let down = PointerWatch.buttonsDown
        let now = Diagnostics.now()
        for overlay in overlays.values where overlay.isShown {
            let ignore = PassThrough.decide(at, overlay.slot, buttonsDown: down, ignoring: overlay.ignoring)
            overlay.setIgnoring(ignore)
            // The page doesn't hear the pointer while it passes through: handed in (a hidden sidebar's reveal edge, peek's hiding).
            let frame = overlay.frameTopLeft
            if frame.contains(at) {
                pointerInside.insert(overlay.key)
                guard overlay.ignoring, !fromTrack, now - (lastPointerPush[overlay.key] ?? 0) >= options.pointerEvery else { continue }
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
        default:
            Diagnostics.note("\(overlay.key): \(name) isn't the app's yet")
        }
    }
}

extension OverlayController {
    // A message already JSON.
    func push(raw json: String) { pushJSON(json) }
}
