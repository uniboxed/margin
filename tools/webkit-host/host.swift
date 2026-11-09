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
// JavaScript in a web view, given up on after `ms`: a page that never answers (busy for good, or held by
// something nothing here answers: a real site's) fails that step and the run goes on.
struct NoAnswer: LocalizedError { let ms: Double; var errorDescription: String? { "no answer in \(Int(ms)) ms" } }
@MainActor func inPage(_ wv: WKWebView, _ js: String, _ world: WKContentWorld, within ms: Double) async throws -> Any? {
  try await withCheckedThrowingContinuation { (answer: CheckedContinuation<Any?, Error>) in
    var done = false
    let finish: @MainActor (Result<Any?, Error>) -> Void = { result in
      guard !done else { return }
      done = true
      answer.resume(with: result)
    }
    wv.callAsyncJavaScript(js, arguments: [:], in: nil, in: world) { result in finish(result.map { $0 as Any? }) }
    DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000) { MainActor.assumeIsolated { finish(.failure(NoAnswer(ms: ms))) } }
  }
}

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

@MainActor final class Tab: NSObject, WKWebExtensionTab, WKNavigationDelegate, WKUIDelegate {
  let name: String
  var url: URL
  var webView: WKWebView?
  // The extension address the web view was made for (an extension page's), or nil (a web page's).
  var madeFor: String?
  // Whether the page's window frame is told to WebKit (its outerWidth and outerHeight then the window's, as in
  // Safari; else 0): the `windowFrame` op, off by default so every other scenario keeps the host as it was.
  static var tellsWindowFrame = false
  // Web views made from now on say they're Safari (the `safariAgent` op: real sites serve Safari its own pages).
  static var safariAgent = false
  // Web content processes that ended under a page (a crash: "A problem repeatedly occurred" in Safari).
  static var crashes = 0
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    Tab.crashes += 1
    log("the web content process of \(name) ended (\(Tab.crashes) so far)")
  }
  @objc(_webView:getWindowFrameWithCompletionHandler:)
  func webViewWindowFrame(_ wv: WKWebView, completionHandler: @escaping (CGRect) -> Void) {
    completionHandler(Tab.tellsWindowFrame ? wv.frame : .zero)
  }
  // Asleep with a view already (made as Safari selected it, its load put off): no page yet, and
  // WebKit answers a script there with an error in place of a result, as in Safari.
  var unloaded = false
  // The tab's next activation by the extension (tabs.update) is carried out and answered only
  // this long after it's asked (ms): Safari's update of a tab whose process hangs, answered as
  // the process recovers (Tirth's Safari, 2026-11-03).
  var stallMs = 0
  var asleep: Bool { webView == nil || unloaded }
  weak var window: Win?
  var loadingObs: [NSKeyValueObservation] = []
  // Session storage to give back when the tab loads again after a relaunch (Safari restores a
  // tab's sessionStorage with it): origin → [[key, value]]. See the "restart" step.
  var restoredSession: [String: [[String]]] = [:]
  // A web page's history as the tab had it when it went to sleep (WKWebView.interactionState):
  // it loads again from it, as Safari restores a tab it unloaded or had at a launch
  // (restoreFromSessionState, then goToBackForwardItem, in Safari's log), so its document's
  // navigation is 'back_forward', as in Safari.
  var savedState: Any?
  init(name: String, url: URL) { self.name = name; self.url = url }
  // `load: false`: the web view only (no process yet), loaded with loadNow().
  func makeWebView(load: Bool = true) {
    // Extension pages need the extension context's own configuration (that's
    // what gives them the browser.* APIs); web pages a plain one.
    let isExtensionPage = host.context.map { url.absoluteString.hasPrefix($0.baseURL.absoluteString) } ?? false
    madeFor = isExtensionPage ? host.context?.baseURL.absoluteString : nil
    let cfg = isExtensionPage ? host.context!.webViewConfiguration! : WKWebViewConfiguration()
    if !isExtensionPage { cfg.webExtensionController = host.controller }
    // Frame timing in every frame: when it was shown, and its first rendering updates after that.
    cfg.userContentController.addUserScript(WKUserScript(source: """
      (() => { window.__vis = []; const note = () => { const t = Math.round(performance.timeOrigin + performance.now()); window.__vis.push([document.hidden ? 'hidden' : 'shown', t]);
        if (!document.hidden) { let n = 0; const tick = () => { window.__vis.push(['frame', Math.round(performance.timeOrigin + performance.now())]); if (++n < 10) requestAnimationFrame(tick); }; requestAnimationFrame(tick); } };
        note(); document.addEventListener('visibilitychange', note); })();
      """, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    cfg.userContentController.addUserScript(WKUserScript(source: pageRecorder, injectionTime: .atDocumentStart, forMainFrameOnly: false))
    if !restoredSession.isEmpty, let data = try? JSONSerialization.data(withJSONObject: restoredSession), let json = String(data: data, encoding: .utf8) {
      // Before any other script of the page: its session storage as it was (an origin's, once,
      // into an empty storage, as a restored tab's first load finds it).
      cfg.userContentController.addUserScript(WKUserScript(source: "(() => { try { const own = (\(json))[location.origin]; if (own && !sessionStorage.length) for (const [k, v] of own) sessionStorage.setItem(k, v); } catch {} })();", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    if Tab.safariAgent { cfg.applicationNameForUserAgent = "Version/27.2 Safari/605.1.15" }
    let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: cfg)
    wv.isInspectable = true
    wv.allowsMagnification = true // as Safari's
    // Not hidden by the window server's occlusion: the window is off screen, which macOS
    // sometimes marks occluded (WebKit's log: "window visible 1 … window occluded 1"); a tab
    // then stayed `document.hidden` after it was shown. Safari's window is on screen.
    let noOcclusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
    if let m = class_getInstanceMethod(WKWebView.self, noOcclusion) {
      typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
      unsafeBitCast(method_getImplementation(m), to: Setter.self)(wv, noOcclusion, false)
    }
    wv.navigationDelegate = self
    wv.uiDelegate = self
    webView = wv
    loadingObs = [
      wv.observe(\.isLoading, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { guard let self else { return }; host.controllers.forEach { $0.didChangeTabProperties([.loading], for: self) } } },
      wv.observe(\.url, options: [.new]) { [weak self] wv, _ in MainActor.assumeIsolated { guard let self else { return }; if let u = wv.url { self.url = u }; host.controllers.forEach { $0.didChangeTabProperties([.URL], for: self) } } },
      wv.observe(\.title, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { guard let self else { return }; host.controllers.forEach { $0.didChangeTabProperties([.title], for: self) } } },
    ]
    if load { loadNow() }
  }
  func loadNow() {
    if let state = savedState, let wv = webView { savedState = nil; wv.interactionState = state } else { webView?.load(URLRequest(url: url)) }
  }
  // Its history kept (savedState) as its web view goes away.
  func keepState() { if madeFor == nil, let wv = webView, wv.url != nil { savedState = wv.interactionState } }
  // Every navigation, so reload loops and redirects show in the log.
  func webView(_ wv: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
    let frame = action.targetFrame.map { $0.isMainFrame ? "top" : "frame" } ?? "new window"
    log("nav \(name) \(frame) \(action.navigationType.rawValue == 3 ? "reload" : "go") \(action.request.url?.absoluteString.prefix(1200) ?? "?")")
    decisionHandler(.allow)
  }
  // A page's alert, confirm or prompt (a real site's, in tests/box/sites-bench.mts): answered at once, as dismissed.
  func webView(_ wv: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) { log("dialog \(name): alert"); completionHandler() }
  func webView(_ wv: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) { log("dialog \(name): confirm"); completionHandler(false) }
  func webView(_ wv: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) { log("dialog \(name): prompt"); completionHandler(nil) }
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
    log("delegate: activate \(name) (asleep=\(asleep), turn \(runLoopTurn))")
    if stallMs > 0 {
      let ms = stallMs; stallMs = 0
      log("  \(name) stalled: shown and answered \(ms) ms from now")
      DispatchQueue.main.asyncAfter(deadline: .now() + Double(ms) / 1000) { MainActor.assumeIsolated { self.window?.show(self); log("  \(self.name) shown after its stall"); completionHandler(nil) } }
      return
    }
    window?.show(self); completionHandler(nil)
  }
  // tabs.update with an address.
  func loadURL(_ url: URL, for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
    log("delegate: load \(name) \(url.absoluteString)"); self.url = url
    unloaded = false
    savedState = nil
    // A web view is made for a web page or for one copy's pages (its configuration): going to
    // another's (or from a copy that's gone to the current one), it's made again, as Safari does.
    let base = host.context?.baseURL.absoluteString
    let wantFor = base.flatMap { url.absoluteString.hasPrefix($0) ? $0 : nil }
    if let wv = webView, wantFor != madeFor {
      let shown = wv.superview != nil
      // An extension page's view is kept (out of the window): closing one took Margin's
      // background with it here, and nothing revives it in the host (Safari starts it again).
      if madeFor != nil { retiredViews.append(wv) }
      wv.removeFromSuperview(); webView = nil; loadingObs = []
      makeWebView()
      if shown { window?.nsWindow.contentView!.addSubview(webView!) }
    } else if webView == nil { makeWebView() } else { webView!.load(URLRequest(url: url)) }
    completionHandler(nil)
  }
  // tabs.remove.
  func close(for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
    log("delegate: close \(name)")
    guard let window else { return completionHandler(nil) }
    window.tabs.removeAll { $0 === self }
    if window.active === self { window.active = nil; if let next = window.tabs.last { window.show(next) } }
    webView?.removeFromSuperview(); webView = nil; loadingObs = []
    host.controllers.forEach { $0.didCloseTab(self, windowIsClosing: false) }
    completionHandler(nil)
  }
  // tabs.reload. Safari ignores it for a tab it unloaded (BrowserViewController reload: canReload
  // is false without a page): it loads one only as it's selected.
  func reload(fromOrigin: Bool, for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
    log("delegate: reload \(name) (asleep=\(asleep), shown=\(window?.active === self))\(asleep ? ": ignored, as Safari does" : "")")
    if !asleep { webView?.reload() }
    completionHandler(nil)
  }
}

// A window AppKit leaves where it's put. A titled window is moved onto a screen as it's ordered
// in (constrainFrameRect(_:to:)), so the host's window, set at (-20000, -20000), showed at the
// top left of the main display, in front of the person's own windows, for every run.
final class OffScreenWindow: NSWindow {
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

@MainActor final class Win: NSObject, WKWebExtensionWindow {
  var tabs: [Tab] = []
  var active: Tab?
  let nsWindow: NSWindow
  override init() {
    nsWindow = OffScreenWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1200, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
    super.init()
    // Off screen and never activated: tests run without showing anything. Ordered in all the
    // same (behind everything), so WebKit counts its web views in a window and visible.
    nsWindow.animationBehavior = .none
    nsWindow.setFrameOrigin(NSPoint(x: -20000, y: -20000))
    nsWindow.orderBack(nil)
  }
  func show(_ tab: Tab) {
    let previous = active
    if previous === tab { return }
    // Safari's own work selecting a tab (its address bar, toolbar, tab bar...): the turn that
    // shows a tab lasts 2–74 ms in Safari's log (from the tab's view entering the window to the
    // one before leaving it, at the turn's end). Here it takes microseconds, so a second tab
    // change sent with the first (an introduction's) could miss the turn; 2 ms, the shortest seen.
    let selecting = Date()
    while Date().timeIntervalSince(selecting) < 0.002 {}
    previous?.webView?.removeFromSuperview()
    active = tab
    if tab.asleep {
      if deferLoads {
        // Safari putting the load off to the end of its selection update: it then loads the
        // tab selected by then (BrowserWindowController _finishLoadingTab → didSelectTabViewItem).
        // Its view is made all the same, as Safari selects it (_applyTabSelectionStateUpdate asks
        // for the tab's web view before _finishLoadingTab).
        log("  \(tab.name) was asleep: its load put off to the end of the turn")
        if tab.webView == nil { tab.makeWebView(load: false); tab.unloaded = true }
        let atTurnEnd = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, false, 0) { _, _ in
          MainActor.assumeIsolated {
            guard let shown = self.active, shown.unloaded else { return log("  \(tab.name) not loaded: \(self.active?.name ?? "-") is the tab shown now") }
            log("  \(shown.name) loads as it's shown (put off)"); self.restore(shown)
          }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), atTurnEnd, .commonModes)
      } else { log("  \(tab.name) was asleep: loading it as it's shown"); restore(tab) }
    }
    if let wv = tab.webView, wv.superview == nil { nsWindow.contentView!.addSubview(wv) }
    if let armed = probeArmed, armed.name == tab.name {
      if armed.nth <= 1 { probeArmed = nil; commitProbe = (tab: tab, started: Date(), frames: []) } else { probeArmed = (armed.name, armed.nth - 1) }
    }
    for c in host.controllers {
      c.didActivateTab(tab, previousActiveTab: previous)
      c.didSelectTabs([tab])
      if let previous { c.didDeselectTabs([previous]) }
    }
  }
  // Safari's order for a tab it restores: its web view into the window before it has a process
  // (so WebKit doesn't count it as having been in a window: "Not dispatching because there is no
  // running process" in Safari's log), and its load a moment later, once its session storage is
  // back (60–90 ms in Safari's log), wherever the tab is by then.
  func restore(_ tab: Tab) {
    if tab.webView == nil { tab.makeWebView(load: false) }
    tab.unloaded = false
    if tab.webView!.superview == nil && active === tab { nsWindow.contentView!.addSubview(tab.webView!) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { MainActor.assumeIsolated { tab.loadNow() } }
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
  // The identity of the controller's storage: a second controller with the same one shares
  // Margin's storage.local (the "installOld" step), as two copies of Margin in one Safari
  // profile do while an old one lingers.
  let storeId = UUID()
  lazy var controller = WKWebExtensionController(configuration: WKWebExtensionController.Configuration(identifier: storeId))
  var context: WKWebExtensionContext?
  // An old copy of Margin still running beside the installed one ("installOld"): its own
  // controller (no pages get its content scripts), same tabs, same storage, its own tab ids.
  var oldController: WKWebExtensionController?
  var oldContext: WKWebExtensionContext?
  var controllers: [WKWebExtensionController] { [controller] + (oldController.map { [$0] } ?? []) }
  let window = Win()
  override init() { super.init(); controller.delegate = self }
  func webExtensionController(_ c: WKWebExtensionController, openWindowsFor x: WKWebExtensionContext) -> [any WKWebExtensionWindow] { [window] }
  // Native messaging, as Safari's extension handler and Margin.app do it (docs/PROTOCOL.md):
  // a copy's wantLink goes to the app's real end of the link (link-server/main.swift, started
  // by an `appStart` step), whose dispatches come into the copy's lasting port. Without it,
  // the handler's answer: the app isn't open. After an `appOnDemand` step, a wantLink with
  // the app not running starts it, as the handler does (NSWorkspace.openApplication), and
  // answers `launching`.
  func webExtensionController(_ c: WKWebExtensionController, sendMessage message: Any, toApplicationWithIdentifier id: String?, for x: WKWebExtensionContext, replyHandler: @escaping (Any?, (any Error)?) -> Void) {
    let body = message as? [String: Any]
    let type = body?["type"] as? String ?? "?"
    var launching = false
    if type == "wantLink", let nonce = body?["nonce"] as? String, appLink.running {
      log("native: wantLink (to the app)")
      appLink.tell(["wantLink": nonce])
      if appLink.loseAnswers > 0 {
        appLink.loseAnswers -= 1
        appLink.lost.append(replyHandler) // never called
        return log("native: wantLink: its answer lost")
      }
    } else if type == "wantLink", appLink.onDemand {
      log("native: wantLink: the app isn't running, started (launching)")
      appLink.onDemand = false
      appLink.start(layout: appLink.onDemandLayout)
      launching = true
    } else if type != "ping" {
      log("native: \(type)\(appLink.running ? "" : " (no app)")")
    }
    replyHandler(["ok": true, "appOpen": appLink.running && !launching, "launching": launching], nil)
  }
  func webExtensionController(_ c: WKWebExtensionController, connectUsing port: WKWebExtension.MessagePort, for x: WKWebExtensionContext, completionHandler: @escaping ((any Error)?) -> Void) {
    log("native: a lasting port opened")
    appLink.port = port
    port.messageHandler = { message, _ in
      // The copy's pings keep its background alive (Safari): answered, as the handler does.
      if (message as? [String: Any])?["type"] as? String == "ping" { appLink.pings += 1 }
      // The copy's lines for Margin.app's log (background/link.ts note: each switch's timeline, say),
      // as the handler writes them to the system log: heard as the app's, for `appHeard`.
      if (message as? [String: Any])?["type"] as? String == "log", let line = (message as? [String: Any])?["line"] as? String {
        appLink.heard.append(#"{"ev":"extension log","line":"# + (String(data: (try? JSONSerialization.data(withJSONObject: [line])) ?? Data(), encoding: .utf8)?.dropFirst().dropLast() ?? "\"\"") + "}")
      }
    }
    port.disconnectHandler = { _ in log("native: the port closed") }
    completionHandler(nil)
  }
  func webExtensionController(_ c: WKWebExtensionController, focusedWindowFor x: WKWebExtensionContext) -> (any WKWebExtensionWindow)? { window }
  // tabs.move (WebKit's private delegate call, as Safari answers it): the tabs to that place
  // in the window, in order, each move told.
  @objc(_webExtensionController:moveTabs:toIndex:inWindow:forExtensionContext:completionHandler:)
  func moveTabs(_ c: WKWebExtensionController, moveTabs given: [Any], toIndex index: Int, inWindow _: Any, forExtensionContext _: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
    var to = index
    for case let t as Tab in given {
      guard let from = window.tabs.firstIndex(where: { $0 === t }) else { continue }
      window.tabs.remove(at: from)
      let at = min(to, window.tabs.count)
      window.tabs.insert(t, at: at)
      log("delegate: move \(t.name) \(from) → \(at)")
      controllers.forEach { $0.didMoveTab(t, from: from, in: window) }
      to = at + 1
    }
    completionHandler(nil)
  }
  // tabs.create: a tab at the end of the window, named new1, new2, … (in front only if asked).
  var openedForMargin = 0
  func webExtensionController(_ c: WKWebExtensionController, openNewTabUsing cfg: WKWebExtension.TabConfiguration, for x: WKWebExtensionContext, completionHandler: @escaping ((any WKWebExtensionTab)?, (any Error)?) -> Void) {
    openedForMargin += 1
    let t = Tab(name: "new\(openedForMargin)", url: cfg.url ?? URL(string: "about:blank")!)
    t.window = window
    window.tabs.append(t)
    t.makeWebView()
    controllers.forEach { $0.didOpenTab(t) } // WebKit doesn't tell the extension (tabs.onCreated) by itself
    if cfg.shouldBeActive { window.show(t) }
    log("opened \(t.name) for Margin, \(cfg.shouldBeActive ? "in front" : "behind"): \(t.url.absoluteString)")
    completionHandler(t, nil)
  }
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
    log("installed \(ctx.uniqueIdentifier) at \(ctx.baseURL.absoluteString)")
    // What WebKit made of the manifest: its errors, and the commands' shortcuts.
    for error in ext.errors { log("manifest error: \(error.localizedDescription)") }
    for command in ctx.commands {
      log("command \(command.id): key=\(command.activationKey ?? "-") modifiers=\(command.modifierFlags.rawValue)")
    }
  }
  func uninstall() throws {
    if let ctx = context { try controller.unload(ctx); log("uninstalled"); context = nil }
    unloadTwin()
  }
  func unloadTwin() { if let t = twin { try? controller.unload(t); log("twin unloaded") }; twin = nil }
  func installOld(dir: URL) async throws {
    let c = WKWebExtensionController(configuration: WKWebExtensionController.Configuration(identifier: storeId))
    c.delegate = self
    let ext = try await WKWebExtension(resourceBaseURL: dir)
    let ctx = WKWebExtensionContext(for: ext)
    ctx.uniqueIdentifier = "margin-fixed-id"
    for p in ext.requestedPermissions { ctx.setPermissionStatus(.grantedExplicitly, for: p) }
    ctx.setPermissionStatus(.grantedExplicitly, for: WKWebExtension.MatchPattern.allURLs())
    try c.load(ctx)
    oldController = c; oldContext = ctx
    c.didOpenWindow(window)
    c.didFocusWindow(window)
    log("installed an old copy from \(dir.lastPathComponent) beside it")
  }
  func uninstallOld() { if let c = oldController, let ctx = oldContext { try? c.unload(ctx); log("old copy gone") }; oldController = nil; oldContext = nil }
  // A second copy loaded into the same controller (as Safari would load a new generation
  // while the old one still runs): same unique identifier, its own base URL.
  var twin: WKWebExtensionContext?
  func installTwin(dir: URL) async throws {
    let ext = try await WKWebExtension(resourceBaseURL: dir)
    let ctx = WKWebExtensionContext(for: ext)
    ctx.uniqueIdentifier = "margin-fixed-id"
    for p in ext.requestedPermissions { ctx.setPermissionStatus(.grantedExplicitly, for: p) }
    ctx.setPermissionStatus(.grantedExplicitly, for: WKWebExtension.MatchPattern.allURLs())
    do { try controller.load(ctx); twin = ctx; log("installed a twin at \(ctx.baseURL.absoluteString)") } catch { log("twin failed to load: \(error)") }
  }
  func world() -> WKContentWorld? { context.map { WKContentWorld.world(name: "WebExtension-\($0.uniqueIdentifier)") } }
  func tab(_ name: String) -> Tab? { window.tabs.first { $0.name == name } }
}

// The "mouse" step: the web view a press went to (its release goes there too), and where.
var pressedView: WKWebView?
var lastPress = NSPoint.zero
// The "deferLoads" step: a tab asleep loads only if it's still the one shown once the run loop
// turn that showed it is over.
var deferLoads = false
// Margin's content-script world, held through an uninstall (`keepWorld`).
var keptWorld: WKContentWorld?
// Run loop turns (each ends before the app waits, where Core Animation commits what's on
// screen): two tab changes in the same turn never reach the screen in between.
var runLoopTurn = 0
let turnObserver = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { _, _ in runLoopTurn += 1 }
CFRunLoopAddObserver(CFRunLoopGetMain(), turnObserver, .commonModes)
// Layers under a web view: WebKit detaches a page's whole layer tree while it hides its content
// (hideContentUntilPendingUpdate), so a count taken as the tab is shown says whether its content
// is there for the first frame.
@MainActor func layerCount(_ layer: CALayer?) -> Int { guard let layer else { return 0 }; return 1 + (layer.sublayers ?? []).reduce(0) { $0 + layerCount($1) } }
// What the first frame after a show contains: the target web view's layers counted just before
// Core Animation commits the run loop turn (its observer has order 2000000), each turn until one
// has content, so a frame shown empty is counted as such. Counted from the end of the show: while
// WebKit waits for the page's paint inside it, nothing is committed (the window keeps its frame).
var commitProbe: (tab: Tab, started: Date, frames: [Int])? = nil
// The same for the nth time a tab is shown from now on, by whoever shows it ("probeShow"),
// and what the last probe found ("checkProbe": nil ms if no content came in 40 turns).
var probeArmed: (name: String, nth: Int)? = nil
var lastProbe: (name: String, contentMs: Double?)? = nil
let commitObserver = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 1_999_000) { _, _ in
  MainActor.assumeIsolated {
    guard var probe = commitProbe else { return }
    let n = layerCount(probe.tab.webView?.layer)
    probe.frames.append(n)
    if n > 3 || probe.frames.count >= 40 {
      let ms = Date().timeIntervalSince(probe.started) * 1000
      log(String(format: "commitProbe %@: layers in the turns committed after showing: %@ (content after %.0f ms)", probe.tab.name, probe.frames.map(String.init).joined(separator: ","), ms))
      lastProbe = (name: probe.tab.name, contentMs: n > 3 ? ms : nil)
      commitProbe = nil
    } else { commitProbe = probe }
  }
}
CFRunLoopAddObserver(CFRunLoopGetMain(), commitObserver, .commonModes)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// No App Nap: an accessory app with only an off-screen window is napped after a minute or so
// (its timers and WebKit's IPC to it held back), which Safari, in front, never is. Without this,
// runs over a minute long failed now and then: tabs shown stayed hidden, clicks went unanswered.
let noNap = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "WebKit host test run")
let host = MainActor.assumeIsolated { Host() }
// Extension pages' web views a tab left for a web page (Tab.loadURL), kept.
var retiredViews: [WKWebView] = []
// Margin.app's end of the link, for the `app*` steps (tools/webkit-host/link-server).
@MainActor final class AppLinkProcess {
  var process: Process?
  var input: FileHandle?
  var port: WKWebExtension.MessagePort?
  var pings = 0
  // What the app's end said (link-server's `ev` lines), for `appHeard` checks; `mark`: where `appMark` left off.
  var heard: [String] = []
  var mark = 0
  var onDemand = false
  var onDemandLayout: [Double]?
  // `appLoseAnswers`: this many wantLinks passed on to the app but never answered, as Safari 27.2
  // answers only one of several sent at once (DECISIONS.md "Every profile's copy links again").
  var loseAnswers = 0
  var lost: [(Any?, (any Error)?) -> Void] = []
  var running: Bool { process?.isRunning == true }
  // `layout`: the page slot's insets the app reports (left, top, right, bottom; link-server/).
  func start(layout: [Double]? = nil) {
    guard let path = ProcessInfo.processInfo.environment["MARGIN_LINK_SERVER"] else { return log("appStart: no MARGIN_LINK_SERVER") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    if let layout, layout.count == 4 {
      var env = ProcessInfo.processInfo.environment
      env["MARGIN_LINK_LAYOUT"] = layout.map { String($0) }.joined(separator: ",")
      p.environment = env
    }
    let inPipe = Pipe(), outPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    var pending = Data()
    outPipe.fileHandleForReading.readabilityHandler = { h in
      let data = h.availableData
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          pending.append(data)
          while let nl = pending.firstIndex(of: 10) {
            let line = pending[pending.startIndex..<nl]
            pending = Data(pending[(nl + 1)...])
            guard let o = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if let name = o["dispatch"] as? String, let info = o["info"],
               let json = try? JSONSerialization.data(withJSONObject: info), let text = String(data: json, encoding: .utf8) {
              log("app: dispatch \(name)")
              self.port?.sendMessage(["name": name, "userInfo": ["e": text]]) { error in if let error { log("app: dispatch failed \(error)") } }
            } else {
              let text = String(decoding: line, as: UTF8.self)
              self.heard.append(text)
              log("app: \(text.prefix(400))")
            }
          }
        }
      }
    }
    try? p.run()
    process = p
    input = inPipe.fileHandleForWriting
    log("appStart: pid \(p.processIdentifier)")
  }
  func tell(_ o: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: o) else { return }
    input?.write(data + Data([10]))
  }
  func kill() { process?.terminate(); log("appKill") }
}
let appLink = MainActor.assumeIsolated { AppLinkProcess() }

// Each tab's web content process as a 'pid' step saw it (name → pid).
var recordedPids: [String: Int32] = [:]

Task { @MainActor in
  for step in scenario {
    let op = step["op"] as! String
    switch op {
    case "open":
      let path = step["url"] as! String
      // "ext:<path>": a page of the installed extension (e.g. its new-tab page); a full URL
      // (a real website); else a test page of server.mts.
      let url = path.hasPrefix("ext:") ? URL(string: String(path.dropFirst(4)), relativeTo: host.context!.baseURL)!.absoluteURL
        : path.contains("://") ? URL(string: path)! : URL(string: base + path)!
      let t = Tab(name: step["name"] as! String, url: url)
      t.window = host.window
      host.window.tabs.append(t)
      if (step["asleep"] as? Bool) != true { t.makeWebView() }
      // selectedFirst: in front before the extension hears of it (Safari's New Tab: a tab made selected).
      let selectedFirst = (step["selectedFirst"] as? Bool) == true && (step["active"] as? Bool) == true
      if selectedFirst { host.window.show(t) }
      if host.context != nil { host.controllers.forEach { $0.didOpenTab(t) } }
      if (step["active"] as? Bool) == true && !selectedFirst { host.window.show(t) }
      log("opened \(t.name)\((step["asleep"] as? Bool) == true ? " (asleep)" : "")")
    case "sleep":
      // Safari unloading a hidden tab: its web view goes away.
      let t = host.tab(step["name"] as! String)!
      t.keepState()
      t.webView?.removeFromSuperview(); t.webView = nil; t.unloaded = false; t.loadingObs = []
      log("put \(t.name) to sleep")
    case "install": try! await host.install(sameId: (step["sameId"] as? Bool) == true)
    case "installOld":
      // An old copy of Margin (MARGIN_HOST_OLD_EXT: run.sh puts main's dist/safari there, or
      // `dir`) running beside the installed one, sharing its storage.
      let dir = step["dir"] as? String ?? ProcessInfo.processInfo.environment["MARGIN_HOST_OLD_EXT"] ?? ""
      try! await host.installOld(dir: URL(fileURLWithPath: dir))
    case "uninstallOld": host.uninstallOld()
    case "installTwin":
      // A second copy in the same controller (this build, or `old: true` for MARGIN_HOST_OLD_EXT,
      // or `dir`): WebKit then shares one content-script world between the two.
      let dir = step["dir"] as? String ?? ((step["old"] as? Bool) == true ? ProcessInfo.processInfo.environment["MARGIN_HOST_OLD_EXT"] ?? "" : extDir.path)
      try! await host.installTwin(dir: URL(fileURLWithPath: dir))
    case "deferLoads":
      deferLoads = true; log("loads of tabs asleep put off to the end of the turn that shows them")
    case "stall":
      // { op: 'stall', name, ms }: the tab's next tabs.update to the front answers ms later (Tab.stallMs).
      host.tab(step["name"] as! String)!.stallMs = step["ms"] as! Int; log("stalling \(step["name"] as! String)")
    case "show":
      // Safari itself bringing a tab to the front (its tab bar, its own shortcuts).
      host.window.show(host.tab(step["name"] as! String)!); log("showed \(step["name"] as! String)")
    case "close":
      // { op: 'close', name, windowClosing? }: Safari closing a tab itself (its tab bar, ⌘W), or
      // with its window (windowClosing: tabs.onRemoved says isWindowClosing; the window stays here).
      guard let t = host.tab(step["name"] as! String) else { log("close: no tab \(step["name"] as! String)"); break }
      let closing = (step["windowClosing"] as? Bool) == true
      let window = host.window
      window.tabs.removeAll { $0 === t }
      if window.active === t { window.active = nil; if let next = window.tabs.last { window.show(next) } }
      t.webView?.removeFromSuperview(); t.webView = nil; t.loadingObs = []
      host.controllers.forEach { $0.didCloseTab(t, windowIsClosing: closing) }
      log("closed \(t.name)\(closing ? " with its window" : "")")
    case "showProbe":
      // Show a tab and report its layers at once (before the screen can update), then a moment later.
      let t = host.tab(step["name"] as! String)!
      let started = Date()
      commitProbe = (tab: t, started: started, frames: [])
      host.window.show(t)
      let showMs = Date().timeIntervalSince(started) * 1000
      let now = layerCount(t.webView?.layer)
      log(String(format: "showProbe %@: show() took %.1f ms", t.name, showMs))
      try? await Task.sleep(nanoseconds: 100_000_000)
      log("showProbe \(t.name): layers as shown \(now), 100ms later \(layerCount(t.webView?.layer)) (turn \(runLoopTurn))")
    case "probeShow":
      // { op: 'probeShow', name, nth? }: commitProbe for the nth time (default 1) the tab is shown from now on.
      probeArmed = (step["name"] as! String, step["nth"] as? Int ?? 1); log("probe armed for \(step["name"] as! String)")
    case "checkProbe":
      // { op: 'checkProbe', name, maxMs, label }: the probed show of the tab had content within maxMs.
      let name = step["name"] as! String, maxMs = step["maxMs"] as! Double, label = step["label"] as! String
      let deadline = Date().addingTimeInterval(3)
      while lastProbe?.name != name && Date() < deadline { try? await Task.sleep(nanoseconds: 50_000_000) }
      if let ms = lastProbe?.contentMs, lastProbe?.name == name, ms <= maxMs { log(String(format: "PASS %@ (%.0f ms)", label, ms)) }
      else { fail(label, lastProbe?.name == name ? (lastProbe!.contentMs.map { String(format: "%.0f ms", $0) } ?? "no content") : "not shown") }
      lastProbe = nil
    case "flip":
      // Show one tab and then another in the same run loop turn (what reaches the screen is the second).
      let a = host.tab(step["to"] as! String)!, b = host.tab(step["back"] as! String)!
      let turn = runLoopTurn
      host.window.show(a); host.window.show(b)
      log("flipped to \(a.name) and back to \(b.name) in turn \(turn)\(runLoopTurn == turn ? " (same turn)" : " (turn changed!)")")
    case "restart":
      // A Safari relaunch: Margin stops; every tab comes back asleep (Safari restores tabs
      // lazily) with its address and its session storage; Margin starts again with its
      // storage.local (sameId), a new storage.session and new tab ids (a new copy); then the tab
      // in front loads. `late: true`: the tab in front loads first and Margin only after `lateMs`
      // (an unsigned build allowed a moment after launch).
      for t in host.window.tabs {
        guard let wv = t.webView, let r = try? await wv.callAsyncJavaScript("return JSON.stringify([location.origin, Object.entries(sessionStorage)])", arguments: [:], in: nil, contentWorld: .page) as? String,
          let pair = try? JSONSerialization.jsonObject(with: Data(r.utf8)) as? [Any], let origin = pair.first as? String, let entries = pair.last as? [[String]] else { continue }
        t.restoredSession[origin] = entries
      }
      if let ctx = host.context { try? host.controller.unload(ctx); host.context = nil }
      host.uninstallOld()
      host.unloadTwin()
      // New tab objects, as a relaunched Safari has (WebKit maps a page to its tab through them).
      // `drop`: tabs Safari doesn't bring back.
      let dropped = Set(step["drop"] as? [String] ?? [])
      let frontName = host.window.active?.name
      for t in host.window.tabs { t.keepState(); t.webView?.removeFromSuperview(); t.webView = nil; t.unloaded = false; t.loadingObs = [] }
      host.window.tabs = host.window.tabs.filter { !dropped.contains($0.name) }.map { old in
        let t = Tab(name: old.name, url: old.url); t.window = host.window; t.restoredSession = old.restoredSession; t.savedState = old.savedState; return t
      }
      host.window.active = nil
      let front = frontName.flatMap { host.tab($0) }
      let late = (step["late"] as? Bool) == true
      let start = { try! await host.install(sameId: true); for t in host.window.tabs { host.controller.didOpenTab(t) } }
      if !late { await start() }
      if let front { host.window.show(front) }
      if late {
        try? await Task.sleep(nanoseconds: UInt64((step["lateMs"] as? Int ?? 1500) * 1_000_000))
        await start()
      }
      log("restarted\(late ? " (Margin allowed late)" : "")")
    case "uninstall":
      // { op: 'uninstall', keepWorld? }: keepWorld holds Margin's content-script world through
      // the unload (as Safari does when it reloads Margin), so pages keep the old copy's globals.
      if (step["keepWorld"] as? Bool) == true, let w = host.world() { keptWorld = w; log("content world kept") }
      try! host.uninstall()
    case "deny":
      // A per-site permission change in Safari's settings.
      if let ctx = host.context, let p = try? WKWebExtension.MatchPattern(string: step["pattern"] as! String) { ctx.setPermissionStatus(.deniedExplicitly, for: p); log("denied \(step["pattern"] as! String)") }
    case "wait": try? await Task.sleep(nanoseconds: UInt64((step["ms"] as! Int) * 1_000_000))
    case "eval":
      // In Margin's content-script world of a tab (as if its sidebar did it).
      let t = host.tab(step["in"] as! String)!
      guard let wv = t.webView, let world = host.world() else { log("eval: no web view or world"); break }
      do {
        let r = try await inPage(wv, step["js"] as! String, world, within: Double(step["timeout"] as? Int ?? 30000))
        log("eval in \(t.name): \(String(describing: r ?? "undefined"))")
      } catch { log("eval in \(t.name) failed: \(error.localizedDescription)") }
    case "page":
      // In the page's own world.
      let t = host.tab(step["in"] as! String)!
      guard let wv = t.webView else { log("page: \(t.name) has no web view"); break }
      do {
        let r = try await inPage(wv, step["js"] as! String, .page, within: Double(step["timeout"] as? Int ?? 30000))
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
    case "mouse":
      // { op: 'mouse', in, at, type: 'down' | 'up', mods }: a real press or release of the mouse's
      // main button in the tab's web view, as a mouse or trackpad sends it. `at`: JavaScript in
      // Margin's content-script world returning the point [x, y] in the page's CSS pixels (the
      // hook's __shadowOf reaches the sidebar's closed shadow root). A release goes to the web
      // view that got the press, wherever it is by then (as AppKit sends it).
      let t = host.tab(step["in"] as! String)!
      let type = (step["type"] as? String) == "up" ? NSEvent.EventType.leftMouseUp : (step["type"] as? String) == "drag" ? .leftMouseDragged : .leftMouseDown
      var flags: NSEvent.ModifierFlags = []
      for m in (step["mods"] as? [String] ?? []) {
        switch m { case "command": flags.insert(.command); case "option": flags.insert(.option); case "control": flags.insert(.control); case "shift": flags.insert(.shift); default: break }
      }
      guard let wv = type == .leftMouseDown ? t.webView : (pressedView ?? t.webView), let world = host.world() else { log("mouse: \(t.name) has no web view"); break }
      var point = lastPress
      if let at = step["at"] as? String {
        guard let r = try? await wv.callAsyncJavaScript(at, arguments: [:], in: nil, contentWorld: world) as? [Double], r.count == 2 else { log("mouse: no point in \(t.name)"); break }
        point = NSPoint(x: r[0], y: wv.isFlipped ? r[1] : wv.bounds.height - r[1])
      }
      if type == .leftMouseDragged {
        // A drag: from where the button went down (or the last drag) to `at`, in `steps` moves a frame apart.
        let steps = step["steps"] as? Int ?? 12
        let from = lastPress
        for i in 1...steps {
          let p = NSPoint(x: from.x + (point.x - from.x) * Double(i) / Double(steps), y: from.y + (point.y - from.y) * Double(i) / Double(steps))
          let e = NSEvent.mouseEvent(with: .leftMouseDragged, location: wv.convert(p, to: nil), modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: host.window.nsWindow.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
          wv.mouseDragged(with: e)
          try? await Task.sleep(nanoseconds: 16_000_000)
        }
        lastPress = point
        log("mouse drag in \(t.name) to \(Int(point.x)),\(Int(wv.isFlipped ? point.y : wv.bounds.height - point.y))")
        break
      }
      let e = NSEvent.mouseEvent(with: type, location: wv.convert(point, to: nil), modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: host.window.nsWindow.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)!
      if type == .leftMouseDown { host.window.nsWindow.makeFirstResponder(wv); pressedView = wv; lastPress = point; wv.mouseDown(with: e) } else { wv.mouseUp(with: e); pressedView = nil }
      log("mouse \(type == .leftMouseDown ? "down" : "up") in \(t.name) at \(Int(point.x)),\(Int(wv.isFlipped ? point.y : wv.bounds.height - point.y))\(flags.isEmpty ? "" : " \(step["mods"] ?? [])")")
    case "hidewin":
      // Take a tab's web view out of the window without showing another (like Safari hiding it).
      let t = host.tab(step["name"] as! String)!; t.webView?.removeFromSuperview(); log("took \(t.name) out of the window")
    case "mark":
      log("MARK \(step["label"] as! String)")
    case "pid":
      // { op: 'pid', name }: the tab's web content process now, kept for 'pidGone'.
      let t = host.tab(step["name"] as! String)!
      let pid = (t.webView?.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value ?? 0
      recordedPids[t.name] = pid
      log("pid \(t.name): \(pid)")
    case "pidGone":
      // { op: 'pidGone', name, label, timeout? }: the process 'pid' kept for the tab has exited
      // (a page's memory given back), within `timeout` ms (default 3000).
      let name = step["name"] as! String
      let label = step["label"] as? String ?? "\(name): its page's process has exited"
      let pid = recordedPids[name] ?? 0
      let deadline = Date().addingTimeInterval(Double(step["timeout"] as? Int ?? 3000) / 1000)
      while true {
        if pid > 0 && kill(pid, 0) != 0 && errno == ESRCH { log("PASS \(label)"); break }
        if Date() > deadline { fail(label, pid > 0 ? "process \(pid) still running" : "no process kept"); break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
    case "check", "checkPage":
      // Waits until `js` returns true (in Margin's content-script world for "check", the
      // page's for "checkPage"), up to `timeout` ms (default 3000), then PASS or FAIL. A tab
      // the extension is still opening (named new1, new2…) is waited for within that time.
      let name = step["in"] as! String
      let js = step["js"] as! String
      let label = step["label"] as? String ?? js
      let deadline = Date().addingTimeInterval(Double(step["timeout"] as? Int ?? 3000) / 1000)
      var last = "nil"
      while true {
        if let t = host.tab(name), let wv = t.webView, let world = op == "check" ? host.world() : .page {
          do {
            let r = try await inPage(wv, js, world, within: max(100, deadline.timeIntervalSinceNow * 1000))
            if (r as? Bool) == true { log("PASS \(label)"); break }
            last = String(describing: r ?? "nil")
          } catch { last = error.localizedDescription }
        } else { last = host.tab(name) == nil ? "no tab \(name)" : "no web view or extension" }
        if Date() > deadline { fail(label, last); break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
    case "noCrash": // { op: 'noCrash', label }: no web content process ended so far
      if Tab.crashes == 0 { log("PASS \(step["label"] as? String ?? "no web content process ended")") } else { fail(step["label"] as? String ?? "no web content process ended", "\(Tab.crashes)") }
    case "safariAgent": // { op: 'safariAgent', on }: tabs made from now on say they're Safari (Tab.safariAgent)
      Tab.safariAgent = step["on"] as? Bool ?? true; log("safariAgent \(Tab.safariAgent)")
    case "windowFrame": // { op: 'windowFrame', on }: pages' outerWidth and outerHeight their window's (Tab.tellsWindowFrame)
      Tab.tellsWindowFrame = step["on"] as? Bool ?? true; log("windowFrame \(Tab.tellsWindowFrame)")
    case "wheel": // { op: 'wheel', dy?, count?, x?, y? }: a real trackpad scroll handed to the shown tab's web view
      if let wv = host.window.active?.webView { await wheelOn(wv, step) }
    case "pinch": // { op: 'pinch', deltas, x?, y? }: real magnify events handed to the shown tab's web view
      if let wv = host.window.active?.webView { await pinchOn(wv, step) }
    case "appStart": // { op: 'appStart', layout?: [left, top, right, bottom] }
      appLink.start(layout: (step["layout"] as? [NSNumber])?.map { $0.doubleValue }); try? await Task.sleep(nanoseconds: 300_000_000)
    case "appOnDemand": // { op: 'appOnDemand', layout? }: the handler starts the app at the next wantLink
      appLink.onDemand = true; appLink.onDemandLayout = (step["layout"] as? [NSNumber])?.map { $0.doubleValue }; log("appOnDemand")
    case "appLayout": // { op: 'appLayout', layout: [left, top, right, bottom] }: the app's overlay measured the slot again
      appLink.tell(["layout": (step["layout"] as? [NSNumber])?.map { $0.doubleValue } ?? []]); log("appLayout \(step["layout"] ?? "")")
    case "appDrawn": // { op: 'appDrawn', on }: the app says whether it draws over the copy's first window (`drawn`)
      let on = step["on"] as? Bool ?? true
      appLink.tell(["drawn": on]); log("appDrawn \(on)")
    case "appQuit": appLink.tell(["bye": true]); log("appQuit")
    case "appLoseAnswers": // { op: 'appLoseAnswers', count? }: the next wantLinks to the app never answered
      appLink.loseAnswers = (step["count"] as? Int) ?? 1; log("appLoseAnswers \(appLink.loseAnswers)")
    case "appRefuse": // { op: 'appRefuse', refuse? }: the app's dispatches refused (as Safari's SFErrorDomain 1) or, refuse false, passed on again
      let refuse = step["refuse"] as? Bool ?? true
      appLink.tell(["refuse": refuse]); log("appRefuse \(refuse)")
    case "appKill": appLink.kill()
    case "appPings": log("app: \(appLink.pings) pings on the port so far")
    case "appMark": appLink.mark = appLink.heard.count; log("appMark at \(appLink.mark)")
    case "appReq": // { op: 'appReq', type, payload? | in, js }: a request from the app's UI for the copy's first window (link-server/); `js` (Margin's world of tab `in`) returns its payload as JSON text
      var payload: Any = step["payload"] ?? [String: Any]()
      if let js = step["js"] as? String, let name = step["in"] as? String, let wv = host.tab(name)?.webView, let world = host.world(),
         let text = try? await wv.callAsyncJavaScript(js, arguments: [:], in: nil, contentWorld: world) as? String,
         let made = try? JSONSerialization.jsonObject(with: Data(text.utf8)) { payload = made }
      appLink.tell(["req": ["type": step["type"] as? String ?? "", "payload": payload]]); log("appReq \(step["type"] ?? "") \(payload)")
    case "appHeard": // { op: 'appHeard', label, has: [text], re?, timeout?, none? }: a line the app's end said since the last appMark has every text (and matches re; none: no such line within the timeout)
      let has = step["has"] as? [String] ?? []
      let re = (step["re"] as? String).flatMap { try? NSRegularExpression(pattern: $0) }
      let label = step["label"] as? String ?? "the app heard \(has)"
      let none = (step["none"] as? Bool) == true
      let deadline = Date().addingTimeInterval((step["timeout"] as? Double ?? (none ? 1500 : 5000)) / 1000)
      var found: String?
      while true {
        found = appLink.heard.dropFirst(appLink.mark).first { line in has.allSatisfy { line.contains($0) } && (re.map { $0.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil } ?? true) }
        if found != nil || Date() > deadline { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      if none { if let found { fail(label, "heard \(found.prefix(300))") } else { log("PASS \(label)") } }
      else if let found { log("PASS \(label)"); _ = found } else { fail(label, "not heard since the mark (\(appLink.heard.count - appLink.mark) lines)") }
    case "zoom": // { op: 'zoom', factor }: the shown tab's page zoom, as ⌘+ / ⌘− do
      host.window.active?.webView?.pageZoom = CGFloat(step["factor"] as! Double); log("zoom \(step["factor"]!)")
    case "state":
      log("state: active=\(host.window.active?.name ?? "-") " + host.window.tabs.map { "\($0.name):\($0.asleep ? "asleep" : ($0.webView!.superview == nil ? "hidden" : "shown"))" }.joined(separator: " "))
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
  appLink.process?.terminate()
  exit(failures == 0 ? 0 : 1)
}
// A pinch: the first of `deltas` as its Began (a real one is never 0), the rest Changed, then Ended.
func pinchField(_ n: UInt32) -> CGEventField { CGEventField(rawValue: n)! }
@MainActor func pinchOn(_ wv: WKWebView, _ step: [String: Any]) async {
  let deltas = step["deltas"] as! [Double]
  let x = step["x"] as? Double ?? 700, y = step["y"] as? Double ?? 400
  // The event has no window, so its locationInWindow is its screen point, and WebKit takes that
  // as a point in the web view's window: the point is given as one (x, y from the window's top
  // left), wherever the window is. Measured 2026-11-06: a gesturestart's clientX/Y is (x, y).
  let screenH = NSScreen.screens[0].frame.height
  let seq: [(Double, Int64)] = deltas.enumerated().map { ($1, $0 == 0 ? 1 : 2) } + [(0, 4)]
  for (mag, phase) in seq {
    let cg = CGEvent(source: nil)!
    cg.type = CGEventType(rawValue: 29)!
    cg.location = CGPoint(x: x, y: screenH - (800 - y))
    cg.setIntegerValueField(pinchField(110), value: 8)
    cg.setDoubleValueField(pinchField(113), value: mag)
    cg.setIntegerValueField(pinchField(132), value: phase)
    wv.magnify(with: NSEvent(cgEvent: cg)!)
    try? await Task.sleep(nanoseconds: 12_000_000)
  }
  try? await Task.sleep(nanoseconds: 120_000_000)
  log("pinch \(deltas.count) deltas: native magnification \(wv.magnification)")
}
// A real trackpad scroll handed to a web view: `dy` points per event (negative: down the page), `count` events, as
// a two-finger swipe sends them (began, changed…, ended), at (x, y) in the window from its top left.
@MainActor func wheelOn(_ wv: WKWebView, _ step: [String: Any]) async {
  let dy = step["dy"] as? Int32 ?? -40, count = step["count"] as? Int ?? 20
  let x = step["x"] as? Double ?? 700, y = step["y"] as? Double ?? 400
  let screenH = NSScreen.screens[0].frame.height
  for i in 0..<count {
    guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) else { continue }
    cg.location = CGPoint(x: x, y: screenH - (800 - y))
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    cg.setIntegerValueField(CGEventField(rawValue: 99)!, value: i == 0 ? 1 : 2) // scroll phase: began, changed
    if let e = NSEvent(cgEvent: cg) { wv.scrollWheel(with: e) }
    try? await Task.sleep(nanoseconds: 12_000_000)
  }
  if let end = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 0, wheel2: 0, wheel3: 0) {
    end.location = CGPoint(x: x, y: screenH - (800 - y))
    end.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    end.setIntegerValueField(CGEventField(rawValue: 99)!, value: 4) // ended
    if let e = NSEvent(cgEvent: end) { wv.scrollWheel(with: e) }
  }
  try? await Task.sleep(nanoseconds: 300_000_000)
  log("wheel \(count) × \(dy)")
}

// A whole run's time limit in seconds (MARGIN_HOST_TIMEOUT, default 120).
let limit = Double(ProcessInfo.processInfo.environment["MARGIN_HOST_TIMEOUT"] ?? "") ?? 120
DispatchQueue.main.asyncAfter(deadline: .now() + limit) { log("TIMEOUT"); exit(1) }
app.run()
