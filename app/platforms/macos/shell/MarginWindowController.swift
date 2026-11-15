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
//   sidebar shown or hidden, another theme). Nothing passes through the window
//   (it's opaque, and a hosted window is beside it, never behind it): with
//   nothing hosted, its page area is the theme's launcher (ui/host-app.ts).
// - Its `chrome`: where the theme draws the window's buttons (the traffic
//   lights go there) and its drag regions.
// - Hosting (HostedSession.swift, behind `MarginHosted`): while another app's window is shown beside it, the window
//   is in full screen and is only the first tile of its Space, the sidebar's (`setHosting`): its page says
//   `pageOutside` (the sidebar alone, docked, its width not dragged: ui/host-app.ts), and its placement is worked out
//   from the tiles (MarginWindowGeometry.hostedPageRect: the display less Margin's tile and the theme's other insets).
//   Its content's max width becomes the sidebar's tile (the page's left inset) only in `tile()`, which the engine
//   calls while Margin's window is alone in its Space, just before the hosted tile comes in: its size constraints
//   never change while the hosted tile is beside it (seen 2026-11-15: a sidebar drag changed them, and macOS took the
//   window out of full screen, leaving the hosted app alone in its own). A sidebar of another width (another theme)
//   is a new placement: the engine parks the one shown and brings it in again (HostEngine.pageRectChanged). Back to
//   the whole width when nothing is hosted.
// - MarginWindows: every such window, the menu bar's actions (to the key one),
//   and the source's changes passed to each.

import AppKit
import WebKit

// Where Margin's windows get their spaces (until the app owns them: the library phase's store, with the same
// two calls). `snapshot()`: the whole state, in the shape pages draw (types/margin.d.ts State, as
// shared/stored.ts fromStorage gives it); `perform`: a request of the UI's (its `send` type and payload, or a
// `perform` name and argument), the window's id in the payload as `windowId`, answered as the page's request is
// (`{ ok, result }` or `{ ok: false, error }`; nil: done, `{ ok: true, result: true }`); `onChange`: the snapshot changed.
protocol MarginWindowSource: AnyObject {
    func snapshot() -> JSONObject
    @discardableResult func perform(_ type: String, _ payload: JSONObject) -> JSONObject?
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
    // Hosting another app's window beside it (setHosting): the display the tiles divide (top left), and the page's
    // right inset as last measured with room for a page (in the sidebar's tile there's none to measure).
    private(set) var hosting = false
    private(set) var tiledWidth: CGFloat? // its content's max width as the sidebar's tile (tile(), as the hosted tile comes in)
    private(set) var hostDisplay: CGRect?
    private var hostingLayoutSaid: String? // the last layout logged while hosting (numbers only)
    private(set) var wideRight: Double?
    private var frameBeforeHosting: NSRect?

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

    // Where the pointer goes through to a window behind (PassThrough.swift): nowhere. The window is opaque and a hosted
    // window is beside it, never behind it; with nothing hosted, its page area is the theme's launcher.
    var slot: Slot? { nil }

    // The page area again (the layout, the window's frame or what's over the page changed).
    func updatePage() {
        let content = contentFrame
        let region = CatchRegion.of(frame: content, slot: slot)
        fill.region = region
        guard let layout else { return window.setPageRect(nil, radius: 0) }
        if hosting {
            // (Only published: its size constraints are tile()'s, never changed here while it may be a tile.)
            return window.setPageRect(hostedPlacement?.page, radius: CGFloat(layout.radius))
        }
        // (A layout from before a resize changes nothing: the page's next one, at the new size, does.)
        guard MarginWindowGeometry.measuredAt(layout, content.size) else { return }
        window.setPageRect(MarginWindowGeometry.pageRect(layout: layout, content: content), radius: CGFloat(layout.radius))
    }

    // ---- hosting another app's window beside it (HostedSession.swift) ----

    // On: its page draws the sidebar alone (docked), nothing passes through it, its page area from the tiles; it becomes
    // the sidebar's tile once the hosted tile comes in (`tile`: alone in its Space, a narrow window would stand in the
    // middle of it while an app starts). Off: the whole width again. The window must be in full screen (its own Space)
    // for the tiles; a test's window plays the window manager's part (its width set to the tile's, off every display).
    func setHosting(_ on: Bool) {
        guard on != hosting else { return }
        hosting = on
        tiledWidth = nil
        if on {
            frameBeforeHosting = window.frame
            hostDisplay = window.screen.map { MarginWindowGeometry.fullScreenArea($0) } ?? contentFrame
            Diagnostics.note("Margin's window \(id): hosting beside it: its tile is the sidebar's, the page area \(hostDisplay.map { "in \(Int($0.width))×\(Int($0.height))" } ?? "not known yet")")
        } else {
            window.contentMaxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            window.contentMinSize = MarginWindow.minimum
            window.minSize = MarginWindow.minimum
            if options.harness, let before = frameBeforeHosting { window.setFrame(before, display: false) }
            frameBeforeHosting = nil
            hostDisplay = nil
            Diagnostics.note("Margin's window \(id): hosting nothing: its whole width again")
        }
        push(#"{"type":"pageOutside","on":\#(on)}"#)
        updatePage()
    }

    // Where the hosted window goes while hosting: the page area beside the sidebar's tile (its width the page's left
    // inset now), the display's full-screen area, the tile's width. Only from a layout its page measured in full screen
    // with the sidebar alone (`pageOutside`): one from before is followed by that one. Nil until then.
    var hostedPlacement: HostPlacement? {
        guard hosting, isFullScreen, let layout, layout.outside, layout.mode == "fullscreen", let area = hostDisplay,
              let page = MarginWindowGeometry.hostedPageRect(display: area, layout: layout, right: wideRight) else { return nil }
        return HostPlacement(page: page, area: area, tileWidth: MarginWindowGeometry.tileWidth(layout))
    }

    // The sidebar's tile now: the host is moving its window's tile in beside this one, alone in its Space meanwhile
    // (the only moment its size constraints change while hosting). The window's content no wider than the page's left
    // inset: macOS lays the tile out that wide.
    func tile() {
        guard hosting, let layout else { return }
        let width = MarginWindowGeometry.tileWidth(layout)
        tiledWidth = width
        if window.contentMaxSize.width != width {
            window.contentMinSize = NSSize(width: min(width, MarginWindow.minimum.width), height: min(MarginWindow.minimum.height, 200))
            window.minSize = window.contentMinSize
            window.contentMaxSize = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        }
        // (A test's window: as the window manager would lay its tile out, off every display.)
        if options.harness, let display = hostDisplay, window.frame.width != width {
            window.setFrame(ScreenGeometry.appKitRect(CGRect(x: display.minX, y: display.minY, width: width, height: display.height)), display: false)
        }
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
        if !on, hosting { owner?.onLeftFullScreen?(self) } // (hosting needs its own Space: HostedSession.swift)
        push(#"{"type":"windows","list":"# + windowsJSON + "}")
        updatePage()
        placeButtons()
    }

    func toggleFullScreen() {
        guard !options.harness else { return fullScreenChanged(!isFullScreen) } // (a test's window never leaves its place)
        // macOS ignores the toggle for a window of an app that isn't active, or one not on the current Space (seen
        // 2026-11-15 when Margin was opened from behind another app's full screen): Margin forward and its window key
        // first, then the toggle a moment later.
        if !NSApp.isActive || !window.isKeyWindow || !window.isOnActiveSpace {
            NSApp.activate()
            window.makeKeyAndOrderFront(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.window.toggleFullScreen(nil) }
            return
        }
        window.toggleFullScreen(nil)
    }

    // For the log when it doesn't happen (numbers only).
    var fullScreenState: String {
        "active \(NSApp.isActive), key \(window.isKeyWindow), on the current Space \(window.isOnActiveSpace), visible \(window.isVisible), full screen \(isFullScreen)"
    }

    func windowDidResize(_ notification: Notification) { updatePage(); placeButtons() }
    func windowDidMove(_ notification: Notification) { updatePage() }
    func windowDidEnterFullScreen(_ notification: Notification) { fullScreenChanged(true) }
    // About to leave full screen while hosting: the one shown goes first, while its tile is still beside this one.
    func windowWillExitFullScreen(_ notification: Notification) { if hosting { owner?.onLeavingFullScreen?(self) } }
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

    @discardableResult func ask(_ type: String, _ payload: JSONObject) -> JSONObject? {
        var payload = payload
        if payload["windowId"] == nil { payload["windowId"] = id }
        asks.append(type)
        return owner?.source.perform(type, payload)
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
        json += #","apps":"# + owner.apps()
        json += #","pageOutside":"# + (hosting ? "true" : "false")
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
        return ask(type, payload) ?? ["ok": true, "result": true]
    }

    func pageSaid(_ op: String, _ body: JSONObject) {
        switch op {
        case "ready":
            guard !isReady else { return }
            isReady = true
            Diagnostics.note("Margin's window \(id): its page drawn")
            show()
            owner?.onReady?(self)
        case "layout":
            guard let geometry = body["geometry"] as? JSONObject, let layout = PageLayout(geometry: geometry) else { return }
            if hosting {
                let said = "\(layout.mode)\(layout.outside ? " (the sidebar alone)" : "") \(Int(layout.left))/\(Int(layout.top))/\(Int(layout.right))/\(Int(layout.bottom)) in \(Int(layout.width))×\(Int(layout.height))"
                if said != hostingLayoutSaid {
                    hostingLayoutSaid = said
                    Diagnostics.note("Margin's window \(id): hosting, its page measured \(said) (window \(Int(window.frame.width))×\(Int(window.frame.height)), full screen \(window.styleMask.contains(.fullScreen)))")
                }
            }
            self.layout = layout
            if MarginWindowGeometry.hasPage(layout) { wideRight = layout.right }
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
            guard pageWantsKeyboard, !options.harness else { return }
            // A field of Margin's wants the keys (the palette, ⌘T or the menu's New Tab): Margin and this window take
            // the keyboard, which a hosted app beside it may have had (seen 2026-11-15: the palette opened while the
            // hosted app kept the keys).
            if !NSApp.isActive || !window.isKeyWindow {
                NSApp.activate()
                window.makeKey()
            }
            if window.firstResponder !== webView { window.makeFirstResponder(webView) }
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
    var apps: () -> String = { "null" } // the installed apps (ShellApps.swift), null with none read
    // A window's page area changed (MarginWindow.pageRect: hosting's own, or the hole's); its page drawn.
    var onPageRect: ((MarginWindowController, CGRect?) -> Void)?
    var onReady: ((MarginWindowController) -> Void)?
    var onLeavingFullScreen: ((MarginWindowController) -> Void)? // about to leave full screen while hosting
    var onLeftFullScreen: ((MarginWindowController) -> Void)? // left full screen while hosting
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
        controller.window.onPageRectChange = { [weak self, weak controller] rect in
            guard let self, let controller else { return }
            self.onPageRect?(controller, rect)
        }
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

    // The installed apps changed: every window told (each page checks them: shared/apps.ts).
    func pushApps() {
        let json = apps()
        for c in controllers { c.push(#"{"type":"apps","apps":"# + json + "}") }
    }
}
