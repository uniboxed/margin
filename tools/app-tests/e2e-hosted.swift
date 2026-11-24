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
import MarginCore
import WebKit

// Entries stored as given at `at` (ms), no rule run (the core's `apply` call; a test's only: library-tests.swift has the
// unit checks' copy).
extension Library {
  func store(_ entries: [Any], at: Double) {
    let request = KeysCore.json(["type": "apply", "entries": entries, "at": at] as JSONObject)
    _ = KeysCore.bytes(request) { p, n in KeysCore.answer { margin_library_call(corePointer, p, n, $0) } }
  }
}

final class FakeWindowSource: MarginWindowSource {
  var state: JSONObject
  var onChange: (() -> Void)?
  var asked: [(type: String, payload: JSONObject)] = []
  init(_ state: JSONObject) { self.state = state }
  func stateText() -> String { jsonString(state) ?? "null" }
  func spaceTheme(window: Int) -> String? { nil }
  func spaceAppearance(window: Int) -> SpaceAppearance? { nil }
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
  // (What Margin's window draws of them: the library's snapshot of them as stored, the profile's settings over it.)
  let stored = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-hosted-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: stored) }
  let library = Library.open(dataRoot: stored, background: false)
  var entries: [Any] = []
  for (c, list) in values where c != "settings" { for (id, v) in list { entries.append(["collection": c, "id": id, "value": v] as JSONObject) } }
  library.store(entries, at: 1)
  var drawn = library.snapshot()
  drawn["settings"] = (values["settings"] ?? [:]).merging(["themes": JSONObject()]) { a, _ in a }
  drawn["favicons"] = JSONObject()
  let source = FakeWindowSource(drawn)
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
  check("Margin's UI in a borderless, non-activating panel over it, its child at its level, never key or main by itself, kept on deactivation",
        c.panel.styleMask.contains(.nonactivatingPanel) && c.panel.styleMask.contains(.borderless) && c.panel.parent === c.window && c.panel.level == c.window.level
          && c.panel.frame == c.window.frame && !c.panel.canBecomeKey && !c.panel.canBecomeMain && !c.panel.hidesOnDeactivate && c.webView.window === c.panel
          && c.window.contentView?.subviews.isEmpty == true && c.window.backgroundColor == .clear,
        "style \(c.panel.styleMask.rawValue) child \(c.panel.parent === c.window) level \(c.panel.level.rawValue)/\(c.window.level.rawValue) frame \(c.panel.frame) \(c.window.frame)")
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
  check("its panel's background is opaque (no edge of it see-through)",
        (c.panel.backgroundColor.usingColorSpace(.sRGB)?.alphaComponent ?? 0) == 1 && !c.window.isOpaque)
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
  check("over the page area: the window takes the mouse (nothing is behind it)", !c.panel.ignoresMouseEvents && c.slot == nil)
  c.pointerMoved(CGPoint(x: content.minX + 60, y: page.midY), buttonsDown: false)
  check("over the sidebar: the window takes it", !c.panel.ignoresMouseEvents)
  if let controls = c.controls {
    c.pointerMoved(CGPoint(x: content.minX + controls.midX, y: content.minY + controls.midY), buttonsDown: false)
    let through = c.panel.ignoresMouseEvents && !c.window.ignoresMouseEvents
    c.pointerMoved(CGPoint(x: content.minX + 60, y: page.midY), buttonsDown: false)
    check("windowed, over the theme's window controls: the panel lets the pointer through to the window's own buttons (the base takes it there), and takes it again off them",
          through && !c.panel.ignoresMouseEvents, "\(controls)")
  }

  // ---- the menu: New Tab opens the palette ----
  guard let newTab = MarginMenu.item(.newTab, in: windows.menu), let action = newTab.action, let target = newTab.target as? MarginMenuTarget else { return check("New Tab in the menu", false) }
  _ = target.perform(action, with: newTab)
  check("File › New Tab: the palette opens in the window", await waitJS(c.webView, "return marginApp.appWindow().palette === true"))
  let palette = rect(await js(c.webView, "const r = document.querySelector('[m-input=\"palette\"]')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null"))
  if let palette, await until(3, { c.hits.contains { $0.contains(CGPoint(x: palette.midX, y: palette.midY)) } || c.captureAll }) {
    let over = CGPoint(x: content.minX + palette.midX, y: content.minY + palette.midY)
    c.pointerMoved(over, buttonsDown: false)
    check("over the palette drawn over the page area: the window takes the mouse", !page.contains(over) || !c.panel.ignoresMouseEvents, "\(palette) \(c.hits)")
  } else { check("the palette's box reported over the page", false, "\(String(describing: palette)) \(c.hits)") }
  _ = target.perform(action, with: newTab)
  check("New Tab again: the palette closes", await waitJS(c.webView, "return marginApp.appWindow().palette === false"))

  // ---- a press on a pin: the source's request, for this window ----
  if let pin = rect(await js(c.webView, "const r = document.querySelector('[data-pin-id=\"p1\"]')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null")) {
    let activationsBefore = c.activations.count
    press(c.panel, at: CGPoint(x: pin.midX, y: pin.midY))
    check("a press in Margin's UI with nothing hosted (its launcher): Margin made the active app once it's over, as a press in its window always made it (a test's never really is)",
          c.activations.count == activationsBefore + 1 && c.activations.last == "a press in its launcher, nothing hosted" && c.keysGivenBack == 0, "\(c.activations)")
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

  // ---- always full screen, opened while macOS wouldn't take the toggle (Margin not active; its window not on the
  // current Space yet: opened from another app's full-screen Space, 2026-11-17): asked only once it would, and until it's in ----
  do {
    var ready = false, macOSEnters = true // (whether macOS would take the toggle now; its answer when asked)
    // (Its own source: a source tells one set of windows of its changes.)
    let always = MarginWindows(pages: pages, source: FakeWindowSource(source.state), options: .init(harness: true, alwaysFullScreen: true))
    defer { always.closeAll() }
    var o = MarginWindowController.Options()
    o.harnessEnters = { macOSEnters }
    o.harnessReady = { ready }
    let w = always.open(o)
    check("always full screen, its window not on the current Space yet: nothing asked (macOS would refuse it), waiting", w.fullScreenAsks == 0 && !w.isFullScreen && w.fullScreenWaits >= 1, "\(w.fullScreenAsks) \(w.fullScreenWaits)")
    w.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification, object: w.window))
    w.windowDidBecomeMain(Notification(name: NSWindow.didBecomeMainNotification, object: w.window))
    NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
    check("its window key and main, Margin active, still not on the current Space: still nothing asked; Margin brought forward once for it, not at every event",
          w.fullScreenAsks == 0 && !w.isFullScreen && w.fullScreenForwards == 1 && w.forwardWays == [.both], "\(w.fullScreenAsks) \(w.fullScreenForwards)")
    ready = true
    NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
    let spaceIn = await until(1, { w.isFullScreen })
    check("the Space changes and its window is on the current one: asked at once, in full screen", spaceIn && w.fullScreenAsks == 1, "\(w.fullScreenAsks)")
    NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
    w.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification, object: w.window))
    _ = await until(0.8, { false })
    check("in full screen: no event and no look asks again", w.fullScreenAsks == 1 && w.isFullScreen)

    // No event at all tells it: its own look finds out.
    ready = false
    let quiet = always.open(o)
    let asksAtOpen = quiet.fullScreenAsks
    ready = true
    let lookedIn = await until(3, { quiet.isFullScreen })
    check("no event as its window comes onto the current Space: its own look (0.3 s, then doubling) asks, in full screen", asksAtOpen == 0 && lookedIn && quiet.fullScreenAsks == 1,
          "\(asksAtOpen) \(quiet.fullScreenAsks)")

    // macOS refuses it though everything looks right: asked again with the back-off, not in a loop, until it's in.
    macOSEnters = false
    let stubborn = always.open(o)
    _ = await until(1.6, { false })
    let refused = stubborn.fullScreenAsks
    check("macOS refuses the toggle: asked again and again with a back-off (after 1.6 s: the first ask and the looks at 0.3 and 0.9 s, not a loop), still not in", !stubborn.isFullScreen && (2...4).contains(refused), "\(refused)")
    macOSEnters = true
    let tookIt = await until(4, { stubborn.isFullScreen })
    check("… and in as soon as macOS takes it (never given up while its window is open)", tookIt, "\(stubborn.fullScreenAsks)")
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

  // ---- a theme with the system's materials (Liquid Glass): the page asks before it makes the theme's sheet, the web
  // view's system appearance goes on, and the sheet keeps `-apple-visual-effect`; a theme that doesn't ask turns it
  // off again and the same sheet draws its plain look (OverlayWebView.swift OverlaySystemAppearance) ----
  let glassDir = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!).deletingLastPathComponent().appendingPathComponent("webkit/themes/liquid-glass")
  if let manifest = try? String(contentsOf: glassDir.appendingPathComponent("theme.json"), encoding: .utf8),
     let html = try? String(contentsOf: glassDir.appendingPathComponent("theme.html"), encoding: .utf8),
     let css = try? String(contentsOf: glassDir.appendingPathComponent("theme.css"), encoding: .utf8) {
    func draw(_ id: String, _ manifest: String) async {
      let message: JSONObject = ["type": "theme", "theme": ["id": id, "manifest": manifest, "html": html, "css": css, "files": [String: String]()] as JSONObject]
      _ = try? await c.webView.callAsyncJavaScript("marginApp.receive(m)", arguments: ["m": jsonString(message) ?? ""], in: nil, contentWorld: .page)
    }
    let system = { c.webView.value(forKey: "_useSystemAppearance") as? Bool }
    // [the page knows the property, the panel's material, whether it still has a shadow of its own, the theme's id]
    let look = """
      const p = document.querySelector('.lg .panel'); if (!p) return null;
      const cs = getComputedStyle(p);
      return [CSS.supports('-apple-visual-effect', '-apple-system-glass-material'), cs.getPropertyValue('-apple-visual-effect'), cs.boxShadow !== 'none'];
      """
    check("no theme has asked yet: the web view's system appearance off (Arcadia draws as it always has)", system() == false)
    await draw("liquid-glass", manifest)
    check("Liquid Glass drawn in Margin's window", await waitJS(c.webView, "return !!document.querySelector('.lg .panel')"))
    if ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26 {
      check("a theme that asks for the system's materials: its web view's system appearance on", system() == true)
      let glass = await js(c.webView, look) as? [Any] ?? []
      check("… before its sheet was made: the panel is the system's glass, with no shadow of its own",
            glass.count == 3 && glass[0] as? Bool == true && glass[1] as? String == "-apple-system-glass-material" && glass[2] as? Bool == false, "\(glass)")
    }
    // The same theme without the word in its manifest (another id): off, and its plain look.
    let plain = manifest.replacingOccurrences(of: "\"systemMaterials\": true,", with: "").replacingOccurrences(of: "\"id\": \"liquid-glass\"", with: "\"id\": \"plain-glass\"")
    await draw("plain-glass", plain)
    let off = await until(5, { system() == false })
    check("a theme that doesn't ask: off again", plain != manifest && off)
    check("… and the same sheet draws its plain look: no material, the panel's own hairline and shadow",
          await waitJS(c.webView, "const p = document.querySelector('.lg .panel'); if (!p) return false; const cs = getComputedStyle(p); return !CSS.supports('-apple-visual-effect', 'none') && cs.getPropertyValue('-apple-visual-effect') === '' && cs.boxShadow !== 'none';"))
    check("nothing warned drawing either", warned.isEmpty, "\(warned.prefix(5))")

    // ---- another theme, no animation (2026-11-20): at once when the hosted window covers its page area already; a bigger
    // page area (Arcadia's after Neubrutalism's): the theme before held until the hosted window has taken it, at most 300 ms ----
    let themes = glassDir.deletingLastPathComponent()
    func pkg(_ id: String) -> JSONObject? {
      let d = themes.appendingPathComponent(id)
      guard let m = try? String(contentsOf: d.appendingPathComponent("theme.json"), encoding: .utf8), let h = try? String(contentsOf: d.appendingPathComponent("theme.html"), encoding: .utf8),
            let cs = try? String(contentsOf: d.appendingPathComponent("theme.css"), encoding: .utf8) else { return nil }
      return ["id": id, "manifest": m, "html": h, "css": cs, "files": [String: String]()]
    }
    func send(_ m: JSONObject) async { _ = try? await c.webView.callAsyncJavaScript("marginApp.receive(m)", arguments: ["m": jsonString(m) ?? ""], in: nil, contentWorld: .page) }
    func slot() async -> [Int] { (await js(c.webView, "const r = document.querySelector('m-page')?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height].map(Math.round) : null") as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.intValue } }
    func swaps() async -> [[String: Any]] { (await js(c.webView, "return marginApp.stats().themeSwaps") as? [[String: Any]]) ?? [] }
    if let arcadia = pkg("arcadia"), let neo = pkg("neubrutalism") {
      await send(["type": "theme", "theme": arcadia])
      _ = await waitJS(c.webView, "return !!document.querySelector('.arcadia')")
      let big = await slot()
      await send(["type": "hostedFrame", "rect": big])
      await send(["type": "theme", "theme": neo])
      let drewNeo = await waitJS(c.webView, "return !!document.querySelector('.nb') && !document.querySelector('.arcadia')")
      let small = await slot()
      let first = (await swaps()).last
      check("another theme with a smaller page area, the hosted window covering it: drawn at once (no wait)", drewNeo && small.count == 4 && big.count == 4 && small[2] < big[2]
            && first?["id"] as? String == "neubrutalism" && (first?["waitedMs"] as? NSNumber)?.intValue == 0 && first?["covered"] as? Bool == true, "\(String(describing: first)) \(big) \(small)")
      // The window at Neubrutalism's page area; Arcadia's is bigger: held until the window says it's there.
      await send(["type": "hostedFrame", "rect": small])
      let n = (await swaps()).count
      await send(["type": "theme", "theme": arcadia])
      try? await Task.sleep(nanoseconds: 120_000_000)
      await send(["type": "hostedFrame", "rect": big])
      _ = await waitJS(c.webView, "return marginApp.stats().themeSwaps.length > \(n)")
      let held = (await swaps()).last
      let heldDrawn = await waitJS(c.webView, "return !!document.querySelector('.arcadia') && !document.querySelector('.nb')")
      let waited = (held?["waitedMs"] as? NSNumber)?.intValue ?? -1
      check("a bigger page area: the theme before held until the hosted window took it (~120 ms here), then drawn in one go", held?["id"] as? String == "arcadia" && held?["covered"] as? Bool == true && waited >= 90 && waited < 290
            && heldDrawn, "\(String(describing: held))")
      // The window never coming: drawn anyway after 300 ms, never stuck.
      await send(["type": "theme", "theme": neo])
      _ = await waitJS(c.webView, "return !!document.querySelector('.nb')")
      await send(["type": "hostedFrame", "rect": small])
      let m = (await swaps()).count
      await send(["type": "theme", "theme": arcadia])
      _ = await waitJS(c.webView, "return marginApp.stats().themeSwaps.length > \(m)")
      let late = (await swaps()).last
      let lateDrawn = await waitJS(c.webView, "return !!document.querySelector('.arcadia')")
      let lateMs = (late?["waitedMs"] as? NSNumber)?.intValue ?? -1
      check("the hosted window not at the bigger page area in 300 ms: the new theme drawn anyway, never stuck", late?["covered"] as? Bool == false && lateMs >= 290 && lateMs < 600
            && lateDrawn, "\(String(describing: late))")
      await send(["type": "hostedFrame", "rect": NSNull()])
    } else {
      check("Arcadia's and Neubrutalism's packages beside the app's page (dist/webkit/themes)", false, themes.path)
    }
  } else {
    check("Liquid Glass's package beside the app's page (dist/webkit/themes/liquid-glass)", false, glassDir.path)
  }

  // ---- the shell's source: the library (the stand-in only when its rules don't load) ----
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-hosted-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  var options = Shell.Options()
  options.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root
  // (Margin's quit and whether it asks first, kept here: never the app's defaults.)
  final class Quit { var asks = true; var asked = 0 }
  let quit = Quit()
  options.asksBeforeQuit = { quit.asks }
  options.setAskBeforeQuit = { quit.asks = $0 }
  options.quit = { quit.asked += 1 }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.hosted.\(ProcessInfo.processInfo.processIdentifier)"))
  let frontApps = ScriptedApps(), hotKeys = FakeKeys()
  let shell = Shell(link: link, apps: frontApps, hotKeys: hotKeys, options: options)
  let made = shell.makeMarginWindows()
  check("the shell's windows: made once, in a test never on a display", made === shell.makeMarginWindows() && made.options.harness)
  check("the shell's windows draw the library: nothing imported, a first space, Personal", made.source is LibraryWindowSource
        && ((((try? JSONSerialization.jsonObject(with: Data(made.source.stateText().utf8))) as? JSONObject)?["spaces"] as? [JSONObject])?.first?["name"] as? String) == "Personal")

  // ---- ⌘Q with Margin itself in front (nothing hosted): its prompt; Always quit quits and stops asking ----
  let command = Combo.parse("Meta+KeyQ")!
  shell.track()
  check("quit: no Margin window open: ⌘Q isn't held", !shell.shortcuts.guardsQuit && !hotKeys.held.values.contains(command))
  let own = made.open()
  frontApps.bringToFront(1) // (another app in front)
  shell.track()
  check("quit: another app in front: ⌘Q is that app's", !shell.shortcuts.guardsQuit && !hotKeys.held.values.contains(command))
  frontApps.bringToFront(ProcessInfo.processInfo.processIdentifier)
  shell.track()
  check("quit: Margin in front with a window: ⌘Q is Margin's first", shell.shortcuts.guardsQuit && hotKeys.held.values.contains(command))
  hotKeys.press("Meta+KeyQ")
  check("quit: ⌘Q with Margin in front: its prompt, nothing asked of the app yet; nothing hosted, said so", shell.quitPrompt?.isUp == true && quit.asked == 0
        && shell.quitPrompt?.view?.note.stringValue == "Nothing Margin opened is running.", shell.quitPrompt?.view?.note.stringValue ?? "none")
  check("quit: the prompt is never ordered in or given the keys in a test", shell.quitPrompt?.isVisible == false && shell.quitPrompt?.isKeyWindow == false)
  shell.quitPrompt?.view?.buttons.first { $0.title == "Always quit" }?.press()
  check("quit: Always quit: Margin's quit asked once, and it stops asking (its stored setting off)", quit.asked == 1 && !quit.asks && shell.quitPrompt == nil && shell.quitsAsked == 1)
  shell.track()
  check("quit: … ⌘Q let go for the quit", !shell.shortcuts.guardsQuit && !hotKeys.held.values.contains(command))
  own.close()
  shell.stop {}
  // The next launch, asking off: ⌘Q is never held, with Margin in front too (its menu's Quit, as any app's).
  do {
    var again = options
    again.dataRoot = root.appendingPathComponent("again")
    let apps2 = ScriptedApps(), keys2 = FakeKeys()
    let shell2 = Shell(link: SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.hosted2.\(ProcessInfo.processInfo.processIdentifier)")), apps: apps2, hotKeys: keys2, options: again)
    let windows2 = shell2.makeMarginWindows()
    let w2 = windows2.open()
    apps2.bringToFront(ProcessInfo.processInfo.processIdentifier)
    shell2.track()
    check("quit: asking off (after Always quit): ⌘Q isn't Margin's hot key even with Margin in front, its other keys held as before",
          !shell2.shortcuts.guardsQuit && !keys2.held.values.contains(command) && shell2.shortcuts.isActive && keys2.held.values.contains(Combo.parse("Meta+KeyT")!))
    quit.asks = true
    shell2.track()
    check("quit: asking on again (the stored setting): held again at the next read", shell2.shortcuts.guardsQuit && keys2.held.values.contains(command))
    w2.close()
    shell2.stop {}
  }
}
