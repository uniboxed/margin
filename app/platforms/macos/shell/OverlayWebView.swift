// The overlay's page (dist/app/overlay.html, built from app/shared/host/: the UI
// runtime with the app's host, extension/ui/host-app.ts) in a web view, and
// its line to the app.
//
// OverlayWebView takes a press without first becoming key (WebKit takes no
// first click by default) and hears the pointer while Margin isn't the active
// app (WebKit's own tracking only while its window is key). Every overlay's
// page shares one configuration: margin-app://app/ serves the app's
// Resources/app/ folder (a fixed origin) with a Content Security Policy that
// allows no network at all (PLAN.md §4), content rules block every web load
// on top, nothing is kept on disk, and nothing but overlay.html loads in it.
//
// OverlayBridge answers the page (webkit.messageHandlers.margin, whose
// postMessage returns a promise of the reply), each web view's to its own
// overlay. What the app pushes in goes as one JSON string
// (marginApp.receive(json)), so nothing in it needs escaping.
//
// From feat/native-panel's PanelWebView, PanelSchemeHandler and PanelBridge.

import AppKit
import WebKit

final class OverlayWebView: WKWebView {
    private var always: NSTrackingArea?
    private var lastMove: TimeInterval = -1
    // A native key equivalent reaches here even while a Margin field owns the keyboard.
    // Reload belongs to the browser underneath, never to this layout's WebView.
    var reloadBrowserTab: ((_ repeating: Bool) -> Bool)?

    static func isBrowserReload(_ event: NSEvent) -> Bool {
        event.type == .keyDown
            && event.modifierFlags.intersection([.command, .shift, .option, .control]) == .command
            && event.charactersIgnoringModifiers?.lowercased() == "r"
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if Self.isBrowserReload(event), reloadBrowserTab?(event.isARepeat) == true { return true }
        return super.performKeyEquivalent(with: event)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func shouldDelayWindowOrdering(for event: NSEvent) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let always { removeTrackingArea(always) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        always = area
    }

    // While the overlay is key, WebKit's own tracking area sends the same move too: once each.
    override func mouseMoved(with event: NSEvent) {
        guard event.timestamp != lastMove else { return }
        lastMove = event.timestamp
        super.mouseMoved(with: event)
    }
}

// margin-app://app/<file>: a file of the overlay's folder, nothing else.
final class OverlaySchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "margin-app"
    static let page = URL(string: "margin-app://app/overlay.html")!
    // PLAN.md §4: scripts only Margin's own (this folder), styles adopted or
    // inline, images and fonts from data and blobs (a theme's bundled files),
    // no connections, no frames, nothing posted anywhere.
    static let policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
    private static let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8"]

    let root: URL
    init(root: URL) { self.root = root }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        let name = url.path.split(separator: "/").last.map(String.init) ?? ""
        let file = root.appendingPathComponent(name)
        guard url.host == "app", url.path == "/" + name, !name.hasPrefix("."), let type = Self.types[file.pathExtension],
              task.request.httpMethod == nil || task.request.httpMethod == "GET", let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: ["Content-Security-Policy": Self.policy])!)
            return task.didFinish()
        }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: [
            "Content-Type": type, "Content-Length": String(data.count), "Content-Security-Policy": Self.policy, "Cache-Control": "no-store",
        ])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

// What an overlay's page asks of the app (OverlayController answers).
protocol OverlayPageOwner: AnyObject {
    // The reply to { op: 'hello' }: the window, the state, the theme (JSON).
    func pageHello() -> String
    // { op: 'send' }: a request for the extension (the reply's body).
    func pageSend(type: String, payload: JSONObject) async throws -> JSONObject
    // Everything else ({ op: 'layout' | 'hits' | 'ready' | 'focus' | 'perform' | 'log' }).
    func pageSaid(_ op: String, _ body: JSONObject)
}

// The pages' messages, for every overlay's page (one configuration), each to its own overlay.
final class OverlayBridge: NSObject, WKScriptMessageHandlerWithReply {
    private var owners: [ObjectIdentifier: () -> OverlayPageOwner?] = [:]

    func register(_ webView: WKWebView, _ owner: OverlayPageOwner) {
        owners[ObjectIdentifier(webView)] = { [weak owner] in owner }
    }

    func unregister(_ webView: WKWebView) {
        owners[ObjectIdentifier(webView)] = nil
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let body = message.body as? JSONObject, let op = body["op"] as? String else { return replyHandler(nil, "not a message") }
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == OverlaySchemeHandler.scheme,
              let webView = message.webView, let owner = owners[ObjectIdentifier(webView)]?() else { return replyHandler(nil, "no overlay") }
        switch op {
        case "hello":
            replyHandler(owner.pageHello(), nil)
        case "send":
            guard let type = body["type"] as? String, (1...64).contains(type.count) else { return replyHandler(nil, "no type") }
            let payload = body["payload"] as? JSONObject ?? [:]
            Task {
                do {
                    let answer = try await owner.pageSend(type: type, payload: payload)
                    replyHandler(jsonString(answer), nil)
                } catch {
                    replyHandler(nil, "no answer from Margin: \(error)")
                }
            }
        default:
            owner.pageSaid(op, body)
            replyHandler(nil, nil)
        }
    }
}

// The one configuration every overlay's page is made with.
final class OverlayPages {
    let configuration: WKWebViewConfiguration
    let bridge = OverlayBridge()
    // The content rules (no web loads), once compiled.
    private(set) var rules: WKContentRuleList?
    private var waiting: [() -> Void] = []
    private var compiled = false

    // Every load a web view could make to the web, blocked (the scheme's own files aren't web loads).
    static let rulesJSON = #"""
    [{"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^ftp:"},"action":{"type":"block"}}]
    """#

    init(root: URL) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.suppressesIncrementalRendering = true
        configuration.setURLSchemeHandler(OverlaySchemeHandler(root: root), forURLScheme: OverlaySchemeHandler.scheme)
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "margin")
        configuration.preferences.isElementFullscreenEnabled = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        // Issue #14, both off unless set (`defaults write com.unibox.margin <name> -bool YES`, then Margin restarted):
        // MarginOverlayFullFrameRate draws the overlay at the display's rate (WebKit holds an app's web view near
        // 60 fps), MarginFrameProbe logs how often the overlay really draws while something moves. Measured first.
        if UserDefaults.standard.bool(forKey: "MarginOverlayFullFrameRate") {
            Diagnostics.note("overlay frame rate: \(OverlayFrameRate.uncap(configuration.preferences))")
        }
        if UserDefaults.standard.bool(forKey: "MarginFrameProbe") {
            configuration.userContentController.addUserScript(WKUserScript(source: OverlayFrameRate.probe, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .page))
        }
        self.configuration = configuration
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "margin-app-no-network", encodedContentRuleList: Self.rulesJSON) { [weak self] list, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let list {
                    self.rules = list
                    configuration.userContentController.add(list)
                } else {
                    Diagnostics.warn("the overlay's content rules didn't compile: \(error?.localizedDescription ?? "?") (the policy alone blocks loads)")
                }
                self.compiled = true
                for fn in self.waiting { fn() }
                self.waiting = []
            }
        }
    }

    // Once the content rules are in place (or failed: the Content Security Policy still holds).
    func ready(_ then: @escaping () -> Void) {
        if compiled { then() } else { waiting.append(then) }
    }

    // The app's own copy of the page (scripts/xcode-add-sources.py puts dist/app there).
    static var appRoot: URL { Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true) }

    func makeWebView(size: NSSize) -> OverlayWebView {
        let webView = OverlayWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.allowsMagnification = false
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        return webView
    }
}

// The overlay's frame rate (issue #14). WebKit draws a web view an app embeds near 60 times a second, even on a
// 120 Hz display (its PreferPageRenderingUpdatesNear60FPSEnabled, on by default and with no public switch), so the
// overlay's motion can look less smooth than the native animations around it. `uncap` turns that feature off
// through WKPreferences' private feature list (docs/PRIVATE-APIS.md); each step is checked, and anything missing
// leaves the cap as it is. `probe` is a page script that logs the gaps between the overlay's frames for 1.5 s
// after each press, wheel, key or animation: 8.3 ms is 120 Hz, 16.7 ms is 60.
enum OverlayFrameRate {
    static let feature = "PreferPageRenderingUpdatesNear60FPSEnabled"

    /// What happened, for the log: the display's rate, or why the cap stays.
    @MainActor static func uncap(_ preferences: WKPreferences) -> String {
        let cls: AnyClass = WKPreferences.self
        let list = NSSelectorFromString("_features")
        let set = NSSelectorFromString("_setEnabled:forFeature:")
        let get = NSSelectorFromString("_isEnabledForFeature:")
        guard (cls as AnyObject).responds(to: list), preferences.responds(to: set), preferences.responds(to: get),
              let setter = class_getInstanceMethod(cls, set), let getter = class_getInstanceMethod(cls, get),
              let features = (cls as AnyObject).perform(list)?.takeUnretainedValue() as? [NSObject] else {
            return "kept near 60 fps: WebKit's feature list isn't there"
        }
        let keyed = NSSelectorFromString("key")
        guard let target = features.first(where: { $0.responds(to: keyed) && ($0.value(forKey: "key") as? String) == feature }) else {
            return "kept near 60 fps: WebKit has no \(feature)"
        }
        typealias Set = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        typealias Get = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
        unsafeBitCast(method_getImplementation(setter), to: Set.self)(preferences, set, false, target)
        let still = unsafeBitCast(method_getImplementation(getter), to: Get.self)(preferences, get, target)
        return still ? "kept near 60 fps: \(feature) didn't turn off" : "the display's rate (\(feature) off)"
    }

    static let probe = #"""
    (() => {
      const post = (text) => { try { window.webkit.messageHandlers.margin.postMessage({ op: 'log', level: 'note', text }); } catch {} };
      let busy = false;
      const sample = (why) => {
        if (busy) return;
        busy = true;
        const gaps = [];
        requestAnimationFrame((first) => {
          let last = first;
          const end = first + 1500;
          const tick = (t) => {
            gaps.push(t - last);
            last = t;
            if (t < end) { requestAnimationFrame(tick); return; }
            busy = false;
            const sorted = [...gaps].sort((a, b) => a - b);
            const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
            const median = at(0.5);
            const hitches = gaps.filter((g) => g > median * 2.5).length;
            post(`frame probe (${why}): ${gaps.length} frames, median ${median.toFixed(1)} ms (${Math.round(1000 / median)} fps), 95th ${at(0.95).toFixed(1)} ms, longest ${sorted[sorted.length - 1].toFixed(1)} ms, ${hitches} longer than 2.5 frames`);
          };
          requestAnimationFrame(tick);
        });
      };
      for (const type of ['pointerdown', 'wheel', 'keydown']) addEventListener(type, () => sample(type), { capture: true, passive: true });
      for (const type of ['transitionstart', 'animationstart']) document.addEventListener(type, () => sample(type.replace('start', '')), true);
    })();
    """#
}
