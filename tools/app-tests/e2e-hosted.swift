// Margin's own window end to end (part of e2e.swift's run; app/platforms/macos/shell/MarginWindow.swift,
// MarginWindowController.swift, ShellHosted.swift): the real overlay page (dist/app) in a MarginWindow off
// every display, never key, the app never active, fed by a stand-in source (no browser, no link).
//
// What it follows: the page knows it's in Margin's window (`app-window`, windowed), draws the source's spaces
// and says where its page area is, which the window publishes in screen points; with nothing hosted, the page
// area is the theme's launcher, opaque, and the window (opaque too) takes the mouse there; the menu's New Tab
// opens the palette and again closes it; Toggle Sidebar asks the source to turn Keep open off, the sidebar
// staying beside the launcher (as on Margin's new-tab page); full screen is the page's mode; a resize moves the
// area; a press on a pin is a request of the source for this window; the source's change is drawn; New Window
// makes a second window; the shell's windows draw the library.
import AppKit
import WebKit

final class FakeWindowSource: MarginWindowSource {
  var state: JSONObject
  var onChange: (() -> Void)?
  var asked: [(type: String, payload: JSONObject)] = []
  init(_ state: JSONObject) { self.state = state }
  func snapshot() -> JSONObject { state }
  @discardableResult func perform(_ type: String, _ payload: JSONObject) -> JSONObject? {
    asked.append((type, payload))
    if type == "updateSettings", let patch = payload["patch"] as? JSONObject {
      var settings = state["settings"] as? JSONObject ?? [:]
      settings.merge(patch) { _, new in new }
      state["settings"] = settings
      onChange?()
    }
    return nil
  }
}

// A real press (an NSEvent to the window, which is never key) at a point of its content (from the top left).
func press(_ window: NSWindow, at p: CGPoint) {
  let at = NSPoint(x: p.x, y: window.frame.height - p.y)
  for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
    if let e = NSEvent.mouseEvent(with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                  context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
      window.sendEvent(e)
    }
  }
}

@MainActor
func hostedScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("hosted: \(label)", ok, detail()) }
  let values: [String: [String: Any]] = [
    "spaces": ["home": ["name": "Home", "emoji": "🏠", "color": "#6c5ce7", "order": 0], "work": ["name": "Work", "emoji": "💼", "color": "#0984e3", "order": 1]],
    "pins": ["p1": ["spaceId": "home", "url": "https://pinned.example/", "title": "Pinned Site", "pos": 0]],
    "tabs": ["t-aaaaaaaaaa": ["spaceId": "home", "url": "https://kept.example/", "title": "Kept Page", "order": 3, "lastUsed": 100]],
    "settings": ["sidebarPinnedOpen": true],
  ]
  let source = FakeWindowSource(DataSetWindowSource.state(values: { values[$0] ?? [:] }, active: [:]))
  let pages = OverlayPages(root: URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!))
  // Every warning said meanwhile (the page's own come as "Margin's window N: …"), passed on as before.
  var warned: [String] = []
  let echo = Diagnostics.echo
  Diagnostics.echo = { line in if line.hasPrefix("warning: ") { warned.append(line) }; echo?(line) }
  defer { Diagnostics.echo = echo }
  // (Windowed Margin is kept for later: this run checks its window both ways, so not always full screen.)
  let windows = MarginWindows(pages: pages, source: source, options: .init(harness: true, alwaysFullScreen: false))
  defer { windows.closeAll() }
  let c = windows.open()
  var published: [CGRect?] = []
  c.window.onPageRectChange = { published.append($0) }
  check("its window off every display, not key, the app not active",
        !c.window.onADisplay && !NSScreen.screens.contains { $0.frame.intersects(c.window.frame) } && !c.window.isKeyWindow && !NSApp.isActive, "\(c.window.frame)")
  check("a regular, resizable window with a transparent title bar, its UI drawn under it",
        c.window.styleMask.contains(.titled) && c.window.styleMask.contains(.fullSizeContentView) && c.window.styleMask.contains(.resizable)
          && c.window.titlebarAppearsTransparent && !c.window.isOpaque && c.window.collectionBehavior.contains(.fullScreenPrimary))
  guard await until(15, { c.isReady }) else { return check("its page drawn", false) }
  let hello = await js(c.webView, "return marginApp.appWindow()") as? JSONObject ?? [:]
  check("the page knows it's in Margin's window, windowed", hello["appWindow"] as? Bool == true && hello["mode"] as? String == "windowed", "\(hello)")
  let rows = await js(c.webView, "return document.body.innerText") as? String ?? ""
  check("the source's space drawn: its name, its pin, its kept tab", rows.contains("Home") && rows.contains("Pinned Site") && rows.contains("Kept Page"), String(rows.prefix(300)))

  // ---- the page area ----
  guard await until(5, { c.window.pageRect != nil }), let page = c.window.pageRect else { return check("a page area published", false) }
  let content = c.contentFrame
  check("the page area in screen points: beside the sidebar, inside the window's frame",
        page.minX >= content.minX + 150 && page.maxX <= content.maxX && page.minY >= content.minY && page.maxY <= content.maxY && page.width >= 600 && page.height >= 600,
        "page \(page) content \(content)")
  check("published with its callback", published.last == page, "\(published)")
  check("the theme's window controls reported (the buttons go there)", await until(3, { c.controls != nil }) && (c.controls?.width ?? 0) > 0, "\(String(describing: c.controls))")

  // ---- nothing hosted: the page area is Margin's own, the theme's launcher, opaque ----
  check("the window's background is opaque (no edge of it see-through), its corners still macOS's",
        (c.window.backgroundColor.usingColorSpace(.sRGB)?.alphaComponent ?? 0) == 1 && !c.window.isOpaque)
  let launcher = await js(c.webView, """
    const l = document.querySelector('.launcher'); if (!l) return null;
    const r = l.getBoundingClientRect(), bg = getComputedStyle(l).backgroundColor;
    return [r.x, r.y, r.width, r.height, bg];
    """) as? [Any]
  let box = launcher.flatMap { l in rect(Array(l.prefix(4))) }
  let bg = launcher?.last as? String ?? ""
  let local = page.offsetBy(dx: -content.minX, dy: -content.minY)
  check("with nothing hosted, the theme's launcher fills the page area", box.map { abs($0.minX - local.minX) <= 1 && abs($0.minY - local.minY) <= 1 && abs($0.width - local.width) <= 1 && abs($0.height - local.height) <= 1 } == true,
        "\(String(describing: box)) page \(local)")
  check("… opaque: its background has no transparency", bg.hasPrefix("rgb(") || (bg.hasPrefix("rgba(") && !bg.hasSuffix(", 0)") && bg.contains(", 1)")), bg)
  c.pointerMoved(CGPoint(x: page.midX, y: page.midY), buttonsDown: false)
  check("over the page area: the window takes the mouse (nothing is behind it)", !c.window.ignoresMouseEvents && c.slot == nil)
  c.pointerMoved(CGPoint(x: content.minX + 60, y: page.midY), buttonsDown: false)
  check("over the sidebar: the window takes it", !c.window.ignoresMouseEvents)

  // ---- the menu: New Tab opens the palette ----
  guard let newTab = MarginMenu.item(.newTab, in: windows.menu), let action = newTab.action, let target = newTab.target as? MarginMenuTarget else { return check("New Tab in the menu", false) }
  _ = target.perform(action, with: newTab)
  check("File › New Tab: the palette opens in the window", await waitJS(c.webView, "return marginApp.appWindow().palette === true"))
  let palette = rect(await js(c.webView, "const r = document.querySelector('[m-input=\"palette\"]')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null"))
  if let palette, await until(3, { c.hits.contains { $0.contains(CGPoint(x: palette.midX, y: palette.midY)) } || c.captureAll }) {
    let over = CGPoint(x: content.minX + palette.midX, y: content.minY + palette.midY)
    c.pointerMoved(over, buttonsDown: false)
    check("over the palette drawn over the page area: the window takes the mouse", !page.contains(over) || !c.window.ignoresMouseEvents, "\(palette) \(c.hits)")
  } else { check("the palette's box reported over the page", false, "\(String(describing: palette)) \(c.hits)") }
  _ = target.perform(action, with: newTab)
  check("New Tab again: the palette closes", await waitJS(c.webView, "return marginApp.appWindow().palette === false"))

  // ---- a press on a pin: the source's request, for this window ----
  if let pin = rect(await js(c.webView, "const r = document.querySelector('[data-pin-id=\"p1\"]')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null")) {
    press(c.window, at: CGPoint(x: pin.midX, y: pin.midY))
    check("a press on a pin: openPin asked of the source, for window \(c.id)",
          await until(3, { source.asked.contains { $0.type == "openPin" && $0.payload["windowId"] as? Int == c.id } }), "\(source.asked.map(\.type))")
  } else { check("the pin's row", false) }

  // ---- Toggle Sidebar: Keep open off; with nothing hosted, the sidebar stays beside the launcher ----
  let before = page
  windows.perform(.toggleSidebar)
  check("View › Toggle Sidebar: Keep open off, asked of the source", await until(3, { source.asked.contains { $0.type == "updateSettings" } }), "\(source.asked.map(\.type))")
  check("with nothing hosted the sidebar stays beside the launcher (as on Margin's new-tab page): the page area as it was",
        await waitJS(c.webView, "return document.querySelector('.arcadia')?.dataset.sidebar === 'open'") && c.window.pageRect == before, "\(String(describing: c.window.pageRect)) was \(before)")
  var settings = source.state["settings"] as? JSONObject ?? [:]
  settings["sidebarPinnedOpen"] = true
  source.state["settings"] = settings
  source.onChange?()
  check("Keep open again (the source's change): the page area as it was", await until(5, { c.window.pageRect == before }), "\(String(describing: c.window.pageRect))")

  // ---- a resize, full screen ----
  let bigger = CGRect(x: -20000, y: -20000, width: 1400, height: 900)
  c.window.setFrame(ScreenGeometry.appKitRect(bigger), display: false)
  check("resized: the page area follows, measured at the new size",
        await until(5, { (c.window.pageRect?.width ?? 0) == before.width + 200 && (c.window.pageRect?.height ?? 0) == before.height + 100 }), "\(String(describing: c.window.pageRect))")
  c.toggleFullScreen() // (a test's window: its state only, it never leaves its place)
  check("full screen: the page draws in full-screen mode", await waitJS(c.webView, "return marginApp.appWindow().mode === 'fullscreen'"))
  check("full screen: the theme hides its window controls (AppKit's own then)", await until(3, { c.controls == nil }))
  check("full screen: a page area still", await until(3, { c.window.pageRect != nil }))
  c.toggleFullScreen()
  check("windowed again", await waitJS(c.webView, "return marginApp.appWindow().mode === 'windowed'") && c.mode == "windowed")

  // ---- always full screen, its toggle ignored (Margin not active, opened by a script): asked again as it activates ----
  do {
    var macOSEnters = false // (macOS's answer to the toggle: ignored until Margin is "active")
    // (Its own source: a source tells one set of windows of its changes.)
    let always = MarginWindows(pages: pages, source: FakeWindowSource(source.state), options: .init(harness: true, alwaysFullScreen: true))
    defer { always.closeAll() }
    var o = MarginWindowController.Options()
    o.harnessEnters = { macOSEnters }
    let w = always.open(o)
    check("always full screen, the toggle ignored: asked once, not in", w.fullScreenAsks == 1 && !w.isFullScreen && w.fullScreenRetries == 0)
    w.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification, object: w.window))
    w.windowDidBecomeMain(Notification(name: NSWindow.didBecomeMainNotification, object: w.window))
    check("its window key, then main (still ignored): asked again once, not twice in one activation", w.fullScreenAsks == 2 && w.fullScreenRetries == 1 && !w.isFullScreen)
    macOSEnters = true
    w.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification, object: w.window))
    check("key again in the same activation: still not asked (no loop)", w.fullScreenAsks == 2 && !w.isFullScreen)
    NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
    check("Margin active: asked again, in full screen", await until(3, { w.isFullScreen }) && w.fullScreenAsks == 3 && w.fullScreenRetries == 2, "\(w.fullScreenAsks) \(w.fullScreenRetries)")
    NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
    w.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification, object: w.window))
    check("in full screen: activations and key never ask again", w.fullScreenAsks == 3 && w.fullScreenRetries == 2 && w.isFullScreen)
  }

  // ---- the source changed: drawn ----
  var pins = source.state["pins"] as? [JSONObject] ?? []
  if !pins.isEmpty { pins[0]["title"] = "Renamed Site" }
  source.state["pins"] = pins
  source.onChange?()
  check("the source's change drawn", await waitJS(c.webView, "return document.body.innerText.includes('Renamed Site')"))

  // ---- New Window ----
  windows.perform(.newWindow)
  check("File › New Window: a second window, off every display", windows.controllers.count == 2 && !NSScreen.screens.contains { $0.frame.intersects(windows.controllers[1].window.frame) })
  let second = windows.controllers[1]
  check("its page drawn too, its own id", await until(15, { second.isReady }) && second.id == c.id + 1)
  second.window.performClose(nil)
  check("closed: one window left", await until(3, { windows.controllers.count == 1 }), "\(windows.controllers.count)")
  check("nothing warned: the page drew the source's state as it is, and nothing asked for a display", warned.isEmpty, "\(warned.prefix(5))")

  // ---- the shell's source: the library (the stand-in only when its rules don't load) ----
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-hosted-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root
  options.hosted = true
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.hosted.\(ProcessInfo.processInfo.processIdentifier)"))
  let shell = Shell(link: link, windows: ScriptedWindows(), apps: ScriptedApps(), hotKeys: FakeKeys(), options: options)
  let made = shell.makeMarginWindows()
  check("the shell's windows: made once, in a test never on a display", made === shell.makeMarginWindows() && made.options.harness)
  check("the shell's windows draw the library: nothing imported, a first space, Personal", made.source is LibraryWindowSource
        && ((made.source.snapshot()["spaces"] as? [JSONObject])?.first?["name"] as? String) == "Personal")
  shell.stop {}
}
