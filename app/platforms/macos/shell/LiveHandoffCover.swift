// Issue #15's optional live protection, independent of Freezer and its 1.7 s rules.
// Only one temporary own panel/WebView exists during a requested switch. It uses
// the same no-network configuration and sanitized theme renderer as the layout,
// with a read-only bridge. Nothing here creates or drives a browser window.
import AppKit
import WebKit

final class LiveCoverPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class NativeHandoffCover: NSObject, HandoffCover, OverlayPageOwner, WKNavigationDelegate {
    static let page = URL(string: "margin-app://app/handoff-cover.html")!
    static let hardLimit: TimeInterval = 20 // last resort if recovery/main actor cannot progress
    private(set) var state: LiveCoverState = .idle
    var onEmergency: (() -> Void)?
    var windowNumbers: Set<Int> { panel.map { [$0.windowNumber] } ?? [] }
    private let pages: OverlayPages
    private let io: LiveCoverSpaceIO
    private let sessionAllowed: () -> Bool
    private let presentation: CoverPresentation
    private let layoutViews: () -> [WKWebView]
    private let renderer: CoverRenderer
    var presentationReason: String? { presentation.reason }
    private var context: LiveCoverContext?
    private var panel: NSPanel?
    private var webView: WKWebView?
    private var lease: LiveCoverSpace?
    private let failedSpaces = CoverSpaceCleanup()
    private var generation = 0
    private var showingAt: Double = 0
    private var check: Timer?
    private var watchdog: DispatchSourceTimer?
    private var started: Double = 0
    private var pageVisible = false
    private var pageShown = false
    private var cleanupFailures = 0
    private var createdWindows = 0, disposedWindows = 0, lastWindow = 0
    var validationStatus: String {
        "live cover audit: state \(state), windows \(windowNumbers.count), views \(webView == nil ? 0 : 1), spaces \((lease == nil ? 0 : 1) + failedSpaces.count), presentation \(presentation.count), timers \((check == nil ? 0 : 1) + (watchdog == nil ? 0 : 1)), cleanup failures \(cleanupFailures); created \(createdWindows), disposed \(disposedWindows), last window \(lastWindow); renderer \(renderer.detail)"
    }

    init(pages: OverlayPages, io: LiveCoverSpaceIO, sessionAllowed: @escaping () -> Bool = { SessionVisibility.allowsCover },
         presentation: CoverPresentation? = nil, layoutViews: @escaping () -> [WKWebView] = { [] }, renderer: CoverRenderer? = nil) {
        self.pages = pages; self.io = io; self.sessionAllowed = sessionAllowed
        self.presentation = presentation ?? CoverPresentation(io: .real()); self.layoutViews = layoutViews
        self.renderer = renderer ?? CoverRenderer()
    }

    func prepare(_ context: LiveCoverContext) {
        guard end(.cancelled) else { state = .failed("previous cleanup unverified"); return }
        guard sessionAllowed() else { state = .failed("session is locked or unavailable"); return }
        self.context = context
        state = .preparing
        pageVisible = false
        pageShown = false
        started = Diagnostics.now()
        let token = generation
        let p = LiveCoverPanel(contentRect: CGRect(x: -20000, y: -20000, width: context.display.width, height: context.display.height),
                               styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isReleasedWhenClosed = false
        p.isOpaque = true
        p.backgroundColor = .windowBackgroundColor
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.hidesOnDeactivate = false
        p.animationBehavior = .none
        p.collectionBehavior = [.stationary, .ignoresCycle]
        p.alphaValue = 0
        let layouts = layoutViews()
        let configuration = renderer.configuration(base: pages.configuration, views: layouts)
        let view = pages.makeWebView(size: context.viewport.size, configuration: configuration)
        // Before the actual visibility transitions: the setter itself does not
        // trigger a visibility update. Object identity survives overlay handover.
        guard presentation.hold(view), layouts.allSatisfy({ presentation.hold($0) }) else {
            fail("WebKit cover presentation unavailable")
            p.close()
            return
        }
        view.frame = context.viewport
        let content = NSView(frame: CGRect(origin: .zero, size: context.display.size))
        content.addSubview(view)
        p.contentView = content
        panel = p; webView = view
        createdWindows += 1; lastWindow = p.windowNumber
        view.navigationDelegate = self
        pages.bridge.register(view, self)
        pages.ready { [weak self, weak view] in
            guard let self, self.generation == token else { return }
            view?.load(URLRequest(url: Self.page))
        }
    }

    func activate(_ done: @escaping (Bool) -> Void) {
        guard state == .prepared, let panel, let context else { return done(false) }
        guard sessionAllowed() else { fail("session is locked or unavailable"); return done(false) }
        state = .showing
        panel.setFrame(context.display, display: false)
        panel.orderFrontRegardless() // alpha zero until the own Space is verified
        panel.displayIfNeeded()
        CATransaction.flush() // commit the owned window's registration before querying its owner
        let failed = failedSpaces
        switch LiveCoverSpace.open(window: UInt32(panel.windowNumber), io: io, onFailedCleanup: { failed.retain($0) }) {
        case .failure(let why):
            fail("Space setup \(why.rawValue)")
            return done(false)
        case .success(let lease):
            self.lease = lease
        }
        let token = generation
        armWatchdog(token) // armed before any synchronous verification or visible panel
        showingAt = Diagnostics.now()
        check = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in MainActor.assumeIsolated {
            guard let self, self.generation == token else { return }
            guard let lease = self.lease, !lease.isHidden, Diagnostics.now() - self.showingAt < 0.3 else {
                self.fail("visibility not verified")
                return done(false)
            }
            if !self.pageShown, lease.isReady {
                guard !lease.isHidden, Diagnostics.now() - self.showingAt < 0.3, self.sessionAllowed() else {
                    self.fail("cover verification interrupted")
                    return done(false)
                }
                self.pageShown = true
                self.panel?.alphaValue = 1
                self.panel?.displayIfNeeded()
                CATransaction.flush()
                self.webView?.evaluateJavaScript("window.marginCover.shown()") { [weak self] _, error in
                    guard let self, self.generation == token, error != nil, self.state == .showing else { return }
                    self.fail("visible frame request failed")
                    done(false)
                }
            }
            if self.pageVisible && self.visible() {
                self.check?.invalidate(); self.check = nil
                self.state = .shown
                Diagnostics.note("live cover ready in \(Diagnostics.ms(since: self.started))")
                done(true)
            }
        } }
    }

    private func visible() -> Bool {
        guard let panel, let lease, let context, lease.isReady,
              let row = CGWindowSource().windows(of: [ProcessInfo.processInfo.processIdentifier]).first(where: { $0.number == panel.windowNumber }),
              row.onScreen, row.alpha > 0 else { return false }
        let expected = ScreenGeometry.appKitRect(context.display)
        return abs(row.bounds.minX - expected.minX) <= 1 && abs(row.bounds.minY - expected.minY) <= 1
            && abs(row.bounds.width - expected.width) <= 1 && abs(row.bounds.height - expected.height) <= 1
    }

    private func armWatchdog(_ token: Int) {
        guard let lease else { return }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "margin.live-cover-watchdog", qos: .userInitiated))
        timer.schedule(deadline: .now() + Self.hardLimit)
        timer.setEventHandler { [weak self, lease] in
            let hidden = lease.hide() // no AppKit call on this queue
            Task { @MainActor [weak self] in
                guard let self, self.generation == token else { return }
                _ = self.end(.watchdog)
                self.state = .failed("emergency watchdog")
                Diagnostics.warn("live cover emergency watchdog: hidden \(hidden); degraded recovery")
                self.onEmergency?()
            }
        }
        watchdog = timer
        timer.resume()
    }

    func recovering() { webView?.evaluateJavaScript("window.marginCover?.recovering()", completionHandler: nil) }

    // A newly linked/created target has no view during prepare(). Hold it before
    // its window is shown; no background view is held outside this cover's life.
    func keepRendering(_ view: WKWebView) -> Bool {
        guard [.preparing, .prepared, .showing, .shown].contains(state) else { return true }
        guard presentation.hold(view) else {
            fail("destination presentation unavailable")
            onEmergency?()
            return false
        }
        return true
    }

    @discardableResult func end(_ why: RevealWhy) -> Bool {
        generation += 1
        check?.invalidate(); check = nil
        watchdog?.cancel(); watchdog = nil
        panel?.orderOut(nil) // before Space destruction: never return a visible panel to Desktop
        CATransaction.flush()
        var rendered = presentation.restore()
        for _ in 0..<2 where !rendered { rendered = presentation.restore() }
        var closed = lease?.close() ?? true
        for _ in 0..<2 where !closed { closed = lease?.close() ?? true }
        let failedClean = failedSpaces.retry()
        let ok = rendered && closed && failedClean
        if closed { lease = nil } // retain an unverified own Space for the next bounded cleanup attempt
        if let webView { pages.bridge.unregister(webView); webView.navigationDelegate = nil; webView.stopLoading(); webView.removeFromSuperview() }
        if let panel { panel.close(); disposedWindows += 1 }
        panel = nil; webView = nil; context = nil
        renderer.detach()
        state = ok ? .idle : .failed("cleanup unverified")
        if !ok { cleanupFailures += 1; Diagnostics.warn("live cover cleanup refused: live cover must be disabled for this session") }
        return ok
    }

    private func fail(_ why: String) { _ = end(.failed); state = .failed(why); Diagnostics.warn("live cover refused: \(why)") }
    func pageHello() -> String { context?.hello ?? "null" }
    func pageSend(type: String, payload: JSONObject) async throws -> JSONObject { throw LinkError.down }
    func pageSaid(_ op: String, _ body: JSONObject) {
        if op == "cover.prepared", state == .preparing {
            if let webView { renderer.prepared(webView) }
            Diagnostics.note("live cover renderer: \(renderer.detail)")
            state = .prepared
        }
        if op == "cover.visible", state == .showing { pageVisible = true }
        if op == "cover.failed" { fail("theme could not draw the switch") }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url == Self.page && action.targetFrame?.isMainFrame == true ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if webView === self.webView { fail("page load failed") } }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if webView === self.webView { fail("page load failed") } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if webView === self.webView { fail("page process ended"); onEmergency?() } }
}
