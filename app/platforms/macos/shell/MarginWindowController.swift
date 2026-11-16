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
//   (it's opaque, and a hosted window is above it, never behind it): with
//   nothing hosted, its page area is the theme's launcher (ui/host-app.ts).
// - Its `chrome`: where the theme draws the window's buttons (the traffic
//   lights go there) and its drag regions.
// - Always in full screen (decided by Tirth, 2026-11-15, `alwaysFullScreen`, on for every Margin window while
//   `MarginHosted` is: windowed Margin waits until it's built properly, Stage Manager being his daily setup): opened
//   (by hand, again, ⌘N) it's shown only once it's in full screen (made see-through, ordered in and taken to full
//   screen, then drawn: no windowed first frame); nothing of Margin's leaves full screen (no Enter/Exit Full Screen
//   item, ⌃⌘F and the page's own ask refused while it's full screen); if macOS takes it out anyway (the green button,
//   Mission Control), it goes straight back in, and the session hosts what it showed again (`onEnteredFullScreen`).
//   macOS ignores the toggle for a window of an app that isn't active (opened by a script, cooperative activation
//   refusing it: seen 2026-11-16), so while it isn't in, it's asked again as soon as Margin is active, the window key or
//   main, or first on screen: once per activation of Margin, logged (`FullScreenRetry`; no timer, no loop).
// - Hosting (HostedSession.swift, behind `MarginHosted`): the window keeps its whole width in its own full-screen Space
//   (never a tile, its size constraints never changed); its page draws its own layout with the sidebar docked and no
//   launcher in the page area (`pageHosted`, ui/host-app.ts: the theme's frame around the page area, no field there
//   to take the keys from the app above it), and the page area from that layout is the hosted window's placement.
//   The hosted window is a member of its Space above it, so whenever this window comes to the front (Margin
//   activated, a click in the sidebar, shown) it's ordered right below that window again (`keepBelow`), except while a
//   field of Margin's has the keys (the palette is drawn in this window: it's in front then); a press in the page area
//   around the hosted window (never on it: the app has that press already) gives that app the keyboard
//   (`onPagePress`). While a host's first open or placing again runs, and while a hosted Safari tab loads, the theme's
//   own loading bar on the page card's edge shows for that item (`setLoadingTabs`: the page's `loading`, as a browser
//   copy's push draws it over a browser); no spinner of Margin's own. A new app's window brought into Margin's Space only
//   to be read is covered by this window meanwhile (`cover`). The page card's rounded corners are drawn over the hosted
//   window by small panels of their own (`corners`, HostCorners: MarginWindow.swift).
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
        var alwaysFullScreen = false // (MarginWindows sets it: on while MarginHosted is) shown only in full screen, never leaving it
        var fullScreenWithin: TimeInterval = 3 // shown at once by then even if full screen didn't come (never left invisible)
        // A test's stand-in for macOS's answer to a full-screen ask: false, ignored (as for an app that isn't active);
        // nil: in at once.
        var harnessEnters: (() -> Bool)?
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
    // Hosting another app's window above its page area (setHosting): the display's full-screen area (top left).
    private(set) var hosting = false
    private(set) var hostDisplay: CGRect?
    private var hostingLayoutSaid: String? // the last layout logged while hosting (numbers only)
    private(set) var below: Int? // the hosted window: this one kept right below it (keepBelow)
    private(set) var belowOrders = 0 // how many times it was ordered below it (the tests read it)
    // A host's first open or placing again: the app's name, nil: none (the bar is its item's: setLoadingTabs).
    private(set) var loadingLabel: String?
    // The items loading as the page was last told (the UI's numbers), and a window this one is ordered above (cover).
    private(set) var loadingTabs: [Int] = []
    private(set) var covering: Int?
    private(set) var coverOrders = 0
    // The page card's corners over the hosted window (HostCorners: MarginWindow.swift).
    let corners: HostCorners
    // The hosted window's bounds by the window server (top left; nil: unread). A test's stand-in reads its own.
    var hostedBounds: (Int) -> CGRect? = { MarginWindowController.serverBounds($0) }
    // Under a hosted window that covers the page area, the page area's ground is the colour around the card (the
    // theme's frame), not the window's: any sliver the hosted window leaves (its own rounded corners, a point short) is
    // the frame, never a dark gap. Nil: the window's own background.
    private(set) var pageGround: NSColor?
    // Always full screen: its first entry (the window see-through until it's in), and the times it went back in.
    private var enteringFirst = false
    private(set) var backIntoFullScreen = 0
    private(set) var refusedExits = 0
    // Its asks for full screen (all of them, and those asked again: the tests read them), the retries' rule, whether
    // the first ask was made (shown), whether it's been on screen, and when AppKit last said it's on its way in.
    private(set) var fullScreenAsks = 0
    private(set) var fullScreenRetries = 0
    private var retry = FullScreenRetry()
    private var firstAsked = false
    private var orderedIn = false
    private var willEnterAt: Date?

    init(id: Int, pages: OverlayPages, options: Options = Options()) {
        self.id = id
        self.pages = pages
        self.options = options
        let frame = options.harness ? (options.frame ?? Self.harnessFrame) : (options.frame ?? Self.centred())
        window = MarginWindow(frame: frame, harness: options.harness)
        corners = HostCorners(harness: options.harness)
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
        window.locksFullScreen = options.alwaysFullScreen
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
        // (A test's window: full screen is its state only, at once, or as its stand-in answers.)
        if options.harness, options.alwaysFullScreen { firstAsked = true; enterFullScreen() }
        pages.ready { [weak self] in self?.webView.load(URLRequest(url: OverlaySchemeHandler.page)) }
        guard !options.harness else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + options.showWithin) { [weak self] in self?.show() }
    }

    func show() {
        guard !options.harness, !isClosed else { return }
        // Always full screen: shown only once it's there. See-through, ordered in, taken to full screen; drawn when it
        // has entered (windowDidEnterFullScreen), or after `fullScreenWithin` whatever happened (said).
        if options.alwaysFullScreen, !isFullScreen {
            guard !enteringFirst else { return }
            enteringFirst = true
            Diagnostics.note("Margin's window \(id): into full screen before it's seen")
            window.alphaValue = 0
            window.makeKeyAndOrderFront(nil)
            NSApp.activate()
            // (Its first ask; asked again only after it: its key and first-on-screen moments here come before it.)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                guard let self else { return }
                self.firstAsked = true
                self.enterFullScreen()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + options.fullScreenWithin) { [weak self] in
                guard let self, !self.isClosed, self.window.alphaValue == 0 else { return }
                Diagnostics.warn("Margin's window \(self.id): not in full screen within \(Int(self.options.fullScreenWithin)) s (\(self.fullScreenState)): shown as it is (asked again once Margin is active)")
                self.window.alphaValue = 1
                self.enteringFirst = false
            }
            return
        }
        if !isShown { Diagnostics.note("Margin's window \(id) shown\(isReady ? "" : " (its page not drawn yet)")") }
        isShown = true
        if window.alphaValue < 1 { window.alphaValue = 1 }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        orderBelowHosted()
        placeButtons()
    }

    private(set) var isClosed = false
    // Its page let go of (the window closing, or closed by close()).
    func teardown() {
        guard !isClosed else { return }
        isClosed = true
        corners.hide()
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
    // window is above it, never behind it; with nothing hosted, its page area is the theme's launcher.
    var slot: Slot? { nil }

    // The page area again (the layout, the window's frame or what's over the page changed).
    func updatePage() {
        let content = contentFrame
        let region = CatchRegion.of(frame: content, slot: slot)
        fill.region = region
        defer { placeCorners() }
        guard let layout else { return window.setPageRect(nil, radius: 0) }
        if hosting { return window.setPageRect(hostedPlacement?.page, radius: CGFloat(layout.radius)) }
        // (A layout from before a resize changes nothing: the page's next one, at the new size, does.)
        guard MarginWindowGeometry.measuredAt(layout, content.size) else { return }
        window.setPageRect(MarginWindowGeometry.pageRect(layout: layout, content: content), radius: CGFloat(layout.radius))
    }

    // ---- hosting another app's window above its page area (HostedSession.swift) ----

    // On: its page draws its own layout with the sidebar docked and no launcher in the page area (`pageHosted`), nothing
    // passes through it, its page area the hosted window's placement. Off: the theme's launcher there again. Its width
    // and its size constraints never change for it (the hosted window is a member of its Space above it, not a tile).
    func setHosting(_ on: Bool) {
        guard on != hosting else { return }
        hosting = on
        if on {
            hostDisplay = window.screen.map { MarginWindowGeometry.fullScreenArea($0) } ?? contentFrame
            Diagnostics.note("Margin's window \(id): hosting above its page area\(hostDisplay.map { " (the display's full-screen area \(Int($0.width))×\(Int($0.height)))" } ?? "")")
        } else {
            below = nil
            covering = nil
            loadingLabel = nil
            hostDisplay = nil
            Diagnostics.note("Margin's window \(id): hosting nothing: its launcher in the page area again")
        }
        push(#"{"type":"pageHosted","on":\#(on)}"#)
        updatePage()
    }

    // A host's first open, or its placing again (the app's name; nil: over). What's drawn is the theme's loading bar,
    // for the item it's opened for (setLoadingTabs).
    func setLoading(_ label: String?) {
        guard label != loadingLabel else { return }
        loadingLabel = label
        Diagnostics.note("Margin's window \(id): \(label == nil ? "loading done" : "loading an app in the page area")")
    }

    // The items loading (the UI's numbers for them): the page's `loading`, as a browser copy's push says it over a
    // browser (host-app.ts receive): the bar on the page card's edge for the one in front, each one's row.
    func setLoadingTabs(_ numbers: [Int]) {
        guard numbers != loadingTabs else { return }
        loadingTabs = numbers
        push(#"{"type":"push","msg":{"type":"loading","tabIds":"# + (jsonString(numbers) ?? "[]") + "}}")
    }

    // Ordered right above `number` (a new app's window brought into Margin's Space only to be read: never seen on its
    // own over Margin), nil: no more (ordered below the hosted window again, if there is one).
    func cover(_ number: Int?) {
        guard number != covering else { return }
        covering = number
        guard let number else { return orderBelowHosted() }
        // (Hosting, or a window made ready out of sight over it: HostedSession.prepareBrowser.)
        guard !isClosed else { return }
        window.order(.above, relativeTo: number)
        coverOrders += 1
    }

    // Kept right below `number` (the hosted window, another app's), now and whenever it comes to the front; nil: no more.
    func keepBelow(_ number: Int?) {
        guard number != below else { return }
        below = number
        Diagnostics.note("Margin's window \(id): \(number.map { "kept below the hosted window \($0)" } ?? "no hosted window above it")")
        orderBelowHosted()
        placeCorners()
    }

    // The page card's rounded corners over the hosted window (it's above this one, its corners square): drawn by
    // HostCorners only while a hosted window is shown in this window's page area and this window is on the current
    // Space, at the page area's corners, with the page's inner radius and the colour the theme draws around them.
    func placeCorners() {
        // (Not while a field of Margin's has the keys: this window is in front of the hosted one then, the palette over it.)
        guard hosting, let below, !pageWantsKeyboard, !isClosed, let page = window.pageRect, let layout else {
            setPageGround(nil)
            return corners.hide()
        }
        let radii = layout.radii.map { CGFloat($0) }
        let said = (0..<4).map { i in i < layout.fills.count ? HostCorners.color(layout.fills[i]) : nil }
        // (A corner the page said nothing for: the colour of the others, not the window's own, dark in dark mode.)
        let common = HostCorners.common(said.compactMap { $0 })
        let fills = said.map { $0 ?? common ?? HostCorners.fallback }
        let edge = layout.edge.flatMap { e in HostCorners.color(e.color).map { HostCorners.Edge(width: CGFloat(e.width), color: $0) } }
        setPageGround(hostedBounds(below).map { HostLayout.near($0, page, within: 2) } == true ? common : nil)
        // (Ordered in only while this window's Space is current, so they join it and no other; shown already as they
        // should be, they stay where they are, in its Space, while another is current.)
        if !options.harness, !(window.isVisible && window.isOnActiveSpace) {
            if !corners.shows(page: page, radii: radii, fills: fills, edge: edge) { corners.hide() }
            return
        }
        corners.show(page: page, radii: radii, fills: fills, edge: edge)
    }

    private func setPageGround(_ color: NSColor?) {
        guard color != pageGround else { return }
        pageGround = color
        window.backgroundColor = color ?? .windowBackgroundColor
    }

    // Ordered right below the hosted window, unless a field of Margin's has the keys (the palette is drawn here).
    func orderBelowHosted() {
        guard let below, hosting, !pageWantsKeyboard, !isClosed else { return }
        window.order(.below, relativeTo: below)
        belowOrders += 1
    }

    // Where the hosted window goes while hosting: the page area from its own layout, measured in full screen at its
    // size (the theme's frame around it), and the display's full-screen area its own Space lays it out in. Nil until then.
    // The area is this window's own frame: a full-screen window, laid out exactly where the hosted window's own Space
    // lays out its full-screen window (seen 2026-11-15: the display's frame less its top safe-area inset said 0,32
    // 1512×950, both windows were at 0,33 1512×949, so the hosted window landed a point below the page area).
    var hostedPlacement: HostPlacement? {
        guard hosting, isFullScreen, let layout, layout.mode == "fullscreen", hostDisplay != nil,
              let page = MarginWindowGeometry.pageRect(layout: layout, content: contentFrame) else { return nil }
        return HostPlacement(page: page, area: contentFrame)
    }

    // The page area as its page draws it now, not hosting (its launcher's layout), in full screen at its size: where a
    // browser's window made ready out of sight is placed (hosting's rect too while the sidebar is docked). Nil until measured.
    var idlePlacement: HostPlacement? {
        guard isFullScreen, let layout, layout.mode == "fullscreen", MarginWindowGeometry.measuredAt(layout, contentFrame.size),
              let page = MarginWindowGeometry.pageRect(layout: layout, content: contentFrame) else { return nil }
        return HostPlacement(page: page, area: contentFrame)
    }

    // A window's bounds by the window server (CGWindowListCopyWindowInfo: no permission needed for bounds).
    nonisolated static func serverBounds(_ number: Int) -> CGRect? {
        guard let n = CGWindowID(exactly: number), let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, n) as? [[String: Any]],
              let raw = list.first?[kCGWindowBounds as String] else { return nil }
        return CGRect(dictionaryRepresentation: raw as! CFDictionary)
    }

    // Its page asked to measure now (overlay.ts `measure`): it reads the size the web view has, drawn or not.
    func remeasure() {
        guard hosting, asked else { return }
        push(#"{"type":"measure"}"#)
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
    // Window mode: a press in the page area (around the hosted window; on it, the app has it already) gives that app
    // the keyboard. Only while this window is on screen in the current Space (the monitor hears every app's presses).
    func pressed(_ at: CGPoint) {
        if below != nil, hosting, !pageWantsKeyboard, window.isVisible, window.isOnActiveSpace, let page = window.pageRect, page.contains(at) {
            owner?.onPagePress?(self, at)
        }
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
        if on {
            if enteringFirst {
                enteringFirst = false
                window.alphaValue = 1
                Diagnostics.note("Margin's window \(id) shown, in full screen")
                isShown = true
            }
            owner?.onEnteredFullScreen?(self)
        } else if options.alwaysFullScreen, !isClosed {
            // macOS took it out anyway (the green button, Mission Control): straight back in.
            backIntoFullScreen += 1
            Diagnostics.note("Margin's window \(id): out of full screen by macOS (it's always full screen): back into it")
            if options.harness { return fullScreenChanged(true) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self, !self.isFullScreen, !self.isClosed else { return }
                NSApp.activate()
                self.window.makeKeyAndOrderFront(nil)
                self.enterFullScreen()
            }
        }
    }

    // AppKit's toggle into full screen, unless it's in, on its way in (AppKit said so in the last 2 s, or its style
    // has it: MarginWindow refuses the toggle then anyway) or closed. A test's window: its stand-in's answer.
    @discardableResult
    private func enterFullScreen() -> Bool {
        guard !isFullScreen, !isClosed, !window.styleMask.contains(.fullScreen) else { return false }
        if let at = willEnterAt, Date().timeIntervalSince(at) < 2 { return false }
        fullScreenAsks += 1
        if options.harness {
            if options.harnessEnters?() ?? true { fullScreenChanged(true) }
            return true
        }
        window.toggleFullScreen(nil)
        return true
    }

    // Always full screen and not in (the toggle ignored: Margin wasn't active): asked again as Margin becomes active,
    // its window key or main, or first on screen; once per activation (FullScreenRetry), never before its first ask.
    func askFullScreenAgain(_ why: String) {
        guard options.alwaysFullScreen else { return }
        // (macOS ignores it while Margin isn't active: its activation asks then. A test's app never activates.)
        guard options.harness || NSApp.isActive else { return }
        let entering = window.styleMask.contains(.fullScreen) || willEnterAt.map { Date().timeIntervalSince($0) < 2 } == true
        guard retry.shouldAsk(inFullScreen: isFullScreen, entering: entering, closed: isClosed, firstAsked: firstAsked) else { return }
        fullScreenRetries += 1
        Diagnostics.note("Margin's window \(id): not in full screen (\(fullScreenState)): asked again (\(why))")
        // (Its window key and on the current Space first, as the toggle needs, then the toggle a moment later.)
        if !options.harness, !window.isKeyWindow || !window.isOnActiveSpace {
            window.makeKeyAndOrderFront(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.enterFullScreen() }
            return
        }
        enterFullScreen()
    }

    // Margin became active (MarginWindows): a new activation, so one more ask if it isn't in full screen.
    func appBecameActive() {
        retry.activated()
        askFullScreenAgain("Margin active")
    }

    // The window's full screen asked (⌃⌘F, the page's own ask): refused while it's in full screen and always is.
    func toggleFullScreen() {
        if options.alwaysFullScreen, isFullScreen {
            refusedExits += 1
            return Diagnostics.note("Margin's window \(id): leaving full screen refused (Margin is always full screen)")
        }
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
    // (Its Space current again, or another: the corners shown only over its own Space's hosted window.)
    func windowDidChangeOcclusionState(_ notification: Notification) {
        placeCorners()
        if !orderedIn, firstAsked, window.occlusionState.contains(.visible) {
            orderedIn = true
            askFullScreenAgain("first on screen")
        }
    }
    func windowDidMove(_ notification: Notification) { updatePage() }
    func windowWillEnterFullScreen(_ notification: Notification) { willEnterAt = Date() }
    func windowDidEnterFullScreen(_ notification: Notification) { willEnterAt = nil; fullScreenChanged(true) }
    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        willEnterAt = nil
        Diagnostics.warn("Margin's window \(id): macOS didn't take it to full screen (\(fullScreenState))")
    }
    // About to leave full screen while hosting: the one shown parked first, while it's still in this window's Space.
    func windowWillExitFullScreen(_ notification: Notification) { if hosting { owner?.onLeavingFullScreen?(self) } }
    func windowDidExitFullScreen(_ notification: Notification) { willEnterAt = nil; fullScreenChanged(false) }
    func windowDidBecomeKey(_ notification: Notification) {
        owner?.becameKey(self); orderBelowHosted(); placeButtons()
        askFullScreenAgain("its window key")
    }
    func windowDidBecomeMain(_ notification: Notification) { orderBelowHosted(); askFullScreenAgain("its window main") }
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
        json += #","pageHosted":"# + (hosting ? "true" : "false")
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
                let said = "\(layout.mode) \(Int(layout.left))/\(Int(layout.top))/\(Int(layout.right))/\(Int(layout.bottom)) in \(Int(layout.width))×\(Int(layout.height))"
                if said != hostingLayoutSaid {
                    hostingLayoutSaid = said
                    Diagnostics.note("Margin's window \(id): hosting, its page measured \(said) (window \(Int(window.frame.width))×\(Int(window.frame.height)), full screen \(window.styleMask.contains(.fullScreen)))")
                }
            }
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
            // (Window mode: the palette is drawn in this window, so it's in front while it has the keys, below the hosted
            // window again after.)
            if !pageWantsKeyboard { orderBelowHosted() }
            placeCorners()
            guard pageWantsKeyboard, !options.harness else { return }
            if below != nil { window.orderFront(nil) }
            // A field of Margin's wants the keys (the palette, ⌘T or the menu's New Tab): Margin and this window take
            // the keyboard, which a hosted app above it may have had (seen 2026-11-15: the palette opened while the
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
        var alwaysFullScreen = true // (Tirth, 2026-11-15) every Margin window full screen, never leaving it, while MarginHosted is on
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
    var onEnteredFullScreen: ((MarginWindowController) -> Void)? // in full screen (again)
    var onPagePress: ((MarginWindowController, CGPoint) -> Void)? // a press in its page area around a window-mode host's window
    var browser = "safari" // the engine hosted pages are in (Settings offers its features)
    private(set) var controllers: [MarginWindowController] = []
    private var lastKey: MarginWindowController?
    private var nextId = 1
    private let pointer = PointerWatch()
    let menuTarget = MarginMenuTarget()
    private(set) lazy var menu: NSMenu = MarginMenu.build(target: menuTarget, fullScreenItem: !options.alwaysFullScreen)

    init(pages: OverlayPages, source: MarginWindowSource, options: Options = Options()) {
        self.pages = pages
        self.source = source
        self.options = options
        source.onChange = { [weak self] in self?.sourceChanged() }
        menuTarget.handle = { [weak self] action in self?.perform(action) }
        menuTarget.enabled = { [weak self] action in action == .newWindow || self?.front != nil }
        pointer.onMove = { [weak self] at in for c in self?.controllers ?? [] { c.pointerMoved(at) } }
        pointer.onPress = { [weak self] at in for c in self?.controllers ?? [] { c.pressed(at) } }
        // Margin activated (its Dock icon, ⌘-Tab): a window kept below a window-mode host's window ordered there again.
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            // (And one still not in full screen, its toggle ignored while Margin wasn't active, asked again.)
            MainActor.assumeIsolated { for c in self?.controllers ?? [] { c.orderBelowHosted(); c.appBecameActive() } }
        }
        // Another Space current, or another app in front (a hosted app activated): the page card's corners placed again
        // (ordered back into Margin's Space if they were ordered in while another Space was current).
        let workspace = NSWorkspace.shared.notificationCenter
        cornerObservers = [NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.didActivateApplicationNotification].map { name in
            workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { for c in self?.controllers ?? [] { c.placeCorners() } }
            }
        }
    }

    private var activeObserver: NSObjectProtocol?
    private var cornerObservers: [NSObjectProtocol] = []
    deinit {
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        for o in cornerObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
    }

    var anyVisible: Bool { controllers.contains { $0.window.isVisible } }

    // The key one, else the one key last, else the newest.
    var front: MarginWindowController? {
        controllers.first { $0.window.isKeyWindow } ?? lastKey.flatMap { k in controllers.first { $0 === k } } ?? controllers.last
    }

    // Margin's menu bar (not in a test: its app's menu stays the test's).
    func installMenu() {
        guard options.installsMenu, !options.harness else { return }
        // (AppKit adds its own Enter Full Screen item to a View menu unless told not to: Margin never leaves full screen.)
        if options.alwaysFullScreen { UserDefaults.standard.register(defaults: ["NSFullScreenMenuItemEverywhere": false]) }
        NSApp.mainMenu = menu
        NSApp.windowsMenu = menu.items.first { $0.submenu?.identifier?.rawValue == "margin.window-menu" }?.submenu
    }

    @discardableResult
    func open(_ windowOptions: MarginWindowController.Options? = nil) -> MarginWindowController {
        var o = windowOptions ?? MarginWindowController.Options()
        o.harness = o.harness || options.harness
        o.alwaysFullScreen = o.alwaysFullScreen || options.alwaysFullScreen
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

// Always full screen (MarginWindowController): whether a window that isn't in full screen is asked again now. Never
// before its first ask, nor while it's in or on its way in, nor once closed; otherwise once per activation of Margin
// (macOS ignored the last ask if Margin wasn't active: the next activation is the next chance), so nothing loops.
struct FullScreenRetry {
    private(set) var activation = 0
    private var askedIn = -1

    // Margin became active: one more ask allowed.
    mutating func activated() { activation += 1 }

    // True: ask now (counted for this activation).
    mutating func shouldAsk(inFullScreen: Bool, entering: Bool, closed: Bool, firstAsked: Bool) -> Bool {
        guard !inFullScreen, !entering, !closed, firstAsked, askedIn != activation else { return false }
        askedIn = activation
        return true
    }
}
