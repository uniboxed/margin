// Margin as the app, joined up, end to end (part of e2e.swift's run; app/platforms/macos/shell/HostedSession.swift,
// ShellHostedGlue.swift): the real shell, its library in a temporary folder, Margin's own window
// with the real page off every display (never key, the app never active), the real link to fake-extension.mts as
// Safari's default profile's copy, and the real host engine on a stand-in window manager (GlueHostWorld: nothing is
// launched, put in full screen or moved; no Space of the Mac's is touched).
//
// What it follows: the first run (nothing to import) makes a space and opens the UI's space editor; an app picked
// in the palette (the page's `app.open`) is an item of the space, and the engine opens it above Margin's page area (a
// member of Margin's Space at the page area its own Space reserved), given the page area from Margin's own layout,
// with the loading animation meanwhile; Margin's window is always full screen (shown so, never leaving it: asked, it
// refuses; taken out by macOS, it goes back and the app shown comes back with it), its whole width, its page drawing
// its own layout (pageHosted, the sidebar docked); a typed address (the page's `newTab`) is a web item: Safari
// started with no Dock icon, a window asked of the copy (`newWindow`) after its link, shown by the engine, and the
// item's tab asked of the copy (`hostShow`); the sidebar highlights the item shown; a second web item is a tab switch
// only; the sidebar's edge dragged in the page (its real handle, pointer events): Margin's window in front of the
// hosted one for the drag, nothing placed until it's let go, then the hosted window once at the new page area (a
// window-mode app moved, a full-screen member out and in), Margin still full screen at its whole width, a parked
// member placed when it's next shown; `drawn` true for the hosted Safari window only, false for the person's own; no
// `setLayout`; ⌘Q with a hosted app in front is Margin's prompt (Cancel keeps everything, another app in front takes
// it down, ⌘Q again quits), and quitting gives it all back.
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
  func isHidden(pid: pid_t) -> Bool? { apps[pid] == nil ? nil : false }
  func unhide(pid: pid_t) -> Bool { apps[pid] != nil }
  func enhancedUserInterface(pid: pid_t) async -> Bool? { false }
  func setEnhancedUserInterface(pid: pid_t, _ on: Bool) async -> Bool { false }
  func keepsWindowsAtQuit(pid: pid_t) -> Bool { false }
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
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root
  options.bundleIds = ["safari": fakeBundle]
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
  // (Margin's quit, as the app's terminate would come back to the shell's stop; asking, kept here.)
  final class Quit { var asks = true; var asked = 0; var stopped = false; var run: () -> Void = {} }
  let quit = Quit()
  options.asksBeforeQuit = { quit.asks }
  options.setAskBeforeQuit = { quit.asks = $0 }
  options.quit = { quit.asked += 1; quit.run() }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.glue.\(ProcessInfo.processInfo.processIdentifier)"))
  let apps = ScriptedApps()
  let keys = FakeKeys()
  let shell = Shell(link: link, apps: apps, hotKeys: keys, options: options)
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
  c.hostedBounds = { world.bounds(window: $0) } // (the hosted window's bounds: the stand-in window manager's)
  var loadingAtLaunch: [String: String?] = [:]
  var loadingTabsAtLaunch: [String: [Int]] = [:]
  world.onLaunch = { bundle in loadingAtLaunch[bundle] = c.loadingLabel; loadingTabsAtLaunch[bundle] = c.loadingTabs }
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
  // (Whether the theme's loading bar is ever drawn from here: Arcadia's root gets `loading` while the tab in front loads.)
  _ = await js(c.webView, "window.__sawLoading = false; new MutationObserver(() => { if (document.querySelector('.arcadia.loading')) window.__sawLoading = true; }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] }); return true")
  _ = await js(c.webView, "window.webkit.messageHandlers.margin.postMessage({ op: 'perform', name: 'app.open', arg: { bundleId: 'com.apple.TextEdit' } }); return true")
  let textEdit = HostTarget.app("com.apple.TextEdit").id
  guard await until(10, { engine.shown == textEdit }) else { return check("the app picked: opened by the engine", false, "\(world.calls) \(session.done.suffix(4))") }
  await session.idle()
  let item = library.items(space: first).first { $0.value["url"] as? String == "app://com.apple.TextEdit" }?.id ?? ""
  check("the pick: an item of the window's space", !item.isEmpty && library.target(ofItem: item) != nil)
  check("the app started with no Dock icon (the stand-in's launch)", world.calls.contains("launch com.apple.TextEdit"))
  let barSeen = await waitJS(c.webView, "return window.__sawLoading === true && !document.querySelector('.arcadia.loading')")
  check("the theme's loading bar for the app's item as it launched (the page told its number is loading), gone once it's shown; no spinner of Margin's own",
        loadingAtLaunch["com.apple.TextEdit"] == .some("com.apple.TextEdit") && loadingTabsAtLaunch["com.apple.TextEdit"] == [session.number(ofItem: item)]
        && barSeen && c.loadingLabel == nil && c.loadingTabs.isEmpty && c.pushed.contains { $0.contains(#""type":"loading""#) }, "\(loadingAtLaunch) \(loadingTabsAtLaunch) \(barSeen)")
  check("Margin's window its whole width (never a tile)", abs(c.window.frame.width - display.width) <= 1, "\(c.window.frame)")
  let dockedFixed = await waitJS(c.webView, "const r = document.querySelector('.arcadia'); const h = document.querySelector('[m-resize]')?.getBoundingClientRect(); return r?.dataset.sidebar === 'open' && !document.querySelector('.launcher') && !r.hasAttribute('m-sidebar-fixed') && getComputedStyle(document.querySelector('[m-resize]')).display !== 'none' && h.width > 0 && h.height > 0")
  check("its page draws its own layout, the sidebar docked (pageHosted), no launcher, its edge's handle there to drag", dockedFixed)
  check("the placement from a layout measured in full screen at its whole width (no fallback to an older one)", c.layout?.outside == false && c.layout?.mode == "fullscreen"
        && !session.done.contains { $0.contains("no full-screen layout") }, "\(String(describing: c.layout)) \(session.done.filter { $0.contains("layout") })")
  let expected = c.layout.flatMap { MarginWindowGeometry.pageRect(layout: $0, content: display) }
  check("the engine got the page area from Margin's own layout (the theme's frame around it)", expected != nil && engine.pageRect == expected && c.window.pageRect == expected && (expected?.minX ?? 0) > display.minX + 100,
        "\(engine.pageRect) \(String(describing: expected))")
  let editWindow = world.apps.values.first { $0.bundle == "com.apple.TextEdit" }?.windows.first ?? 0
  check("the app's window there, a member of Margin's Space, still full screen; Mission Control Margin's Space only", world.bounds(window: editWindow) == expected && world.inMargin == [editWindow]
        && world.wins[editWindow]?.fullScreen == true && world.listsMarginOnly && world.calls.last == "activate com.apple.TextEdit", "\(String(describing: world.bounds(window: editWindow))) \(world.calls.suffix(3))")
  check("Margin's window kept right below it", c.below == editWindow)
  // (The page card's rounded corners over the hosted window: Arcadia's 10 pt radius, its frame around them, which is
  // the space's colour mixed into a near-white: read from the page, as it computes it.)
  let frameCSS = (await js(c.webView, "return getComputedStyle(document.querySelector('m-page')).boxShadow.split(') ')[0] + ')'") as? String) ?? ""
  let radius = CGFloat(c.layout?.radii.first ?? 0), side = radius.rounded(.up)
  let page = expected ?? .zero
  let wantCorners = [CGRect(x: page.minX, y: page.minY, width: side, height: side), CGRect(x: page.maxX - side, y: page.minY, width: side, height: side),
                     CGRect(x: page.maxX - side, y: page.maxY - side, width: side, height: side), CGRect(x: page.minX, y: page.maxY - side, width: side, height: side)]
  check("the page card's corners drawn over the hosted window: one small panel each, at the page area's corners, the theme's frame colour, above normal windows, never taking the mouse",
        radius > 0 && c.corners.isShown && c.corners.frames == wantCorners && frameCSS.hasPrefix("color(srgb ") && c.layout?.fills == Array(repeating: frameCSS, count: 4) && c.layout?.edge == nil
        && c.corners.panels.prefix(4).allSatisfy { $0.level == .floating && $0.ignoresMouseEvents && !$0.isOpaque && !$0.canBecomeKey && $0.collectionBehavior.contains(.transient) && !$0.collectionBehavior.contains(.canJoinAllSpaces) },
        "\(c.corners.frames) want \(wantCorners) fills \(String(describing: c.layout?.fills))")
  check("the hosted window placed in Margin's own full-screen frame (the area its own Space lays it out in), never the display less its inset",
        c.hostedPlacement?.area == c.contentFrame, "\(String(describing: c.hostedPlacement))")
  let ground = HostCorners.color(frameCSS)
  check("under a hosted window covering the page area, the page area's ground is the frame's colour (any sliver it leaves is the frame, never dark)",
        ground != nil && c.pageGround == ground && c.window.backgroundColor == ground, "\(String(describing: c.pageGround)) \(frameCSS)")
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
        && !world.calls.suffix(4).contains { $0.hasPrefix("fullScreen") } && c.loadingLabel == nil && c.loadingTabs.isEmpty && world.wins[safariWin]?.fullScreen == true, "\(world.calls.suffix(6))")
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

  // ---- Margin's keys while hosting: held while Margin or a hosted app is in front, the next/previous item of the space ----
  apps.bringToFront(1) // (an app Margin doesn't host)
  shell.track()
  check("keys: another app in front: Margin's keys let go, ⌘Q that app's own", !shell.shortcuts.isActive && !shell.shortcuts.guardsQuit && keys.held.isEmpty)
  let calcPid = world.apps.values.first { $0.bundle == GlueHostWorld.calculator }?.pid ?? 0
  apps.bringToFront(calcPid)
  shell.track()
  check("keys: a hosted app in front (Calculator): Margin's keys held, the defaults (⌥⌘↑/↓, ⌘T…) but the sidebar's (docked while hosting), and ⌘Q and ⌥⌘Q (Margin asks before it quits)", shell.shortcuts.isActive && keys.held.values.contains(Combo.parse("Alt+Meta+ArrowDown")!)
        && shell.shortcuts.guardsQuit && keys.held.values.contains(Combo.parse("Meta+KeyQ")!) && keys.held.values.contains(Combo.parse("Alt+Meta+KeyQ")!) && !keys.held.values.contains(Combo.parse("Alt+KeyS")!), "\(keys.held.values)")
  let calcItem = session.shown[c.id] ?? ""
  keys.press("Alt+Meta+ArrowUp")
  let movedOn = await until(5, { (session.shown[c.id] ?? calcItem) != calcItem })
  await session.idle()
  let prevItem = session.shown[c.id] ?? ""
  check("keys: ⌥⌘↑ with a hosted app in front: the previous item of the space shown (as a sidebar pick)", movedOn && !prevItem.isEmpty && shell.hostedKeysRun.last == "prev-tab → \(c.id)"
        && library.requests.last { $0.type == "activateTab" }?.item == prevItem, "\(shell.hostedKeysRun) \(session.done.suffix(4))")
  keys.press("Alt+Meta+ArrowDown")
  let back = await until(5, { session.shown[c.id] == calcItem && engine.shown == calculator })
  await session.idle()
  check("keys: ⌥⌘↓ then: the next one, Calculator again", back && shell.hostedKeysRun.last == "next-tab → \(c.id)", "\(String(describing: session.shown[c.id])) \(shell.hostedKeysRun)")
  apps.bringToFront(ProcessInfo.processInfo.processIdentifier)
  shell.track()
  check("keys: Margin itself in front: held, its sidebar key too", shell.shortcuts.isActive && keys.held.values.contains(Combo.parse("Alt+KeyS")!))
  let pushes = c.pushes
  keys.press("Meta+KeyT")
  check("keys: ⌘T: the palette, in Margin's window", c.pushed.suffix(max(1, c.pushes - pushes)).contains(#"{"type":"command","name":"palette"}"#))
  keys.press("Meta+KeyT") // (and closed again)
  _ = await waitJS(c.webView, "return !document.querySelector('[m-input=\"palette\"]:focus')")
  apps.bringToFront(1)
  shell.track()
  check("keys: let go again once another app is in front", !shell.shortcuts.isActive)
  if c.below != calcWindow { c.orderBelowHosted() }

  // ---- macOS takes Margin's window out of full screen anyway: straight back in, the app shown back with it ----
  c.fullScreenChanged(false)
  guard await until(5, { engine.shown == calculator && c.hosting && c.below == calcWindow }) else { return check("back into full screen with Calculator", false, "\(session.done.suffix(5))") }
  await session.idle()
  check("out of full screen by macOS: back into it at once, Calculator hosted again at the page area", c.isFullScreen && c.backIntoFullScreen == 1 && world.bounds(window: calcWindow) == centred
        && session.done.contains { $0.contains("back in full screen") }, "\(session.done.suffix(5))")

  check("the corners follow the page area (window mode: Calculator)", c.corners.isShown && c.corners.frames.first?.origin == c.window.pageRect?.origin, "\(c.corners.frames)")
  check("window mode (Calculator, smaller than the page area): the window's own ground around it, not the frame's", c.pageGround == nil && c.window.backgroundColor == .windowBackgroundColor, "\(String(describing: c.pageGround))")

  // ---- the sidebar's edge dragged: the page's own handle, pointer events as WebKit hands a person's drag ----
  // (Each event at the handle, `dx` from where the press landed; the handle moves with the width, the pointer doesn't.)
  func handle(_ type: String, dx: Double = 0) async {
    _ = await js(c.webView, """
      const h = document.querySelector('[m-resize]'); const r = h.getBoundingClientRect();
      if ('\(type)' === 'pointerdown' || '\(type)' === 'dblclick') window.__resizeAt = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const at = window.__resizeAt;
      const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: \(type == "pointerup" || type == "dblclick" ? 0 : 1), clientX: at.x + \(dx), clientY: at.y };
      h.dispatchEvent('\(type)' === 'dblclick' ? new MouseEvent('dblclick', init) : new PointerEvent('\(type)', { ...init, pointerId: 7, isPrimary: true }));
      return true
    """)
  }
  func called(_ prefix: String, since: Int) -> [String] { world.calls.dropFirst(since).filter { $0.hasPrefix(prefix) } }
  func inContent(_ r: CGRect) -> CGRect { r.offsetBy(dx: -display.minX, dy: -display.minY) }
  let asksBefore = c.fullScreenAsks, backBefore = c.backIntoFullScreen
  let stillFullScreen = { c.isFullScreen && c.fullScreenAsks == asksBefore && c.backIntoFullScreen == backBefore && abs(c.window.frame.width - display.width) <= 1 && c.window.frame.height == display.height }
  let marginUnreserved = { (world.reservation[GlueHostWorld.marginSpace] ?? .zero).isZero }

  // A window-mode app shown (Calculator, centred): held while dragged, moved once when it's let go.
  var mark = world.calls.count
  let liftsBefore = c.liftOrders
  let placings = { session.done.filter { $0.hasPrefix("page area changed") }.count }
  var placed = placings()
  await handle("pointerdown")
  check("resize: a press on the handle alone: nothing lifted, nothing held", !c.lifted && session.resizing == nil)
  await handle("pointermove", dx: 12)
  await handle("pointermove", dx: 24)
  guard await until(5, { c.lifted && session.resizing == c.id }) else { return check("resize: the drag reaches the app (the page's sidebar.resizing)", false, "\(c.asks.suffix(4)) \(session.done.suffix(3))") }
  c.remeasure() // (a test's window gets no frames: the page's place as it is now)
  let live = await until(5, { c.window.pageRect?.minX == calcPage.minX + 24 })
  check("resize (window mode): while dragged, Margin's own page area follows live, its window in front of Calculator's and see-through where that window is, the page card's corner panels put away",
        live && c.liftOrders == liftsBefore + 1 && c.window.backgroundColor == .clear && c.ground.isShown && c.ground.hole == inContent(centred) && !c.corners.isShown,
        "page \(String(describing: c.window.pageRect)) hole \(String(describing: c.ground.hole)) orders \(c.liftOrders)")
  check("resize (window mode): … and Calculator isn't moved, the engine's page area held", world.bounds(window: calcWindow) == centred && engine.pageRect == calcPage && called("frame", since: mark).isEmpty
        && placings() == placed, "\(called("frame", since: mark)) \(session.done.suffix(3))")
  await handle("pointermove", dx: 40)
  await handle("pointerup", dx: 40)
  guard await until(5, { !c.lifted && session.resizing == nil }) else { return check("resize (window mode): let go", false, "\(session.done.suffix(4))") }
  await session.idle()
  let wider = c.window.pageRect ?? .zero
  let centredWider = CGRect(x: (wider.minX + (wider.width - 230) / 2).rounded(), y: (wider.minY + (wider.height - 408) / 2).rounded(), width: 230, height: 408)
  check("resize (window mode): let go: the page area 40 pt narrower from its left, Calculator moved once to its middle, the engine told once",
        wider.minX == calcPage.minX + 40 && wider.maxX == calcPage.maxX && world.bounds(window: calcWindow) == centredWider && engine.pageRect == wider && called("frame", since: mark).count == 1
        && called("fullScreen", since: mark).isEmpty && placings() == placed + 1, "\(wider) \(String(describing: world.bounds(window: calcWindow))) \(called("frame", since: mark)) \(session.done.suffix(3))")
  check("resize (window mode): Margin's window right below Calculator's again, opaque, its corners at the new page area; still full screen at its whole width, nothing reserved on its Space",
        c.below == calcWindow && !c.ground.isShown && c.window.backgroundColor != .clear && c.corners.isShown && c.corners.frames.first?.origin == wider.origin && stillFullScreen() && marginUnreserved(),
        "\(c.corners.frames) \(c.window.frame)")
  let savedWidth = await js(c.webView, "return getComputedStyle(document.querySelector('.arcadia')).getPropertyValue('--m-sidebar-width').trim()") as? String ?? ""
  check("resize: the width saved as the theme's own setting (asked of the source), drawn from it", c.asks.contains("updateThemeSettings") && !savedWidth.isEmpty, "\(savedWidth)")

  // A full-screen member parked through that drag (TextEdit, placed for the page area before it): placed when it's next shown.
  mark = world.calls.count
  _ = library.perform("activateTab", ["windowId": c.id, "tabId": item])
  guard await until(10, { engine.shown == textEdit }) else { return check("resize: back to the app", false, "\(session.done.suffix(4))") }
  await session.idle()
  check("resize: a member parked through the drag, shown next: placed for the new page area as it's shown (out of full screen and in, once), its Space's reservation the new page area's alone",
        world.bounds(window: editWindow) == wider && called("fullScreen", since: mark) == ["fullScreen false", "fullScreen true"] && world.inMargin == [editWindow] && world.listsMarginOnly
        && called("reserve", since: mark).allSatisfy { $0 == "reserve " + (HostLayout.plan(HostPlacement(page: wider, area: display))?.text ?? "?") } && !called("reserve", since: mark).isEmpty && marginUnreserved(),
        "\(String(describing: world.bounds(window: editWindow))) \(called("fullScreen", since: mark)) \(called("reserve", since: mark))")

  // That full-screen member shown: seen through while dragged, placed once when it's let go (the sidebar narrower now).
  mark = world.calls.count
  placed = placings()
  let loadingPushes = { c.pushed.filter { $0.contains(#""type":"loading""#) && !$0.contains(#""tabIds":[]"#) }.count }
  let pushesBefore = c.pushes
  await handle("pointerdown")
  await handle("pointermove", dx: -10)
  await handle("pointermove", dx: -25)
  guard await until(5, { c.lifted && session.resizing == c.id }) else { return check("resize (full screen): the drag reaches the app", false, "\(session.done.suffix(3))") }
  c.remeasure()
  let live2 = await until(5, { c.window.pageRect?.minX == wider.minX - 25 })
  check("resize (full screen): while dragged, Margin's window in front of the member, see-through at its bounds, the ground in the gap the narrower sidebar leaves",
        live2 && c.window.backgroundColor == .clear && c.ground.hole == inContent(wider) && c.ground.fills(CGPoint(x: inContent(wider).minX - 10, y: inContent(wider).midY)) && !c.ground.fills(CGPoint(x: inContent(wider).midX, y: inContent(wider).midY))
        && c.ground.color == ground && !c.corners.isShown, "page \(String(describing: c.window.pageRect)) hole \(String(describing: c.ground.hole)) ground \(String(describing: c.ground.color))")
  // (What seeing through rests on: nothing the page draws covers the middle of its page slot. Every element whose box
  // holds that point, whether or not it takes the pointer, has no background of its own.)
  let slotClear = await js(c.webView, """
    const r = document.querySelector('m-page').getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const paints = [...document.querySelectorAll('*')].filter((el) => {
      const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if (!(b.left <= x && x <= b.right && b.top <= y && y <= b.bottom) || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
      return !/^(rgba\\(0, 0, 0, 0\\)|transparent)$/.test(cs.backgroundColor) || cs.backgroundImage !== 'none';
    });
    return paints.map((el) => el.localName + '.' + el.className).join(' | ')
  """) as? String
  check("resize: the page draws nothing over the middle of its page slot while hosting (the hosted window shows through there)", slotClear == "", slotClear ?? "not read")
  check("resize (full screen): … and nothing leaves full screen, nothing is reserved or moved: the member where it was", called("fullScreen", since: mark).isEmpty && called("reserve", since: mark).isEmpty
        && world.bounds(window: editWindow) == wider && engine.pageRect == wider && world.inMargin == [editWindow] && placings() == placed, "\(world.calls.dropFirst(mark))")
  await handle("pointermove", dx: -30)
  await handle("pointerup", dx: -30)
  // (Let go over a full-screen member: the ground alone while it's out of Margin's Space, then below it again.)
  guard await until(10, { !c.lifted && session.resizing == nil && engine.shown == textEdit }) else { return check("resize (full screen): let go", false, "\(session.done.suffix(4))") }
  await session.idle()
  let narrower = c.window.pageRect ?? .zero
  check("resize (full screen): let go: one exit from full screen and one entry, the member at the new page area in Margin's Space, still full screen; Mission Control Margin's Space only",
        narrower.minX == wider.minX - 30 && narrower.maxX == wider.maxX && world.bounds(window: editWindow) == narrower && engine.pageRect == narrower
        && called("fullScreen", since: mark) == ["fullScreen false", "fullScreen true"] && world.inMargin == [editWindow] && world.wins[editWindow]?.fullScreen == true && world.listsMarginOnly
        && placings() == placed + 1, "\(narrower) \(String(describing: world.bounds(window: editWindow))) \(called("fullScreen", since: mark))")
  check("resize (full screen): its own Space reserved for the new page area alone (never added to the last), nothing on Margin's Space",
        !called("reserve", since: mark).isEmpty && called("reserve", since: mark).allSatisfy { $0 == "reserve " + (HostLayout.plan(HostPlacement(page: narrower, area: display))?.text ?? "?") } && marginUnreserved(),
        "\(called("reserve", since: mark))")
  check("resize (full screen): Margin never left full screen and kept its whole width; right below the member again, opaque, the frame's colour its ground, the corners at the new page area in the theme's colours",
        stillFullScreen() && c.below == editWindow && !c.ground.isShown && c.pageGround == ground && c.window.backgroundColor == ground && c.corners.isShown && c.corners.frames.first?.origin == narrower.origin
        && c.layout?.fills == Array(repeating: frameCSS, count: 4), "\(c.corners.frames) fills \(String(describing: c.layout?.fills)) ground \(String(describing: c.pageGround))")
  check("resize (full screen): the theme's loading bar for its item while it's placed again", c.pushed.suffix(max(1, c.pushes - pushesBefore)).contains { $0.contains(#""type":"loading""#) && !$0.contains(#""tabIds":[]"#) } && c.loadingTabs.isEmpty,
        "\(loadingPushes())")

  // Double-click on the handle: the theme's default width, as one change.
  mark = world.calls.count
  await handle("dblclick")
  guard await until(10, { c.window.pageRect == expected && engine.pageRect == expected && !c.lifted && session.resizing == nil }) else {
    return check("resize: a double-click on the handle: the default width", false, "\(String(describing: c.window.pageRect)) want \(String(describing: expected)) \(session.done.suffix(4))")
  }
  await session.idle()
  check("resize: a double-click on the handle: the default width again, the member placed once for it", world.bounds(window: editWindow) == expected && called("fullScreen", since: mark) == ["fullScreen false", "fullScreen true"]
        && stillFullScreen() && world.listsMarginOnly && c.below == editWindow, "\(called("fullScreen", since: mark))")

  // ---- which of the copy's windows Margin draws: only the one it hosts; the person's own told not (their ⌘T stays
  // Safari's way); nothing of the page box ----
  shell.track()
  let told = { (id: Int) in fake.all("drawn") { int($0["windowId"]) == id }.last.flatMap { $0["on"] as? Bool } }
  check("drawn: the person's own Safari window told not drawn, the hosted one drawn, each once",
        told(1) == false && told(madeId ?? -1) == true && fake.all("drawn") { int($0["windowId"]) == 1 }.count == 1,
        "\(fake.all("drawn").map { "\(int($0["windowId"]) ?? -1)=\($0["on"] ?? "?")" })")
  check("nothing laid out for the copy's windows", fake.first("setLayout") == nil)

  // ---- ⌘Q with an app Margin hosts in front: Margin's own prompt ----
  // (The app shown now, in front: one Margin hosts.)
  let hostedPid = engine.shown.flatMap { engine.hosts[$0]?.pid } ?? 0
  apps.bringToFront(hostedPid)
  shell.track()
  let running = Set(world.apps.keys), shownNow = engine.shown, itemNow = session.shown[c.id], members = world.inMargin
  let untouched = { quit.asked == 0 && Set(world.apps.keys) == running && engine.shown == shownNow && session.shown[c.id] == itemNow && world.inMargin == members && members.count == 1
    && !world.calls.contains { $0.hasPrefix("terminate") } }
  check("quit: a hosted app in front: ⌘Q and ⌥⌘Q are Margin's first", hostedPid != 0 && shell.shortcuts.guardsQuit && keys.held.values.contains(Combo.parse("Meta+KeyQ")!) && keys.held.values.contains(Combo.parse("Alt+Meta+KeyQ")!))
  keys.press("Meta+KeyQ")
  let said = shell.quitPrompt?.view?.note.stringValue ?? ""
  check("quit: ⌘Q with a hosted app in front: Margin's prompt, nothing quit, nothing given back yet", shell.quitPrompt?.isUp == true && untouched(), "\(world.calls.suffix(3))")
  check("quit: the prompt asks about Margin and says what quitting closes, in numbers and Margin's own words (no title, no address, no app's name)",
        shell.quitPrompt?.view?.title.stringValue == "Are you sure you want to quit Margin?"
        && said == "Margin will close 2 open tabs and quit 2 apps it opened. Your tabs stay in their spaces, but unsaved work may be lost." && !said.contains("example") && !said.contains("TextEdit") && !said.contains("Calculator"), said)
  if let escape = QuitPrompt.choice(keyCode: 53, command: false) { shell.quitPrompt?.choose(escape) }
  shell.track()
  check("quit: Cancel (Escape): the prompt gone, everything as it was, ⌘Q still Margin's first", shell.quitPrompt == nil && untouched() && shell.shortcuts.guardsQuit && quit.asks)
  keys.press("Alt+Meta+KeyQ")
  check("quit: ⌥⌘Q the same: the prompt", shell.quitPrompt?.isUp == true && untouched())
  apps.bringToFront(1) // (an app Margin doesn't host)
  shell.track()
  check("quit: the prompt up and another app comes to the front: taken down (never left up), nothing quit", shell.quitPrompt == nil && untouched())
  keys.press("Meta+KeyQ")
  check("quit: an app Margin doesn't host in front: ⌘Q isn't Margin's (not held, no prompt)", !shell.shortcuts.guardsQuit && !keys.held.values.contains(Combo.parse("Meta+KeyQ")!) && shell.quitPrompt == nil && untouched())
  apps.bringToFront(hostedPid)
  shell.track()
  // (Asking off, as after "Always quit": the key in a hosted app is still Margin's, so it never quits the hosted app alone.)
  quit.asks = false
  shell.track()
  check("quit: asking off with a hosted app in front: ⌘Q still Margin's first (it would quit Margin without asking, never the hosted app alone)",
        shell.shortcuts.guardsQuit && keys.held.values.contains(Combo.parse("Meta+KeyQ")!) && untouched())
  quit.asks = true
  shell.track()
  keys.press("Meta+KeyQ")
  check("quit: the hosted app in front again: the prompt again", shell.quitPrompt?.isUp == true && untouched())

  // ---- Quit (⌘Q again): Margin quits as it always does: the hosted apps given back while the link is up ----
  var done = false
  stopped = true
  quit.run = { shell.stop { done = true } }
  keys.press("Meta+KeyQ")
  check("quit: ⌘Q again with the prompt up: Quit, asked of the app once; still asking next time (not Always quit)", quit.asked == 1 && shell.quitsAsked == 1 && shell.quitPrompt == nil && quit.asks)
  guard await until(10, { done }) else { return check("quit", false) }
  check("quit: ⌘Q is the front app's again while Margin quits", !shell.shortcuts.guardsQuit && !keys.held.values.contains(Combo.parse("Meta+KeyQ")!))
  check("quit: nothing hosted: the corners gone, the window's own ground again", !c.corners.isShown && c.corners.panels.allSatisfy { !$0.isVisible } && c.pageGround == nil)
  check("quit: Calculator back at its own frame before it was quit", world.frameAtQuit[GlueHostWorld.calculator] == GlueHostWorld.calculatorFrame, "\(world.frameAtQuit)")
  check("quit: the apps Margin started quit, nothing left in Margin's Space, Mission Control Margin's Space only", world.apps.isEmpty && world.inMargin.isEmpty && world.listsMarginOnly
        && (world.reservation[GlueHostWorld.marginSpace] ?? .zero).isZero, "\(world.apps.values.map(\.bundle)) \(world.fullScreenSpaces)")
}
