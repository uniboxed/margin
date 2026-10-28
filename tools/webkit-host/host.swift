// A minimal Safari stand-in on WebKit's WKWebExtension engine (the extension engine Safari
// uses): one window, tabs that are visible, hidden (web view not in the window) or asleep
// (no web view, like a tab Safari unloaded). Runs a JSON scenario, prints what happens, and
// exits with 1 if a check failed. Usage: host <extension dir> <page server URL> <scenario.json>
// (tools/webkit-host/run.sh does all of it; see README.md). Never shows a window.
import Cocoa
import WebKit

let args = CommandLine.arguments
let extDir = URL(fileURLWithPath: args[1])
let base = args[2]
let scenario = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[3]))) as! [[String: Any]]
let t0 = Date()
func log(_ s: String) { print(String(format: "[%6.0f] ", Date().timeIntervalSince(t0) * 1000) + s); fflush(stdout) }
var failures = 0
func fail(_ label: String, _ why: String) { failures += 1; log("FAIL \(label): \(why)") }

// A page-world recorder in every frame: the page's own console errors and warnings, uncaught
// errors and CSP violations, kept in window.__pageLog (read with a "page" step).
let pageRecorder = """
  (() => { if (window.__pageLog) return; const log = window.__pageLog = []; const add = (kind, text) => { if (log.length < 300) log.push(kind + ' ' + String(text).slice(0, 300)); };
    for (const level of ['error', 'warn']) { const original = console[level]; console[level] = function (...a) { add(level, a.map((x) => { try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch { return String(x); } }).join(' ')); return original.apply(this, a); }; }
    addEventListener('error', (e) => add('uncaught', e.message));
    addEventListener('unhandledrejection', (e) => add('unhandled', e.reason && e.reason.message || e.reason));
    addEventListener('securitypolicyviolation', (e) => add('csp', e.effectiveDirective + ' ' + e.blockedURI));
  })();
  """

@MainActor final class Tab: NSObject, WKWebExtensionTab, WKNavigationDelegate {
  let name: String
  var url: URL
  var webView: WKWebView?
  weak var window: Win?
  var loadingObs: [NSKeyValueObservation] = []
  init(name: String, url: URL) { self.name = name; self.url = url }
  func makeWebView() {
    // Extension pages need the extension context's own configuration (that's
    // what gives them the browser.* APIs); web pages a plain one.
    let isExtensionPage = host.context.map { url.absoluteString.hasPrefix($0.baseURL.absoluteString) } ?? false
    let cfg = isExtensionPage ? host.context!.webViewConfiguration! : WKWebViewConfiguration()
    if !isExtensionPage { cfg.webExtensionController = host.controller }
    // Frame timing in every frame: when it was shown, and its first rendering updates after that.
    cfg.userContentController.addUserScript(WKUserScript(source: """
      (() => { window.__vis = []; const note = () => { const t = Math.round(performance.timeOrigin + performance.now()); window.__vis.push([document.hidden ? 'hidden' : 'shown', t]);
        if (!document.hidden) { let n = 0; const tick = () => { window.__vis.push(['frame', Math.round(performance.timeOrigin + performance.now())]); if (++n < 10) requestAnimationFrame(tick); }; requestAnimationFrame(tick); } };
        note(); document.addEventListener('visibilitychange', note); })();
      """, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    cfg.userContentController.addUserScript(WKUserScript(source: pageRecorder, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: cfg)
    wv.isInspectable = true
    wv.navigationDelegate = self
    webView = wv
    loadingObs = [
      wv.observe(\.isLoading, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { guard let self else { return }; host.controller.didChangeTabProperties([.loading], for: self) } },
      wv.observe(\.url, options: [.new]) { [weak self] wv, _ in MainActor.assumeIsolated { guard let self else { return }; if let u = wv.url { self.url = u }; host.controller.didChangeTabProperties([.URL], for: self) } },
      wv.observe(\.title, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { guard let self else { return }; host.controller.didChangeTabProperties([.title], for: self) } },
    ]
    wv.load(URLRequest(url: url))
  }
  // Every navigation, so reload loops and redirects show in the log.
  func webView(_ wv: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    let frame = action.targetFrame.map { $0.isMainFrame ? "top" : "frame" } ?? "new window"
    log("nav \(name) \(frame) \(action.navigationType.rawValue == 3 ? "reload" : "go") \(action.request.url?.absoluteString.prefix(1200) ?? "?")")
    decisionHandler(.allow)
  }
  func webView(_ wv: WKWebView, didCommit navigation: WKNavigation!) { log("nav \(name) committed \(wv.url?.absoluteString.prefix(1200) ?? "?")") }
  func webView(_ wv: WKWebView, didFinish navigation: WKNavigation!) { log("nav \(name) loaded \(wv.url?.absoluteString.prefix(1200) ?? "?")") }
  func webView(_ wv: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { log("nav \(name) failed \(error.localizedDescription)") }
  func webView(_ wv: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { log("nav \(name) failed early \(error.localizedDescription)") }
  func window(for context: WKWebExtensionContext) -> (any WKWebExtensionWindow)? { window }
  func indexInWindow(for context: WKWebExtensionContext) -> Int { window?.tabs.firstIndex(of: self) ?? 0 }
  func webView(for context: WKWebExtensionContext) -> WKWebView? { webView }
  func title(for context: WKWebExtensionContext) -> String? { webView?.title ?? name }
  func url(for context: WKWebExtensionContext) -> URL? { url }
  func isLoadingComplete(for context: WKWebExtensionContext) -> Bool { !(webView?.isLoading ?? false) }
  func isSelected(for context: WKWebExtensionContext) -> Bool { window?.active === self }
  // Page zoom (Safari's ⌘+ / tabs.setZoom): WebKit's pageZoom.
  func zoomFactor(for context: WKWebExtensionContext) -> Double { Double(webView?.pageZoom ?? 1) }
  func setZoomFactor(_ zoomFactor: Double, for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
    webView?.pageZoom = CGFloat(zoomFactor); completionHandler(nil)
  }
  func activate(for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
    log("delegate: activate \(name) (asleep=\(webView == nil))"); window?.show(self); completionHandler(nil)
  }
  func reload(fromOrigin: Bool, for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
    log("delegate: reload \(name) (asleep=\(webView == nil), shown=\(window?.active === self))")
    if webView == nil { makeWebView() } else { webView!.reload() }
    completionHandler(nil)
  }
}

@MainActor final class Win: NSObject, WKWebExtensionWindow {
  var tabs: [Tab] = []
  var active: Tab?
  let nsWindow: NSWindow
  override init() {
    nsWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
    super.init()
    // Off screen and never activated: tests run without showing anything.
    nsWindow.setFrameOrigin(NSPoint(x: -20000, y: -20000))
    nsWindow.orderBack(nil)
  }
  func show(_ tab: Tab) {
    let previous = active
    if previous === tab { return }
    previous?.webView?.removeFromSuperview()
    if tab.webView == nil { log("  \(tab.name) was asleep: loading it as it's shown"); tab.makeWebView() }
    nsWindow.contentView!.addSubview(tab.webView!)
    active = tab
    host.controller.didActivateTab(tab, previousActiveTab: previous)
    host.controller.didSelectTabs([tab])
    if let previous { host.controller.didDeselectTabs([previous]) }
  }
  func tabs(for context: WKWebExtensionContext) -> [any WKWebExtensionTab] { tabs }
  func activeTab(for context: WKWebExtensionContext) -> (any WKWebExtensionTab)? { active }
  func windowType(for context: WKWebExtensionContext) -> WKWebExtension.WindowType { .normal }
  func windowState(for context: WKWebExtensionContext) -> WKWebExtension.WindowState { .normal }
  func isPrivate(for context: WKWebExtensionContext) -> Bool { false }
  func frame(for context: WKWebExtensionContext) -> CGRect { nsWindow.frame }
  func screenFrame(for context: WKWebExtensionContext) -> CGRect { NSScreen.main?.frame ?? .zero }
  func focus(for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) { completionHandler(nil) }
}

@MainActor final class Host: NSObject, WKWebExtensionControllerDelegate {
  let controller = WKWebExtensionController(configuration: WKWebExtensionController.Configuration(identifier: UUID()))
  var context: WKWebExtensionContext?
  let window = Win()
  override init() { super.init(); controller.delegate = self }
  func webExtensionController(_ c: WKWebExtensionController, openWindowsFor x: WKWebExtensionContext) -> [any WKWebExtensionWindow] { [window] }
  func webExtensionController(_ c: WKWebExtensionController, focusedWindowFor x: WKWebExtensionContext) -> (any WKWebExtensionWindow)? { window }
  func webExtensionController(_ c: WKWebExtensionController, promptForPermissions p: Set<WKWebExtension.Permission>, in tab: (any WKWebExtensionTab)?, for x: WKWebExtensionContext, completionHandler: @escaping (Set<WKWebExtension.Permission>, Date?) -> Void) {
    log("PROMPT permissions \(p)"); completionHandler(p, nil)
  }
  func webExtensionController(_ c: WKWebExtensionController, promptForPermissionToAccess urls: Set<URL>, in tab: (any WKWebExtensionTab)?, for x: WKWebExtensionContext, completionHandler: @escaping (Set<URL>, Date?) -> Void) {
    log("PROMPT access \(urls.map(\.host!))"); completionHandler(urls, nil)
  }
  func webExtensionController(_ c: WKWebExtensionController, promptForPermissionMatchPatterns p: Set<WKWebExtension.MatchPattern>, in tab: (any WKWebExtensionTab)?, for x: WKWebExtensionContext, completionHandler: @escaping (Set<WKWebExtension.MatchPattern>, Date?) -> Void) {
    log("PROMPT patterns \(p)"); completionHandler(p, nil)
  }
  func install(sameId: Bool = false) async throws {
    let ext = try await WKWebExtension(resourceBaseURL: extDir)
    let ctx = WKWebExtensionContext(for: ext)
    if sameId { ctx.uniqueIdentifier = "margin-fixed-id" }
    ctx.isInspectable = true
    for p in ext.requestedPermissions { ctx.setPermissionStatus(.grantedExplicitly, for: p) }
    ctx.setPermissionStatus(.grantedExplicitly, for: WKWebExtension.MatchPattern.allURLs())
    try controller.load(ctx)
    context = ctx
    controller.didOpenWindow(window)
    controller.didFocusWindow(window)
    log("installed \(ctx.uniqueIdentifier)")
    // What WebKit made of the manifest: its errors, and the commands' shortcuts.
    for error in ext.errors { log("manifest error: \(error.localizedDescription)") }
    for command in ctx.commands {
      log("command \(command.id): key=\(command.activationKey ?? "-") modifiers=\(command.modifierFlags.rawValue)")
    }
  }
  func uninstall() throws { if let ctx = context { try controller.unload(ctx); log("uninstalled"); context = nil } }
  func world() -> WKContentWorld? { context.map { WKContentWorld.world(name: "WebExtension-\($0.uniqueIdentifier)") } }
  func tab(_ name: String) -> Tab? { window.tabs.first { $0.name == name } }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let host = MainActor.assumeIsolated { Host() }

Task { @MainActor in
  for step in scenario {
    let op = step["op"] as! String
    switch op {
    case "open":
      let path = step["url"] as! String
      // "ext:<path>": a page of the installed extension (e.g. its new-tab page); a full URL
      // (a real website); else a test page of server.mjs.
      let url = path.hasPrefix("ext:") ? URL(string: String(path.dropFirst(4)), relativeTo: host.context!.baseURL)!.absoluteURL
        : path.contains("://") ? URL(string: path)! : URL(string: base + path)!
      let t = Tab(name: step["name"] as! String, url: url)
      t.window = host.window
      host.window.tabs.append(t)
      if (step["asleep"] as? Bool) != true { t.makeWebView() }
      if host.context != nil { host.controller.didOpenTab(t) }
      if (step["active"] as? Bool) == true { host.window.show(t) }
      log("opened \(t.name)\((step["asleep"] as? Bool) == true ? " (asleep)" : "")")
    case "sleep":
      // Safari unloading a hidden tab: its web view goes away.
      let t = host.tab(step["name"] as! String)!
      t.webView?.removeFromSuperview(); t.webView = nil; t.loadingObs = []
      log("put \(t.name) to sleep")
    case "install": try! await host.install(sameId: (step["sameId"] as? Bool) == true)
    case "uninstall": try! host.uninstall()
    case "deny":
      // A per-site permission change in Safari's settings.
      if let ctx = host.context, let p = try? WKWebExtension.MatchPattern(string: step["pattern"] as! String) { ctx.setPermissionStatus(.deniedExplicitly, for: p); log("denied \(step["pattern"] as! String)") }
    case "wait": try? await Task.sleep(nanoseconds: UInt64((step["ms"] as! Int) * 1_000_000))
    case "eval":
      // In Margin's content-script world of a tab (as if its sidebar did it).
      let t = host.tab(step["in"] as! String)!
      guard let wv = t.webView, let world = host.world() else { log("eval: no web view or world"); break }
      do {
        let r = try await wv.callAsyncJavaScript(step["js"] as! String, arguments: [:], in: nil, contentWorld: world)
        log("eval in \(t.name): \(String(describing: r ?? "undefined"))")
      } catch { log("eval in \(t.name) failed: \(error.localizedDescription)") }
    case "page":
      // In the page's own world.
      let t = host.tab(step["in"] as! String)!
      guard let wv = t.webView else { log("page: \(t.name) has no web view"); break }
      do {
        let r = try await wv.callAsyncJavaScript(step["js"] as! String, arguments: [:], in: nil, contentWorld: .page)
        log("page \(t.name): \(String(describing: r ?? "nil"))")
      } catch { log("page \(t.name) failed: \(error)") }
    case "key":
      // { op: 'key', in, chars, keyCode, mods: ['command','option','control','shift'] }: a real key
      // press (keyDown, keyUp) into the tab's web view, as the keyboard would send it.
      let t = host.tab(step["in"] as! String)!
      guard let wv = t.webView else { log("key: \(t.name) has no web view"); break }
      var flags: NSEvent.ModifierFlags = []
      for m in (step["mods"] as? [String] ?? []) {
        switch m { case "command": flags.insert(.command); case "option": flags.insert(.option); case "control": flags.insert(.control); case "shift": flags.insert(.shift); default: break }
      }
      let chars = step["chars"] as! String
      let code = UInt16(step["keyCode"] as! Int)
      if [123, 124, 125, 126].contains(code) { flags.insert(.numericPad); flags.insert(.function) }
      host.window.nsWindow.makeFirstResponder(wv)
      for type in [NSEvent.EventType.keyDown, .keyUp] {
        let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: host.window.nsWindow.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
        if type == .keyDown { if !wv.performKeyEquivalent(with: e) { wv.keyDown(with: e) } } else { wv.keyUp(with: e) }
      }
      log("key \(t.name): \(step["mods"] ?? []) \(code)")
    case "hidewin":
      // Take a tab's web view out of the window without showing another (like Safari hiding it).
      let t = host.tab(step["name"] as! String)!; t.webView?.removeFromSuperview(); log("took \(t.name) out of the window")
    case "mark":
      log("MARK \(step["label"] as! String)")
    case "check", "checkPage":
      // Waits until `js` returns true (in Margin's content-script world for "check", the
      // page's for "checkPage"), up to `timeout` ms (default 3000), then PASS or FAIL.
      let t = host.tab(step["in"] as! String)!
      let js = step["js"] as! String
      let label = step["label"] as? String ?? js
      let deadline = Date().addingTimeInterval(Double(step["timeout"] as? Int ?? 3000) / 1000)
      var last = "nil"
      while true {
        if let wv = t.webView, let world = op == "check" ? host.world() : .page {
          do {
            let r = try await wv.callAsyncJavaScript(js, arguments: [:], in: nil, contentWorld: world)
            if (r as? Bool) == true { log("PASS \(label)"); break }
            last = String(describing: r ?? "nil")
          } catch { last = error.localizedDescription }
        } else { last = "no web view or extension" }
        if Date() > deadline { fail(label, last); break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
    case "zoom": // { op: 'zoom', factor }: the shown tab's page zoom, as ⌘+ / ⌘− do
      host.window.active?.webView?.pageZoom = CGFloat(step["factor"] as! Double); log("zoom \(step["factor"]!)")
    case "state":
      log("state: active=\(host.window.active?.name ?? "-") " + host.window.tabs.map { "\($0.name):\($0.webView == nil ? "asleep" : ($0.webView!.superview == nil ? "hidden" : "shown"))" }.joined(separator: " "))
    case "snapshot":
      if let wv = host.window.active?.webView, let img = try? await wv.takeSnapshot(configuration: nil) {
        let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
        try? rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: step["file"] as! String))
        log("snapshot \(step["file"] as! String)")
      }
    default: log("unknown op \(op)")
    }
  }
  log(failures == 0 ? "all checks passed" : "\(failures) check(s) failed")
  exit(failures == 0 ? 0 : 1)
}
// A whole run's time limit in seconds (MARGIN_HOST_TIMEOUT, default 120).
let limit = Double(ProcessInfo.processInfo.environment["MARGIN_HOST_TIMEOUT"] ?? "") ?? 120
DispatchQueue.main.asyncAfter(deadline: .now() + limit) { log("TIMEOUT"); exit(1) }
app.run()
