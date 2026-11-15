// Margin's own window end to end (part of e2e.swift's run; app/platforms/macos/shell/MarginWindow.swift,
// MarginWindowController.swift, ShellHosted.swift): the real overlay page (dist/app) in a MarginWindow off
// every display, never key, the app never active, fed by a stand-in source (no browser, no link).
//
// What it follows: the page knows it's in Margin's window (`app-window`, windowed), draws the source's spaces
// and says where its page area is, which the window publishes in screen points; the window ignores the mouse
// over that area only, and over the palette drawn there it doesn't; the menu's New Tab opens the palette and
// again closes it; Toggle Sidebar widens the page area (the source keeps the setting); full screen is the
// page's mode; a resize moves the area; a press on a pin is a request of the source for this window; the
// source's change is drawn; New Window makes a second window; the shell's stand-in source reads a data set.
import AppKit
import WebKit

final class FakeWindowSource: MarginWindowSource {
  var state: JSONObject
  var onChange: (() -> Void)?
  var asked: [(type: String, payload: JSONObject)] = []
  init(_ state: JSONObject) { self.state = state }
  func snapshot() -> JSONObject { state }
  func perform(_ type: String, _ payload: JSONObject) {
    asked.append((type, payload))
    if type == "updateSettings", let patch = payload["patch"] as? JSONObject {
      var settings = state["settings"] as? JSONObject ?? [:]
      settings.merge(patch) { _, new in new }
      state["settings"] = settings
      onChange?()
    }
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
  let windows = MarginWindows(pages: pages, source: source, options: .init(harness: true))
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

  // ---- the pointer through to the window behind ----
  c.pointerMoved(CGPoint(x: page.midX, y: page.midY), buttonsDown: false)
  check("over the page area: the window ignores the mouse", c.window.ignoresMouseEvents)
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

  // ---- Toggle Sidebar: the page area widens; out again over the page, Margin's there ----
  let before = page
  windows.perform(.toggleSidebar)
  check("View › Toggle Sidebar: Keep open off, asked of the source", await until(3, { source.asked.contains { $0.type == "updateSettings" } }), "\(source.asked.map(\.type))")
  check("the sidebar hidden: the page area widens, published", await until(5, { (c.window.pageRect?.minX ?? .infinity) < before.minX - 100 }), "\(String(describing: c.window.pageRect)) was \(before)")
  let wide = c.window.pageRect ?? .zero
  windows.perform(.toggleSidebar)
  let overSidebar = CGPoint(x: content.minX + 60, y: content.minY + 300)
  check("toggled out over the page: what it draws there is reported", await until(5, { c.hits.contains { $0.contains(CGPoint(x: 60, y: 300)) } || c.captureAll }), "\(c.hits)")
  c.pointerMoved(overSidebar, buttonsDown: false)
  check("the sidebar out over the page: the page area stays, the window takes the mouse over the sidebar", c.window.pageRect == wide && wide.contains(overSidebar) && !c.window.ignoresMouseEvents)
  windows.perform(.toggleSidebar)
  // (Put away, it slides off with a transition, which a page off every display doesn't run: its box stays reported
  // where it was until a frame is drawn. What's checked is that the UI put it away.)
  check("toggled away: the sidebar hidden again", await waitJS(c.webView, "return document.querySelector('.arcadia')?.dataset.sidebar === 'hidden'"))
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

  // ---- the shell's stand-in source: a data set, read only ----
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
  check("the shell's stand-in source: no data set yet, Personal", ((made.source.snapshot()["spaces"] as? [JSONObject])?.first?["id"] as? String) == "personal")
  shell.stop {}
}
