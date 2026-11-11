// Owned off-screen WebKit allocation experiment, no browser or screen capture.
// This first probe establishes process reuse/isolation, not product acceptance.
import AppKit
import WebKit
import ObjectiveC

#if MARGIN_THEMED_COVER_PROBE
@MainActor final class MemoryPageOwner: OverlayPageOwner {
    let hello: String
    var ready = false
    var failed = false
    init(_ hello: String) { self.hello = hello }
    func pageHello() -> String { hello }
    func pageSend(type: String, payload: JSONObject) async throws -> JSONObject { throw LinkError.down }
    func pageSaid(_ op: String, _ body: JSONObject) {
        if op == "ready" || op == "cover.prepared" { ready = true }
        if op == "cover.failed" { failed = true }
    }
}
#endif

@MainActor final class MemoryScheme: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == "margin-memory", url.host == "app" else { return }
        let label = url.lastPathComponent
        let rows = (0..<80).map { "<div class='row'>Saved tab \($0)</div>" }.joined()
        let html = """
        <!doctype html><meta charset=utf-8><style>
        body{margin:0;background:#18222b;color:white;font:14px system-ui}
        aside{position:absolute;width:260px;inset:12px auto 12px 12px;overflow:hidden;background:#26323d;border-radius:12px}
        .row{padding:10px;border-bottom:1px solid #384957}main{position:absolute;inset:12px 12px 12px 284px;border-radius:12px;background:#344350}
        .pulse{position:absolute;width:24px;height:24px;left:50%;top:50%;background:#adcbea;animation:pulse 1s infinite alternate}
        @keyframes pulse{to{transform:scale(.7) rotate(90deg);opacity:.3}}
        </style><aside>\(rows)</aside><main><div class=pulse></div></main>
        <script>window.identity='\(label)';window.ready=true;</script>
        """
        let data = Data(html.utf8)
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "text/html", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'"])!)
        task.didReceive(data); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

@main enum CoverMemoryProbe {
    static var windows: [NSPanel] = []
    static var mode = "isolated"
    #if MARGIN_THEMED_COVER_PROBE
    static var pages: OverlayPages!
    static var hello = ""
    static var owners: [ObjectIdentifier: MemoryPageOwner] = [:]
    #if MARGIN_NATIVE_PREPARED_MEMORY_PROBE
    static var nativeCover: NativeHandoffCover?
    static weak var preparedView: WKWebView?
    #endif
    #endif
    static var getter: (@convention(c) (AnyObject, Selector) -> Int32)?
    static let pidSelector = NSSelectorFromString("_webProcessIdentifier")
    static var occlusion: (@convention(c) (AnyObject, Selector, UInt8) -> Void)?
    static let occlusionSelector = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")

    static func emit(_ event: String, _ extra: [String: Any] = [:]) {
        var row: [String: Any] = ["event": event, "at": Date().timeIntervalSince1970 * 1000,
            "mono": ProcessInfo.processInfo.systemUptime, "pid": ProcessInfo.processInfo.processIdentifier, "mode": mode]
        row.merge(extra) { _, new in new }
        if let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
        }
    }
    static func pause(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) }
    static func js(_ view: WKWebView, _ script: String) async -> Any? {
        try? await view.evaluateJavaScript(script)
    }
    static func process(_ view: WKWebView) -> Int32 { getter?(view, pidSelector) ?? 0 }
    static func cleanup() {
        #if MARGIN_NATIVE_PREPARED_MEMORY_PROBE
        _ = nativeCover?.end(.cancelled)
        #endif
        for panel in windows { panel.alphaValue = 0; panel.orderOut(nil); panel.close() }
        windows = []; CATransaction.flush()
    }
    static func require(_ ok: Bool, _ why: String) {
        if !ok { emit("failed", ["reason": why]); cleanup(); exit(1) }
    }
    static func checkMethods() {
        guard let pm = class_getInstanceMethod(WKWebView.self, pidSelector),
              let pe = method_getTypeEncoding(pm), String(cString: pe) == "i16@0:8",
              let om = class_getInstanceMethod(WKWebView.self, occlusionSelector), let oe = method_getTypeEncoding(om),
              ["v20@0:8B16", "v20@0:8c16"].contains(String(cString: oe)) else { require(false, "lab selectors unavailable/changed"); return }
        getter = unsafeBitCast(method_getImplementation(pm), to: (@convention(c) (AnyObject, Selector) -> Int32).self)
        occlusion = unsafeBitCast(method_getImplementation(om), to: (@convention(c) (AnyObject, Selector, UInt8) -> Void).self)
    }
    static func related(_ configuration: WKWebViewConfiguration, _ view: WKWebView) {
        let set = NSSelectorFromString("_setRelatedWebView:"), get = NSSelectorFromString("_relatedWebView")
        guard let sm = class_getInstanceMethod(WKWebViewConfiguration.self, set), let gm = class_getInstanceMethod(WKWebViewConfiguration.self, get),
              let se = method_getTypeEncoding(sm), let ge = method_getTypeEncoding(gm),
              String(cString: se) == "v24@0:8@16", String(cString: ge) == "@16@0:8" else { require(false, "related-view ABI unavailable/changed"); return }
        require(configuration.websiteDataStore === view.configuration.websiteDataStore, "different data store")
        let setter = unsafeBitCast(method_getImplementation(sm), to: (@convention(c) (AnyObject, Selector, AnyObject?) -> Void).self)
        let getter = unsafeBitCast(method_getImplementation(gm), to: (@convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?).self)
        setter(configuration, set, view)
        require(getter(configuration, get)?.takeUnretainedValue() === view, "related view not acknowledged")
    }
    static func create(_ base: WKWebViewConfiguration, label: String, anchor: WKWebView? = nil) async -> (NSPanel, WKWebView) {
        let configuration = base.copy() as! WKWebViewConfiguration
        if let anchor { related(configuration, anchor) }
        let size = NSSize(width: 1512, height: 949)
        let panel = NSPanel(contentRect: NSRect(origin: NSPoint(x: -30000, y: -30000), size: size),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false; panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.transient, .stationary, .ignoresCycle]
        panel.alphaValue = 0; windows.append(panel)
        require(!NSScreen.screens.contains { $0.frame.intersects(panel.frame) }, "panel intersects an actual display")
        #if MARGIN_THEMED_COVER_PROBE
        let view = pages.makeWebView(size: size, configuration: configuration)
        let owner = MemoryPageOwner(hello)
        owners[ObjectIdentifier(view)] = owner
        pages.bridge.register(view, owner)
        #else
        let view = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        #endif
        occlusion?(view, occlusionSelector, 0)
        panel.contentView = view
        panel.orderFrontRegardless(); panel.displayIfNeeded(); CATransaction.flush()
        let id = panel.windowNumber
        let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(id)) as? [[String: Any]]
        let row = list?.first
        let values = row?[kCGWindowBounds as String] as? [String: Double]
        let bounds: CGRect? = values.flatMap { value in
            guard let x = value["X"], let y = value["Y"], let w = value["Width"], let h = value["Height"] else { return nil }
            return CGRect(x: x, y: y, width: w, height: h)
        }
        let displays = NSScreen.screens.compactMap { screen -> CGRect? in
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return CGDisplayBounds(id.uint32Value)
        }
        require(row?[kCGWindowOwnerPID as String] as? Int == Int(ProcessInfo.processInfo.processIdentifier)
            && !displays.isEmpty && bounds.map { rect in !displays.contains { $0.intersects(rect) } } == true,
            "owned window not independently off screen")
        panel.alphaValue = 1; CATransaction.flush()
        #if MARGIN_THEMED_COVER_PROBE
        view.load(URLRequest(url: label == "cover" ? NativeHandoffCover.page : OverlaySchemeHandler.page))
        #else
        view.load(URLRequest(url: URL(string: "margin-memory://app/\(label)")!))
        #endif
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        while ProcessInfo.processInfo.systemUptime < deadline {
            #if MARGIN_THEMED_COVER_PROBE
            if owner.ready || owner.failed { break }
            #else
            if await js(view, "window.ready === true") as? Bool == true { break }
            #endif
            await pause(0.02)
        }
        #if MARGIN_THEMED_COVER_PROBE
        require(owner.ready && !owner.failed, "real theme page did not prepare")
        _ = await js(view, "window.identity='\(label)'")
        #endif
        require(await js(view, "window.identity") as? String == label && process(view) > 0, "owned page did not load")
        return (panel, view)
    }
    static func dispose(_ panel: NSPanel, _ view: WKWebView) {
        panel.orderOut(nil); CATransaction.flush(); occlusion?(view, occlusionSelector, 1)
        #if MARGIN_THEMED_COVER_PROBE
        pages.bridge.unregister(view); owners[ObjectIdentifier(view)] = nil
        #endif
        view.stopLoading(); view.removeFromSuperview(); panel.contentView = nil; panel.close()
        windows.removeAll { $0 === panel }
    }
    static func cycle(_ base: WKWebViewConfiguration, a: WKWebView, b: WKWebView, round: Int) async {
        emit("cover_begin", ["round": round])
        #if MARGIN_NATIVE_PREPARED_MEMORY_PROBE
        preparedView = nil
        let context = LiveCoverContext(hello: hello,
            display: CGRect(x: -20000, y: -20000, width: 1512, height: 949),
            viewport: CGRect(x: 0, y: 0, width: 1512, height: 949))
        nativeCover!.prepare(context)
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        while nativeCover?.state == .preparing, ProcessInfo.processInfo.systemUptime < deadline { await pause(0.02) }
        require(nativeCover?.state == .prepared, "actual Native preparation failed")
        guard let c = preparedView else { require(false, "native view not observed"); return }
        require(c.window.map { panel in !panel.isVisible && !NSScreen.screens.contains { $0.frame.intersects(panel.frame) } } == true,
            "native prepared panel is not safely off screen and hidden")
        let modeVerified = nativeCover!.validationStatus.contains(mode == "related" ? "; renderer shared" : "; renderer isolated")
        require(modeVerified, "native renderer did not acknowledge requested mode")
        #else
        let (pc, c) = await create(base, label: "cover", anchor: mode == "related" ? a : nil)
        #endif
        require(mode == "related" ? process(c) == process(a) : process(c) != process(a) && process(c) != process(b), "actual process grouping differs from requested mode")
        require(await js(c, "window.opener === null") as? Bool == true, "cover has an opener")
        _ = await js(c, "window.identity='cover-changed'")
        let aIdentity = await js(a, "window.identity") as? String
        let bIdentity = await js(b, "window.identity") as? String
        require(aIdentity == "layout-a" && bIdentity == "layout-b", "page globals leaked")
        let dpr = await js(c, "window.devicePixelRatio") as? Double ?? 0
        emit("cover_ready", ["round": round, "a": process(a), "b": process(b), "cover": process(c),
                             "device_pixel_ratio": dpr, "backing_scale": c.window?.backingScaleFactor ?? 0])
        await pause(3)
        #if MARGIN_NATIVE_PREPARED_MEMORY_PROBE
        require(nativeCover!.end(.cancelled), "native cleanup refused")
        require(pages.bridge.registrationCount == 2, "native bridge registration leaked")
        emit("native_clean", ["round": round, "audit": nativeCover!.validationStatus])
        #else
        dispose(pc, c)
        #endif
    }
    static func run() async {
        checkMethods()
        #if MARGIN_THEMED_COVER_PROBE
        let base = pages.configuration
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in pages.ready { done.resume() } }
        #else
        let base = WKWebViewConfiguration()
        base.websiteDataStore = .nonPersistent()
        base.preferences.javaScriptCanOpenWindowsAutomatically = false
        base.setURLSchemeHandler(MemoryScheme(), forURLScheme: "margin-memory")
        #endif
        let (pa, a) = await create(base, label: "layout-a")
        let (pb, b) = await create(base, label: "layout-b")
        #if MARGIN_NATIVE_PREPARED_MEMORY_PROBE
        let raw = CoverPresentationIO.real()
        require(raw.reason == nil, "native presentation capability unavailable")
        let noSpaceWrites = LiveCoverSpaceIO(owns: { _ in false }, create: { nil }, level: { _ in false },
            readLevel: { _ in nil }, add: { _, _ in false }, show: { _ in false }, hide: { _ in false },
            hideWindow: { _ in false }, destroy: { _ in false }, spaces: { _ in nil })
        let presentation = CoverPresentation(io: CoverPresentationIO(reason: raw.reason, read: { object in
            if let view = object as? WKWebView, view !== a, view !== b { preparedView = view }
            return raw.read(object)
        }, write: raw.write))
        let renderer = mode == "related" ? CoverRenderer() : CoverRenderer(io: CoverRendererIO(reason: "probe control", relate: { _, _ in false }, process: { _ in nil }))
        nativeCover = NativeHandoffCover(pages: pages, io: noSpaceWrites, sessionAllowed: { true },
            presentation: presentation, layoutViews: { [a, b] }, renderer: renderer)
        #endif
        emit("baseline", ["a": process(a), "b": process(b)])
        require(process(a) != process(b), "baseline views unexpectedly share; comparison invalid")
        await pause(4)
        let rounds = Int(ProcessInfo.processInfo.environment["MARGIN_MEMORY_ROUNDS"] ?? "4") ?? 0
        let idleSeconds = Double(ProcessInfo.processInfo.environment["MARGIN_MEMORY_IDLE_SECONDS"] ?? "4") ?? 0
        require((1...30).contains(rounds) && (4...60).contains(idleSeconds), "invalid bounded experiment length")
        for round in 1...rounds {
            await cycle(base, a: a, b: b, round: round)
            #if MARGIN_NATIVE_PREPARED_MEMORY_PROBE
            let deadline = ProcessInfo.processInfo.systemUptime + 2
            while preparedView != nil, ProcessInfo.processInfo.systemUptime < deadline { await pause(0.02) }
            require(preparedView == nil, "native cover WebView retained after cleanup")
            #endif
            emit("cover_end", ["round": round])
            await pause(3)
        }
        let aIdentity = await js(a, "window.identity") as? String
        let bIdentity = await js(b, "window.identity") as? String
        require(aIdentity == "layout-a" && bIdentity == "layout-b", "source page did not survive")
        emit("post_idle"); await pause(idleSeconds)
        dispose(pa, a); dispose(pb, b)
        emit("complete"); cleanup(); exit(0)
    }
    static func main() {
        let args = CommandLine.arguments
        guard args.contains("--go"), let m = args.last, ["isolated", "related"].contains(m) else {
            print("Dry run only: --go isolated|related; owns entirely off-screen panels, no browser; four allocation rounds, about35s. Not a product performance/visual acceptance run."); return
        }
        mode = m
        require(ProcessInfo.processInfo.environment["MARGIN_APP_TESTS"] == nil, "refused under app tests")
        let app = NSApplication.shared; app.setActivationPolicy(.accessory)
        #if MARGIN_THEMED_COVER_PROBE
        guard let fixture = ProcessInfo.processInfo.environment["MARGIN_MEMORY_HELLO"],
              let content = try? String(contentsOfFile: fixture, encoding: .utf8),
              let root = ProcessInfo.processInfo.environment["MARGIN_MEMORY_ROOT"] else { print("requires owned synthetic fixture/root"); exit(2) }
        hello = content
        pages = OverlayPages(root: URL(fileURLWithPath: root))
        #endif
        Task { await run() }
        app.run()
    }
}
