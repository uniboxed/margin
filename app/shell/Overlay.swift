// One overlay over one browser window (PLAN.md §6, Spike 1): a borderless,
// non-activating, transparent panel exactly over the window, kept just above
// it in the window server's order, joining full-screen Spaces, with the
// whole theme in one web view (OverlayWebView.swift) and the page slot left
// empty. It ignores the mouse while the pointer is over the slot
// (PassThrough.swift), so the page under it gets clicks, scrolling and
// selection.
//
// The page is loaded before the overlay is needed, and the overlay is never
// shown before its page says it's drawn (`ready`). A press in it never takes
// the keyboard from the browser; a text field of Margin's in it does (the
// palette, an input: the page says `focus`), as a key panel that doesn't make
// Margin the active app (the browser stays in front and doesn't dim), and
// gives it back as it's left or on Escape.
//
// In the tests (`harness`) nothing is ever shown on screen: a frame on any
// display is refused, the panel is never made key and nothing is activated.

import AppKit
import QuartzCore
import WebKit

// Key only while a text field in it has focus; never main.
final class OverlayPanel: NSPanel {
    var allowKey = false
    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { false }
}

protocol OverlayDelegate: AnyObject {
    func hello(for overlay: OverlayController) -> String
    func send(from overlay: OverlayController, type: String, payload: JSONObject) async throws -> JSONObject
    func layoutChanged(_ overlay: OverlayController, _ layout: PageLayout)
    // Drawn, crashed, the slot or its hits changed: whether it shows, and how the mouse goes, may have changed.
    func overlayChanged(_ overlay: OverlayController, _ why: String)
    func perform(from overlay: OverlayController, _ name: String, _ arg: Any?)
}

final class OverlayController: NSObject, OverlayPageOwner, WKNavigationDelegate {
    struct Options {
        var harness = false
        // The window level. .normal, ordered just above the browser window; floating would cover other apps' windows too.
        var level: NSWindow.Level = .normal
        var crashLimit = 3 // reloads after the page's process died, within crashWindow; past that, it stays put away
        var crashWindow: TimeInterval = 300
        var edgeWidth: CGFloat = EdgeGuard.width // the edge guard's (PassThrough.swift EdgeGuard); 0: none
        // Joining only its window's Space instead of every Space, so it's already drawn when that
        // Space comes back (Tirth, 2026-11-05: the layout at once on every window switch). On by
        // default in the app (`defaults write io.tirth.margin MarginOverlayOwnSpace -bool NO` turns it
        // off); the shell falls back to every Space for the launch if macOS doesn't place it with its
        // window (Shell.checkOwnSpace).
        var ownSpace = false
    }

    // PLAN.md §6 and Phase 0's overlay probe: in every Space (a full-screen one too), beside a
    // full-screen window, not moved by Mission Control, not in ⌘-Tab's or the window cycle.
    // With it, an overlay is in every Space, so it stays drawn while macOS slides from Safari's
    // full-screen Space to another (the desktop) until the shell hears the Space changed and puts it
    // away (Shell.spaceChanged). `ownSpace`: a managed window joining only the Space it's shown in
    // (the full-screen window's, `.fullScreenAuxiliary`), which would slide away with it; not the
    // default until it's checked over real full-screen Safari (DECISIONS.md, Phase 2 step 8).
    static let collectionBehavior: NSWindow.CollectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    static let ownSpaceBehavior: NSWindow.CollectionBehavior = [.managed, .fullScreenAuxiliary, .ignoresCycle]
    // The thin panel at the window's left edge (PassThrough.swift EdgeGuard): nil with `edgeWidth` 0.
    let edgePanel: OverlayPanel?
    private(set) var edgeFrame: CGRect?

    weak var delegate: OverlayDelegate?
    let key: WindowKey
    let panel: OverlayPanel
    let webView: OverlayWebView
    private let pages: OverlayPages
    private var options: Options
    var ownSpace: Bool { options.ownSpace }
    // Back to every Space (the shell's fallback when macOS didn't keep an overlay with its window).
    func joinEverySpace() {
        guard options.ownSpace else { return }
        options.ownSpace = false
        panel.collectionBehavior = Self.collectionBehavior
        edgePanel?.collectionBehavior = Self.collectionBehavior
    }

    private(set) var isReady = false // the page has drawn
    private(set) var isShown = false
    private(set) var crashBudgetOK = true
    private var crashes: [TimeInterval] = []
    private var asked = false // the page has asked for its hello: pushes reach it
    private(set) var layout: PageLayout?
    private(set) var hits: [CGRect] = []
    private(set) var captureAll = false
    private(set) var frameTopLeft: CGRect = .zero
    // Its browser window's bounds (top left): the overlay's frame, or more when Safari takes part of
    // the window (Shell.overlayFrame).
    var windowFrame: CGRect?
    private(set) var aboveWindow: Int?
    private(set) var belowWindow: Int? // the browser window's full-screen toolbar, when it has one
    private(set) var ignoring = false
    private(set) var hasKeyboard = false
    // Which pointer positions its page wants (PointerWant): all, until it says.
    private(set) var pointerWant = PointerWant.all
    // For the tests: each time the keyboard went back to the browser, and each re-order.
    private(set) var handedBack = 0
    private(set) var reorders = 0

    init(pages: OverlayPages, key: WindowKey, options: Options = Options()) {
        self.pages = pages
        self.key = key
        self.options = options
        let start = NSRect(x: -20000, y: -20000, width: 800, height: 600)
        panel = OverlayPanel(contentRect: start, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        webView = pages.makeWebView(size: start.size)
        let behavior = options.ownSpace ? Self.ownSpaceBehavior : Self.collectionBehavior
        if options.edgeWidth > 0 {
            // Never key, never ignoring the mouse; filled just above nothing, since the window server
            // passes the pointer through a window's fully transparent pixels.
            let edge = OverlayPanel(contentRect: NSRect(x: -20000, y: -20000, width: options.edgeWidth, height: 600), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
            edge.level = options.level
            edge.hidesOnDeactivate = false
            edge.isOpaque = false
            edge.hasShadow = false
            edge.backgroundColor = NSColor(calibratedWhite: 0, alpha: 0.01)
            edge.animationBehavior = .none
            edge.isReleasedWhenClosed = false
            edge.collectionBehavior = behavior
            edge.ignoresMouseEvents = false
            edgePanel = edge
        } else {
            edgePanel = nil
        }
        super.init()
        panel.level = options.level
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isOpaque = false
        panel.hasShadow = false
        panel.backgroundColor = .clear
        panel.animationBehavior = .none
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = behavior
        panel.acceptsMouseMovedEvents = true
        let content = NSView(frame: NSRect(origin: .zero, size: start.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = .clear
        webView.autoresizingMask = [.width, .height]
        webView.frame = content.bounds
        content.addSubview(webView)
        panel.contentView = content
        webView.navigationDelegate = self
        pages.bridge.register(webView, self)
    }

    // The page, drawn off screen until it's needed (never shown before it's ready).
    func load() {
        isReady = false
        asked = false
        pages.ready { [weak self] in
            guard let self else { return }
            self.webView.load(URLRequest(url: OverlaySchemeHandler.page))
        }
    }

    func close() {
        hide("closed")
        pages.bridge.unregister(webView)
        webView.navigationDelegate = nil
        webView.stopLoading()
        panel.close()
        edgePanel?.close()
    }

    // The edge guard where this overlay's slot needs it, just above the overlay; away otherwise.
    // `restack`: the overlay was just ordered (the guard goes back above it).
    func placeEdge(restack: Bool = false) {
        guard let edgePanel else { return }
        // (Only at the window's own left edge: with the Web Inspector docked on the left, the overlay
        // starts beside it, and the inspector is Safari's.)
        let atWindowEdge = windowFrame.map { abs($0.minX - frameTopLeft.minX) < 1 } ?? true
        let want = isShown && atWindowEdge ? EdgeGuard.frame(for: frameTopLeft, slot: slot, width: options.edgeWidth) : nil
        guard let want, allowed(ScreenGeometry.appKitRect(want)) else {
            if edgeFrame != nil { edgePanel.orderOut(nil) }
            edgeFrame = nil
            return
        }
        let appKit = ScreenGeometry.appKitRect(want)
        if edgePanel.frame != appKit { edgePanel.setFrame(appKit, display: false) }
        let new = edgeFrame == nil
        edgeFrame = want
        if new || restack { edgePanel.order(.above, relativeTo: panel.windowNumber) }
    }

    var edgeWindowNumber: Int? { edgeFrame != nil ? edgePanel?.windowNumber : nil }

    // ---- where it is ----

    // In a test, nowhere on a display.
    private func allowed(_ appKitFrame: CGRect) -> Bool {
        guard options.harness, NSScreen.screens.contains(where: { $0.frame.intersects(appKitFrame) }) else { return true }
        Diagnostics.warn("harness: not putting an overlay on a display (\(appKitFrame))")
        return false
    }

    /// At the browser window's size (`frame`, top left) before it shows, so its
    /// page measures the slot at the size it will have.
    func size(to frame: CGRect) {
        guard frame != frameTopLeft else { return }
        let appKit = ScreenGeometry.appKitRect(frame)
        guard allowed(appKit) else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        panel.setFrame(appKit, display: false)
        CATransaction.commit()
        frameTopLeft = frame
    }

    /// Over the browser window `number`, at its bounds (`frame`, top left),
    /// just above it. False if it can't be shown (not drawn yet, or a test's
    /// frame on a display).
    /// `toolbar`: the window's full-screen toolbar (WindowMatcher.fullScreenToolbar): the overlay goes
    /// just below it, so it still slides over Margin as over the page.
    @discardableResult
    func show(over number: Int, frame: CGRect, toolbar: Int? = nil, why: String = "its window is on screen") -> Bool {
        guard isReady, crashBudgetOK else { return false }
        let appKit = ScreenGeometry.appKitRect(frame)
        guard allowed(appKit) else { return false }
        if frame != frameTopLeft || panel.frame != appKit {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            if panel.frame != appKit { panel.setFrame(appKit, display: false) }
            panel.displayIfNeeded()
            CATransaction.commit()
            frameTopLeft = frame
        }
        reveal() // (at its frame already, if its window came back elsewhere)
        let ordered = !isShown || aboveWindow != number || belowWindow != toolbar
        aboveWindow = number
        belowWindow = toolbar
        if ordered { orderInPlace() }
        if !isShown {
            isShown = true
            Diagnostics.note("overlay shown over \(key) (window \(number)): \(why)")
        }
        placeEdge(restack: ordered)
        return true
    }

    // Put back just above its browser window (something came between them: a click raised the browser).
    func reorder() {
        guard isShown, aboveWindow != nil else { return }
        orderInPlace()
        placeEdge(restack: true)
    }

    // Just above the browser window, and below its full-screen toolbar when it has one.
    private func orderInPlace() {
        if let belowWindow { panel.order(.below, relativeTo: belowWindow) } else if let aboveWindow { panel.order(.above, relativeTo: aboveWindow) }
        reorders += 1
    }

    // Unseen where it is: its window is missing from a read of the window server (a blip: WindowBinder
    // keeps the binding, `absentNumbers`). Still ordered in its Space, above its window, with the
    // keyboard if it had it; drawn at alpha 0, and the mouse passes through. `reveal` (or the next
    // `show`) brings it back; `hide` puts it away if the binding goes.
    private(set) var isConcealed = false
    func conceal() {
        guard isShown, !isConcealed else { return }
        isConcealed = true
        panel.alphaValue = 0
        panel.ignoresMouseEvents = true
        edgePanel?.alphaValue = 0
        edgePanel?.ignoresMouseEvents = true
    }

    func reveal() {
        guard isConcealed else { return }
        isConcealed = false
        panel.alphaValue = 1
        panel.ignoresMouseEvents = ignoring
        edgePanel?.alphaValue = 1
        edgePanel?.ignoresMouseEvents = false
    }

    // `why`: for the log (only a shown overlay put away is logged).
    func hide(_ why: String) {
        if hasKeyboard { handBack() }
        if isShown { Diagnostics.note("overlay put away (\(key)): \(why)") }
        panel.orderOut(nil)
        reveal()
        isShown = false
        aboveWindow = nil
        belowWindow = nil
        setIgnoring(false)
        placeEdge()
    }

    var windowNumber: Int { panel.windowNumber }

    // The slot in the window server's coordinates (nil before the page reported it).
    var slot: Slot? {
        guard let layout else { return nil }
        return PassThrough.slot(in: frameTopLeft, layout: layout, hits: hits, captureAll: captureAll)
    }

    func setIgnoring(_ on: Bool) {
        guard on != ignoring else { return }
        ignoring = on
        panel.ignoresMouseEvents = on || isConcealed
    }

    // ---- the page ----

    // A message to the page (marginApp.receive), as JSON text.
    func pushJSON(_ json: String) {
        guard asked else { return } // its hello, when it asks, has this already
        webView.callAsyncJavaScript("marginApp.receive(m)", arguments: ["m": json], in: nil, in: .page) { result in
            if case .failure(let error) = result { Diagnostics.warn("push into an overlay failed: \(error.localizedDescription)") }
        }
    }

    func pageHello() -> String {
        asked = true
        return delegate?.hello(for: self) ?? "null"
    }

    func pageSend(type: String, payload: JSONObject) async throws -> JSONObject {
        guard let delegate else { throw LinkError.down }
        return try await delegate.send(from: self, type: type, payload: payload)
    }

    func pageSaid(_ op: String, _ body: JSONObject) {
        switch op {
        case "ready":
            guard !isReady else { return }
            isReady = true
            Diagnostics.note("overlay page drawn (\(key))")
            delegate?.overlayChanged(self, "page drawn")
        case "layout":
            guard let geometry = body["geometry"] as? JSONObject, let layout = PageLayout(geometry: geometry) else { return }
            self.layout = layout
            placeEdge()
            delegate?.layoutChanged(self, layout)
            delegate?.overlayChanged(self, "layout")
        case "hits":
            let rects = (body["rects"] as? [[Any]] ?? []).compactMap { r -> CGRect? in
                let n = r.compactMap(num)
                return n.count == 4 && n.allSatisfy(\.isFinite) ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
            }
            hits = Array(rects.prefix(64))
            captureAll = body["all"] as? Bool == true || rects.count > 64
            placeEdge()
            delegate?.overlayChanged(self, "hits")
        case "focus":
            if body["on"] as? Bool == true { takeKeyboard() } else { handBack() }
        case "pointerWant":
            pointerWant = PointerWant(body)
        case "perform":
            delegate?.perform(from: self, body["name"] as? String ?? "", body["arg"])
        case "log":
            let text = "overlay page (\(key)): \(body["text"] as? String ?? "")"
            if ["error", "warn"].contains(body["level"] as? String ?? "") { Diagnostics.warn(text) } else { Diagnostics.note(text) }
        default:
            break
        }
    }

    // When the app's palette key was last sent to this page (Shell.run), for the log: how long until the keyboard was here.
    var paletteKeyAt: TimeInterval?

    // A text field of Margin's has focus: the keyboard is the overlay's (the browser stays the active app).
    // The web view is made the panel's first responder too: a panel made key with nothing in it as its
    // first responder keeps the keys itself, so a palette opened by the app's key, with no click in the
    // overlay before, showed its field focused while what was typed went nowhere.
    func takeKeyboard() {
        let had = hasKeyboard
        panel.allowKey = true
        hasKeyboard = true
        if panel.firstResponder !== webView { panel.makeFirstResponder(webView) }
        if !had {
            let after = paletteKeyAt.map { " \(Diagnostics.ms(since: $0)) after the palette's key" } ?? ""
            Diagnostics.note("\(key) took the keyboard\(after)\(isShown ? "" : ", but it isn't shown")")
        }
        paletteKeyAt = nil
        guard !options.harness, isShown else { return }
        panel.makeKey()
    }

    // Left, or Escape: the keyboard goes back to the browser's window.
    func handBack() {
        let had = hasKeyboard
        panel.allowKey = false
        hasKeyboard = false
        guard had else { return }
        handedBack += 1
        if panel.isKeyWindow { panel.resignKey() }
        guard !options.harness, let browser = NSRunningApplication(processIdentifier: browserPid) else { return }
        NSApp.yieldActivation(to: browser)
        browser.activate(from: NSRunningApplication.current, options: [])
    }

    // The browser's process (the shell sets it as it shows the overlay).
    var browserPid: pid_t = 0

    // ---- navigation: only overlay.html ----

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        let ours = url?.scheme == OverlaySchemeHandler.scheme && url?.host == "app" && url?.path == OverlaySchemeHandler.page.path && action.targetFrame?.isMainFrame == true
        decisionHandler(ours ? .allow : .cancel)
    }

    // The page's process died: loaded again, unless that keeps happening (then it stays put away).
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let now = Diagnostics.now()
        crashes = crashes.filter { now - $0 < options.crashWindow } + [now]
        hide("its page stopped")
        guard crashes.count <= options.crashLimit else {
            Diagnostics.warn("an overlay's page stopped \(crashes.count) times in \(Int(options.crashWindow / 60)) minutes: put away until Margin.app opens again")
            crashBudgetOK = false
            delegate?.overlayChanged(self, "page crashed too often")
            return
        }
        Diagnostics.warn("an overlay's page stopped: loading it again")
        load()
        delegate?.overlayChanged(self, "page crashed")
    }
}
