// Margin as the app, joined up, end to end (part of e2e.swift's run; app/platforms/macos/shell/HostedSession.swift,
// ShellHostedGlue.swift): the real shell, its library in a temporary folder, Margin's own window
// with the real page off every display (never key, the app never active), the real link to fake-extension.mts as
// Safari's default profile's copy, and the real host engine on a stand-in window manager (GlueHostWorld: nothing is
// launched, put in full screen or moved; no Space of the Mac's is touched).
//
// What it follows: the first run (nothing to import) makes a space and opens the UI's space editor; an app picked
// in the palette (the page's `app.open`) is an item of the space, and the engine opens it in Margin's page area (a
// member of Margin's Space at the page area its own Space reserved), given the page area from Margin's own layout;
// Margin's window is always full screen (shown so, never leaving it: asked, it refuses; taken out by macOS, it goes
// back and the app shown comes back with it), its whole width, its page drawing its own layout (pageHosted, the
// sidebar docked), and IN FRONT of what it hosts (its level raised, held by the window server): the page card
// `loading` (opaque, the theme's root says so, Margin's default loader) while the app launches, then `shown`: the
// page area a hole (the window's own picture see-through there, the ground and the theme's frame around it), the
// pointer through it to the app but for the frame, the rounded corners and what the theme draws over it; a typed
// address (the page's `newTab`) is a web item: Safari started with no Dock icon, a window asked of the copy
// (`newWindow`) after its link, shown by the engine, and the item's tab asked of the copy (`hostShow`); the sidebar
// highlights the item shown; a switch between two prepared items never shows the loader; a second web item is a tab
// switch only; ⌘T with a hosted app in front draws the palette over the page area (Margin's window is in front), the
// pointer there Margin's, and Escape gives the app the keys again; the sidebar's edge dragged in the page (its real
// handle, pointer events): the sidebar over the hosted window live, nothing placed until it's let go, then the hosted
// window once at the new page area behind the loader (a window-mode app moved, a full-screen member out and in),
// twice in a row, Margin still full screen at its whole width, a parked member placed when it's next shown; another
// app's window let in front and the ordering way of staying in front; `drawn` true for the hosted Safari window only,
// false for the person's own; ⌘Q with a hosted app in front is Margin's prompt (Cancel keeps everything, another app
// in front takes it down, ⌘Q again quits), and quitting gives it all back.
import AppKit
import ImageIO
import UniformTypeIdentifiers
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
  // All panes active (PanesActive.swift): off unless a scenario turns it on; each record asked for, in order.
  var panesActive = false
  var activeCalls: [String] = []
  var keepsPanesActive: Bool { panesActive }
  func keepActive(_ w: PaneWindow) { activeCalls.append("keep \(w.pid) \(w.window)") }
  func moveActive(_ w: PaneWindow, from: Int) { activeCalls.append("move \(w.pid) \(from)→\(w.window)") }
  func releaseActive(_ w: PaneWindow) { activeCalls.append("release \(w.pid) \(w.window)") }
  func releaseActiveNow(_ list: [PaneWindow]) { for w in list { activeCalls.append("releaseNow \(w.pid) \(w.window)") } }

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
  var focused: [pid_t: Int] = [:] // the app's keyboard's window (none: unread)
  func focusedWindow(pid: pid_t) async -> Int? { focused[pid] }
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
  func spaces(window: Int) -> [UInt64]? { window == marginWindow ? [Self.marginSpace] : wins[window].map { $0.priv != nil ? [] : $0.spaces } ?? extraSpaces[window] }
  func spaceType(_ space: UInt64) -> Int? { fullScreenSpaces.contains(space) ? ManagedSpace.fullScreenType : (space == Self.desktop ? 0 : nil) }
  func spaceExists(_ space: UInt64) -> Bool? { fullScreenSpaces.contains(space) || space == Self.desktop }
  func currentSpace(onDisplayOf space: UInt64) -> UInt64? { current }
  func setCurrentSpace(_ space: UInt64) -> Bool { current = space; if space == Self.marginSpace { blank = false }; return true }
  // The window server's on-screen list (`lists`: played; else none, and the engine's on-screen look doesn't apply):
  // Margin's window and the windows of the current Space; none while the display shows a Space that's gone (`blank`).
  // `extraOnScreen`: windows only the list has (another app's, the hosted app's own extra one), right behind Margin's,
  // their Spaces by `extraSpaces`; `hostedFirst`: Margin's window behind the others.
  var lists = false
  var blank = false
  var extraOnScreen: [ServerWindow] = []
  var extraSpaces: [Int: [UInt64]] = [:]
  var hostedFirst = false
  func onScreenWindows() -> [ServerWindow]? {
    guard lists else { return nil }
    if blank { return [] }
    let here = wins.keys.sorted().filter { wins[$0]?.priv == nil && wins[$0]?.spaces.contains(current) == true }
    var list = ([marginWindow] + here).compactMap { n in bounds(window: n).map { ServerWindow(number: n, pid: wins[n]?.pid ?? 1, layer: n == marginWindow ? 1 : 0, bounds: $0) } }
    list.insert(contentsOf: extraOnScreen, at: min(1, list.count))
    if hostedFirst, list.count > 1 { list.append(list.removeFirst()) }
    return list
  }
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

// The window server's own picture of one of this process's windows (CGWindowListCreateImage of that window alone, as
// tools/glass-shots: no Screen Recording, and it pictures a window off every display), as alpha at points of the
// window (top left, points). What the hosted window would show through is where it's 0. Nil: no picture.
@MainActor
func windowAlpha(_ window: NSWindow, at points: [CGPoint]) -> [Int]? {
  typealias Create = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage"),
        let image = unsafeBitCast(symbol, to: Create.self)(.null, 8, UInt32(window.windowNumber), 1 | 16)?.takeRetainedValue(), image.width > 0, image.height > 0,
        let ctx = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let data = ctx.data else { return nil }
  ctx.clear(CGRect(x: 0, y: 0, width: image.width, height: image.height))
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  let bytes = data.assumingMemoryBound(to: UInt8.self)
  let sx = CGFloat(image.width) / window.frame.width, sy = CGFloat(image.height) / window.frame.height
  return points.map { p in
    let x = min(image.width - 1, max(0, Int(p.x * sx))), y = min(image.height - 1, max(0, Int(p.y * sy)))
    return Int(bytes[(y * image.width + x) * 4 + 3]) // (memory's first row is the top)
  }
}

// The window server's order of two of this process's windows (front to back, its on-screen list: off every display
// they're still listed): whether `upper` is above `lower`, and the layer it gives each. Nil: one isn't listed.
func serverAbove(_ upper: Int, _ lower: Int) -> (above: Bool, layers: [Int])? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
  let numbers = list.map { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0 }
  guard let u = numbers.firstIndex(of: upper), let l = numbers.firstIndex(of: lower) else { return nil }
  let layer = { (i: Int) in (list[i][kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1 }
  return (u < l, [layer(u), layer(l)])
}

// A real key press (an NSEvent to the window: never through the window server, so it reaches nothing of the person's).
func key(_ window: NSWindow, _ characters: String, code: UInt16) {
  for type in [NSEvent.EventType.keyDown, .keyUp] {
    if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) {
      window.sendEvent(e)
    }
  }
}

// A point of the sidebar where a press does nothing (no row, button, field, handle or drag region under it), in the
// content (top left); as the dev hook's `say: spot` finds one for check10.
@MainActor
func emptySidebarSpot(_ web: WKWebView) async -> CGPoint? {
  let found = await js(web, """
    const page = document.querySelector('m-page')?.getBoundingClientRect();
    if (!page || page.left < 40) return null;
    const busy = 'a, button, input, textarea, select, [contenteditable], [m-action], [m-input], [m-drag], [m-resize], [m-drag-region], [m-rename], [m-editor], [m-menu], [m-notice], [m-prompt], [m-window-controls], [draggable="true"], [role="button"], [tabindex]';
    for (const x of [page.left / 2, page.left * 0.3, page.left * 0.7]) {
      for (let y = innerHeight - 90; y > 90; y -= 12) {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest(busy) && !el.closest('m-page')) return [x, y];
      }
    }
    return null;
    """) as? [Double]
  return found.map { CGPoint(x: $0[0], y: $0[1]) }
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
  host.privateRetire = 0
  options.hostOptions = host
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
  let library = shell.library
  guard let session = shell.hosted, let engine = shell.host else { return check("the library, the session and the engine", false) }
  check("the windows draw the library", made.source is LibraryWindowSource)
  // (Keep open on, as most of what follows was written for: the sidebar docked beside the hosted app, its edge dragged.
  // Off, while an app is hosted: the block "Keep open off while an app is hosted" below.)
  _ = made.source.perform("updateSettings", ["patch": ["sidebarPinnedOpen": true]])
  let c = made.open()
  defer { made.closeAll() }
  world.marginWindow = c.window.windowNumber
  c.hostedBounds = { world.bounds(window: $0) } // (the hosted window's bounds: the stand-in window manager's)
  // (Off every display WebKit takes the page for hidden and stops drawing after its first frame: not this view, so the
  // window server's picture of the window has what the page draws now, and the loader's fade runs. As tools/glass-shots.)
  do {
    typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
    let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
    if c.webView.responds(to: sel), let imp = class_getMethodImplementation(type(of: c.webView), sel) { unsafeBitCast(imp, to: SetBool.self)(c.webView, sel, false) }
  }
  var loadingAtLaunch: [String: String?] = [:]
  var loadingTabsAtLaunch: [String: [Int]] = [:]
  // (And the page card as the app is launched: `loading`, nothing of Margin's window see-through.)
  var cardAtLaunch: [String: String] = [:]
  world.onLaunch = { bundle in
    loadingAtLaunch[bundle] = c.loadingLabel; loadingTabsAtLaunch[bundle] = c.loadingTabs
    cardAtLaunch[bundle] = "\(c.pageState.rawValue) hole \(c.hole == nil ? "none" : "open") ground \(c.ground.isShown ? "cut" : "whole") clear \(c.panel.backgroundColor == .clear)"
  }
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
  let emptyRoot = await waitJS(c.webView, "return document.querySelector('.arcadia')?.getAttribute('m-page-state') === 'empty' && !document.querySelector('.arcadia').hasAttribute('m-starting')")
  check("nothing hosted: the page card `empty` (the theme's root says so, its data drawn: not starting), no hole, the window's own ground, the pointer Margin's everywhere",
        c.pageState == .empty && emptyRoot && c.hole == nil && c.slot == nil && !c.ground.isShown && c.panel.backgroundColor == .windowBackgroundColor && c.pageHello().contains(#""pageState":"empty""#))
  check("in front of what it hosts from the start: its level raised one above normal (below floating), as the window server has it",
        c.mechanism == .level && c.window.level == FrontMechanism.raised && MarginWindowController.serverLayer(c.window.windowNumber) == FrontMechanism.raised.rawValue,
        "level \(c.window.level.rawValue) server \(String(describing: MarginWindowController.serverLayer(c.window.windowNumber)))")
  let stack = serverAbove(c.panel.windowNumber, c.window.windowNumber)
  check("Margin's UI in its panel: a non-activating panel, the full-screen window's child, at its level as the window server has it, right above it; the full-screen window clear and ignoring the mouse",
        c.panel.styleMask.contains(.nonactivatingPanel) && c.panel.parent === c.window && c.panel.level == FrontMechanism.raised && MarginWindowController.serverLayer(c.panel.windowNumber) == FrontMechanism.raised.rawValue
          && stack?.above == true && c.panel.frame == c.window.frame && c.window.ignoresMouseEvents && c.window.backgroundColor == .clear && c.webView.window === c.panel && c.activations.isEmpty,
        "child \(c.panel.parent === c.window) level \(c.panel.level.rawValue) server \(String(describing: MarginWindowController.serverLayer(c.panel.windowNumber))) order \(String(describing: stack)) activations \(c.activations)")
  // (2026-11-19: hosted apps' glass sidebars showed the wallpaper macOS draws behind a full-screen Space's windows.)
  let backdropLayer = c.backdrop.flatMap { MarginWindowController.serverLayer($0.windowNumber) }
  check("in full screen, behind what it hosts: its backdrop, the full-screen window's child, opaque in the system's window background colour, below every normal window as the window server has it (above macOS's own backdrop), never the mouse's or the keys'",
        c.backdrop?.parent === c.window && c.backdrop?.isOpaque == true && c.backdrop?.backgroundColor == .windowBackgroundColor && c.backdrop?.frame == c.window.frame
          && c.backdrop?.ignoresMouseEvents == true && c.backdrop?.canBecomeKey == false && c.backdrop?.level == MarginBackdrop.level
          && (backdropLayer ?? 0) < 0 && (backdropLayer ?? 0) > -2147483620 && c.backdropOff == nil && c.backdropAttached == 1,
        "child \(c.backdrop?.parent === c.window) level \(String(describing: c.backdrop?.level.rawValue)) server \(String(describing: backdropLayer)) off \(String(describing: c.backdropOff))")
  c.toggleFullScreen()
  check("asked to leave full screen (⌃⌘F, the page's own ask): refused, still full screen", c.isFullScreen && c.refusedExits == 1)
  check("its menu has no Enter/Exit Full Screen item", !made.menu.items.flatMap { $0.submenu?.items ?? [] }.contains { $0.action == #selector(NSWindow.toggleFullScreen(_:)) })

  // ---- the space swipe as Arc's (2026-11-20): the trackpad's phases reach the page; its detent's tick reaches the app ----
  _ = await js(c.webView, "window.__phases = []; document.addEventListener('m-wheel-phase', (e) => window.__phases.push(e.detail.phase)); return true")
  c.wheelPhase("began")
  c.wheelPhase("ended")
  c.wheelPhase("momentum")
  let phasesSeen = await waitJS(c.webView, "return JSON.stringify(window.__phases) === JSON.stringify(['began', 'ended', 'momentum'])")
  let phasesThere = await js(c.webView, "return JSON.stringify(window.__phases)") as? String ?? "?"
  check("the trackpad's phases told to the page, in order, as the swipe hears them (m-wheel-phase)", phasesSeen && c.wheelPhasesSaid.suffix(3) == ["began", "ended", "momentum"], phasesThere)
  let hapticsBefore = c.haptics
  _ = await js(c.webView, "window.webkit.messageHandlers.margin.postMessage({ op: 'perform', name: 'haptic.alignment' }); return true")
  let ticked = await until(2) { c.haptics == hapticsBefore + 1 }
  check("a swipe's detent: the trackpad's alignment tick asked of Margin.app", ticked, "\(c.haptics - hapticsBefore)")
  // Edit Theme Color's ticks (M2.9 step 6): a texture's is the level's change; the device each gesture comes from told
  // to the page (PointerKind.swift: a touch's press a trackpad, a wheel's notch a mouse), the Mac's haptics with it.
  let levelsBefore = c.hapticLevels
  _ = await js(c.webView, "window.webkit.messageHandlers.margin.postMessage({ op: 'perform', name: 'haptic.level' }); return true")
  let leveled = await until(2) { c.hapticLevels == levelsBefore + 1 && c.haptics == hapticsBefore + 2 }
  check("edit theme color's texture: the trackpad's level change asked of Margin.app", leveled, "\(c.hapticLevels - levelsBefore)")
  made.pointerSaw(PointerFacts(kind: .press, touch: true), in: c)
  made.pointerSaw(PointerFacts(kind: .scroll), in: c)
  let toldKinds = c.pointersSaid.suffix(2).compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? JSONObject }
  check("a gesture's device told to the page: a touch's press a trackpad, then a wheel's notch a mouse, the Mac's haptics with each",
        toldKinds.map { $0["kind"] as? String ?? "" } == ["trackpad", "mouse"] && toldKinds.allSatisfy { $0["haptics"] is Bool && $0["uiSounds"] is Bool }, "\(c.pointersSaid.suffix(2))")
  let pageHas = await waitJS(c.webView, "const d = marginApp.stats().device; return !!d && d.pointer === 'mouse' && typeof d.haptics === 'boolean'")
  let pageDevice = await js(c.webView, "return JSON.stringify(marginApp.stats().device)") as? String ?? "?"
  check("…the page has the last (its host's device: a mouse)", pageHas, pageDevice)

  // ---- its card (its item in another Margin window) and the item coming back (bug of 2026-11-20: the launcher was
  // drawn for the loader's grace between the card and the loader) ----
  c.setElsewhere("Notes", app: "com.apple.Notes", picture: nil)
  let cardMark = c.pageStates.count
  let carded = c.pageState == .elsewhere
  c.setShowing("Notes", app: "com.apple.Notes", slow: false)
  let stillCard = c.pageState == .elsewhere
  c.setHosting(true)
  c.setElsewhere(nil, app: nil, picture: nil)
  let backStates = Array(c.pageStates.dropFirst(cardMark))
  check("its item back from its card: the card kept until it hosts, then the loader at once (no grace), never its launcher in between",
        carded && stillCard && backStates == ["loading Notes"] && c.pageState == .loading, "\(carded) \(stillCard) \(backStates)")
  c.setHosting(false) // (as the session does: hosting off before the loader's words go)
  c.setShowing(nil, app: nil, slow: false)
  // A press on its card (another display: the window in use without becoming key): its item asked back there.
  c.setElsewhere("Notes", app: "com.apple.Notes", picture: nil)
  var cardAsks: [Int] = []
  let onKey = made.onKey
  made.onKey = { cardAsks.append($0) }
  let cardPage = c.window.pageRect
  if let page = cardPage { c.pressEnded(at: CGPoint(x: page.midX - c.contentFrame.minX, y: page.midY - c.contentFrame.minY)) }
  c.pressEnded(at: CGPoint(x: 2, y: 2)) // (its sidebar's corner, outside the page area: nothing)
  c.setElsewhere(nil, app: nil, picture: nil)
  c.pressEnded(at: CGPoint(x: (cardPage?.midX ?? 0) - c.contentFrame.minX, y: (cardPage?.midY ?? 0) - c.contentFrame.minY)) // (no card: nothing)
  made.onKey = onKey
  check("a press on its card's page area: its item asked back in this window, once; outside it or with no card, nothing", cardPage != nil && cardAsks == [c.id], "\(cardAsks) \(String(describing: cardPage))")

  // ---- closed (its close button) while it hosts: held until what it shows is parked, then only this window closes
  // (a second window of its own; the session's hooks put back after) ----
  do {
    let other = made.open()
    _ = await until(5) { other.isFullScreen }
    let onClosing = made.onClosing, onClosed = made.onClosed
    other.setHosting(true)
    var closeHolds: [() -> Void] = []
    made.onClosing = { _, done in closeHolds.append(done) }
    var closedIds: [Int] = []
    made.onClosed = { closedIds.append($0) }
    let firstPress = other.windowShouldClose(other.window)
    let againPress = other.windowShouldClose(other.window)
    let heldOpen = !other.isClosed && closedIds.isEmpty && made.controllers.contains { $0 === other }
    closeHolds.first?()
    let closedAfter = await until(2) { other.isClosed }
    made.onClosing = onClosing
    made.onClosed = onClosed
    check("closed while it hosts: held (pressed again: still held, asked once), closed once what it shows is parked: that window only, gone from Margin's windows, the first one still open",
          !firstPress && !againPress && closeHolds.count == 1 && heldOpen && closedAfter && closedIds == [other.id] && !made.controllers.contains { $0 === other }
            && made.controllers.contains { $0 === c } && !c.isClosed,
          "\(firstPress) \(againPress) \(closeHolds.count) \(heldOpen) \(closedAfter) \(closedIds)")
    // Not hosting: closed at once, nothing asked.
    let plain = made.open()
    made.onClosing = { _, done in closeHolds.append(done) }
    let plainCloses = plain.windowShouldClose(plain.window)
    made.onClosing = onClosing
    check("closed while it hosts nothing: closed at once, nothing held", plainCloses && closeHolds.count == 1)
    plain.window.close()
    _ = await until(2) { plain.isClosed }
  }
  let pickMark = c.pageStates.count

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
  check("Margin's window told the app's window, and in front of it: its level still raised, never ordered below anything", c.hosted == editWindow && c.window.level == FrontMechanism.raised
        && c.mechanism == .level && c.yieldOrders == 0, "hosted \(String(describing: c.hosted)) level \(c.window.level.rawValue)")
  // ---- the page card: loading while the app launched, shown now: the page area a hole ----
  // (Margin's start before the pick, with no item to show again: "Getting you started", then the launcher.)
  // (Since the checks of its card and of a window closed, just before the pick.)
  let states = Array(c.pageStates.dropFirst(pickMark))
  check("the page card `loading` as the app launched (the engine's slow step: at once, with its name), nothing of Margin's window see-through then; `shown` once its window was in place",
        cardAtLaunch["com.apple.TextEdit"] == "loading hole none ground whole clear false" && states == ["loading com.apple.TextEdit", "shown"]
        && c.pushed.contains(#"{"type":"pageState","state":"loading","label":"com.apple.TextEdit","bundleId":"com.apple.TextEdit"}"#) && c.pushed.contains(#"{"type":"pageState","state":"shown","label":null}"#) && c.pageState == .shown, "\(cardAtLaunch) \(states)")
  // (From the pick on: the card's checks before it said `elsewhere` with Notes' bundle id, as a card does.)
  let fromPick = Array(c.pushed.drop { !$0.contains(#""label":"com.apple.TextEdit""#) })
  check("an app item's loader: the pageState message names the app's bundle id (the page shows its icon), and only while loading",
        !fromPick.isEmpty && fromPick.filter { $0.contains(#""type":"pageState""#) && $0.contains(#""state":"loading""#) && !$0.contains(#""starting":true"#) }.allSatisfy { $0.contains(#""bundleId":"com.apple.TextEdit""#) }
        && fromPick.filter { $0.contains(#""type":"pageState""#) && !$0.contains(#""state":"loading""#) }.allSatisfy { !$0.contains("bundleId") }, "\(c.pushed.filter { $0.contains("pageState") })")
  let rootShown = await waitJS(c.webView, "const l = document.querySelector('.arcadia > m-page-loader'); return document.querySelector('.arcadia')?.getAttribute('m-page-state') === 'shown' && !!l && !l.hasAttribute('m-default') && document.querySelectorAll('m-page-loader').length === 1 && l.textContent.trim() === '' && getComputedStyle(l).pointerEvents === 'none'")
  check("the theme's root says shown; the theme's own loader (Arcadia's slot, no default of Margin's beside it) has its part taken out and lets go as it's shown", rootShown)
  // (The page card's rounded corners: Arcadia's 10 pt radius, its frame around them, which is the space's colour mixed
  // into a near-white: read from the page, as it computes it. The theme draws them itself, over the app.)
  let frameCSS = (await js(c.webView, "return getComputedStyle(document.querySelector('m-page')).boxShadow.split(') ')[0] + ')'") as? String) ?? ""
  let radius = CGFloat(c.layout?.radii.first ?? 0)
  let page = expected ?? .zero
  func inContent(_ r: CGRect) -> CGRect { r.offsetBy(dx: -display.minX, dy: -display.minY) }
  let ground = PageFill.color(frameCSS)
  check("shown: the hole is the hosted window's bounds, the page area: Margin's window clear there, its ground drawn around it with the page card's rounded corners, in the theme's frame colour",
        radius > 0 && c.hole == page && c.panel.backgroundColor == .clear && c.ground.isShown && c.ground.hole == inContent(page) && c.ground.radii == (c.layout?.radii.map { CGFloat($0) } ?? [])
        && frameCSS.hasPrefix("color(srgb ") && c.layout?.fills == Array(repeating: frameCSS, count: 4) && ground != nil && c.pageGround == ground && c.ground.color == ground,
        "hole \(String(describing: c.hole)) ground \(String(describing: c.ground.hole)) \(c.ground.radii) fills \(String(describing: c.layout?.fills))")
  check("the hosted window placed in Margin's own full-screen frame (the area its own Space lays it out in), never the display less its inset",
        c.hostedPlacement?.area == c.contentFrame, "\(String(describing: c.hostedPlacement))")
  // The window server's own picture of Margin's window (the real compositing: the page, the ground, the window's
  // background): see-through across the page area and inside the corners' curves, painted everywhere else.
  let local = inContent(page)
  let r2 = radius / 2.0.squareRoot()
  // (Its left edge 16 pt in: the sidebar's resize handle reaches a few points over the page area, and takes the pointer there.)
  let holePoints = [CGPoint(x: local.midX, y: local.midY), CGPoint(x: local.minX + 16, y: local.midY), CGPoint(x: local.maxX - 3, y: local.midY), CGPoint(x: local.midX, y: local.minY + 3),
                    CGPoint(x: local.midX, y: local.maxY - 3), CGPoint(x: local.minX + radius - r2 + 3, y: local.minY + radius - r2 + 3), CGPoint(x: local.maxX - radius + r2 - 3, y: local.maxY - radius + r2 - 3)]
  let solidPoints = [CGPoint(x: 60, y: local.midY), CGPoint(x: local.minX - 4, y: local.midY), CGPoint(x: local.midX, y: local.minY - 4), CGPoint(x: local.maxX + 4, y: local.midY),
                     CGPoint(x: local.midX, y: local.maxY + 4), CGPoint(x: local.minX + 1, y: local.minY + 1), CGPoint(x: local.maxX - 1, y: local.maxY - 1)]
  _ = await until(3) { windowAlpha(c.panel, at: holePoints)?.allSatisfy { $0 == 0 } == true }
  let holeAlpha = windowAlpha(c.panel, at: holePoints), solidAlpha = windowAlpha(c.panel, at: solidPoints)
  check("shown, as the window server pictures Margin's window: see-through (alpha 0) across the page area, up to its edges and inside its corners' curves",
        holeAlpha?.allSatisfy { $0 == 0 } == true, "\(String(describing: holeAlpha))")
  check("shown, as the window server pictures it: painted (alpha 255) on the sidebar, on the theme's frame at each side of the page area and outside the curve of its rounded corners",
        solidAlpha?.allSatisfy { $0 == 255 } == true, "\(String(describing: solidAlpha))")
  // Several visible hosts (docs/PEEK-SPLIT.md §1): holes for each, the pointer through them, a card's content alone.
  await multiHoleChecks(c, page: page, main: editWindow, bounds: { world.bounds(window: $0) }, check: check)
  // The pointer: through the hole to the app, Margin's on its sidebar, its frame and the card's rounded corners; a drag keeps who had it.
  let middle = CGPoint(x: page.midX, y: page.midY)
  check("the pointer's slot is the hole (its radius the card's); the catch fill everywhere but there", c.slot?.rect == page && c.slot?.radius == radius && c.slot?.captureAll == false, "\(String(describing: c.slot))")
  c.pointerMoved(middle, buttonsDown: false)
  let overApp = c.panel.ignoresMouseEvents
  c.pointerMoved(CGPoint(x: page.minX - 120, y: page.midY), buttonsDown: false)
  let overSidebar = c.panel.ignoresMouseEvents
  c.pointerMoved(CGPoint(x: page.minX - 4, y: page.midY), buttonsDown: false)
  let overFrame = c.panel.ignoresMouseEvents
  c.pointerMoved(CGPoint(x: page.minX + 0.5, y: page.minY + 0.5), buttonsDown: false)
  let overCorner = c.panel.ignoresMouseEvents
  c.pointerMoved(CGPoint(x: page.maxX - 1, y: page.midY), buttonsDown: false)
  let atRight = c.panel.ignoresMouseEvents
  c.pointerMoved(CGPoint(x: page.midX, y: page.minY + 1), buttonsDown: false)
  let atEdge = atRight && c.panel.ignoresMouseEvents
  check("the pointer: over the page area it goes through to the app (to its very edge); over the sidebar, the frame's strip and outside a rounded corner's curve it's Margin's",
        overApp && !overSidebar && !overFrame && !overCorner && atEdge, "app \(overApp) sidebar \(overSidebar) frame \(overFrame) corner \(overCorner) edge \(atEdge)")
  c.pointerMoved(middle, buttonsDown: false)
  c.pointerMoved(CGPoint(x: page.minX - 120, y: page.midY), buttonsDown: true)
  let dragFromApp = c.panel.ignoresMouseEvents
  c.pointerMoved(CGPoint(x: page.minX - 120, y: page.midY), buttonsDown: false)
  c.pointerMoved(middle, buttonsDown: true)
  let dragFromMargin = c.panel.ignoresMouseEvents
  c.pointerMoved(middle, buttonsDown: false)
  check("the pointer: a drag begun in the app stays the app's over Margin's sidebar; one begun on Margin stays Margin's over the app", dragFromApp && !dragFromMargin && c.panel.ignoresMouseEvents)
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
  check("a web item's loader: the pageState message names Safari's bundle id (the browser it opens in: its icon)",
        c.pushed.contains(#"{"type":"pageState","state":"loading","label":"Safari","bundleId":"com.apple.Safari"}"#), "\(c.pushed.filter { $0.contains("pageState") }.suffix(4))")

  // ---- back to the app: an instant switch, straight from shown to shown ----
  let statesBefore = c.pageStates.count
  var holeClosed = false
  let hostedBefore = engine.hostedWindow
  engine.hostedWindow = { number in hostedBefore?(number); if c.hole == nil || c.pageState != .shown { holeClosed = true } }
  let backAt = Date()
  _ = library.perform("activateTab", ["windowId": c.id, "tabId": item])
  guard await until(5, { engine.shown == textEdit }) else { return check("back to the app", false, "\(session.done.suffix(4))") }
  await session.idle()
  let switchMs = Int((Date().timeIntervalSince(backAt) * 1000).rounded())
  engine.hostedWindow = hostedBefore
  check("back to the app: no full-screen exit or entry, Safari's window parked as it is", world.inMargin == [editWindow]
        && !world.calls.suffix(4).contains { $0.hasPrefix("fullScreen") } && c.loadingLabel == nil && c.loadingTabs.isEmpty && world.wins[safariWin]?.fullScreen == true, "\(world.calls.suffix(6))")
  check("back to the app (a prepared, parked window): shown → shown with no loader (nothing said to the page, the hole never closed), in \(switchMs) ms on the stand-in (under the loader's 120 ms grace)",
        switchMs < 120 && c.pageStates.count == statesBefore && !holeClosed && c.pageState == .shown && c.hosted == editWindow && c.hole == page,
        "\(switchMs) ms, states \(c.pageStates.dropFirst(statesBefore)) closed \(holeClosed)")
  // (A show that isn't in place within the grace: the loader, with the item's name, then shown again.)
  c.setShowing("Slow one")
  let inGrace = c.pageState == .shown && c.hole == page
  c.graceOver()
  let late = c.pageState == .loading && c.hole == nil && c.panel.backgroundColor == ground && !c.ground.isShown && c.slot == nil && c.pushed.last == #"{"type":"pageState","state":"loading","label":"Slow one"}"#
  let lateDrawn = await waitJS(c.webView, "const l = document.querySelector('.arcadia > m-page-loader:not([m-default])'); return document.querySelector('.arcadia')?.getAttribute('m-page-state') === 'loading' && l?.textContent.trim() === 'Opening Slow one…' && getComputedStyle(l).opacity === '1' && getComputedStyle(l).pointerEvents === 'auto'")
  _ = await until(3) { windowAlpha(c.panel, at: holePoints)?.allSatisfy { $0 == 255 } == true }
  let cardAlpha = windowAlpha(c.panel, at: holePoints)
  c.pointerMoved(middle, buttonsDown: false)
  let loadingPointer = c.panel.ignoresMouseEvents
  check("a show not in place within the grace: what's drawn stays for it, then the page card `loading`: the hole closed at once (the window's own ground whole), the pointer Margin's, the loader drawn with the item's name",
        inGrace && late && lateDrawn && !loadingPointer, "grace \(inGrace) late \(late) drawn \(lateDrawn) pointer through \(loadingPointer)")
  check("loading, as the window server pictures Margin's window: the page card opaque (alpha 255 across the page area): whatever opens behind it isn't seen", cardAlpha?.allSatisfy { $0 == 255 } == true, "\(String(describing: cardAlpha))")
  c.setShowing(nil)
  let fadeMs = await js(c.webView, "const l = document.querySelector('.arcadia > m-page-loader'); return Math.round(parseFloat(getComputedStyle(l).transitionDuration) * 1000)") as? Int ?? -1
  _ = await until(3) { windowAlpha(c.panel, at: holePoints)?.allSatisfy { $0 == 0 } == true }
  check("… and shown again once it is: the hole open again (see-through in the window's picture once the loader has faded, \(fadeMs) ms, at most 150)", c.pageState == .shown && c.hole == page
        && fadeMs > 0 && fadeMs <= 150 && windowAlpha(c.panel, at: holePoints)?.allSatisfy { $0 == 0 } == true, "\(fadeMs) \(String(describing: windowAlpha(c.panel, at: holePoints)))")
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

  // ---- the background mini player (M2.4): the copy's `media` push drawn in Margin's window, its buttons back to the copy ----
  do {
    let firstTab = session.safariTabs[web] ?? -1
    let source: JSONObject = ["tabId": firstTab, "itemId": web, "url": "https://example.com/", "title": "Background Song", "subtitle": "The Band", "playing": true, "muted": false,
                              "canPrev": true, "canNext": true, "updatedAt": Date().timeIntervalSince1970 * 1000, "pausedAt": NSNull()]
    let pushesBefore = c.pushes
    fake.tell(["do": "send", "id": "S", "msg": ["k": "push", "windowId": 90, "msg": ["type": "media", "sources": [source]]]])
    let drawn = await waitJS(c.webView, "const p = document.querySelector('.mini-player'); return !!p && p.querySelector('.mini-title')?.textContent.trim() === 'Background Song' && p.querySelector('.mini-sub')?.textContent.trim() === 'The Band' && !!p.querySelector('[aria-label=\"Next track\"]')")
    let pushed = c.pushed.suffix(c.pushes - pushesBefore).first { $0.contains(#""type":"media""#) } ?? ""
    let player = await js(c.webView, "return (document.querySelector('.mini-player')?.outerHTML ?? 'no mini player').slice(0, 600)") as? String ?? "?"
    check("mini player: the copy's `media` push for its hosted window reaches Margin's window (its tab by the UI's number, no item id or address) and the theme draws it, the playing item in the background",
          drawn && pushed.contains(#""tabId":\#(session.number(ofItem: web))"#) && !pushed.contains("itemId") && !pushed.contains("example.com"), "\(pushed) \(player)")
    // (Its Play/Pause, pressed: a real press on the theme's button, as the UI takes only those.)
    let reqsBefore = fake.events.count
    let at = await js(c.webView, "const r = document.querySelector('.mini-player [aria-label=\"Play or pause\"]')?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : null") as? [Double]
    if let at, at.count == 2 {
      let spot = CGPoint(x: at[0], y: at[1])
      c.pointerMoved(CGPoint(x: display.minX + spot.x, y: display.minY + spot.y), buttonsDown: false)
      press(c.panel, at: spot)
    }
    let asked = await until(5) { fake.first("req", since: reqsBefore) { ($0["msg"] as? JSONObject)?["type"] as? String == "hostMedia" } != nil }
    let media = (fake.first("req", since: reqsBefore) { ($0["msg"] as? JSONObject)?["type"] as? String == "hostMedia" }?["msg"] as? JSONObject)?["payload"] as? JSONObject ?? [:]
    check("mini player: its Play/Pause: the copy asked hostMedia for that item's tab (the library's mediaControl, the session)",
          asked && media["itemId"] as? String == web && media["command"] as? String == "toggle" && int(media["tabId"]) == firstTab, "\(media) \(session.done.suffix(3))")
    // The playing item in front: the mini player goes; another in front: it's back.
    _ = library.perform("activateTab", ["windowId": c.id, "tabId": web])
    await session.idle()
    let hiddenInFront = await waitJS(c.webView, "return !document.querySelector('.mini-player')")
    let second = library.items(space: first).first { $0.value["url"] as? String == "https://second.example/" }?.id ?? ""
    _ = library.perform("activateTab", ["windowId": c.id, "tabId": second])
    await session.idle()
    let backInBackground = await waitJS(c.webView, "return !!document.querySelector('.mini-player')")
    check("mini player: never for the item in front (its page shows it), back once another is", hiddenInFront && backInBackground)
    // A push of a type not passed on, from the person's own window, and the copy's sources gone (a tab closed): nothing, then none.
    let before = c.pushes
    let sentBefore = fake.all("sent").count
    let none: [JSONObject] = []
    fake.tell(["do": "send", "id": "S", "msg": ["k": "push", "windowId": 90, "msg": ["type": "peekOpen", "url": "https://x.example/"]]])
    fake.tell(["do": "send", "id": "S", "msg": ["k": "push", "windowId": 1, "msg": ["type": "media", "sources": [source]]]])
    fake.tell(["do": "send", "id": "S", "msg": ["k": "push", "windowId": 90, "msg": ["type": "media", "sources": none]]])
    _ = await until(3) { fake.all("sent").count >= sentBefore + 3 }
    let gone = await waitJS(c.webView, "return !document.querySelector('.mini-player')")
    let passed = c.pushed.suffix(c.pushes - before)
    check("mini player: gone once the copy has no sources; a push not passed on, or for the person's own window, never reaches the page",
          gone && passed.count == 1 && passed.first.map { $0.contains(#""type":"media""#) && $0.contains(#""sources":[]"#) } == true, "\(passed) sent \(fake.all("sent").count - sentBefore)")
  }

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
  check("Calculator: Margin's window told its window, in front of it; the hole its own bounds (smaller than the page area, square), the theme's frame colour around it",
        c.hosted == calcWindow && engine.shownWindow == calcWindow && c.pageState == .shown && c.hole == centred && c.ground.hole == inContent(centred) && c.ground.radii == [0, 0, 0, 0]
        && c.pageGround == ground && c.ground.color == ground && c.panel.backgroundColor == .clear,
        "hosted \(String(describing: c.hosted)) hole \(String(describing: c.hole)) want \(centred) ground \(String(describing: c.ground.color))")
  // (Nothing of the theme's over the page area any more: its loader, fading out as `shown` came, is reported until it's gone.)
  _ = await until(3) { !c.captureAll && c.hits.isEmpty }
  c.pointerMoved(CGPoint(x: centred.midX, y: centred.midY), buttonsDown: false)
  let overCalc = c.panel.ignoresMouseEvents
  c.pointerMoved(CGPoint(x: calcPage.minX + 20, y: calcPage.minY + 20), buttonsDown: false)
  let aroundCalc = c.panel.ignoresMouseEvents
  let activations = world.calls.filter { $0 == "activate \(GlueHostWorld.calculator)" }.count
  c.pressed(CGPoint(x: calcPage.minX + 20, y: calcPage.minY + 20))
  let pressGives = await until(3) { world.calls.filter { $0 == "activate \(GlueHostWorld.calculator)" }.count == activations + 1 }
  check("Calculator: the pointer through to it on its window; in the page area around it Margin's, and a press there gives Calculator the keyboard", overCalc && !aroundCalc && pressGives,
        "over \(overCalc) around \(aroundCalc) press \(pressGives) hits \(c.hits.count) all \(c.captureAll) hole \(String(describing: c.hole))")
  // ---- a press in Margin's sidebar (an empty spot) with Calculator shown: Margin never made active, the panel not key,
  // the keys back to Calculator once the press is over (Tirth's recording, 2026-11-17: the hosted app's inactive look
  // at every use of the sidebar) ----
  // (Which app a hosted window is: the engine's stand-in's. Margin the front app or not: the stand-in says not, as on
  // check10's screen, where the hosted pane was the front app throughout.)
  c.hostedPid = { number in engine.hosts.values.first { $0.window == number }?.pid }
  c.appActive = { false }
  let shownCalcPid = engine.hosts.values.first { $0.window == calcWindow }?.pid ?? -1
  // AppKit says Margin is active, its window key (as on check10's screen after its launch and after any press in the
  // panel, with the hosted app still the front app): the panel still can't be key, nor have the keys.
  NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
  c.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification, object: c.window))
  check("AppKit says Margin is active and its window key, the hosted app still the front app, no field of Margin's: the panel can't be key (only a field of Margin's makes it so) and doesn't have the keys",
        !c.panel.allowKey && !c.panel.canBecomeKey && !c.hasKeys && !c.pageWantsKeyboard, "allow \(c.panel.allowKey) has \(c.hasKeys)")
  // ---- its Space shown again with Margin the active app (back from another app's full screen, 2026-11-20): the keys
  // back to the app shown, once; not when that app is the active one already ----
  do {
    let backsBefore = c.handBacks.count, returnsBefore = c.returnHandBacks
    c.appActive = { true }
    c.spaceChanged()
    let gave = await until(1.5) { c.returnHandBacks == returnsBefore + 1 }
    try? await Task.sleep(for: .milliseconds(600)) // (past the second look: still once)
    check("its Space shown again, Margin the active app: the keys back to the app shown (Calculator), once for the change",
          gave && c.returnHandBacks == returnsBefore + 1 && c.handBacks.count == backsBefore + 1 && c.handBacks.last == shownCalcPid,
          "\(c.returnHandBacks - returnsBefore) \(c.handBacks.suffix(2)) \(shownCalcPid)")
    c.appActive = { false }
    c.spaceChanged()
    try? await Task.sleep(for: .milliseconds(700))
    check("its Space shown again with the app shown already the active one: nothing", c.returnHandBacks == returnsBefore + 1 && c.handBacks.count == backsBefore + 1)
  }
  if let spot = await emptySidebarSpot(c.webView) {
    let handsBefore = c.handBacks.count
    let pressesBefore = c.panel.presses, marginBefore = c.activations.count, asksBefore = c.keyAsks, backBefore = c.keysGivenBack
    let calcBefore = world.calls.filter { $0 == "activate \(GlueHostWorld.calculator)" }.count
    c.pointerMoved(CGPoint(x: display.minX + spot.x, y: display.minY + spot.y), buttonsDown: false)
    let takes = !c.panel.ignoresMouseEvents
    press(c.panel, at: spot)
    let back = await until(3) { world.calls.filter { $0 == "activate \(GlueHostWorld.calculator)" }.count == calcBefore + 1 }
    check("a press on an empty spot of the sidebar with Calculator shown: Margin's panel took it (a non-activating panel), Margin not made active, the panel not asked to be key, the keys back to Calculator once it's over",
          takes && c.panel.presses == pressesBefore + 1 && c.panel.styleMask.contains(.nonactivatingPanel) && c.activations.count == marginBefore && c.keyAsks == asksBefore && !c.panel.canBecomeKey
            && back && c.keysGivenBack == backBefore + 1 && !c.pageWantsKeyboard && !c.panel.allowKey && !c.hasKeys
            && c.handBacks.count == handsBefore + 1 && c.handBacks.last == shownCalcPid,
          "hand-backs \(c.handBacks.suffix(2)) (Calculator \(shownCalcPid)) allow \(c.panel.allowKey) takes \(takes) presses \(c.panel.presses - pressesBefore) Margin active \(c.activations.suffix(2)) key asks \(c.keyAsks - asksBefore) can be key \(c.panel.canBecomeKey) back \(back) \(world.calls.suffix(2))")
  } else { check("an empty spot of the sidebar", false) }
  // (The engine asks Margin's window's page to measure at every look while it waits for a layout at its whole width:
  // a size the window took isn't measured until a frame is drawn, which can be seconds late. The page measures at once.)
  let measuresBefore = await js(c.webView, "return marginApp.stats().measures") as? Int ?? -1
  c.remeasure()
  let measuredAgain = await waitJS(c.webView, "return marginApp.stats().measures > \(measuresBefore)")
  check("Calculator: Margin's window's page measures when asked (no frame needed)", measuresBefore >= 0 && measuredAgain && c.layout?.outside == false && abs((c.layout?.width ?? 0) - display.width) <= 1,
        "\(measuresBefore) \(String(describing: c.layout))")

  func hostedPidNow() -> pid_t { engine.shown.flatMap { engine.hosts[$0]?.pid } ?? 0 }
  // ---- Margin's keys while hosting: held while Margin or a hosted app is in front, the next/previous item of the space ----
  apps.bringToFront(1) // (an app Margin doesn't host)
  shell.track()
  check("keys: another app in front: Margin's keys let go, ⌘Q that app's own", !shell.shortcuts.isActive && !shell.shortcuts.guardsQuit && !shell.shortcuts.guardsAppKeys && keys.held.isEmpty)
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
  // ---- a hosted app's own keys that would undo its hosting (2026-11-19): Margin's while it's in front ----
  check("app keys: a hosted app in front: its ⌘W, ⇧⌘W, ⌥⌘W, ⌘M, ⌘H, ⌥⌘H, ⌃⌘F are Margin's", shell.shortcuts.guardsAppKeys
        && AppKey.allCases.allSatisfy { k in keys.held.values.contains(k.combo) }, "\(keys.held.values)")
  let calcWindowNow = engine.shown.flatMap { engine.hosts[$0]?.window } ?? 0
  world.focused[calcPid] = calcWindowNow
  let appKeysBefore = shell.hostedKeysRun.count
  for k in ["Meta+KeyM", "Ctrl+Meta+KeyF", "Meta+KeyH"] { keys.press(k) }
  _ = await until(3) { shell.hostedKeysRun.count >= appKeysBefore + 3 }
  check("app keys: ⌘M, ⌃⌘F, ⌘H in the window Margin hosts: nothing (each would take it out of Margin), Calculator still shown",
        shell.hostedKeysRun.dropFirst(appKeysBefore).count == 3 && shell.hostedKeysRun.dropFirst(appKeysBefore).allSatisfy { $0.contains("in the window Margin hosts: nothing") }
        && engine.shown == calculator && session.shown[c.id] == calcItem && !world.calls.contains { $0.hasPrefix("close ") }, "\(shell.hostedKeysRun.suffix(3))")
  world.focused[calcPid] = nil
  keys.press("Meta+KeyW")
  _ = await until(3) { shell.hostedKeysRun.count >= appKeysBefore + 4 }
  check("app keys: ⌘W with its keyboard's window unread: nothing closed", shell.hostedKeysRun.last == "⌘W → the window with its keys unread: nothing"
        && engine.shown == calculator && session.shown[c.id] == calcItem, "\(shell.hostedKeysRun.suffix(2))")
  apps.bringToFront(ProcessInfo.processInfo.processIdentifier)
  shell.track()
  check("keys: Margin itself in front: held, its sidebar key too", shell.shortcuts.isActive && keys.held.values.contains(Combo.parse("Alt+KeyS")!))
  check("app keys: Margin itself in front: let go (its own menu has Close Tab, Minimize, Hide)", !shell.shortcuts.guardsAppKeys && !keys.held.values.contains(Combo.parse("Meta+KeyW")!))
  let pushes = c.pushes
  keys.press("Meta+KeyT")
  check("keys: ⌘T: the palette, in Margin's window", c.pushed.suffix(max(1, c.pushes - pushes)).contains(#"{"type":"command","name":"palette"}"#))
  keys.press("Meta+KeyT") // (and closed again)
  _ = await waitJS(c.webView, "return !document.querySelector('[m-input=\"palette\"]:focus')")
  _ = await until(3) { !c.pageWantsKeyboard }

  // ---- ⌘T with the hosted app in front (bug of 2026-11-17: the palette opened behind the hosted window): drawn over
  // the page area, Margin's window in front; the pointer there Margin's; Escape: the app has the keys again ----
  apps.bringToFront(calcPid)
  shell.track()
  let ordersBefore = c.yieldOrders
  let paletteAsks = c.keyAsks, paletteMargin = c.activations.count
  // (Nothing its first responder, as a panel that never had the keys: the field's keys must make the web view it.)
  c.panel.makeFirstResponder(nil)
  keys.press("Meta+KeyT")
  let paletteOpen = await waitJS(c.webView, "const i = document.querySelector('[m-input=\"palette\"]'); return !!i && document.activeElement === i")
  _ = await until(3) { c.pageWantsKeyboard && (c.captureAll || !c.hits.isEmpty) }
  // (Where the theme draws its palette, in the window: its field's box.)
  let fieldBox = await js(c.webView, "const r = document.querySelector('[m-input=\"palette\"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]") as? [Double] ?? [0, 0]
  let fieldAt = CGPoint(x: display.minX + fieldBox[0], y: display.minY + fieldBox[1])
  check("⌘T with a hosted app in front: its field has the keys through the panel, Margin never made active: the panel can be key and was asked to be (non-activating: the app stays the active one), the web view its first responder",
        c.pageWantsKeyboard && c.hasKeys && c.panel.allowKey && c.panel.canBecomeKey && c.keyAsks == paletteAsks + 1 && c.panel.firstResponder === c.webView && c.activations.count == paletteMargin,
        "keys \(c.pageWantsKeyboard) has \(c.hasKeys) allow \(c.panel.allowKey) asks \(c.keyAsks - paletteAsks) responder \(String(describing: c.panel.firstResponder)) Margin active \(c.activations.suffix(2))")
  // Typing: real key events to the panel (never through the window server), into the palette's field.
  for (ch, code) in [("a", UInt16(0)), ("b", UInt16(11)), ("c", UInt16(8))] { key(c.panel, ch, code: code) }
  let typed = await waitJS(c.webView, "const i = document.querySelector('[m-input=\"palette\"]'); return !!i && i.value === 'abc'")
  let typedValue = await js(c.webView, "return document.querySelector('[m-input=\"palette\"]')?.value ?? null")
  check("⌘T: what's typed reaches the palette's field (key events to the panel, its web view the first responder)", typed, "\(String(describing: typedValue))")
  // ⌘A then a letter (Margin not the active app: the hosted app's menu bar, so Margin's web view sends the editing keys itself).
  if let selectAll = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: c.panel.windowNumber,
                                      context: nil, characters: "a", charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0) {
    let took = c.webView.performKeyEquivalent(with: selectAll)
    key(c.panel, "z", code: 6)
    let replaced = await waitJS(c.webView, "return document.querySelector('[m-input=\"palette\"]')?.value === 'z'")
    let value = await js(c.webView, "return document.querySelector('[m-input=\"palette\"]')?.value ?? null")
    check("⌘T: ⌘A in the field with Margin not the active app selects what's typed (then typing replaces it)", took && replaced, "took \(took) \(String(describing: value))")
  }
  check("⌘T with a hosted app in front: the palette open in Margin's window, its field focused, over the page area; Margin's window still in front of the hosted one (its level raised, never ordered below it)",
        paletteOpen && c.pageWantsKeyboard && calcPage.contains(fieldAt) && c.window.level == FrontMechanism.raised && c.yieldOrders == ordersBefore && c.hosted == calcWindow && c.pageState == .shown,
        "open \(paletteOpen) keys \(c.pageWantsKeyboard) field \(fieldAt) page \(calcPage)")
  // (Off every display WebKit can keep an older frame of a layer that just appeared: the page is asked for a new one
  // until the window server's picture has it. On the real screen it's check10's step c1.)
  for _ in 0..<30 where windowAlpha(c.panel, at: [CGPoint(x: fieldBox[0], y: fieldBox[1])]) != [255] {
    _ = await js(c.webView, "const el = document.querySelector('[m-input=\"palette\"]'); el.style.outlineOffset = el.style.outlineOffset ? '' : '0px'; void el.offsetWidth; await new Promise((done) => requestAnimationFrame(() => done(true))); return true")
    _ = await until(0.1) { windowAlpha(c.panel, at: [CGPoint(x: fieldBox[0], y: fieldBox[1])]) == [255] }
  }
  check("⌘T: as the window server pictures Margin's window, the palette's pixels are painted over the page area (alpha 255 at its field)",
        windowAlpha(c.panel, at: [CGPoint(x: fieldBox[0], y: fieldBox[1])]) == [255], "\(String(describing: windowAlpha(c.panel, at: [CGPoint(x: fieldBox[0], y: fieldBox[1])])))")
  // (As soon as the page has said where its palette is: its report of what it draws over the page area follows the draw.)
  _ = await until(3) { c.pointerMoved(fieldAt, buttonsDown: false); return !c.panel.ignoresMouseEvents }
  let overPalette = c.panel.ignoresMouseEvents
  check("⌘T: the pointer over the palette is Margin's (not passed to the app under it)", !overPalette, "hits \(c.hits.count) all \(c.captureAll)")
  // (Counted from here: the palette closed just before this step gave the app the keys back in a task of its own.)
  let activationsBefore = world.calls.filter { $0 == "activate \(GlueHostWorld.calculator)" }.count
  let letsBefore = c.keyLets, callsBefore = world.calls.count, handsEscape = c.handBacks.count
  key(c.panel, "\u{1b}", code: 53) // (Escape, a real key event to the panel)
  let paletteClosed = await waitJS(c.webView, "return !document.querySelector('[m-input=\"palette\"]')")
  let keysBack = await until(3) { !c.pageWantsKeyboard && world.calls.filter { $0 == "activate \(GlueHostWorld.calculator)" }.count == activationsBefore + 1 }
  _ = await until(3) { !c.captureAll && c.hits.isEmpty }
  c.pointerMoved(CGPoint(x: centred.midX, y: centred.midY), buttonsDown: false)
  check("⌘T then Escape: the panel lets go of the keys (it can't be key any more), Margin never made active, and all the hosted app is asked is to be the active app (which it is): nothing that would deactivate it",
        paletteClosed && c.keyLets == letsBefore + 1 && !c.hasKeys && !c.panel.allowKey && !c.panel.canBecomeKey && c.activations.count == paletteMargin
          && c.handBacks.count == handsEscape + 1 && c.handBacks.last == calcPid
          && world.calls.dropFirst(callsBefore).allSatisfy { $0 == "activate \(GlueHostWorld.calculator)" },
        "hand-backs \(c.handBacks.suffix(2)) lets \(c.keyLets - letsBefore) has \(c.hasKeys) allow \(c.panel.allowKey) Margin active \(c.activations.suffix(2)) asked of the app \(Array(world.calls.dropFirst(callsBefore)))")
  check("⌘T then Escape: the palette gone, the hosted app activated again (it has the keys), the pointer through to it again",
        paletteClosed && keysBack && c.panel.ignoresMouseEvents && world.calls.last == "activate \(GlueHostWorld.calculator)",
        "closed \(paletteClosed) back \(keysBack) (\(world.calls.filter { $0 == "activate \(GlueHostWorld.calculator)" }.count) activations, \(activationsBefore) before) keys \(c.pageWantsKeyboard) ignoring \(c.panel.ignoresMouseEvents) \(world.calls.suffix(3))")
  apps.bringToFront(1)
  shell.track()
  check("keys: let go again once another app is in front", !shell.shortcuts.isActive)

  // ---- macOS takes Margin's window out of full screen anyway: straight back in, the app shown back with it ----
  c.fullScreenChanged(false)
  guard await until(5, { engine.shown == calculator && c.hosting && c.hosted == calcWindow }) else { return check("back into full screen with Calculator", false, "\(session.done.suffix(5))") }
  await session.idle()
  check("out of full screen by macOS: back into it at once, Calculator hosted again at the page area", c.isFullScreen && c.backIntoFullScreen == 1 && world.bounds(window: calcWindow) == centred
        && session.done.contains { $0.contains("back in full screen") }, "\(session.done.suffix(5))")
  let backAgainLayer = c.backdrop.flatMap { MarginWindowController.serverLayer($0.windowNumber) }
  check("…back in full screen with Calculator: its backdrop still behind the hosted app (below every normal window, Margin's window raised above the app)",
        c.backdrop?.parent === c.window && (backAgainLayer ?? 0) < 0 && c.backdropOff == nil && MarginWindowController.serverLayer(c.window.windowNumber) == FrontMechanism.raised.rawValue,
        "attached \(c.backdropAttached) server \(String(describing: backAgainLayer)) off \(String(describing: c.backdropOff))")

  _ = await until(3) { c.pageState == .shown && c.hole == centred } // (its page's layout at the window's whole width again, measured)
  check("back in full screen: in front of Calculator again (its level raised), the page card shown, the hole at its window", c.window.level == FrontMechanism.raised && c.pageState == .shown && c.hole == centred,
        "level \(c.window.level.rawValue) \(c.pageState.rawValue) hole \(String(describing: c.hole))")

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
  let asksBefore = c.fullScreenAsks, backBefore = c.backIntoFullScreen
  let stillFullScreen = { c.isFullScreen && c.fullScreenAsks == asksBefore && c.backIntoFullScreen == backBefore && abs(c.window.frame.width - display.width) <= 1 && c.window.frame.height == display.height }
  let marginUnreserved = { (world.reservation[GlueHostWorld.marginSpace] ?? .zero).isZero }

  // A window-mode app shown (Calculator, centred): held while dragged, moved once when it's let go.
  // (The page's docked layout can reach the app after Calculator was hosted again: that placing, of the same place, first.)
  try? await Task.sleep(nanoseconds: 300_000_000)
  await session.idle()
  var mark = world.calls.count
  let placings = { session.done.filter { $0.hasPrefix("page area changed") }.count }
  let cardStates = { c.pageStates }
  var placed = placings()
  var statesMark = cardStates().count
  let levelSets = c.levelSets, frontOrders = c.frontOrders
  await handle("pointerdown")
  check("resize: a press on the handle alone: nothing held", session.resizing == nil)
  await handle("pointermove", dx: 12)
  await handle("pointermove", dx: 24)
  guard await until(5, { session.resizing == c.id }) else { return check("resize: the drag reaches the app (the page's sidebar.resizing)", false, "\(c.asks.suffix(4)) \(session.done.suffix(3))") }
  c.remeasure() // (a test's window gets no frames: the page's place as it is now)
  let live = await until(5, { c.window.pageRect?.minX == calcPage.minX + 24 })
  // (Live resize: a window-mode window follows the drag by Accessibility, centred in the page area as it is; the hole
  // its bounds, read again as it moves, never the whole page area around a smaller window.)
  let page24 = c.window.pageRect ?? .zero
  let centred24 = CGRect(x: (page24.minX + (page24.width - 230) / 2).rounded(), y: (page24.minY + (page24.height - 408) / 2).rounded(), width: 230, height: 408)
  let followed = await until(5, { world.bounds(window: calcWindow) == centred24 })
  c.remeasure()
  _ = await until(3, { c.hole == centred24 })
  check("resize (window mode): while dragged, Margin's own page area follows live and Calculator follows it, centred, in sight through the hole at its bounds: the page card still shown, nothing lifted, ordered or told to the page",
        live && followed && c.pageState == .shown && c.hole == centred24 && c.ground.hole == inContent(centred24) && c.panel.backgroundColor == .clear && c.levelSets == levelSets && c.frontOrders == frontOrders
        && cardStates().count == statesMark && c.window.level == FrontMechanism.raised,
        "live \(live) followed \(followed) page \(String(describing: c.window.pageRect)) \(c.pageState.rawValue) hole \(String(describing: c.hole)) want \(centred24) states \(cardStates().dropFirst(statesMark)) level sets \(c.levelSets - levelSets) orders \(c.frontOrders - frontOrders)")
  check("resize (window mode): … by Accessibility only (no full-screen change), the engine's page area held until it's let go", !called("frame", since: mark).isEmpty && called("fullScreen", since: mark).isEmpty && engine.pageRect == calcPage
        && placings() == placed, "\(called("frame", since: mark)) bounds \(String(describing: world.bounds(window: calcWindow))) engine \(engine.pageRect) want \(calcPage) placings \(placings() - placed) \(session.done.suffix(5))")
  await handle("pointermove", dx: 40)
  await handle("pointerup", dx: 40)
  guard await until(5, { session.resizing == nil && placings() == placed + 1 }) else { return check("resize (window mode): let go", false, "\(session.done.suffix(4))") }
  await session.idle()
  let wider = c.window.pageRect ?? .zero
  let centredWider = CGRect(x: (wider.minX + (wider.width - 230) / 2).rounded(), y: (wider.minY + (wider.height - 408) / 2).rounded(), width: 230, height: 408)
  check("resize (window mode): let go: the page area 40 pt narrower from its left, Calculator at its middle, the engine told once",
        wider.minX == calcPage.minX + 40 && wider.maxX == calcPage.maxX && world.bounds(window: calcWindow) == centredWider && engine.pageRect == wider && called("frame", since: mark).count >= 1
        && called("fullScreen", since: mark).isEmpty && placings() == placed + 1, "\(wider) \(String(describing: world.bounds(window: calcWindow))) \(called("frame", since: mark)) \(session.done.suffix(3))")
  check("resize (window mode): the hole at Calculator's new bounds (read again once it was moved), the page card shown throughout (it never left Margin's Space: no loader); still full screen at its whole width, nothing reserved on its Space",
        c.hosted == calcWindow && c.hole == centredWider && c.ground.hole == inContent(centredWider) && c.pageState == .shown && cardStates().count == statesMark && stillFullScreen() && marginUnreserved(),
        "hole \(String(describing: c.hole)) states \(cardStates().dropFirst(statesMark)) \(c.window.frame)")
  let savedWidth = await js(c.webView, "return getComputedStyle(document.querySelector('.arcadia')).getPropertyValue('--m-sidebar-width').trim()") as? String ?? ""
  check("resize: the width saved as the theme's own setting (asked of the source), drawn from it", c.asks.contains("updateThemeSettings") && !savedWidth.isEmpty, "\(savedWidth)")

  // A full-screen member parked through that drag (TextEdit, placed for the page area before it): placed when it's next shown.
  mark = world.calls.count
  statesMark = cardStates().count
  _ = library.perform("activateTab", ["windowId": c.id, "tabId": item])
  guard await until(10, { engine.shown == textEdit }) else { return check("resize: back to the app", false, "\(session.done.suffix(4))") }
  await session.idle()
  check("resize: a member parked through the drag, shown next: placed for the new page area as it's shown (out of full screen and in, once), its Space's reservation the new page area's alone",
        world.bounds(window: editWindow) == wider && called("fullScreen", since: mark) == ["fullScreen false", "fullScreen true"] && world.inMargin == [editWindow] && world.listsMarginOnly
        && called("reserve", since: mark).allSatisfy { $0 == "reserve " + (HostLayout.plan(HostPlacement(page: wider, area: display))?.text ?? "?") } && !called("reserve", since: mark).isEmpty && marginUnreserved(),
        "\(String(describing: world.bounds(window: editWindow))) \(called("fullScreen", since: mark)) \(called("reserve", since: mark))")
  check("resize: … behind the loader (the page card loading with its name, then shown), the hole at the new page area",
        Array(cardStates().dropFirst(statesMark)).contains { $0.hasPrefix("loading") } && cardStates().last == "shown" && c.hole == wider && c.pageGround == ground,
        "\(cardStates().dropFirst(statesMark)) hole \(String(describing: c.hole))")

  // That full-screen member shown: the sidebar over it while dragged, placed once when it's let go (the sidebar narrower now).
  mark = world.calls.count
  placed = placings()
  statesMark = cardStates().count
  let loadingPushes = { c.pushed.filter { $0.contains(#""type":"loading""#) && !$0.contains(#""tabIds":[]"#) }.count }
  let pushesBefore = c.pushes
  await handle("pointerdown")
  await handle("pointermove", dx: -10)
  await handle("pointermove", dx: -25)
  guard await until(5, { session.resizing == c.id }) else { return check("resize (full screen): the drag reaches the app", false, "\(session.done.suffix(3))") }
  c.remeasure()
  let live2 = await until(5, { c.window.pageRect?.minX == wider.minX - 25 })
  check("resize (full screen): while dragged, the member stays in sight where it is: the hole its bounds (the page area as it was), the ground in the frame's colour in the gap the narrower sidebar leaves, the page card still shown",
        live2 && c.pageState == .shown && c.hole == wider && c.ground.hole == inContent(wider) && c.ground.fills(CGPoint(x: inContent(wider).minX - 10, y: inContent(wider).midY)) && !c.ground.fills(CGPoint(x: inContent(wider).midX, y: inContent(wider).midY))
        && c.ground.color == ground && c.ground.radii == [0, CGFloat(c.layout?.radii[1] ?? 0), CGFloat(c.layout?.radii[2] ?? 0), 0] && cardStates().count == statesMark,
        "page \(String(describing: c.window.pageRect)) hole \(String(describing: c.ground.hole)) radii \(c.ground.radii) ground \(String(describing: c.ground.color))")
  c.pointerMoved(CGPoint(x: wider.minX - 10, y: wider.midY), buttonsDown: false)
  let gapPointer = c.panel.ignoresMouseEvents
  c.pointerMoved(CGPoint(x: wider.midX, y: wider.midY), buttonsDown: false)
  check("resize (full screen): the pointer in the gap is Margin's, over the member the app's", !gapPointer && c.panel.ignoresMouseEvents)
  // (What seeing through rests on: nothing the page draws covers the middle of its page slot. Every element whose box
  // holds that point, whether or not it takes the pointer, has no background of its own. The theme's loader card, drawn
  // for the placing just before, has faded out by now.)
  let loaderGone = await waitJS(c.webView, "const l = document.querySelector('.arcadia > m-page-loader'); return !l || (getComputedStyle(l).visibility === 'hidden' && +getComputedStyle(l).opacity === 0)")
  check("resize: the theme's loader card, drawn for the placing before, has faded out and is hidden", loaderGone)
  let slotClear = await js(c.webView, """
    const r = document.querySelector('m-page').getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const paints = [...document.querySelectorAll('*')].filter((el) => {
      const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if (!(b.left <= x && x <= b.right && b.top <= y && y <= b.bottom) || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
      return !/^(rgba\\(0, 0, 0, 0\\)|transparent)$/.test(cs.backgroundColor) || cs.backgroundImage !== 'none';
    });
    return paints.map((el) => el.localName + '.' + el.className).join(' | ')
  """) as? String
  check("resize: the page draws nothing over the middle of its page slot while shown (the hosted window shows through there)", slotClear == "", slotClear ?? "not read")
  check("resize (full screen): … and nothing leaves full screen, nothing is reserved or moved: the member where it was", called("fullScreen", since: mark).isEmpty && called("reserve", since: mark).isEmpty
        && world.bounds(window: editWindow) == wider && engine.pageRect == wider && world.inMargin == [editWindow] && placings() == placed, "\(world.calls.dropFirst(mark))")
  await handle("pointermove", dx: -30)
  await handle("pointerup", dx: -30)
  guard await until(10, { session.resizing == nil && placings() == placed + 1 && engine.shown == textEdit }) else { return check("resize (full screen): let go", false, "\(session.done.suffix(4))") }
  await session.idle()
  let narrower = c.window.pageRect ?? .zero
  check("resize (full screen): let go: one exit from full screen and one entry, the member at the new page area in Margin's Space, still full screen; Mission Control Margin's Space only",
        narrower.minX == wider.minX - 30 && narrower.maxX == wider.maxX && world.bounds(window: editWindow) == narrower && engine.pageRect == narrower
        && called("fullScreen", since: mark) == ["fullScreen false", "fullScreen true"] && world.inMargin == [editWindow] && world.wins[editWindow]?.fullScreen == true && world.listsMarginOnly
        && placings() == placed + 1, "\(narrower) \(String(describing: world.bounds(window: editWindow))) \(called("fullScreen", since: mark))")
  check("resize (full screen): its own Space reserved for the new page area alone (never added to the last), nothing on Margin's Space",
        !called("reserve", since: mark).isEmpty && called("reserve", since: mark).allSatisfy { $0 == "reserve " + (HostLayout.plan(HostPlacement(page: narrower, area: display))?.text ?? "?") } && marginUnreserved(),
        "\(called("reserve", since: mark))")
  let refit = Array(cardStates().dropFirst(statesMark))
  check("resize (full screen): the one placing behind the loader: the page card loading once (with the app's name), then shown once; the hole at the new page area, rounded, the frame's colour its ground",
        refit == ["loading com.apple.TextEdit", "shown"]
        && c.hole == narrower && c.ground.hole == inContent(narrower) && c.ground.radii == (c.layout?.radii.map { CGFloat($0) } ?? []) && c.pageGround == ground, "\(refit) hole \(String(describing: c.hole))")
  check("resize (full screen): Margin never left full screen and kept its whole width, still in front (its level raised), the theme's colours as reported",
        stillFullScreen() && c.hosted == editWindow && c.window.level == FrontMechanism.raised && c.layout?.fills == Array(repeating: frameCSS, count: 4), "fills \(String(describing: c.layout?.fills))")
  check("resize (full screen): the theme's loading bar for its item while it's placed again", c.pushed.suffix(max(1, c.pushes - pushesBefore)).contains { $0.contains(#""type":"loading""#) && !$0.contains(#""tabIds":[]"#) } && c.loadingTabs.isEmpty,
        "\(loadingPushes())")

  // Double-click on the handle: the theme's default width, as one change: a second placing right after the first
  // (2026-11-17: the second one lost the window), the member still hosted.
  mark = world.calls.count
  await handle("dblclick")
  guard await until(10, { c.window.pageRect == expected && engine.pageRect == expected && session.resizing == nil && c.pageState == .shown }) else {
    return check("resize: a double-click on the handle: the default width", false, "\(String(describing: c.window.pageRect)) want \(String(describing: expected)) \(session.done.suffix(4))")
  }
  await session.idle()
  check("resize: a double-click on the handle: the default width again, the member placed once for it, a second placing in a row: still hosted and shown, the hole at the page area",
        world.bounds(window: editWindow) == expected && called("fullScreen", since: mark) == ["fullScreen false", "fullScreen true"]
        && stillFullScreen() && world.listsMarginOnly && c.hosted == editWindow && engine.shown == textEdit && c.hole == expected && session.shown[c.id] == item, "\(called("fullScreen", since: mark))")

  // ---- another app's window opened in Margin's Space (a hosted app's Settings): let in front, then in front again ----
  let levelBefore = c.window.level, frontBefore = c.frontOrders
  session.others(4242)
  let yielded = c.yieldingTo == 4242 && c.window.level == .normal && c.yieldOrders == 1
  let panelYielded = c.panel.level == .normal // (its panel with it: the other window in front of Margin's UI too)
  session.others(nil)
  check("another window in Margin's Space: Margin's window lets it in front (the normal level, ordered right below it), and once it's gone is in front of what it hosts again: its raised level, and ordered right above the hosted window",
        levelBefore == FrontMechanism.raised && yielded && c.yieldingTo == nil && c.window.level == FrontMechanism.raised && c.yieldOrders == 1 && c.frontOrders == frontBefore + 1
          && panelYielded && c.panel.level == FrontMechanism.raised,
        "yielded \(yielded) level \(c.window.level.rawValue) orders \(c.frontOrders - frontBefore)")

  // ---- the same through the engine's poll (the stand-in's on-screen list): a Space swipe's picture, the shown app's
  // own extra window, and the poll's check that Margin's window is in front ----
  final class Said { var lines: [String] = [] }
  let heard = Said(), echoBefore = Diagnostics.echo
  Diagnostics.echo = { heard.lines.append($0); echoBefore?($0) }
  func pollTwice() async { engine.poll(); try? await Task.sleep(nanoseconds: 260_000_000); engine.poll() }
  world.lists = true
  world.extraOnScreen = [ServerWindow(number: 12315, pid: 4321, bounds: display)] // (his Claude app, full screen in its own Space)
  world.extraSpaces[12315] = [555]
  await pollTwice(); await pollTwice()
  check("a Space swipe: another app's full-screen window (not hosted, in its own Space by its Space read) in the on-screen list while the current Space still reads Margin's: never let in front, Margin's level stays raised",
        c.yieldingTo == nil && c.window.level == FrontMechanism.raised && c.mechanism == .level && c.yieldOrders == 1, "yielding \(String(describing: c.yieldingTo)) level \(c.window.level.rawValue)")
  let shownPid = hostedPidNow()
  // (Beside the sidebar, reaching above the page area: a window over the sidebar at all is never let in front, the
  // hosting core's stage 3, host-tests' "yield" check.)
  let pageNow = engine.pageRect
  world.extraOnScreen = [ServerWindow(number: 4343, pid: shownPid, bounds: CGRect(x: pageNow.minX + 40, y: display.minY, width: 700, height: 500))]
  world.extraSpaces[4343] = [GlueHostWorld.marginSpace]
  engine.poll()
  let notYet = c.yieldingTo == nil
  try? await Task.sleep(nanoseconds: 260_000_000)
  engine.poll()
  check("the hosted app's own extra window in Margin's Space (its Settings, reaching above the page area beside the sidebar): not at the first poll, let in front at the second (the normal level, ordered right below it)",
        shownPid != 0 && notYet && c.yieldingTo == 4343 && c.window.level == .normal && c.yieldOrders == 2, "first \(notYet) yielding \(String(describing: c.yieldingTo)) level \(c.window.level.rawValue)")
  let ordersYield = c.frontOrders
  world.extraOnScreen = []
  engine.poll()
  check("…gone: Margin's raised level again, and ordered right above the hosted window", c.yieldingTo == nil && c.window.level == FrontMechanism.raised && c.frontOrders == ordersYield + 1 && c.mechanism == .level,
        "yielding \(String(describing: c.yieldingTo)) level \(c.window.level.rawValue) orders \(c.frontOrders - ordersYield)")
  let restoresBefore = c.frontRestores, ordersWrong = c.frontOrders
  world.hostedFirst = true
  engine.poll()
  engine.poll()
  world.hostedFirst = false
  let wrongLines = heard.lines.filter { $0.contains("above it in the window server's order") }
  check("the poll's check: the hosted window found above Margin's window in the on-screen order: put right at once (ordered above it again) at each read, said once",
        c.frontRestores == restoresBefore + 2 && c.frontOrders == ordersWrong + 2 && wrongLines.count == 1 && c.mechanism == .level && c.window.level == FrontMechanism.raised,
        "restores \(c.frontRestores - restoresBefore) lines \(wrongLines.count)")
  world.lists = false

  // ---- the raised level's read back (the poll's, at rest): never concluded right after Margin's own change or during a
  // Space change; held reads forgotten; two misses at least 1 s apart: the ordering way (the overlay's), said once; and
  // tried again from there until the window server holds it ----
  final class Clock { var offset = 2.0 }
  let clock = Clock()
  c.now = { Diagnostics.now() + clock.offset } // (stays: monotonic for the rest of the run)
  let held = c.hosted ?? 0
  func read(_ layer: Int) { c.frontRead(HostEngine.FrontRead(hosted: held, marginLayer: layer, marginAbove: true)) }
  let linesMark = heard.lines.count
  session.others(4242); session.others(nil) // (Margin's own change: a yield over, as at 06:32:56.268 in his log)
  clock.offset += 0.1
  read(0)
  let afterOwn = c.mechanism == .level
  clock.offset += 2
  c.spaceChanged() // (a Space change: his swipe)
  clock.offset += 0.2
  read(0)
  let duringSwipe = c.mechanism == .level
  clock.offset += 2
  read(1)
  clock.offset += 2
  read(0) // (the first miss at rest: the level set again)
  let firstMiss = c.mechanism == .level
  clock.offset += 0.6
  read(0) // (0.6 s later: not yet)
  let tooSoon = c.mechanism == .level
  clock.offset += 0.6
  read(0) // (1.2 s after the first)
  let fellBack = heard.lines[linesMark...].filter { $0.contains("isn't held by the window server") }
  check("the raised level read as 0 right after Margin's own change (a yield's end) or during a Space change: no fallback; a miss at rest, then another 0.6 s later: not yet; at reads 1.2 s apart: kept in front by its order instead (the normal level, ordered above the hosted window), said once",
        afterOwn && duringSwipe && firstMiss && tooSoon && c.mechanism == .order && c.window.level == .normal && fellBack.count == 1,
        "after its own change \(afterOwn), during a swipe \(duringSwipe), first \(firstMiss), 0.6 s \(tooSoon), now \(c.mechanism) level \(c.window.level.rawValue), said \(fellBack.count)")
  let orders = c.frontOrders
  apps.bringToFront(hostedPidNow())
  c.keepFront() // (an app activated: MarginWindows' observer)
  c.pressed(CGPoint(x: (expected?.midX ?? 0), y: (expected?.midY ?? 0)))
  let pressedAgain = await until(2) { c.frontOrders >= orders + 2 }
  check("the ordering way: ordered above the hosted window again when an app is activated and after a press (a click in the hosted app raises its window)", pressedAgain, "\(c.frontOrders) from \(orders)")
  clock.offset += 5.5
  read(0) // (5 s on: the raised level tried again)
  let probed = c.levelProbes == 1 && c.window.level == FrontMechanism.raised && c.mechanism == .order
  clock.offset += 0.6
  read(0) // (not held: the order again)
  let stillOrder = c.mechanism == .order && c.window.level == .normal
  clock.offset += 5.5
  read(0)
  clock.offset += 0.6
  read(1) // (held now)
  let backLines = heard.lines[linesMark...].filter { $0.contains("held by the window server again") }
  check("kept in front by its order, never for good: the raised level tried again every 5 s; not held, the order again; held, back to its raised level, said once",
        probed && stillOrder && c.levelProbes == 2 && c.mechanism == .level && c.window.level == FrontMechanism.raised && c.levelBacks == 1 && backLines.count == 1,
        "probed \(probed) still order \(stillOrder) probes \(c.levelProbes) now \(c.mechanism) level \(c.window.level.rawValue) said \(backLines.count)")
  // Its window not on the current Space (the person on another Space): nothing changed at all.
  c.onCurrentSpace = { false }
  let levelAway = c.window.level, setsAway = c.levelSets, yieldsAway = c.yieldOrders, ordersAway = c.frontOrders
  session.others(4242)
  c.keepFront()
  clock.offset += 2
  read(0)
  check("Margin's Space not the current one: a yield, an activation, a read: its level and order never changed", c.window.level == levelAway && c.levelSets == setsAway && c.yieldOrders == yieldsAway && c.frontOrders == ordersAway,
        "level \(c.window.level.rawValue) sets \(c.levelSets - setsAway) yields \(c.yieldOrders - yieldsAway)")
  c.onCurrentSpace = { true }
  session.others(nil)
  Diagnostics.echo = echoBefore

  // ---- which of the copy's windows Margin draws: only the one it hosts; the person's own told not (their ⌘T stays
  // Safari's way) ----
  shell.track()
  let told = { (id: Int) in fake.all("drawn") { int($0["windowId"]) == id }.last.flatMap { $0["on"] as? Bool } }
  check("drawn: the person's own Safari window told not drawn, the hosted one drawn, each once",
        told(1) == false && told(madeId ?? -1) == true && fake.all("drawn") { int($0["windowId"]) == 1 }.count == 1,
        "\(fake.all("drawn").map { "\(int($0["windowId"]) ?? -1)=\($0["on"] ?? "?")" })")

  // ---- Keep open off while an app is hosted (Tirth, 2026-11-20; docked whatever it was until then): the sidebar
  // hidden, the app placed at the frame's page area, brought out over the app from the left edge (Margin's window is in
  // front of it), Margin's the pointer on it; Keep open on again: docked, the app placed beside it again ----
  do {
    let shownBefore = engine.shown
    let docked = engine.pageRect
    _ = made.source.perform("updateSettings", ["patch": ["sidebarPinnedOpen": false]])
    c.stateChanged()
    let hiddenDrawn = await waitJS(c.webView, "return document.querySelector('.arcadia')?.dataset.sidebar === 'hidden'")
    let placedWide = await until(10, { engine.pageRect.minX - display.minX < 20 && c.window.pageRect == engine.pageRect })
    await session.idle()
    check("Keep open off while an app is hosted: the sidebar hidden, the app placed at the frame's page area (the theme's frame alone at its left), still shown, by a layout measured hosting",
          shownBefore != nil && hiddenDrawn && placedWide && engine.shown == shownBefore && c.layout?.hosted == true && docked.minX - display.minX > 100,
          "page \(engine.pageRect) docked \(docked) layout \(String(describing: c.layout)) shown \(String(describing: engine.shown))")
    c.pointerMoved(CGPoint(x: display.minX + 2, y: display.midY))
    let peeked = await waitJS(c.webView, "return document.querySelector('.arcadia')?.dataset.sidebar === 'peek'")
    let onSidebar = CGPoint(x: display.minX + 120, y: display.midY), onApp = CGPoint(x: display.maxX - 200, y: display.midY)
    let marginTakes = await until(3, { c.slot.map { !PassThrough.pageGets(onSidebar, $0) } ?? false })
    let appGets = c.slot.map { PassThrough.pageGets(onApp, $0) } ?? false
    check("…the left edge brings it out over the app: Margin takes the pointer on it, the app keeps it beside it; the app not placed again for it",
          peeked && marginTakes && appGets && engine.pageRect.minX - display.minX < 20 && engine.shown == shownBefore,
          "peeked \(peeked) margin \(marginTakes) app \(appGets) page \(engine.pageRect)")
    c.pointerMoved(onApp)
    _ = made.source.perform("updateSettings", ["patch": ["sidebarPinnedOpen": true]])
    c.stateChanged()
    let dockedAgain = await waitJS(c.webView, "return document.querySelector('.arcadia')?.dataset.sidebar === 'open'")
    let backBeside = await until(10, { engine.pageRect == docked })
    await session.idle()
    check("Keep open on again: docked, the app placed beside it again, still shown", dockedAgain && backBeside && engine.shown == shownBefore && c.window.pageRect == docked,
          "page \(engine.pageRect) docked \(docked)")
    // A layout its page didn't measure hosting (the launcher's, from before hosting began): never a hosted placement, so
    // nothing is placed by it; the same measured hosting: the placement.
    if let real = c.layout {
      var geometry: JSONObject = ["insets": ["left": real.left, "top": real.top, "right": real.right, "bottom": real.bottom], "radius": real.radius, "radii": real.radii,
                                  "container": ["width": real.width, "height": real.height], "mode": real.mode, "fills": real.fills]
      c.pageSaid("layout", ["geometry": geometry])
      let none = c.hostedPlacement == nil && c.pageAreaWhyNot.contains("launcher")
      geometry["pageHosted"] = true
      c.pageSaid("layout", ["geometry": geometry])
      await session.idle()
      check("a layout its page didn't measure hosting (the launcher's): no hosted placement, nothing placed by it; measured hosting: the placement again",
            none && c.hostedPlacement?.page == docked && engine.pageRect == docked && engine.shown == shownBefore, "\(String(describing: c.hostedPlacement)) \(c.pageAreaWhyNot)")
    } else {
      check("a layout to check the hosted placement with", false)
    }
  }

  // ---- the hosted app keeping its keys: the sidebar's hover lit by the pointer's moves, Margin's menus staying up
  // (Tirth, 2026-11-20: nothing highlighted under the pointer, the "+" menu gone as it came) ----
  do {
    // (A point of the page in the window server's coordinates, and in the web view's window's.)
    func centre(_ selector: String) async -> CGPoint? {
      guard let r = await js(c.webView, "const r = document.querySelector('\(selector)')?.getBoundingClientRect(); return r ? [r.left + r.width / 2, r.top + r.height / 2] : null") as? [Double], r.count == 2 else { return nil }
      return CGPoint(x: r[0], y: r[1])
    }
    // (A row that isn't the one shown: the shown one's own fill wins over hover in the theme.)
    let rowSelector = ".margin-sidebar .tab:not(.active)"
    guard let row = await centre(rowSelector) else { return check("a sidebar row to hover", false) }
    let fill = "return getComputedStyle(document.querySelector('\(rowSelector)')).backgroundColor"
    let before = await js(c.webView, fill) as? String
    let pushesBefore = c.hoverPushes
    c.pointerMoved(CGPoint(x: display.minX + row.x, y: display.minY + row.y), buttonsDown: false)
    let marked = await waitJS(c.webView, "return document.querySelector('\(rowSelector)')?.hasAttribute('m-hover') === true")
    let after = await js(c.webView, fill) as? String
    check("hover: the hosted app with the keys (Margin's panel not key, so WebKit's own :hover can't), the pointer over a sidebar row: the row marked by Margin's page and drawn with the theme's hover fill",
          !c.panel.isKeyWindow && marked && before != nil && after != nil && before != after && c.hoverPushes > pushesBefore && c.pageState == .shown,
          "marked \(marked) fill \(String(describing: before)) → \(String(describing: after)) pushes \(c.hoverPushes - pushesBefore) key \(c.panel.isKeyWindow)")
    c.pointerMoved(CGPoint(x: display.maxX - 200, y: display.midY), buttonsDown: false)
    let cleared = await waitJS(c.webView, "return !document.querySelector('[m-hover]')")
    let back = await js(c.webView, fill) as? String
    let pushesOver = c.hoverPushes
    c.pointerMoved(CGPoint(x: display.maxX - 180, y: display.midY), buttonsDown: false)
    _ = await waitJS(c.webView, "return true")
    check("hover: over the hosted app again: nothing of Margin's marked, the row's own fill again, and nothing more said to the page there",
          cleared && back == before && c.hoverPushes == pushesOver, "cleared \(cleared) fill \(String(describing: back)) pushes \(c.hoverPushes - pushesOver)")
    // The row shown (the active one) under the pointer: its own fill kept, as with WebKit's :hover (2026-11-20: the
    // rewritten selector outweighed the theme's `.active` rule, so the active row took the hover fill).
    let activeSelector = ".margin-sidebar :is(.tab, .pin).active"
    if let active = await centre(activeSelector) {
      let activeFill = "return getComputedStyle(document.querySelector('\(activeSelector)')).backgroundColor"
      let plainActive = await js(c.webView, activeFill) as? String
      c.pointerMoved(CGPoint(x: display.minX + active.x, y: display.minY + active.y), buttonsDown: false)
      let markedActive = await waitJS(c.webView, "return document.querySelector('\(activeSelector)')?.hasAttribute('m-hover') === true")
      try? await Task.sleep(for: .milliseconds(400)) // (past any fill transition)
      let hoveredActive = await js(c.webView, activeFill) as? String
      check("hover: the row shown, under the pointer (Margin's mark on it): its own active fill kept, never the hover fill",
            markedActive && plainActive != nil && hoveredActive == plainActive && plainActive != after,
            "marked \(markedActive) fill \(String(describing: plainActive)) → \(String(describing: hoveredActive)) hover \(String(describing: after))")
      c.pointerMoved(CGPoint(x: display.maxX - 200, y: display.midY), buttonsDown: false)
      _ = await waitJS(c.webView, "return !document.querySelector('[m-hover]')")
    } else { check("the row shown, to hover", false) }
    // A run of moves 2 ms apart for 200 ms over the sidebar: said to the page once a frame at most, the last place in the end.
    if let rows = await js(c.webView, "return [...document.querySelectorAll('\(rowSelector)')].slice(0, 2).map(e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })") as? [[Double]], rows.count == 2 {
      let burstStart = c.hoverPushes, t0 = Date()
      for i in 0..<100 {
        let r = rows[i < 99 ? 0 : 1]
        c.pointerMoved(CGPoint(x: display.minX + r[0] + Double(i % 3), y: display.minY + r[1]), buttonsDown: false)
        try? await Task.sleep(nanoseconds: 2_000_000)
      }
      let took = Date().timeIntervalSince(t0)
      let last = await waitJS(c.webView, "return document.querySelectorAll('\(rowSelector)')[1]?.hasAttribute('m-hover') === true")
      let said = c.hoverPushes - burstStart
      let frames = Int((took * 120).rounded(.up)) + 2
      check("hover: a run of moves (100 in \(Int(took * 1000)) ms) said to the page once a frame at most (\(said), at most \(frames) at 120 Hz), the last place marked in the end",
            said >= 2 && said <= frames && last, "said \(said) frames \(frames) last \(last)")
      c.pointerMoved(CGPoint(x: display.maxX - 200, y: display.midY), buttonsDown: false)
      _ = await waitJS(c.webView, "return !document.querySelector('[m-hover]')")
    } else { check("two sidebar rows to hover", false) }
    // WebKit's own :hover left where it was (the row the pointer was over while Margin's panel was key: it follows no move
    // once the panel isn't), Margin's marks on another row: only the marked one lit (Tirth's recording, 2026-11-20: the
    // row from before stayed lit beside the one under the pointer).
    if let rows = await js(c.webView, "return [...document.querySelectorAll('\(rowSelector)')].slice(0, 2).map(e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })") as? [[Double]], rows.count == 2 {
      let fillOf = { (i: Int) in "return getComputedStyle(document.querySelectorAll('\(rowSelector)')[\(i)]).backgroundColor" }
      let plain = await js(c.webView, fillOf(1)) as? String
      let sel = NSSelectorFromString("_simulateMouseMove:")
      let p0 = c.webView.convert(NSPoint(x: rows[0][0], y: rows[0][1]), to: nil)
      if c.webView.responds(to: sel), let e = NSEvent.mouseEvent(with: .mouseMoved, location: p0, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                             windowNumber: c.panel.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0) {
        _ = c.webView.perform(sel, with: e) // (WebKit's own hover, as a key panel's move gives it: the test's way to get one)
        let webKitHover = await waitJS(c.webView, "return document.querySelectorAll('\(rowSelector)')[0].matches(':hover')")
        c.pointerMoved(CGPoint(x: display.minX + rows[1][0], y: display.minY + rows[1][1]), buttonsDown: false)
        let marked = await waitJS(c.webView, "return document.querySelectorAll('\(rowSelector)')[1].hasAttribute('m-hover') && document.querySelectorAll('\(rowSelector)')[0].hasAttribute('m-hover-off')")
        let stale = await js(c.webView, fillOf(0)) as? String, lit = await js(c.webView, fillOf(1)) as? String
        let closeShown = await js(c.webView, "return [0, 1].map((i) => getComputedStyle(document.querySelectorAll('\(rowSelector)')[i].querySelector('.icon')).visibility)") as? [String]
        let stillWebKits = await js(c.webView, "return document.querySelectorAll('\(rowSelector)')[0].matches(':hover')") as? Bool
        check("hover: WebKit's own :hover left on a row from before, Margin's marks on another: the old one drawn plain (no fill, no ×), only the one under the pointer lit",
              webKitHover && marked && stillWebKits == true && plain != nil && stale == plain && lit != plain && closeShown == ["hidden", "visible"],
              "webkit \(webKitHover) marked \(marked) still \(String(describing: stillWebKits)) plain \(String(describing: plain)) old \(String(describing: stale)) new \(String(describing: lit)) × \(String(describing: closeShown))")
        c.pointerMoved(CGPoint(x: display.maxX - 200, y: display.midY), buttonsDown: false)
        _ = await waitJS(c.webView, "return !document.querySelector('[m-hover]')")
      } else { check("WebKit's test hook for its own hover", false) }
    } else { check("two sidebar rows for the old hover", false) }
    let rewritten = await js(c.webView, "let n = 0, m = 0; const walk = (rules) => { for (const r of rules) { if (r.selectorText) { if (/:hover/.test(r.selectorText)) n++; if (/:hover/.test(r.selectorText) && r.selectorText.includes('[m-hover]')) m++; } if (r.cssRules) walk(r.cssRules); } }; for (const s of document.adoptedStyleSheets) walk(s.cssRules); return [n, m]") as? [Int]
    check("hover: every :hover rule of the theme's and Margin's own also says [m-hover]", (rewritten?.first ?? 0) > 0 && rewritten?.first == rewritten?.last, "\(String(describing: rewritten))")

    // The "+" pressed (a real press, the web view's own): its menu up, and still up after the press's hand-back.
    guard let plus = await centre(".margin-sidebar .add") else { return check("the sidebar's + button", false) }
    let inWindow = c.webView.convert(NSPoint(x: plus.x, y: plus.y), to: nil)
    let handBacks = c.handBacks.count
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      if let e = NSEvent.mouseEvent(with: type, location: inWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: c.panel.windowNumber,
                                    context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
        if type == .leftMouseDown { c.webView.mouseDown(with: e) } else { c.webView.mouseUp(with: e) }
      }
    }
    let menuUp = await waitJS(c.webView, "return !!document.querySelector('m-menu .tab-menu')")
    let wants = await until(2, { c.pageWantsKeyboard })
    c.afterPress()
    let stillUp = await waitJS(c.webView, "return !!document.querySelector('m-menu .tab-menu')")
    check("the + menu: up at the press, the keys taken for it as a field takes them (its arrows, Return, Escape), so the press's hand-back gives nothing back; still up",
          menuUp && wants && stillUp && c.handBacks.count == handBacks, "up \(menuUp) wants \(wants) still \(stillUp) handBacks \(c.handBacks.count - handBacks)")
    _ = await js(c.webView, "const m = document.querySelector('m-menu .tab-menu'); (m?.querySelector('[m-action]') ?? m)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true")
    let closed = await waitJS(c.webView, "return !document.querySelector('m-menu .tab-menu')")
    let given = await until(2, { !c.pageWantsKeyboard && c.handBacks.count == handBacks + 1 })
    check("the + menu closed (Escape): the keys back to the hosted app at once", closed && given, "closed \(closed) wants \(c.pageWantsKeyboard) handBacks \(c.handBacks.count - handBacks)")
  }

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
  check("quit: nothing hosted: the page card empty, no hole, the window's own ground again", c.pageState == .empty && c.hole == nil && !c.ground.isShown && c.pageGround == nil && c.panel.backgroundColor == .windowBackgroundColor)
  check("quit: Calculator back at its own frame before it was quit", world.frameAtQuit[GlueHostWorld.calculator] == GlueHostWorld.calculatorFrame, "\(world.frameAtQuit)")
  check("quit: the apps Margin started quit, nothing left in Margin's Space, Mission Control Margin's Space only", world.apps.isEmpty && world.inMargin.isEmpty && world.listsMarginOnly
        && (world.reservation[GlueHostWorld.marginSpace] ?? .zero).isZero, "\(world.apps.values.map(\.bundle)) \(world.fullScreenSpaces)")

}

// Margin opened again with an item selected in its window's space (HostedSession.resumeLast; asked 2026-11-17: "open
// Margin and that's it, show a loader until the data is shown"): the real shell, library, page and window, the engine
// on the stand-in window manager. The item is shown again by itself: the page's hello already says hosting and
// `loading` with its name, so the first frame is the loader, never the launcher; its app is opened once Margin's
// window is in full screen with its page area; then `shown`.
@MainActor
// Several visible hosts in Margin's real window and page (docs/PEEK-SPLIT.md §1), told as the engine tells them
// (`setVisibleHosts`), two stand-in windows beside the hosted one (their bounds given here): a split's two panes, each a
// hole of its own in the ground (its corners rounded only where they meet the page card's), the pointer through both and
// not the gap; a card over main: the pointer only through the card's content, the page around it caught (a press there
// reported), never see-through for the window server; then one host again, as it was.
func multiHoleChecks(_ c: MarginWindowController, page: CGRect, main: Int, bounds: @escaping (Int) -> CGRect?, check: (String, Bool, @autoclosure () -> String) -> Void) async {
  let content = c.contentFrame
  func local(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x - content.minX, y: p.y - content.minY) }
  func mid(_ r: CGRect) -> CGPoint { CGPoint(x: r.midX, y: r.midY) }
  let radius = CGFloat(c.layout?.radii.first ?? 0)
  let half = ((page.width - 8) / 2).rounded(.down)
  let left = CGRect(x: page.minX, y: page.minY, width: half, height: page.height)
  let right = CGRect(x: page.maxX - half, y: page.minY, width: half, height: page.height)
  let gap = CGPoint(x: (left.maxX + right.minX) / 2, y: page.midY)
  let pane = 99901, card = 99902
  let cardRect = page.insetBy(dx: (page.width * 0.08).rounded(), dy: (page.height * 0.07).rounded())
  let was = c.hostedBounds
  c.hostedBounds = { n in n == pane ? right : n == card ? cardRect : bounds(n) }
  defer { c.hostedBounds = was }
  let pushedBefore = c.pushed.count

  // ---- a split of two ----
  c.setVisibleHosts([HostShownWindow(window: main, rect: left, role: .main, z: 0, focused: true), HostShownWindow(window: pane, rect: right, role: .pane, z: 1, focused: false)])
  check("several hosts: a split's two holes, each its window's frame inside its rect; the focused one's is `hole`",
        c.holes == [left, right] && c.hole == left && c.pageState == .shown, "\(c.holes) \(String(describing: c.hole))")
  check("several hosts: the ground cut for both (its corners rounded only where they meet the page card's), drawn in the gap between them",
        !c.ground.fills(local(mid(left))) && !c.ground.fills(local(mid(right))) && c.ground.fills(local(gap)) && c.ground.extras.count == 1
        && c.ground.radii == [radius, 0, 0, radius] && c.ground.extras.first?.radii == [0, radius, radius, 0] && radius > 0,
        "\(c.ground.radii) \(String(describing: c.ground.extras)) gap \(c.ground.fills(local(gap)))")
  check("several hosts: the pointer through each hole to its window, Margin's in the gap (caught there)",
        PassThrough.pageGets(mid(left), c.slot) && PassThrough.pageGets(mid(right), c.slot) && !PassThrough.pageGets(gap, c.slot) && c.catchRegion.contains(local(gap), in: content.size)
        && !c.catchRegion.contains(local(mid(right)), in: content.size), "\(String(describing: c.slot))")
  let points = [local(mid(left)), local(mid(right)), local(gap)]
  _ = await until(3) { windowAlpha(c.panel, at: points).map { $0[0] == 0 && $0[1] == 0 && $0[2] == 255 } == true }
  let alpha = windowAlpha(c.panel, at: points)
  check("several hosts: as the window server pictures Margin's window: see-through in both holes, painted in the gap", alpha.map { $0[0] == 0 && $0[1] == 0 && $0[2] == 255 } == true, "\(String(describing: alpha))")
  let frames = c.pushed.dropFirst(pushedBefore).filter { $0.contains(#""type":"hostedFrames""#) }
  let seen = await js(c.webView, "return marginApp.hostedFrames().map(f => f.role + (f.focused ? '*' : '')).join(',')") as? String
  check("several hosts: their frames pushed to the page beside `hostedFrame` (unchanged), back to front, the page keeping them",
        frames.count == 1 && frames.first?.contains(#""role":"main","focused":true"#) == true && frames.first?.contains(#""role":"pane","focused":false"#) == true && seen == "main*,pane",
        "\(frames) \(String(describing: seen))")

  // ---- a card over main ----
  // (A still pointer over where the card's bar comes, in main's hole until then: the page's, through to main.)
  let overBar = CGPoint(x: cardRect.midX, y: cardRect.minY - 20)
  c.setVisibleHosts([])
  c.pointerMoved(overBar, buttonsDown: false)
  let passedBefore = c.panel.ignoresMouseEvents
  c.setVisibleHosts([HostShownWindow(window: main, rect: page, role: .main, z: 0, focused: false), HostShownWindow(window: card, rect: cardRect, role: .card, z: 1, focused: true)])
  check("several hosts: a card opening under a STILL pointer over its bar (in main's hole until then): Margin's panel takes the mouse there at once, with no move (never Safari's toolbar under the bar)",
        passedBefore && !c.panel.ignoresMouseEvents, "before \(passedBefore), now ignoring \(c.panel.ignoresMouseEvents)")
  // (Still there as the card closes: main's again at once; still over the card's content as it opens: the card's.)
  c.setVisibleHosts([])
  let throughMain = c.panel.ignoresMouseEvents
  c.pointerMoved(mid(cardRect), buttonsDown: false)
  c.setVisibleHosts([HostShownWindow(window: main, rect: page, role: .main, z: 0, focused: false), HostShownWindow(window: card, rect: cardRect, role: .card, z: 1, focused: true)])
  let throughCard = c.panel.ignoresMouseEvents
  c.setVisibleHosts([])
  c.pointerMoved(overBar, buttonsDown: true) // (a drag from the page: its way kept whatever the slot does)
  c.setVisibleHosts([HostShownWindow(window: main, rect: page, role: .main, z: 0, focused: false), HostShownWindow(window: card, rect: cardRect, role: .card, z: 1, focused: true)])
  let dragKept = c.panel.ignoresMouseEvents
  c.pointerMoved(overBar, buttonsDown: false)
  check("several hosts: …a still pointer there goes through to main again as soon as the card's gone, one over the card's content to the card as it opens; a held button keeps the drag's way through a slot's change",
        throughMain && throughCard && dragKept && !c.panel.ignoresMouseEvents, "main \(throughMain) card \(throughCard) drag \(dragKept) after \(c.panel.ignoresMouseEvents)")
  let around = CGPoint(x: page.minX + 20, y: page.midY)
  check("several hosts: a card open: main's hole and the card's, the card's the focused one; the ground cut for the page area (the card's inside it)",
        c.holes == [page, cardRect] && c.hole == cardRect && !c.ground.fills(local(mid(cardRect))) && !c.ground.fills(local(around)) && c.ground.extras.isEmpty, "\(c.holes) \(c.ground.extras)")
  check("several hosts: a card open: the pointer only through its content, the page around it caught",
        PassThrough.pageGets(mid(cardRect), c.slot) && !PassThrough.pageGets(around, c.slot) && c.catchRegion.contains(local(around), in: content.size)
        && !c.catchRegion.contains(local(mid(cardRect)), in: content.size), "\(String(describing: c.slot?.holes))")
  _ = await until(3) { windowAlpha(c.panel, at: [local(around)]).map { $0[0] > 0 } == true }
  let caughtAlpha = windowAlpha(c.panel, at: [local(around), local(mid(cardRect))])
  check("several hosts: a card open: the page around it never see-through to the window server (the pointer can't pass), the card's content is",
        caughtAlpha.map { $0[0] > 0 && $0[1] == 0 } == true, "\(String(describing: caughtAlpha))")
  let caught = c.caughtPresses.count
  c.pressed(around)
  let afterAround = c.caughtPresses.count
  c.pressed(mid(cardRect))
  check("several hosts: a card open: a press on the page around it reported as caught (Preview closes the card then), one on the card's content not",
        afterAround == caught + 1 && c.caughtPresses.count == afterAround && c.caughtPresses.last == around, "\(c.caughtPresses)")
  let hello = c.pageHello()
  check("several hosts: a page's hello has every visible host's frame (a page started again while a card is open knows them at once)",
        hello.contains(#""hostedFrames":[{"role":"main","focused":false"#) && hello.contains(#"{"role":"card","focused":true"#), String(hello.prefix(0)))

  // ---- The preview card drawn by the real page (Arcadia): where its <m-preview-page> is, for the card's window ----
  let rectsBefore = c.pushed.count
  c.push(#"{"type":"peek","peek":{"url":"https://docs.example.org/guide","title":"The Guide","loading":true}}"#)
  _ = await until(3) { c.cardRect != nil }
  let drawn = c.cardRect ?? .zero
  let near = { (a: CGFloat, b: CGFloat) in abs(a - b) <= 3 }
  check("Preview: the page draws the card and says where its page is (the theme's <m-preview-page>): centred in the page area, 8% each side, 7% and a 52 pt bar above (the card window's toolbar rests under it)",
        c.cardRect != nil && near(drawn.minX - page.minX, page.maxX - drawn.maxX) && near(drawn.minX - page.minX, (page.width * 0.08).rounded())
        && near(drawn.minY - page.minY, (page.height * 0.07).rounded() + 52) && page.contains(drawn), "\(drawn) in \(page)")
  let loaderUp = await js(c.webView, "return getComputedStyle(document.querySelector('m-preview-page')).backgroundColor") as? String
  check("Preview: while its window isn't in place the card's page is covered (its own loader), never the page card's loader over main",
        loaderUp != nil && loaderUp != "rgba(0, 0, 0, 0)" && c.pageState == .shown, "\(String(describing: loaderUp)) \(c.pageState)")
  c.push(#"{"type":"peek","peek":{"url":"https://docs.example.org/guide","title":"The Guide","loading":false}}"#)
  var clear: String?
  for _ in 0..<60 {
    clear = await js(c.webView, "return getComputedStyle(document.querySelector('m-preview-page')).backgroundColor") as? String
    if clear == "rgba(0, 0, 0, 0)" { break }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  check("Preview: in place: the card's page clear (its window shows through), at the same place", clear == "rgba(0, 0, 0, 0)" && c.cardRect == drawn, "\(String(describing: clear)) \(String(describing: c.cardRect))")
  c.push(#"{"type":"peek","peek":null}"#)
  _ = await until(3) { c.cardRect == nil }
  check("Preview: closed by the app: animated out, then no card page any more (said once)", c.cardRect == nil && c.pushed.count > rectsBefore, "\(String(describing: c.cardRect))")

  // ---- one host again ----
  c.setVisibleHosts([])
  check("several hosts: one again: the hole the hosted window's alone, the ground and the pointer as before, the page told none",
        c.holes == [page] && c.hole == page && c.ground.extras.isEmpty && c.ground.hole == CGRect(origin: local(page.origin), size: page.size) && c.slot?.holes == nil && c.slot?.rect == page
        && c.pushed.last == #"{"type":"hostedFrames","frames":[]}"#, "\(c.holes) \(String(describing: c.slot)) \(String(describing: c.pushed.last))")
}

func glueResumeScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("glue: at launch: \(label)", ok, detail()) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-resume-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let world = GlueHostWorld()
  var options = Shell.Options()
  options.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root
  options.bundleIds = ["safari": fakeBundle]
  options.hostSystem = world
  options.appCatalog.folders = []
  options.appCatalog.spotlight = false
  options.appCatalog.icons = AppIconCache(folder: root.appendingPathComponent("icons"))
  var host = HostEngine.Options()
  host.every = 0.01
  host.privateRetire = 0
  options.hostOptions = host
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.resume.\(ProcessInfo.processInfo.processIdentifier)"))
  let shell = Shell(link: link, apps: ScriptedApps(), hotKeys: FakeKeys(), options: options)
  shell.start()
  defer { shell.stop {} }
  let made = shell.makeMarginWindows()
  let library = shell.library
  guard let session = shell.hosted, let engine = shell.host else { return check("the library, the session and the engine", false) }
  // (What an earlier run left: an app item of the first space, the one selected there.)
  let space = library.spaces().first?.id ?? ""
  let added = library.perform("addItem", ["spaceId": space, "target": ItemTarget.app(bundleId: "com.apple.Notes", name: "Notes").json, "front": true])
  let item = (added.result as? JSONObject)?["tabId"] as? String ?? ""
  _ = library.perform("activateTab", ["windowId": 1, "tabId": item])
  await session.idle()
  check("an item selected in the window's space, nothing shown (no Margin window yet)", !item.isEmpty && engine.shown == nil
        && library.items().contains { $0.id == item && $0.value["selected"] as? Bool == true }, "\(library.items().map { $0.value })")

  var atLaunch: String?
  world.onLaunch = { bundle in if bundle == "com.apple.Notes" { atLaunch = "\(made.controllers.first?.isFullScreen == true) \(made.controllers.first?.pageState.rawValue ?? "?") \(made.controllers.first?.hostedPlacement != nil)" } }
  _ = made.source.perform("updateSettings", ["patch": ["sidebarPinnedOpen": true]]) // (Keep open on: the docked first frame below)
  let c = made.open()
  defer { made.closeAll() }
  world.marginWindow = c.window.windowNumber
  c.hostedBounds = { world.bounds(window: $0) }
  world.display = c.contentFrame
  let hello = c.pageHello()
  // (Margin's start, Tirth 2026-11-18: the default browser first, behind "Getting you started", then the item. Here no
  // browser can be made ready out of sight (no early full screen in this world), and since the start found that out at
  // once (Safari started with Margin, not after its window: 2026-11-18 night) it says the item's name from the first
  // frame instead, never "Getting you started" for a browser that isn't being started. The start's own words are
  // hosted-tests.swift's "start:" checks.)
  let startsWithBrowser = c.pageStates == ["loading \(HostedSession.startupLabel)"] && hello.contains(#""pageStarting":true"#)
  let startsWithItem = c.pageStates == ["loading Notes"] && !hello.contains(#""pageStarting":true"#)
  check("as the window is made, before its page has loaded: hosting, the page card loading (\"Getting you started\" while a browser starts; here none can be, so the item's name), its hello saying so (the first frame is the loader, not the launcher)",
        c.hosting && c.pageState == .loading && (startsWithBrowser || startsWithItem) && hello.contains(#""pageHosted":true"#) && hello.contains(#""pageState":"loading""#)
        && session.resuming == c.id, "\(c.pageStates) \(c.pageState.rawValue) \(hello.contains("pageStarting"))")
  guard await until(15, { c.isReady }) else { return check("Margin's window's page drawn", false) }
  let first = await js(c.webView, "const r = document.querySelector('.arcadia'); const l = r?.querySelector('m-page-loader'); return [r?.getAttribute('m-page-state'), !!document.querySelector('.launcher'), l?.textContent ?? '', r?.dataset.sidebar].join('|')") as? String ?? "?"
  check("its page as it's first drawn: the theme's root loading (or already shown), no launcher, the loader with Margin's words, the sidebar docked",
        (first.hasPrefix("loading|false|Opening Notes…") || first.hasPrefix("loading|false|Getting you started…") || first.hasPrefix("shown|false|")) && first.hasSuffix("|open"), first)
  let notes = HostTarget.app("com.apple.Notes").id
  guard await until(10, { engine.shown == notes && c.pageState == .shown }) else { return check("the item shown again", false, "\(session.done.suffix(5)) \(c.pageStates)") }
  let win = world.apps.values.first { $0.bundle == "com.apple.Notes" }?.windows.first ?? 0
  // The window dropped from every Space right after it's shown (the real Mac, 2026-11-17, check10): the engine's polls
  // that follow a show (every 0.1 s for 1.5 s; nothing else polls here) put it back at their first read.
  world.wins[win]?.spaces = []
  let putBack = await until(1.2) { world.inMargin == [win] }
  await session.idle()
  check("its window in no Space at all right after it's shown: put back into Margin's Space by the polls that follow a show, still the one shown",
        putBack && engine.shown == notes && c.hosted == win && c.pageState == .shown, "back \(putBack) \(String(describing: world.wins[win]?.spaces)) \(c.pageState.rawValue)")
  // Nothing of Margin's Space on screen though every Space read is right (the real Mac, 2026-11-17: macOS finished its
  // own full-screen change into a Space that was gone): the shell's poll looks at the on-screen list too.
  world.lists = true
  shell.track()
  world.blank = true
  let onAgain = await until(3) { shell.track(); return !world.blank }
  await session.idle()
  check("neither Margin's window nor the hosted one on screen though the Spaces read as they should: the shell's poll makes Margin's Space current again, still the one shown, never the launcher",
        onAgain && engine.shown == notes && c.hosted == win && c.pageState == .shown && world.inMargin == [win], "back \(onAgain) \(c.pageState.rawValue)")
  world.lists = false
  check("its app opened only once Margin's window was in full screen with its page area, still behind the loader", atLaunch == "true loading true", "\(String(describing: atLaunch))")
  check("then shown: the page card loading (Margin's start, then the item's name) → shown with never the launcher (never `empty`, hosting never turned off), the hole at the app's window, its item the one shown",
        (c.pageStates == ["loading \(HostedSession.startupLabel)", "loading Notes", "shown"] || c.pageStates == ["loading Notes", "shown"]) && !c.pushed.contains(#"{"type":"pageHosted","on":false}"#) && c.hole == world.bounds(window: win) && c.hole == c.window.pageRect
        && session.shown[c.id] == item && session.resuming == nil && world.inMargin == [win], "\(c.pageStates) hole \(String(describing: c.hole))")
  let lit = await waitJS(c.webView, "return document.querySelector('.tab.active')?.getAttribute('aria-label') === 'Notes' && document.querySelector('.arcadia')?.getAttribute('m-page-state') === 'shown' && !document.querySelector('.launcher')")
  check("the sidebar highlights it, the theme's root says shown, no launcher", lit)
  check("the dev hook's front line says what the engine reads of the one shown (its Spaces, on screen or not, the polls so far) and what the window would show by itself at the next launch: the app's bundle id only",
        shell.devFront().hasSuffix(", last app:com.apple.Notes") && shell.devFront().contains("; engine: polls ") && shell.devFront().contains("app:com.apple.Notes window \(win) in [\(GlueHostWorld.marginSpace)]"), String(shell.devFront().suffix(260)))

  // ---- a theme per space (2026-11-20): each window draws the theme of the space it shows ----
  do {
    // (One theme's root drawn, that one: the theme before gone.)
    let rootIs = { (cls: String) in "return !!document.querySelector('.\(cls)') && document.querySelectorAll('.arcadia, .pixel, .m3').length === 1" }
    let before = library.snapshot()
    let firstSpace = ((before["openTabs"] as? JSONObject)?["activeSpaceByWindow"] as? JSONObject)?[String(c.id)] as? String ?? ""
    check("a theme per space: the window draws Arcadia to start with", await waitJS(c.webView, rootIs("arcadia")))
    let made = library.perform("createSpace", ["windowId": c.id, "name": "Pix", "theme": "pixel"])
    let pix = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    let drewPixel = await waitJS(c.webView, rootIs("pixel"))
    check("a theme per space: a space made with Pixel and shown: the window draws Pixel (its package from the app's built-ins)", !pix.isEmpty && drewPixel)
    _ = library.perform("setSpace", ["windowId": c.id, "spaceId": firstSpace])
    check("a theme per space: back to the first space: Arcadia again", await waitJS(c.webView, rootIs("arcadia")))
    _ = library.perform("setSpaceTheme", ["spaceId": firstSpace, "theme": "material"])
    check("a theme per space: the space shown given Material (its menu, Settings): drawn at once", await waitJS(c.webView, rootIs("m3")))
    _ = library.perform("setSpaceTheme", ["spaceId": firstSpace, "theme": NSNull()])
    check("a theme per space: none again: the profile's (Arcadia)", await waitJS(c.webView, rootIs("arcadia")))
    // Mid-swipe (the sidebar `m-swiping`, as ui/behaviors/swipe.ts marks it): another theme waits for it to land.
    let marked = await js(c.webView, "const el = document.querySelector('.margin-sidebar'); el?.classList.add('m-swiping'); return !!el") as? Bool == true
    _ = library.perform("setSpaceTheme", ["spaceId": firstSpace, "theme": "pixel"])
    try? await Task.sleep(nanoseconds: 400_000_000)
    let waited = await js(c.webView, "return !!document.querySelector('.arcadia') && !document.querySelector('.pixel')") as? Bool == true
    _ = await js(c.webView, "document.querySelector('.margin-sidebar')?.classList.remove('m-swiping'); return true")
    let landed = await waitJS(c.webView, rootIs("pixel"))
    check("a theme per space: a theme come mid-swipe waits for it to land, then drawn", marked && waited && landed, "marked \(marked) waited \(waited) landed \(landed)")
    _ = library.perform("setSpaceTheme", ["spaceId": firstSpace, "theme": NSNull()])
    check("a theme per space: and back", await waitJS(c.webView, rootIs("arcadia")))
    _ = library.perform("deleteSpace", ["spaceId": pix])
  }

  // ---- a space's appearance (M2.9 step 3): Margin's window draws in the space's own light or dark ----
  do {
    let shown = ((library.snapshot()["openTabs"] as? JSONObject)?["activeSpaceByWindow"] as? JSONObject)?[String(c.id)] as? String ?? ""
    let systemDark = c.window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    // (The other one: so each change is one the page can see, whatever this Mac's appearance.)
    let other = systemDark ? "light" : "dark", otherName: NSAppearance.Name = systemDark ? .aqua : .darkAqua
    let pageDark = { (dark: Bool) in "return matchMedia('(prefers-color-scheme: dark)').matches === \(dark)" }
    let marked = { (look: String) in " && document.querySelector('[m-background]')?.getAttribute('m-appearance') === '\(look)'" }
    let look = { (appearance: String) -> JSONObject in ["colors": ["#6c5ce7"], "appearance": appearance] }
    let start = await waitJS(c.webView, pageDark(systemDark))
    check("a space's appearance: none of its own: the window's, the system's", c.webView.appearance == nil && start)
    _ = library.perform("renameSpace", ["spaceId": shown, "background": look(other)])
    let own = await until(3) { c.webView.appearance?.name == otherName }
    check("a space's appearance: its own (\(other)): the window's web view in it", own, "\(String(describing: c.webView.appearance?.name))")
    check("a space's appearance: the page in it (prefers-color-scheme), its background marked so", await waitJS(c.webView, pageDark(!systemDark) + marked(other)))
    _ = library.perform("renameSpace", ["spaceId": shown, "background": look("auto")])
    let auto = await until(3) { c.webView.appearance == nil }
    let autoPage = await waitJS(c.webView, pageDark(systemDark))
    check("a space's appearance: automatic: the system's again", auto && autoPage)
    let made = library.perform("createSpace", ["windowId": c.id, "name": "Night"])
    let night = (made.result as? JSONObject)?["spaceId"] as? String ?? ""
    _ = library.perform("renameSpace", ["spaceId": night, "background": look(other)])
    let switched = await until(3) { c.webView.appearance?.name == otherName }
    let nightPage = await waitJS(c.webView, pageDark(!systemDark))
    check("a space's appearance: another space with its own, shown: the window in it", !night.isEmpty && switched && nightPage)
    _ = library.perform("setSpace", ["windowId": c.id, "spaceId": shown])
    let back = await until(3) { c.webView.appearance == nil }
    let backPage = await waitJS(c.webView, pageDark(systemDark))
    check("a space's appearance: back to one that follows the system: the system's", back && backPage)
    _ = library.perform("renameSpace", ["spaceId": shown, "background": NSNull()])
    _ = library.perform("deleteSpace", ["spaceId": night])
    check("a space's appearance: no background, none of its own", await until(3) { c.webView.appearance == nil })
  }

  // ---- Edit Theme Color's glass (M2.9 step 5): the system's materials on while its panel is open ----
  do {
    let switched = { (c.webView.value(forKey: "_useSystemAppearance") as? Bool) == true }
    // (Where the switch exists and isn't kept off: macOS 26 and later.)
    let glass = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26 && OverlaySystemAppearance.allowed
    let panelUp = "return !!document.querySelector('margin-background-picker')"
    let arcadia = await waitJS(c.webView, "return !!document.querySelector('.arcadia')")
    check("edit theme color's glass: Arcadia drawn, the switch off", arcadia && !switched())
    // Opened from the space's menu: the menu up (its `contextmenu` on the space's chip), its item really pressed (a
    // theme's action runs for a person's press only, a trusted event: ui/render.ts), as the + menu's check presses.
    let at = await js(c.webView, """
      const chip = document.querySelector('.chip.active'); if (!chip) return null;
      const r = chip.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      for (const type of ['mousedown', 'contextmenu']) chip.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
      const item = [...document.querySelectorAll('.menu-item')].find((e) => e.textContent.includes('Edit Theme Color'));
      if (!item) return null;
      const b = item.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
      """) as? [Double]
    if let at, at.count == 2 {
      let inWindow = c.webView.convert(NSPoint(x: at[0], y: at[1]), to: nil)
      for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        if let e = NSEvent.mouseEvent(with: type, location: inWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: c.webView.window?.windowNumber ?? 0,
                                      context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
          if type == .leftMouseDown { c.webView.mouseDown(with: e) } else { c.webView.mouseUp(with: e) }
        }
      }
    }
    let up = await waitJS(c.webView, panelUp)
    check("edit theme color's glass: opened from the space's menu (its item pressed)", at?.count == 2 && up, "item \(String(describing: at)) up \(up)")
    check("edit theme color's glass: the system's materials on while it's open (\(glass ? "macOS 26+" : "off here"))", switched() == glass, "switched \(switched())")
    let known = await js(c.webView, "return CSS.supports('-apple-visual-effect', '-apple-system-glass-material')") as? Bool == true
    check("edit theme color's glass: the page knows the property (its panel read with it)", known == glass, "known \(known)")
    // A press outside closes it: the materials given back.
    _ = await js(c.webView, "document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, isPrimary: true })); return true")
    let gone = await waitJS(c.webView, "return !document.querySelector('margin-background-picker')")
    let off = await until(3) { !switched() }
    check("edit theme color's glass: closed, the switch off again (Arcadia as before)", gone && off, "gone \(gone) off \(off)")
  }

  // ---- a space's picture (M2.9 step 7): asked for by the page, kept by the store, served, drawn ----
  // (The page's own requests, as Edit Theme Color sends them: its buttons are in a closed root, worked by
  // tests/theme/picker-picture.test.ts. The file picker: the store's stand-in, `pick`.)
  do {
    let file = root.appendingPathComponent("chosen-photo.png")
    let ctx = CGContext(data: nil, width: 64, height: 40, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(CGColor(red: 0.12, green: 0.25, blue: 0.38, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 40))
    let png = NSMutableData()
    let dest = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
    try? (png as Data).write(to: file)
    let send = { (type: String, payload: String) async -> JSONObject? in
      let text = await js(c.webView, "return await window.webkit.messageHandlers.margin.postMessage({ op: 'send', type: '\(type)', payload: \(payload) })") as? String
      return text.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? JSONObject }
    }
    let isId = { (v: Any?) in ((v as? JSONObject)?["id"] as? String).map { $0.count == 64 && $0.allSatisfy { $0.isHexDigit && !$0.isUppercase } } == true }
    shell.backgrounds.pick = { file }
    let chosen = await send("backgroundChoose", "{}")
    let id = (chosen?["result"] as? JSONObject)?["id"] as? String ?? ""
    check("a space's picture: chosen (the file picker's stand-in): kept, its id answered", chosen?["ok"] as? Bool == true && isId(chosen?["result"]) && shell.backgrounds.ids().contains(id), "\(String(describing: chosen))")
    shell.backgrounds.pick = { nil }
    let cancelled = await send("backgroundChoose", "{}")
    check("a space's picture: the file picker cancelled: answered with nothing", cancelled?["ok"] as? Bool == true && cancelled?["result"] is NSNull, "\(String(describing: cancelled))")
    shell.backgrounds.pick = nil
    let dropped = await send("backgroundAdd", "{ bytes: '\((png as Data).base64EncodedString())' }")
    check("a space's picture: dropped (its bytes): kept, its id answered", dropped?["ok"] as? Bool == true && isId(dropped?["result"]), "\(String(describing: dropped))")
    let refused = await send("backgroundAdd", "{ bytes: 'aGVsbG8=' }")
    check("a space's picture: what isn't one: refused with words for the page", refused?["ok"] as? Bool == false && (refused?["error"] as? String)?.isEmpty == false, "\(String(describing: refused))")
    // Drawn: the shown space's background with it. Its ground (`--m-bg`, on the page's root) is the underlay's until
    // the picture is served, loaded and read from (a canvas copy: a picture from Margin's own scheme isn't tainted).
    let shown = ((library.snapshot()["openTabs"] as? JSONObject)?["activeSpaceByWindow"] as? JSONObject)?[String(c.id)] as? String ?? ""
    let bg = { (image: String) -> JSONObject in
      ["colors": [String](), "image": ["id": image, "fit": "cover", "focus": [0.5, 0.5]], "wheel": "analogous", "intensity": 0.5, "texture": "grain", "amount": 0, "appearance": "light"]
    }
    let ground = "return getComputedStyle(document.documentElement).getPropertyValue('--m-bg').trim()"
    _ = library.perform("renameSpace", ["spaceId": shown, "background": bg(String(repeating: "f", count: 64))])
    var unserved = ""
    for _ in 0..<40 { unserved = await js(c.webView, ground) as? String ?? ""; if !unserved.isEmpty { break }; try? await Task.sleep(nanoseconds: 50_000_000) }
    _ = library.perform("renameSpace", ["spaceId": shown, "background": bg(id)])
    var drawn = ""
    for _ in 0..<60 { drawn = await js(c.webView, ground) as? String ?? ""; if !drawn.isEmpty && drawn != unserved { break }; try? await Task.sleep(nanoseconds: 50_000_000) }
    check("a space's picture: one not kept: drawn without it (the underlay)", !unserved.isEmpty, unserved)
    check("a space's picture: served by Margin's scheme, loaded and read by the page: its ground the picture's", !drawn.isEmpty && drawn != unserved, "\(unserved) → \(drawn)")
    _ = library.perform("renameSpace", ["spaceId": shown, "background": NSNull()])
    try? FileManager.default.removeItem(at: file)
  }
}
