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
// gives it back as it's left or on Escape. Only while it's shown: a field
// focused while it isn't waits for the show, and gets the keyboard then only
// over the front window and if it's fresh (`appeared`); a put-away overlay
// hands the keyboard back and tells its page to let go (`blur`), so a field
// never shows focused while the keys go to the browser.
//
// In the tests (`harness`) nothing is ever shown on screen: a frame on any
// display is refused, the panel is never made key and nothing is activated.

import AppKit
import QuartzCore
import WebKit

// Key only while a text field in it has focus; never main.
class OverlayPanel: NSPanel {
    var allowKey = false
    /// A press in it ended (the main button let go): OverlayController.pressEnded.
    var pressEnded: (() -> Void)?
    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { false }
    override func sendEvent(_ event: NSEvent) {
        super.sendEvent(event)
        if event.type == .leftMouseUp { pressEnded?() }
    }
}

// The region that isn't the page's (PassThrough.swift CatchRegion), filled at alpha 0.01 so the window
// server never passes the pointer through it; the rest left fully transparent. Top-left coordinates.
final class CatchView: NSView {
    var region = CatchRegion(all: true, hole: nil) { didSet { if region != oldValue { needsDisplay = true } } }
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil } // (under the web view: never the one that takes an event)
    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        bounds.fill(using: .copy)
        let fill = NSColor(calibratedWhite: 0, alpha: 0.01)
        fill.setFill()
        let path = NSBezierPath(rect: bounds)
        if !region.all, let hole = region.hole {
            path.append(NSBezierPath(roundedRect: hole, xRadius: region.radius, yRadius: region.radius))
            path.windingRule = .evenOdd
        }
        path.fill()
        for r in region.hits { NSBezierPath(rect: r).fill() }
    }
}

// Just below its overlay, at its frame, filled where the overlay's region isn't the page's (CatchView) and
// never told to ignore the mouse (so its transparent pixels, the slot, still let the pointer through to the
// page): what reaches it is an event over Margin's UI that the overlay let through because its
// `ignoresMouseEvents` hadn't caught up with the pointer yet. Handed to the overlay, which takes the mouse
// from then on: a click or a scroll over Margin's UI never reaches the browser.
final class OverlayCatcher: OverlayPanel {
    weak var overlay: OverlayController?
    static let forwarded: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged,
                                                   .otherMouseDown, .otherMouseUp, .otherMouseDragged, .scrollWheel, .magnify, .smartMagnify, .swipe]
    override func sendEvent(_ event: NSEvent) {
        if Self.forwarded.contains(NSEvent.EventTypeMask(rawValue: 1 << event.type.rawValue)), let overlay, overlay.caught(event) { return }
        super.sendEvent(event)
    }
}

protocol OverlayDelegate: AnyObject {
    func hello(for overlay: OverlayController) -> String
    func send(from overlay: OverlayController, type: String, payload: JSONObject) async throws -> JSONObject
    func layoutChanged(_ overlay: OverlayController, _ layout: PageLayout)
    // Drawn, crashed, the slot or its hits changed: whether it shows, and how the mouse goes, may have changed.
    func overlayChanged(_ overlay: OverlayController, _ why: String)
    func perform(from overlay: OverlayController, _ name: String, _ arg: Any?)
    // Its page drew after a `shown`, in this mode (`framed`: the handoff's R4, app/HANDOFF.md §3.2).
    func framed(_ overlay: OverlayController, mode: OverlayFramed.Mode)
    // The space its page shows now (for the log, beside its copy's word).
    func shownSpace(_ overlay: OverlayController, _ said: JSONObject)
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
        // off); the shell falls back to every Space, until no link and no overlay is left, if macOS
        // doesn't place it with its window (Shell.checkOwnSpace, judgeOwnSpace).
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
    // Just below the overlay (OverlayCatcher), and the overlay's own fill under its web view (CatchView).
    let catcher: OverlayCatcher
    private let catcherView = CatchView(frame: .zero)
    private let fillView = CatchView(frame: .zero)
    private(set) var catcherShown = false
    // Events over Margin's UI the catcher took and handed to the overlay (the tests read it; the log says the first ones).
    private(set) var caughtEvents = 0
    var catcherWindowNumbers: Set<Int> { catcherShown ? [catcher.windowNumber] : [] }
    /// Its windows that go into a Space with it: the panel, the catcher when it's out, the edge when it has one.
    var spaceWindowNumbers: Set<Int> {
        var numbers: Set<Int> = [panel.windowNumber]
        numbers.formUnion(catcherWindowNumbers)
        if edgeFrame != nil, let edge = edgePanel { numbers.insert(edge.windowNumber) }
        return numbers
    }

    weak var delegate: OverlayDelegate?
    private(set) var key: WindowKey
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
        catcher.collectionBehavior = Self.collectionBehavior
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
    var windowFullScreen = false // its window in full screen, as its copy says (the edge stop: Shell.updateKeys)
    var pageFullscreen = false // its window's page (or video) in full screen: out of sight, Margin's keys let go (Shell.track)
    private(set) var ignoring = false
    private(set) var hasKeyboard = false
    // What its page last said of its focus (`focus` on or off), apart from whether it has the keyboard:
    // a field focused while the overlay isn't shown is wanted here until the page or the app says
    // otherwise (handBack and a put-away of an overlay not shown leave it), and `appeared` decides.
    private(set) var pageWantsKeyboard = false
    private(set) var pageFocusAt: TimeInterval?
    // A field focused at most this long before the overlay shows takes the keyboard as it shows.
    static let focusFresh: TimeInterval = 2
    // Which pointer positions its page wants (PointerWant): all, until it says.
    private(set) var pointerWant = PointerWant.all
    // For the tests: each time the keyboard went back to the browser, and each re-order.
    private(set) var handedBack = 0
    private(set) var reorders = 0
    // For the tests (the harness never makes a panel key): shows that gave the keyboard to a field
    // focused while hidden, and each time the page was told to let go of its focus (`blur`).
    private(set) var keyOnShow = 0
    private(set) var blurs = 0

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
        catcher = OverlayCatcher(contentRect: start, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        catcher.level = options.level
        catcher.hidesOnDeactivate = false
        catcher.isOpaque = false
        catcher.hasShadow = false
        catcher.backgroundColor = .clear
        catcher.animationBehavior = .none
        catcher.isReleasedWhenClosed = false
        catcher.collectionBehavior = behavior
        // (Its `ignoresMouseEvents` never set: the window server passes the pointer through its transparent pixels.)
        catcherView.frame = NSRect(origin: .zero, size: start.size)
        catcherView.autoresizingMask = [.width, .height]
        catcher.contentView = catcherView
        super.init()
        catcher.overlay = self
        panel.pressEnded = { [weak self] in self?.pressEnded() }
        edgePanel?.pressEnded = { [weak self] in self?.pressEnded() }
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
        // Said, not left to the default: a window left at the default passes the pointer through its fully
        // transparent pixels, and the theme's may be (or its web view's layers may not count).
        panel.ignoresMouseEvents = false
        let content = NSView(frame: NSRect(origin: .zero, size: start.size))
        content.wantsLayer = true
        content.layer?.backgroundColor = .clear
        fillView.frame = content.bounds
        fillView.autoresizingMask = [.width, .height]
        content.addSubview(fillView)
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
        pageWantsKeyboard = false // a new page: nothing of it focused yet
        pageFocusAt = nil
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
        catcher.close()
    }

    // The region that isn't the page's, as the layout says now (CatchRegion), in both fills.
    private func updateCatch() {
        let region = CatchRegion.of(frame: frameTopLeft, slot: slot)
        fillView.region = region
        catcherView.region = region
    }

    // The catcher just below the overlay, at its frame, while it's shown (and not concealed); away otherwise.
    // `restack`: the overlay was just ordered.
    private func placeCatcher(restack: Bool = false) {
        guard isShown, !isConcealed, aboveWindow != nil, frameTopLeft.width > 0, allowed(ScreenGeometry.appKitRect(frameTopLeft)) else {
            if catcherShown { catcher.orderOut(nil) }
            catcherShown = false
            return
        }
        let appKit = ScreenGeometry.appKitRect(frameTopLeft)
        if catcher.frame != appKit { catcher.setFrame(appKit, display: false) }
        updateCatch()
        if !catcherShown || restack { catcher.order(.below, relativeTo: panel.windowNumber) }
        catcherShown = true
    }

    /// An event over Margin's UI that reached the catcher (the overlay let it through: its `ignoresMouseEvents`
    /// hadn't caught up yet): the overlay takes the mouse, and the event is handed to its window. False if the
    /// overlay isn't shown (the catcher then lets AppKit have it, which does nothing with it).
    func caught(_ event: NSEvent) -> Bool {
        guard isShown, !isConcealed else { return false }
        caughtEvents += 1
        if caughtEvents <= 3 || caughtEvents % 100 == 0 {
            Diagnostics.note("\(key): an event over Margin's UI reached the catcher under its overlay (\(event.type.rawValue), \(caughtEvents) so far): handed to the overlay, which takes the mouse")
        }
        setIgnoring(false)
        panel.sendEvent(retargeted(event) ?? event)
        return true
    }

    // The same event for the overlay's window (the same frame as the catcher's, so the same point in it).
    private func retargeted(_ event: NSEvent) -> NSEvent? {
        guard let cg = event.cgEvent?.copy() else { return nil }
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(panel.windowNumber))
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(panel.windowNumber))
        guard let e = NSEvent(cgEvent: cg), e.window === panel, abs(e.locationInWindow.x - event.locationInWindow.x) < 1, abs(e.locationInWindow.y - event.locationInWindow.y) < 1 else { return nil }
        return e
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
        updateCatch()
        if catcherShown { placeCatcher() }
    }

    /// Over the browser window `number`, at its bounds (`frame`, top left),
    /// just above it. False if it can't be shown (not drawn yet, or a test's
    /// frame on a display).
    /// `toolbar`: the window's full-screen toolbar (WindowMatcher.fullScreenToolbar): the overlay goes
    /// just below it, so it still slides over Margin as over the page.
    /// When it was last shown (put away and shown again: a new time). The own-Space check judges only an overlay
    /// shown since before it was asked (Shell.checkOwnSpace).
    private(set) var shownAt: Double = .infinity
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
            shownAt = Diagnostics.now()
            Diagnostics.note("overlay shown over \(key) (window \(number)): \(why)")
        }
        placeCatcher(restack: ordered)
        placeEdge(restack: ordered)
        return true
    }

    /// Placed ahead of a visit: over its window `number`, which is in another Space (not on screen), so that when
    /// that Space slides in the layout is already there and drawn (Tirth, 2026-11-07: "i should never see safari's
    /// ui at all"). Ordered in unseen (alpha 0: ordering in puts a window in the active Space), then its windows
    /// moved into its window's Space by `move` (the Space bridge), then seen again there. False, and put away, if
    /// it can't be shown or moved. `aheadPending`: shown this way and not yet on screen (the shell's first on-screen
    /// show then does what a first show does).
    private(set) var aheadPending = false
    @discardableResult
    func placeAhead(over number: Int, frame: CGRect, move: (Set<Int>) -> Bool) -> Bool {
        guard isReady, crashBudgetOK, allowed(ScreenGeometry.appKitRect(frame)) else { return false }
        panel.alphaValue = 0
        edgePanel?.alphaValue = 0
        catcher.alphaValue = 0
        defer {
            if !isConcealed { panel.alphaValue = 1; edgePanel?.alphaValue = 1 }
            catcher.alphaValue = 1
        }
        guard show(over: number, frame: frame, toolbar: nil, why: "placed in its window's Space ahead of a visit") else { return false }
        guard move(spaceWindowNumbers) else {
            hide("couldn't be placed in its window's Space")
            return false
        }
        aheadPending = true
        return true
    }

    /// Its first time on screen after `placeAhead` (the shell's on-screen show).
    func arrived() { aheadPending = false }

    // Put back just above its browser window (something came between them: a click raised the browser).
    func reorder() {
        guard isShown, aboveWindow != nil else { return }
        orderInPlace()
        placeCatcher(restack: true)
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
        placeCatcher()
    }

    func reveal() {
        guard isConcealed else { return }
        isConcealed = false
        panel.alphaValue = 1
        panel.ignoresMouseEvents = ignoring
        edgePanel?.alphaValue = 1
        edgePanel?.ignoresMouseEvents = false
        if panel.isVisible { placeCatcher(restack: true) }
    }

    // `why`: for the log (only a shown overlay put away is logged).
    func hide(_ why: String) {
        // (Not the page of one that wasn't shown: what it focused waits for the show, `appeared`.)
        if isShown, pageWantsKeyboard { letGo("put away: \(why)") } else if hasKeyboard { handBack("put away: \(why)") }
        if isShown { Diagnostics.note("overlay put away (\(key)): \(why)") }
        panel.orderOut(nil)
        reveal()
        isShown = false
        aheadPending = false
        aboveWindow = nil
        belowWindow = nil
        setIgnoring(false)
        placeCatcher()
        placeEdge()
    }

    var windowNumber: Int { panel.windowNumber }

    // The slot in the window server's coordinates (nil before the page reported it).
    var slot: Slot? {
        guard let layout else { return nil }
        return PassThrough.slot(in: frameTopLeft, layout: layout, hits: hits, captureAll: captureAll)
    }

    // (Always said to the window, even when it's what it was: never left at the default, which lets the
    // pointer through fully transparent pixels.)
    func setIgnoring(_ on: Bool) {
        ignoring = on
        let want = on || isConcealed
        if panel.ignoresMouseEvents != want { panel.ignoresMouseEvents = want }
    }

    // ---- the page ----

    // A message to the page (marginApp.receive), as JSON text.
    /// Handed to another window by a profile switch (Shell.handOverOverlay): its key changes, and its page, if drawn,
    /// takes that window's hello in place (host-app.js `rekey`); one still loading asks for it as it starts.
    /// (Its hello is asked for after the key changes: one built before it, as an argument, was its old window's, and the
    /// page went on drawing that window: Tirth, 2026-11-07, the sidebar showing another space after a switch.)
    func rekey(_ to: WindowKey) {
        Diagnostics.note("overlay for \(key) handed to \(to)")
        key = to
        guard isReady, let hello = delegate?.hello(for: self) else { return }
        pushJSON(#"{"type":"rekey","hello":"# + hello + "}")
    }

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
            updateCatch()
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
            updateCatch()
            placeEdge()
            delegate?.overlayChanged(self, "hits")
        case "focus":
            let on = body["on"] as? Bool == true
            pageWantsKeyboard = on
            pageFocusAt = on ? Diagnostics.now() : nil
            if !on { handBack("its field let go of the focus") } else if isShown { takeKeyboard() } else {
                Diagnostics.note("\(key): a field of its page has the focus, but the overlay isn't shown: the keyboard waits for it to show")
            }
        case "pointerWant":
            pointerWant = PointerWant(body)
        case "perform":
            delegate?.perform(from: self, body["name"] as? String ?? "", body["arg"])
        case OverlayFramed.op:
            guard isShown, let framed = OverlayFramed(body) else { return }
            delegate?.framed(self, mode: framed.mode)
        case "shownSpace":
            delegate?.shownSpace(self, body)
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
    // Only while it's shown (`focus` while it isn't waits for `appeared`).
    func takeKeyboard() {
        guard isShown else { return }
        let had = hasKeyboard
        panel.allowKey = true
        hasKeyboard = true
        if panel.firstResponder !== webView { panel.makeFirstResponder(webView) }
        if !had {
            let after = paletteKeyAt.map { " \(Diagnostics.ms(since: $0)) after the palette's key" } ?? ""
            Diagnostics.note("\(key) took the keyboard\(after)")
        }
        paletteKeyAt = nil
        guard !options.harness else { return }
        panel.makeKey()
    }

    /// Shown just now (it wasn't). A field its page focused while it was hidden takes the keyboard
    /// only if this is the overlay over the front app's front window (`front`, Shell.frontOverlay)
    /// and the focus is at most `focusFresh` old; otherwise the page lets go of it (`blur`), so no
    /// field shows focused while the keys go to the browser. Then the page hears it's shown:
    /// `focusLauncher`, its window is new and in front (⌘N, New Window): the new-tab launcher takes
    /// the focus (palette.js focuses it only then, never as the page first draws).
    // `palette`: a window made from another (⌘N, the palette's New window), in front: the palette opens over
    // its new tab, as ⌘T's does (Tirth, 2026-11-09). `focusLauncher`: another new window in front (Safari's own
    // New Window): its new-tab launcher's field takes the focus. Neither while a field of its page has it.
    func appeared(front: Bool, palette: Bool, focusLauncher: Bool) {
        if pageWantsKeyboard, !hasKeyboard {
            let age = pageFocusAt.map { Diagnostics.now() - $0 }
            if front, let age, age <= Self.focusFresh {
                keyOnShow += 1
                Diagnostics.note("\(key): shown \(Int(age * 1000)) ms after a field of its page took the focus: the keyboard is the overlay's")
                takeKeyboard()
            } else {
                letGo(front ? "shown \(age.map { "\(Int($0 * 1000)) ms" } ?? "long") after its field took the focus" : "shown, but not over the front window")
            }
        }
        let free = !pageWantsKeyboard
        pushJSON(#"{"type":"shown","focus":"# + (focusLauncher && !palette && free ? "true" : "false") + #","palette":"# + (palette && free ? "true" : "false") + "}")
    }

    /// The page told to let go of its focus (`blur`: the palette closes, the field blurs, it says
    /// `focus` off), and the keyboard given back if it had it. `why`: for the log.
    func letGo(_ why: String) {
        let had = hasKeyboard
        handBack(why)
        if !had, pageWantsKeyboard { Diagnostics.note("\(key): its page told to let go of the focus: \(why)") }
        pageWantsKeyboard = false // (the page says so too, a moment later)
        pageFocusAt = nil
        blurs += 1
        pushJSON(#"{"type":"blur"}"#)
    }

    // Left, or Escape: the keyboard goes back to the browser's window. `why`: for the log.
    func handBack(_ why: String) {
        let had = hasKeyboard
        panel.allowKey = false
        hasKeyboard = false
        guard had else { return }
        handedBack += 1
        Diagnostics.note("\(key) gave the keyboard back: \(why)")
        if panel.isKeyWindow { panel.resignKey() }
        guard !options.harness, let browser = NSRunningApplication(processIdentifier: browserPid) else { return }
        NSApp.yieldActivation(to: browser)
        browser.activate(from: NSRunningApplication.current, options: [])
    }

    // A press in Margin's UI ended. A click in a non-activating panel moves the keyboard to Margin.app without making
    // it the active app, and the panel isn't key unless a field of Margin's has the focus: a key pressed after the
    // click reached Margin.app with nowhere to go (⌘R beeped instead of reloading: Tirth, 2026-11-08). So the keyboard
    // goes back to the browser as the press ends, as handBack gives it, unless a field of Margin's took it (its page
    // says `focus` as it's pressed): looked at `pressSettle` later, once the page has had the chance to say so.
    // (A key that still reaches Margin.app goes on to the browser: Shell's key monitor.)
    static let pressSettle: TimeInterval = 0.08
    private(set) var keyboardReturned = 0
    /// Whether the keyboard goes back to the browser once a press ends: shown, and no field of Margin's has it or asked for it.
    static func handsKeyboardBack(shown: Bool, hasKeyboard: Bool, wantsKeyboard: Bool) -> Bool { shown && !hasKeyboard && !wantsKeyboard }
    func pressEnded() {
        guard !options.harness else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pressSettle) { [weak self] in
            guard let self, Self.handsKeyboardBack(shown: self.isShown, hasKeyboard: self.hasKeyboard, wantsKeyboard: self.pageWantsKeyboard) else { return }
            self.returnKeyboard()
        }
    }
    // The browser made the active app again (it already is: this moves the keyboard back to its window).
    func returnKeyboard() {
        guard browserPid > 0, let browser = NSRunningApplication(processIdentifier: browserPid) else { return }
        keyboardReturned += 1
        if keyboardReturned == 1 || keyboardReturned % 200 == 0 { Diagnostics.note("\(key): the keyboard back to the browser after a press in Margin's UI (\(keyboardReturned) so far)") }
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
        pageWantsKeyboard = false // (nothing to tell a page that's gone)
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
