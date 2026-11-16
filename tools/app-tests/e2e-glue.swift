// Margin as the app, joined up, end to end (part of e2e.swift's run; app/platforms/macos/shell/HostedSession.swift,
// ShellHostedGlue.swift): the real shell with MarginHosted, its library in a temporary folder, Margin's own window
// with the real page off every display (never key, the app never active), the real link to fake-extension.mts as
// Safari's default profile's copy, and the real host engine on a stand-in window manager (GlueHostWorld: nothing is
// launched, put in full screen or moved; no Space of the Mac's is touched).
//
// What it follows: the first run (nothing to import) makes a space and opens the UI's space editor; an app picked
// in the palette (the page's `app.open`) is an item of the space, and the engine opens it above Margin's page area (a
// member of Margin's Space at the page area its own Space reserved), given the page area from Margin's own layout,
// with the loading animation meanwhile; Margin's window is always full screen (shown so, never leaving it: asked, it
// refuses; taken out by macOS, it goes back and the app shown comes back with it), its whole width, its page drawing
// its own layout (pageHosted, the sidebar docked, its width not dragged); a typed address (the page's `newTab`) is a web item: Safari
// started with no Dock icon, a window asked of the copy (`newWindow`) after its link, shown by the engine, and the
// item's tab asked of the copy (`hostShow`); the sidebar highlights the item shown; a second web item is a tab switch
// only; the overlay path is off (no overlay, `drawn` or `setLayout` for the copy's windows); quitting gives it all back.
import AppKit
import WebKit

// The window manager as the test kit measured it on the real Mac (2026-11-15, mc8/mc10), around Margin's real
// (off-screen) window: a window put in full screen gets a Space of its own laid out by its reservation; moved into
// Margin's Space it's a member there at the frame it had, still full screen; out of full screen it's a normal window
// where it is. Margin's window is its whole width (the display: its frame, off every display).
final class GlueHostWorld: HostSystem {
  struct App { var pid: pid_t; var bundle: String; var policy: HostPolicy; var windows: [Int] }
  // frame: a normal window's (none: 100,100 800×600); Calculator's can't go full screen and is a fixed 230×408.
  struct Win { var pid: pid_t; var fullScreen = false; var spaces: [UInt64]; var priv: UInt64?; var frame: CGRect? = nil; var canFullScreen = true; var resizable = true
               var memberFrame: CGRect? = nil }
  static let calculator = "com.apple.calculator", calculatorFrame = CGRect(x: 400, y: 300, width: 230, height: 408)
  var frameAtQuit: [String: CGRect] = [:]
  static let marginSpace: UInt64 = 100, desktop: UInt64 = 1
  var display: CGRect = .zero
  var marginWindow = 0
  var calls: [String] = []
  var apps: [pid_t: App] = [:]
  var wins: [Int: Win] = [:]
  var fullScreenSpaces: Set<UInt64> = [GlueHostWorld.marginSpace] // what Mission Control lists
  var current = GlueHostWorld.marginSpace
  var privates: Set<UInt64> = []
  var reservation: [UInt64: SlotEdges] = [:]
  var nextId: UInt64 = 1000, nextPid: pid_t = 600, nextWindow = 50
  var onAppQuit: ((pid_t) -> Void)?
  var onLaunch: ((String) -> Void)? // (the test's: what Margin's window shows as an app is launched)
  var listsMarginOnly: Bool { fullScreenSpaces == [Self.marginSpace] }

  func now() -> Double { Date().timeIntervalSince1970 }
  func sleep(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(max(0.005, seconds) * 1_000_000_000)) }
  func running(bundleId: String) -> [HostApp] { apps.values.filter { $0.bundle == bundleId }.sorted { $0.pid < $1.pid }.map { HostApp(pid: $0.pid, bundleId: $0.bundle, launchedAt: 1) } }
  func app(pid: pid_t) -> HostApp? { apps[pid].map { HostApp(pid: $0.pid, bundleId: $0.bundle, launchedAt: 1) } }
  func policy(pid: pid_t) -> HostPolicy? { apps[pid]?.policy }
  func launchDockless(bundleId: String, arguments: [String]) -> Bool {
    calls.append("launch \(bundleId)")
    onLaunch?(bundleId)
    let pid = nextPid
    nextPid += 1
    apps[pid] = App(pid: pid, bundle: bundleId, policy: .accessory, windows: [])
    // An app's first window comes with it; Safari's are the ones its copy makes (addWindow).
    if bundleId != safariIdentifier { addWindow(pid) }
    return true
  }
  @discardableResult func addWindow(_ pid: pid_t) -> Int {
    let n = nextWindow
    nextWindow += 1
    wins[n] = apps[pid]?.bundle == Self.calculator ? Win(pid: pid, spaces: [Self.desktop], frame: Self.calculatorFrame, canFullScreen: false, resizable: false) : Win(pid: pid, spaces: [Self.desktop])
    apps[pid]?.windows.append(n)
    return n
  }
  func terminate(pid: pid_t) -> Bool {
    calls.append("terminate \(apps[pid]?.bundle ?? "?")")
    guard let a = apps.removeValue(forKey: pid) else { return false }
    if let n = a.windows.first, let w = wins[n] { frameAtQuit[a.bundle] = w.frame ?? CGRect(x: 100, y: 100, width: 800, height: 600) }
    for n in a.windows { wins[n] = nil }
    onAppQuit?(pid)
    return true
  }
  func windows(pid: pid_t) async -> [HostWindow]? { apps[pid].map { $0.windows.compactMap { n in wins[n].map { HostWindow(number: n, fullScreen: $0.fullScreen, canFullScreen: $0.canFullScreen, resizable: $0.resizable) } } } }
  func window(pid: pid_t, number: Int) async -> HostWindow? { await windows(pid: pid)?.first { $0.number == number } }
  func setFullScreen(pid: pid_t, window: Int, _ on: Bool) async -> Bool {
    calls.append("fullScreen \(on)")
    guard var w = wins[window], w.pid == pid, !on || w.canFullScreen else { return false }
    if on, !w.fullScreen {
      let space = nextId
      nextId += 1
      fullScreenSpaces.insert(space)
      w.fullScreen = true
      w.spaces = [space]
      w.priv = nil
      w.memberFrame = nil
    } else if !on, w.fullScreen {
      w.fullScreen = false
      if w.memberFrame != nil { w.memberFrame = nil } // (a member: a normal window where it is)
      else {
        for s in w.spaces where s != Self.marginSpace { fullScreenSpaces.remove(s) } // (its own Space goes with it)
        if w.priv == nil { w.spaces = [Self.desktop] }
      }
    }
    wins[window] = w
    return true
  }
  func isFullScreen(pid: pid_t, window: Int) async -> Bool? { wins[window].flatMap { $0.pid == pid ? $0.fullScreen : nil } }
  func mainWindow(pid: pid_t) async -> Int? { apps[pid]?.windows.last }
  func frame(pid: pid_t, window: Int) async -> CGRect? { wins[window].map { $0.frame ?? CGRect(x: 100, y: 100, width: 800, height: 600) } }
  func setFrame(pid: pid_t, window: Int, _ frame: CGRect, size: Bool) async -> Bool {
    calls.append("frame \(window)")
    guard var w = wins[window], w.pid == pid, !w.fullScreen else { return false }
    w.frame = CGRect(origin: frame.origin, size: size && w.resizable ? frame.size : (w.frame ?? CGRect(x: 100, y: 100, width: 800, height: 600)).size)
    wins[window] = w
    return true
  }
  func activate(pid: pid_t, window: Int) async -> Bool { calls.append("activate \(apps[pid]?.bundle ?? "?")"); return apps[pid] != nil }
  func close(pid: pid_t, window: Int) async -> Bool { false }
  func isUIKitApp(pid: pid_t) -> Bool { false }
  func safariSidebar(pid: pid_t) async -> HostSidebar { .closed }
  func pressSafariSidebar(pid: pid_t) async -> Bool { true }
  func safariAutoShowsToolbar() -> Bool? { true }
  func serverWindows(pid: pid_t) -> [ServerWindow]? {
    wins.keys.sorted().compactMap { n in wins[n].flatMap { $0.pid == pid ? bounds(window: n).map { ServerWindow(number: n, pid: pid, bounds: $0) } : nil } }
  }
  func bounds(window: Int) -> CGRect? {
    if window == marginWindow { return display }
    guard let w = wins[window] else { return nil }
    if let f = w.memberFrame { return f }
    guard w.fullScreen, w.priv == nil, let space = w.spaces.first, space != Self.marginSpace else { return w.frame ?? CGRect(x: 100, y: 100, width: 800, height: 600) }
    return (reservation[space] ?? .zero).inset(display)
  }
  func spaces(window: Int) -> [UInt64]? { window == marginWindow ? [Self.marginSpace] : wins[window].map { $0.priv != nil ? [] : $0.spaces } }
  func spaceType(_ space: UInt64) -> Int? { fullScreenSpaces.contains(space) ? ManagedSpace.fullScreenType : (space == Self.desktop ? 0 : nil) }
  func spaceExists(_ space: UInt64) -> Bool? { fullScreenSpaces.contains(space) || space == Self.desktop }
  func currentSpace(onDisplayOf space: UInt64) -> UInt64? { current }
  func setCurrentSpace(_ space: UInt64) -> Bool { current = space; return true }
  func desktop(onDisplayOf space: UInt64) -> UInt64? { Self.desktop }
  func ownerlessFullScreenSpaces() -> [UInt64]? { [] }
  func listedFullScreenSpaces() -> [UInt64]? { fullScreenSpaces.sorted() }
  func destroyFullScreenSpace(_ space: UInt64) -> Bool { calls.append("destroy"); fullScreenSpaces.remove(space); return true }
  func reserve(_ edges: SlotEdges, space: UInt64) -> Bool { calls.append("reserve \(edges.text)"); reservation[space] = edges; return true }
  func reserved(space: UInt64) -> SlotEdges? { reservation[space] ?? .zero }
  func createPrivateSpace() -> UInt64? { let s = nextId; nextId += 1; privates.insert(s); return s }
  func move(window: Int, to space: UInt64) -> Bool {
    guard var w = wins[window] else { return false }
    if privates.contains(space) { w.priv = space } else {
      if w.fullScreen, w.memberFrame == nil, fullScreenSpaces.contains(space) { w.memberFrame = bounds(window: window) } // (a member, at its frame)
      w.priv = nil
      w.spaces = [space]
    }
    wins[window] = w
    return true
  }
  func destroyPrivateSpace(_ space: UInt64) -> Bool { privates.remove(space) != nil }
  func freeze() -> Bool { false }
  func reveal() {}
  func watchOpens(pid: pid_t, _ heard: @escaping (Int32) -> Void) -> Bool { true }
  func stopWatchingOpens(pid: pid_t) {}
  var inMargin: [Int] { wins.keys.filter { wins[$0]?.priv == nil && wins[$0]?.spaces == [Self.marginSpace] }.sorted() }
}

@MainActor
func glueScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("glue: \(label)", ok, detail()) }
  let fake = Fake()
  do { try fake.start() } catch { return check("fake extension starts", false) }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-glue-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let world = GlueHostWorld()
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root
  options.bundleIds = ["safari": fakeBundle]
  options.hosted = true
  options.hostSystem = world
  // (No installed apps read: the Mac's folders and Spotlight left alone, the icons' cache a temporary one.)
  options.appCatalog.folders = []
  options.appCatalog.spotlight = false
  options.appCatalog.icons = AppIconCache(folder: root.appendingPathComponent("icons"))
  var host = HostEngine.Options()
  host.every = 0.01
  options.hostOptions = host
  var hostedOptions = HostedSession.Options()
  hostedOptions.linkWait = 5
  options.hostedOptions = hostedOptions
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.glue.\(ProcessInfo.processInfo.processIdentifier)"))
  let windows = ScriptedWindows()
  let shell = Shell(link: link, windows: windows, apps: ScriptedApps(), hotKeys: FakeKeys(), options: options)
  windows.shell = shell
  shell.start()
  var stopped = false
  defer { if !stopped { shell.stop {} } }
  guard await until(3, { link.port != nil }) else { return check("link listens", false) }

  // ---- Safari's default profile's copy linked, with a window of the person's (never drawn over) ----
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { return check("link requested", false) }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { return check("linked", false) }
  let theirs: JSONObject = ["windowId": 1, "left": -20000, "top": -20000, "width": 1200, "height": 800, "state": "fullscreen", "focused": true]
  fake.tell(["do": "connect", "id": "S", "profile": "s-default", "windows": [theirs], "newWindow": ["left": -20000, "top": -20000, "width": 1200, "height": 800]])
  guard await until(5, { shell.isLinked("safari:s-default") }) else { return check("the copy linked", false) }

  // ---- the first run: a space made, the UI's editor open for it ----
  let made = shell.makeMarginWindows()
  guard let library = shell.library, let session = shell.hosted, let engine = shell.host else { return check("the library, the session and the engine", false) }
  check("the windows draw the library", made.source is LibraryWindowSource)
  let c = made.open()
  defer { made.closeAll() }
  world.marginWindow = c.window.windowNumber
  var loadingAtLaunch: [String: String?] = [:]
  world.onLaunch = { bundle in loadingAtLaunch[bundle] = c.loadingView.isHidden ? nil : c.loadingView.text }
  // (Safari's window its copy makes, in the stand-in window manager too.)
  let ask = engine.requestSafariWindow
  engine.requestSafariWindow = { profile in
    let made = await ask?(profile)
    if made != nil, let pid = world.running(bundleId: safariIdentifier).first?.pid { world.addWindow(pid) }
    return made
  }
  // (Its full screen, asked of the copy (setWindowState), in the stand-in window manager too once the copy answers.)
  let fullScreen = engine.safariFullScreen
  engine.safariFullScreen = { profile, id, on in
    let ok = await fullScreen?(profile, id, on) ?? false
    if ok, let host = engine.hosts.values.first(where: { $0.safariWindow == id }) { _ = await world.setFullScreen(pid: host.pid, window: host.window, on) }
    return ok
  }
  guard await until(15, { c.isReady }) else { return check("Margin's window's page drawn", false) }
  let first = library.spaces().first?.id ?? ""
  check("the first run, nothing imported: one space, Personal", library.spaces().count == 1 && library.spaces().first?.value["name"] as? String == "Personal")
  check("its page asked to open the UI's space editor for it", c.pushed.contains { $0.contains("edit-space") && $0.contains(first) })
  check("the space editor open in the page", await waitJS(c.webView, "return !!document.querySelector('[m-input=\"space-name\"]')"))
  // (Closed with Escape in its field, as a person would: in window mode the sidebar stays docked, so an editor left open
  // keeps its field, and Margin's window, in front of the hosted app.)
  _ = await js(c.webView, "document.querySelector('[m-input=\"space-name\"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true")
  check("the space editor closed (Escape)", await waitJS(c.webView, "return !document.querySelector('[m-input=\"space-name\"]')"))

  // ---- always full screen: from the start, never leaving it ----
  let emptyLauncher = await waitJS(c.webView, "return !!document.querySelector('.launcher')")
  check("in full screen from the start, nothing hosted: its page area the theme's launcher, never a see-through hole", c.isFullScreen && c.window.pageRect != nil && emptyLauncher
        && c.window.locksFullScreen && (c.pageHello().contains(#""mode":"fullscreen""#)))
  c.toggleFullScreen()
  check("asked to leave full screen (⌃⌘F, the page's own ask): refused, still full screen", c.isFullScreen && c.refusedExits == 1)
  check("its menu has no Enter/Exit Full Screen item", !made.menu.items.flatMap { $0.submenu?.items ?? [] }.contains { $0.action == #selector(NSWindow.toggleFullScreen(_:)) })

  // ---- an app picked in the palette: an item, the app opened above Margin's page area ----
  let display = c.contentFrame
  world.display = display // (full screen in a test is the window's state only: the display is its frame)
  _ = await js(c.webView, "window.webkit.messageHandlers.margin.postMessage({ op: 'perform', name: 'app.open', arg: { bundleId: 'com.apple.TextEdit' } }); return true")
  let textEdit = HostTarget.app("com.apple.TextEdit").id
  guard await until(10, { engine.shown == textEdit }) else { return check("the app picked: opened by the engine", false, "\(world.calls) \(session.done.suffix(4))") }
  await session.idle()
  let item = library.items(space: first).first { $0.value["url"] as? String == "app://com.apple.TextEdit" }?.id ?? ""
  check("the pick: an item of the window's space", !item.isEmpty && library.target(ofItem: item) != nil)
  check("the app started with no Dock icon (the stand-in's launch)", world.calls.contains("launch com.apple.TextEdit"))
  check("the loading animation over the page area as it launched (the app's name), gone once it's shown", loadingAtLaunch["com.apple.TextEdit"] == .some("Opening com.apple.TextEdit…")
        && c.loadingView.isHidden && c.loadingLabel == nil, "\(loadingAtLaunch)")
  check("Margin's window its whole width (never a tile)", abs(c.window.frame.width - display.width) <= 1, "\(c.window.frame)")
  let dockedFixed = await waitJS(c.webView, "const r = document.querySelector('.arcadia'); return r?.dataset.sidebar === 'open' && !document.querySelector('.launcher') && r.hasAttribute('m-sidebar-fixed') && getComputedStyle(document.querySelector('[m-resize]')).display === 'none'")
  check("its page draws its own layout, the sidebar docked (pageHosted), no launcher, its width not dragged", dockedFixed)
  check("the placement from a layout measured in full screen at its whole width (no fallback to an older one)", c.layout?.outside == false && c.layout?.mode == "fullscreen"
        && !session.done.contains { $0.contains("no full-screen layout") }, "\(String(describing: c.layout)) \(session.done.filter { $0.contains("layout") })")
  let expected = c.layout.flatMap { MarginWindowGeometry.pageRect(layout: $0, content: display) }
  check("the engine got the page area from Margin's own layout (the theme's frame around it)", expected != nil && engine.pageRect == expected && c.window.pageRect == expected && (expected?.minX ?? 0) > display.minX + 100,
        "\(engine.pageRect) \(String(describing: expected))")
  let editWindow = world.apps.values.first { $0.bundle == "com.apple.TextEdit" }?.windows.first ?? 0
  check("the app's window there, a member of Margin's Space, still full screen; Mission Control Margin's Space only", world.bounds(window: editWindow) == expected && world.inMargin == [editWindow]
        && world.wins[editWindow]?.fullScreen == true && world.listsMarginOnly && world.calls.last == "activate com.apple.TextEdit", "\(String(describing: world.bounds(window: editWindow))) \(world.calls.suffix(3))")
  check("Margin's window kept right below it", c.below == editWindow)
  check("nothing passes through Margin's window while hosting", c.slot == nil && !c.window.ignoresMouseEvents)
  // (Its title: the app's name as the catalog read it, else its bundle id.)
  let title = library.items().first { $0.id == item }?.value["title"] as? String ?? "?"
  let lit = await waitJS(c.webView, "return document.querySelector('.tab.active')?.getAttribute('aria-label') === \(jsonString(title) ?? "''")")
  let rows = await js(c.webView, "return [...document.querySelectorAll('.tab')].map(t => t.className + ' ' + t.getAttribute('aria-label')).join(' | ')") as? String ?? ""
  check("the sidebar highlights the app's item", lit, rows)

  // ---- a typed address: a web item, Safari started with no Dock icon, its copy's window, the tab ----
  let since = fake.events.count
  _ = await js(c.webView, "window.webkit.messageHandlers.margin.postMessage({ op: 'send', type: 'newTab', payload: { url: 'https://example.com/' } }); return true")
  guard await until(10, { fake.first("hostShow", since: since) != nil }) else { return check("a web item: its tab asked of the copy", false, "\(world.calls.suffix(6)) \(session.done.suffix(4))") }
  await session.idle()
  let web = library.items(space: first).first { $0.value["url"] as? String == "https://example.com/" }?.id ?? ""
  let reqs = fake.all("req", since: since).compactMap { $0["msg"] as? JSONObject }
  let asked = reqs.compactMap { $0["type"] as? String }.filter { $0 != "closeWindow" }
  check("Safari started with no Dock icon, then a window asked of its copy, put in full screen by it, then the item's tab", world.calls.contains("launch \(safariIdentifier)") && asked == ["newWindow", "setWindowState", "hostShow"], "\(asked)")
  // (Tirth, 2026-11-15) a Safari Margin started: the windows it restored are closed; Margin's own one never is.
  var madeId: Int?
  for r in reqs where r["type"] as? String == "setWindowState" {
    let payload = r["payload"] as? JSONObject
    madeId = int(payload?["windowId"])
  }
  var closed: [Int] = []
  for r in reqs where r["type"] as? String == "closeWindow" {
    let payload = r["payload"] as? JSONObject
    if let id = int(payload?["windowId"]) { closed.append(id) }
  }
  check("the window Safari had before its copy started (restored) closed, Margin's own never", madeId != nil && !closed.contains(madeId!) && !closed.isEmpty, "made \(String(describing: madeId)) closed \(closed)")
  let shown = fake.first("hostShow", since: since)?["payload"] as? JSONObject ?? [:]
  check("hostShow names the copy's new window, the item and its address", int(shown["windowId"]) == 90 && shown["itemId"] as? String == web && shown["url"] as? String == "https://example.com/", "\(shown)")
  let safariWin = engine.hosts[HostTarget.safariWindow("s-default").id]?.window ?? 0
  check("the engine shows Safari's window in the page area, a member; the app parked, still full screen", engine.shown == HostTarget.safariWindow("s-default").id && engine.hosts[textEdit]?.phase == .parked
        && engine.pageRect == expected && world.inMargin == [safariWin] && world.bounds(window: safariWin) == expected && world.wins[editWindow]?.fullScreen == true && world.listsMarginOnly)

  // ---- back to the app: an instant switch ----
  let backAt = Date()
  _ = library.perform("activateTab", ["windowId": c.id, "tabId": item])
  guard await until(5, { engine.shown == textEdit }) else { return check("back to the app", false, "\(session.done.suffix(4))") }
  await session.idle()
  check("back to the app: no full-screen exit or entry, no loading animation, Safari's window parked as it is", Date().timeIntervalSince(backAt) < 2 && world.inMargin == [editWindow]
        && !world.calls.suffix(4).contains { $0.hasPrefix("fullScreen") } && c.loadingView.isHidden && world.wins[safariWin]?.fullScreen == true, "\(world.calls.suffix(6))")
  _ = library.perform("activateTab", ["windowId": c.id, "tabId": web])
  guard await until(5, { engine.shown == HostTarget.safariWindow("s-default").id }) else { return check("back to Safari", false) }
  await session.idle()
  check("the sidebar highlights the web item", await waitJS(c.webView, "return document.querySelector('.tab.active')?.getAttribute('aria-label') === 'https://example.com/'"))

  // ---- a second web item: a tab switch only ----
  let calls = world.calls.count
  let since2 = fake.events.count
  _ = await js(c.webView, "window.webkit.messageHandlers.margin.postMessage({ op: 'send', type: 'newTab', payload: { url: 'https://second.example/' } }); return true")
  guard await until(5, { fake.first("hostShow", since: since2) != nil }) else { return check("the second web item's tab", false) }
  await session.idle()
  check("a second web item of the profile: only its tab, the engine not asked", world.calls.count == calls && fake.all("req", since: since2).count == 1, "\(world.calls.dropFirst(calls))")

  // ---- an app that can't go full screen (Calculator): window mode, Margin's window its whole width below it ----
  let since3 = world.calls.count
  _ = await js(c.webView, "window.webkit.messageHandlers.margin.postMessage({ op: 'perform', name: 'app.open', arg: { bundleId: '\(GlueHostWorld.calculator)' } }); return true")
  let calculator = HostTarget.app(GlueHostWorld.calculator).id
  guard await until(10, { engine.shown == calculator }) else { return check("Calculator picked: shown by the engine", false, "\(world.calls.dropFirst(since3)) \(session.done.suffix(4))") }
  await session.idle()
  let calcWindow = world.apps.values.first { $0.bundle == GlueHostWorld.calculator }?.windows.first ?? 0
  check("Calculator: in window mode, never put in full screen, alone in Margin's Space", engine.mode(of: calculator) == .window && world.wins[calcWindow]?.fullScreen == false
        && world.inMargin == [calcWindow] && world.listsMarginOnly, "\(world.calls.dropFirst(since3))")
  check("Calculator: Margin's window its whole width, drawing its own layout, nothing reserved on its Space",
        c.hosting && abs(c.window.frame.width - display.width) <= 1 && c.layout?.outside == false && (world.reservation[GlueHostWorld.marginSpace] ?? .zero).isZero, "\(c.window.frame) \(String(describing: c.layout))")
  // (Seen 2026-11-15: in full screen with Keep open off the sidebar hid, the page area became the whole window and
  // FaceTime was placed over where the sidebar is. Docked as beside a tile, the page area is the docked layout's.)
  let docked = await waitJS(c.webView, "return document.querySelector('.arcadia')?.dataset.sidebar === 'open'")
  check("Calculator: the sidebar stays docked in window mode, the page area beside it (the docked layout's)", docked && (c.layout?.left ?? 0) > 100 && (c.window.pageRect?.minX ?? 0) > display.minX + 100,
        "layout \(String(describing: c.layout)) page \(String(describing: c.window.pageRect))")
  let calcPage = c.window.pageRect ?? .zero
  let centred = CGRect(x: (calcPage.minX + (calcPage.width - 230) / 2).rounded(), y: (calcPage.minY + (calcPage.height - 408) / 2).rounded(), width: 230, height: 408)
  check("Calculator: centred in Margin's own page area (its layout's), only moved", calcPage.width > 400 && world.bounds(window: calcWindow) == centred && engine.pageRect == calcPage,
        "\(String(describing: world.bounds(window: calcWindow))) in \(calcPage)")
  let noLauncher = await waitJS(c.webView, "return !document.querySelector('.launcher')")
  // (The first run's space editor, its field focused, closed before hosting began: a field taken out of the page fires
  // no focusout in WebKit, and the page says the keys are free anyway.)
  let focused = await js(c.webView, "const a = document.activeElement; return a ? a.outerHTML.slice(0, 200) : 'none'") as? String ?? "?"
  check("Calculator: no launcher under its window (its field would take the keys), no field of Margin's has them", noLauncher && !c.pageWantsKeyboard, focused)
  check("Calculator: Margin's window kept right below its window", c.below == calcWindow && c.belowOrders >= 1 && engine.shownAbove == calcWindow,
        "below \(String(describing: c.below)) orders \(c.belowOrders) shown \(String(describing: engine.shownAbove)) calc \(calcWindow) keys \(c.pageWantsKeyboard)")
  // (The engine asks Margin's window's page to measure at every look while it waits for a layout at its whole width:
  // a size the window took isn't measured until a frame is drawn, which can be seconds late. The page measures at once.)
  let measuresBefore = await js(c.webView, "return marginApp.stats().measures") as? Int ?? -1
  c.remeasure()
  let measuredAgain = await waitJS(c.webView, "return marginApp.stats().measures > \(measuresBefore)")
  check("Calculator: Margin's window's page measures when asked (no frame needed)", measuresBefore >= 0 && measuredAgain && c.layout?.outside == false && abs((c.layout?.width ?? 0) - display.width) <= 1,
        "\(measuresBefore) \(String(describing: c.layout))")

  // ---- macOS takes Margin's window out of full screen anyway: straight back in, the app shown back with it ----
  c.fullScreenChanged(false)
  guard await until(5, { engine.shown == calculator && c.hosting && c.below == calcWindow }) else { return check("back into full screen with Calculator", false, "\(session.done.suffix(5))") }
  await session.idle()
  check("out of full screen by macOS: back into it at once, Calculator hosted again at the page area", c.isFullScreen && c.backIntoFullScreen == 1 && world.bounds(window: calcWindow) == centred
        && session.done.contains { $0.contains("back in full screen") }, "\(session.done.suffix(5))")

  // ---- the overlay path off ----
  shell.track()
  check("no overlay over the copy's windows, nothing drawn or laid out for them", shell.overlays.isEmpty && fake.first("drawn") == nil && fake.first("setLayout") == nil)

  // ---- quitting: the hosted apps given back while the link is up ----
  var done = false
  stopped = true
  shell.stop { done = true }
  guard await until(10, { done }) else { return check("quit", false) }
  check("quit: Calculator back at its own frame before it was quit", world.frameAtQuit[GlueHostWorld.calculator] == GlueHostWorld.calculatorFrame, "\(world.frameAtQuit)")
  check("quit: the apps Margin started quit, nothing left in Margin's Space, Mission Control Margin's Space only", world.apps.isEmpty && world.inMargin.isEmpty && world.listsMarginOnly
        && (world.reservation[GlueHostWorld.marginSpace] ?? .zero).isZero, "\(world.apps.values.map(\.bundle)) \(world.fullScreenSpaces)")
}
