// Margin's own windows (MarginWindow.swift; docs/MARGIN-APP.md phase 2): each
// one the overlay's page (OverlayPages: the same UI, its configuration and
// bridge) in a MarginWindow, fed from a MarginWindowSource instead of a
// browser's copy. Behind `MarginHosted` (Shell.forApp); off, none is made.
//
// - The page's hello says `host: 'app-window'` (ui/host-app.ts appWindow): it
//   draws the whole app, in the window's mode (windowed or full screen, pushed
//   as its `windows` list as it changes), never as a layer over a browser.
// - Its state is the source's `snapshot()` (the State shape pages draw), pushed
//   again whenever the source says it changed; its requests (`send`) and what
//   only the app does (`perform`) go to the source, but for the window's own
//   full screen, done here.
// - Its `layout` (where `<m-page>` sits) and the window's frame make the page
//   area (MarginWindow.pageRect, top left, points), redone as the window moves,
//   resizes, enters or leaves full screen, and as the page measures again (the
//   sidebar shown or hidden, another theme). The window ignores the mouse only
//   while the pointer is over that area and not over what the theme draws there
//   (its `hits`), as an overlay does (PassThrough.swift, the same decision and
//   the same fill): the window behind, the hosted one, gets it there.
// - Its `chrome`: where the theme draws the window's buttons (the traffic
//   lights go there) and its drag regions.
// - MarginWindows: every such window, the menu bar's actions (to the key one),
//   and the source's changes passed to each.

import AppKit
import WebKit

// Where Margin's windows get their spaces (until the app owns them: the library phase's store, with the same
// two calls). `snapshot()`: the whole state, in the shape pages draw (types/margin.d.ts State, as
// shared/stored.ts fromStorage gives it); `perform`: a request of the UI's (its `send` type and payload, or a
// `perform` name and argument), the window's id in the payload as `windowId`; `onChange`: the snapshot changed.
protocol MarginWindowSource: AnyObject {
    func snapshot() -> JSONObject
    func perform(_ type: String, _ payload: JSONObject)
    var onChange: (() -> Void)? { get set }
}

final class MarginWindowController: NSObject, OverlayPageOwner, NSWindowDelegate, WKNavigationDelegate {
    struct Options {
        var harness = false
        var frame: CGRect? // top left; nil: centred on the main display (a test's: off every display)
        var pointerEvery: TimeInterval = 1.0 / 30 // the pointer handed to a page that wants it
        var showWithin: TimeInterval = 1.5 // shown by then even if its page hasn't said it's drawn
    }

    static let harnessFrame = CGRect(x: -20000, y: -20000, width: 1200, height: 800)

    let id: Int
    let window: MarginWindow
    let webView: OverlayWebView
    weak var owner: MarginWindows?
    private let pages: OverlayPages
    private let options: Options
    private let fill = CatchView(frame: .zero)

    private(set) var isReady = false
    private(set) var isShown = false
    private var asked = false // its page asked for its hello: pushes reach it
    private(set) var isFullScreen = false
    private(set) var layout: PageLayout?
    private(set) var hits: [CGRect] = []
    private(set) var captureAll = false
    private(set) var controls: CGRect?
    private(set) var ignoring = false
    private(set) var pointerWant = PointerWant.all
    private(set) var pageWantsKeyboard = false
    private var pointerInside = false
    private var lastPointerPush: TimeInterval = 0
    private var themeSent: String?
    // What was pushed into the page, the last 50 (the tests read it), and how many in all.
    private(set) var pushed: [String] = []
    private(set) var pushes = 0
    // The source's requests from this window (the tests read it).
    private(set) var asks: [String] = []

    init(id: Int, pages: OverlayPages, options: Options = Options()) {
        self.id = id
        self.pages = pages
        self.options = options
        let frame = options.harness ? (options.frame ?? Self.harnessFrame) : (options.frame ?? Self.centred())
        window = MarginWindow(frame: frame, harness: options.harness)
        webView = pages.makeWebView(size: frame.size)
        super.init()
        let content = NSView(frame: NSRect(origin: .zero, size: frame.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = .clear
        fill.frame = content.bounds
        fill.autoresizingMask = [.width, .height]
        content.addSubview(fill)
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        content.addSubview(webView)
        window.contentView = content
        window.delegate = self
        // Said, not left to the default (which passes the pointer through fully transparent pixels).
        window.ignoresMouseEvents = false
        window.acceptsMouseMovedEvents = true
        webView.navigationDelegate = self
        pages.bridge.register(webView, self)
    }

    // 1200 × 800 at most, inside the main display's visible part.
    static func centred() -> CGRect {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = CGSize(width: min(1200, visible.width - 40), height: min(800, visible.height - 40))
        let appKit = NSRect(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2, width: size.width, height: size.height)
        return ScreenGeometry.appKitRect(appKit)
    }

    // The page, loaded; the window shown once it's drawn (or `showWithin` after, whichever is first).
    // A test's window is ordered in off every display at once (its page draws there: MarginWindow refuses
    // a display), never made key.
    func load() {
        if options.harness { window.orderBack(nil) }
        pages.ready { [weak self] in self?.webView.load(URLRequest(url: OverlaySchemeHandler.page)) }
        guard !options.harness else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + options.showWithin) { [weak self] in self?.show() }
    }

    func show() {
        guard !options.harness, !isClosed else { return }
        if !isShown { Diagnostics.note("Margin's window \(id) shown\(isReady ? "" : " (its page not drawn yet)")") }
        isShown = true
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        placeButtons()
    }

    private(set) var isClosed = false
    // Its page let go of (the window closing, or closed by close()).
    func teardown() {
        guard !isClosed else { return }
        isClosed = true
        pages.bridge.unregister(webView)
        webView.navigationDelegate = nil
        webView.stopLoading()
        window.delegate = nil
    }

    func close() {
        teardown()
        window.close()
    }

    // ---- the page area ----

    // The content's frame, top left.
    var contentFrame: CGRect { MarginWindowGeometry.content(of: window.frame) }

    // Where the page area is, and what the theme draws over it, as the pass-through decides (PassThrough.swift).
    var slot: Slot? {
        guard let layout else { return nil }
        return PassThrough.slot(in: contentFrame, layout: layout, hits: hits, captureAll: captureAll)
    }

    // The page area again (the layout, the window's frame or what's over the page changed).
    func updatePage() {
        let content = contentFrame
        let region = CatchRegion.of(frame: content, slot: slot)
        fill.region = region
        guard let layout else { return window.setPageRect(nil, radius: 0) }
        // (A layout from before a resize changes nothing: the page's next one, at the new size, does.)
        guard MarginWindowGeometry.measuredAt(layout, content.size) else { return }
        window.setPageRect(MarginWindowGeometry.pageRect(layout: layout, content: content), radius: CGFloat(layout.radius))
    }

    // The window's buttons where the theme draws its window controls (AppKit's own place when it draws none).
    func placeButtons() {
        guard let controls, !isFullScreen,
              let close = window.standardWindowButton(.closeButton), let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton), let bar = close.superview else { return }
        let step = mini.frame.minX - close.frame.minX
        let origins = MarginWindowGeometry.buttonOrigins(controls: controls, button: close.frame.size, step: step > 0 ? step : 20)
        let height = window.frame.height
        for (button, origin) in zip([close, mini, zoom], origins) {
            // Top left in the content (the window) → the button's superview's own coordinates.
            let inWindow = NSRect(x: origin.x, y: height - origin.y - button.frame.height, width: button.frame.width, height: button.frame.height)
            let placed = bar.convert(inWindow, from: nil).origin
            if button.frame.origin != placed { button.setFrameOrigin(placed) }
        }
    }

    // ---- the pointer (Margin's mouse monitors, the window server's coordinates: top left) ----

    func pointerMoved(_ at: CGPoint, buttonsDown: Bool = PointerWatch.buttonsDown) {
        guard window.isVisible || options.harness else { return }
        setIgnoring(PassThrough.decide(at, slot, buttonsDown: buttonsDown, ignoring: ignoring))
        let content = contentFrame
        let local = CGPoint(x: at.x - content.minX, y: at.y - content.minY)
        if content.contains(at) {
            pointerInside = true
            let now = Diagnostics.now()
            guard pointerWant.wants(local, in: content.size), now - lastPointerPush >= options.pointerEvery else { return }
            lastPointerPush = now
            push(#"{"type":"pointer","x":\#(Double(local.x)),"y":\#(Double(local.y))}"#)
        } else if pointerInside {
            pointerInside = false
            push(#"{"type":"pointerLeft","x":\#(Double(local.x)),"y":\#(Double(local.y))}"#)
        }
    }

    // A press on the page area (the hosted window's) or outside: a field of Margin's lets go, the palette goes.
    func pressed(_ at: CGPoint) {
        guard pageWantsKeyboard, !contentFrame.contains(at) || PassThrough.pageGets(at, slot) else { return }
        push(#"{"type":"pressOutside"}"#)
    }

    func setIgnoring(_ on: Bool) {
        ignoring = on
        if window.ignoresMouseEvents != on { window.ignoresMouseEvents = on }
    }

    // ---- the window ----

    var mode: String { isFullScreen ? "fullscreen" : "windowed" }
    var windowsJSON: String {
        jsonString([["windowId": id, "id": id, "state": isFullScreen ? "fullscreen" : "normal", "focused": window.isKeyWindow]]) ?? "[]"
    }

    func fullScreenChanged(_ on: Bool) {
        guard on != isFullScreen else { return }
        isFullScreen = on
        Diagnostics.note("Margin's window \(id): \(on ? "in full screen (its own Space)" : "windowed")")
        push(#"{"type":"windows","list":"# + windowsJSON + "}")
        updatePage()
        placeButtons()
    }

    func toggleFullScreen() {
        guard !options.harness else { return fullScreenChanged(!isFullScreen) } // (a test's window never leaves its place)
        window.toggleFullScreen(nil)
    }

    func windowDidResize(_ notification: Notification) { updatePage(); placeButtons() }
    func windowDidMove(_ notification: Notification) { updatePage() }
    func windowDidEnterFullScreen(_ notification: Notification) { fullScreenChanged(true) }
    func windowDidExitFullScreen(_ notification: Notification) { fullScreenChanged(false) }
    func windowDidBecomeKey(_ notification: Notification) { owner?.becameKey(self); placeButtons() }
    func windowDidResignKey(_ notification: Notification) { placeButtons() }
    func windowWillClose(_ notification: Notification) { owner?.closed(self) }

    // ---- the menu's actions ----

    func run(_ action: MarginMenuAction) {
        switch action.effect {
        case .page(let json): push(json)
        case .source(let type): ask(type, [:])
        case .newWindow: _ = owner?.open()
        }
    }

    // ---- the page ----

    func push(_ json: String) {
        guard asked else { return } // its hello, when it asks, has this already
        pushes += 1
        pushed.append(json)
        if pushed.count > 50 { pushed.removeFirst(pushed.count - 50) }
        webView.callAsyncJavaScript("marginApp.receive(m)", arguments: ["m": json], in: nil, in: .page) { result in
            if case .failure(let error) = result { Diagnostics.warn("push into Margin's window failed: \(error.localizedDescription)") }
        }
    }

    // The source's state changed: drawn again; its theme too, if that changed.
    func stateChanged() {
        guard asked, let owner else { return }
        let state = jsonString(owner.source.snapshot()) ?? "null"
        push(#"{"type":"state","state":"# + state + #","windows":"# + windowsJSON + "}")
        if let theme = owner.theme(), theme != themeSent {
            themeSent = theme
            push(#"{"type":"theme","theme":"# + theme + "}")
        }
    }

    func ask(_ type: String, _ payload: JSONObject) {
        var payload = payload
        if payload["windowId"] == nil { payload["windowId"] = id }
        asks.append(type)
        owner?.source.perform(type, payload)
    }

    func pageHello() -> String {
        asked = true
        guard let owner else { return "null" }
        let head: JSONObject = [
            "windowId": id, "profile": "", "browser": owner.browser, "mode": mode, "host": "app-window",
            "platform": ["browser": owner.browser, "os": "mac", "app": true],
            "state": owner.source.snapshot(), "across": NSNull(), "cloudTabs": NSNull(), "held": [Any](),
        ]
        var json = String((jsonString(head) ?? "{}").dropLast())
        json += #","windows":"# + windowsJSON
        json += #","themes":"# + owner.themes()
        let theme = owner.theme()
        themeSent = theme
        json += #","theme":"# + (theme ?? "null") + "}"
        return json
    }

    func pageSend(type: String, payload: JSONObject) async throws -> JSONObject {
        // The window's own full screen (ui/actions.ts window.fullscreen's request), not the source's.
        if type == "toggleFullscreen" {
            toggleFullScreen()
            return ["ok": true, "result": true]
        }
        ask(type, payload)
        return ["ok": true, "result": true]
    }

    func pageSaid(_ op: String, _ body: JSONObject) {
        switch op {
        case "ready":
            guard !isReady else { return }
            isReady = true
            Diagnostics.note("Margin's window \(id): its page drawn")
            show()
        case "layout":
            guard let geometry = body["geometry"] as? JSONObject, let layout = PageLayout(geometry: geometry) else { return }
            self.layout = layout
            updatePage()
        case "hits":
            let rects = (body["rects"] as? [[Any]] ?? []).compactMap { Self.rect($0) }
            hits = Array(rects.prefix(64))
            captureAll = body["all"] as? Bool == true || rects.count > 64
            updatePage()
        case "chrome":
            controls = (body["controls"] as? [Any]).flatMap { Self.rect($0) }
            window.dragRegions = (body["drags"] as? [[Any]] ?? []).compactMap { Self.rect($0) }
            placeButtons()
        case "focus":
            pageWantsKeyboard = body["on"] as? Bool == true
            if pageWantsKeyboard, !options.harness, window.firstResponder !== webView { window.makeFirstResponder(webView) }
        case "pointerWant":
            pointerWant = PointerWant(body)
        case "perform":
            let name = body["name"] as? String ?? ""
            if name == "window.fullscreen" { return toggleFullScreen() }
            guard !name.isEmpty else { return }
            ask(name, body["arg"] as? JSONObject ?? [:])
        case "log":
            let text = "Margin's window \(id): \(body["text"] as? String ?? "")"
            if ["error", "warn"].contains(body["level"] as? String ?? "") { Diagnostics.warn(text) } else { Diagnostics.note(text) }
        default:
            break // (framed, shownSpace, switch covers: a browser overlay's)
        }
    }

    static func rect(_ r: [Any]) -> CGRect? {
        let n = r.compactMap(num)
        return n.count == 4 && n.allSatisfy(\.isFinite) && n[2] >= 0 && n[3] >= 0 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
    }

    // ---- navigation: only overlay.html ----

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        let ours = url?.scheme == OverlaySchemeHandler.scheme && url?.host == "app" && url?.path == OverlaySchemeHandler.page.path && action.targetFrame?.isMainFrame == true
        decisionHandler(ours ? .allow : .cancel)
    }

    // Its page's process died: loaded again (its state comes with the new hello).
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Diagnostics.warn("Margin's window \(id): its page stopped: loading it again")
        isReady = false
        asked = false
        pages.ready { [weak self] in self?.webView.load(URLRequest(url: OverlaySchemeHandler.page)) }
    }
}

// Every Margin window, and what the menu bar asks of them.
final class MarginWindows {
    struct Options {
        var harness = false
        var installsMenu = true
    }

    let pages: OverlayPages
    let source: MarginWindowSource
    let options: Options
    // The theme package the windows draw (JSON), nil for Arcadia; the imported themes' index (JSON).
    var theme: () -> String? = { nil }
    var themes: () -> String = { "[]" }
    var browser = "safari" // the engine hosted pages are in (Settings offers its features)
    private(set) var controllers: [MarginWindowController] = []
    private var lastKey: MarginWindowController?
    private var nextId = 1
    private let pointer = PointerWatch()
    let menuTarget = MarginMenuTarget()
    private(set) lazy var menu: NSMenu = MarginMenu.build(target: menuTarget)

    init(pages: OverlayPages, source: MarginWindowSource, options: Options = Options()) {
        self.pages = pages
        self.source = source
        self.options = options
        source.onChange = { [weak self] in self?.sourceChanged() }
        menuTarget.handle = { [weak self] action in self?.perform(action) }
        menuTarget.enabled = { [weak self] action in action == .newWindow || self?.front != nil }
        pointer.onMove = { [weak self] at in for c in self?.controllers ?? [] { c.pointerMoved(at) } }
        pointer.onPress = { [weak self] at in for c in self?.controllers ?? [] { c.pressed(at) } }
    }

    var anyVisible: Bool { controllers.contains { $0.window.isVisible } }

    // The key one, else the one key last, else the newest.
    var front: MarginWindowController? {
        controllers.first { $0.window.isKeyWindow } ?? lastKey.flatMap { k in controllers.first { $0 === k } } ?? controllers.last
    }

    // Margin's menu bar (not in a test: its app's menu stays the test's).
    func installMenu() {
        guard options.installsMenu, !options.harness else { return }
        NSApp.mainMenu = menu
        NSApp.windowsMenu = menu.items.first { $0.submenu?.identifier?.rawValue == "margin.window-menu" }?.submenu
    }

    @discardableResult
    func open(_ windowOptions: MarginWindowController.Options? = nil) -> MarginWindowController {
        var o = windowOptions ?? MarginWindowController.Options()
        o.harness = o.harness || options.harness
        let controller = MarginWindowController(id: nextId, pages: pages, options: o)
        nextId += 1
        controller.owner = self
        controllers.append(controller)
        if !options.harness { pointer.start() }
        Diagnostics.note("Margin's window \(controller.id) opened (\(controllers.count) open)")
        controller.load()
        return controller
    }

    // Margin opened again (its Dock icon, opened by hand): the window in front shown, or a new one.
    func reopen() {
        if let front { front.show() } else { open() }
    }

    func perform(_ action: MarginMenuAction) {
        if action == .newWindow { open(); return }
        front?.run(action)
    }

    func becameKey(_ controller: MarginWindowController) { lastKey = controller }

    func closed(_ controller: MarginWindowController) {
        controllers.removeAll { $0 === controller }
        if lastKey === controller { lastKey = nil }
        controller.teardown() // (closing already)
        if controllers.isEmpty { pointer.stop() }
        Diagnostics.note("Margin's window \(controller.id) closed (\(controllers.count) open)")
    }

    func closeAll() {
        for c in controllers { c.close() }
        controllers = []
        lastKey = nil
        pointer.stop()
    }

    private func sourceChanged() {
        for c in controllers { c.stateChanged() }
    }
}
