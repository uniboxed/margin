// Margin.app's shell end to end, with no browser and nothing on screen: the
// real link (ExtensionLink.swift), mirrors, window matching, overlays with
// their web views drawing the real overlay page (dist/app: the UI runtime
// with extension/ui/host-app.js) and Arcadia, against fake-extension.mjs (a
// stand-in for the extension's copies, in Node). The "browser windows" are
// plain windows of this process at (-20000, -20000), which the window server
// list stands in for (ScriptedWindows: the browser's process is made up);
// overlays are ordered just above them, off every display. The app never
// activates, nothing is made key, no real hot key is taken (FakeKeys).
// Writes the overlay's picture to MARGIN_APP_SHOT. Then the lasting data
// (dataScenario): the first link, a relink with a queue, two profiles kept
// apart, a wiped cache refilled, the app's own change, and a crash mid-write
// followed by a relaunch, all in a temporary folder.
import AppKit
import WebKit

var failures = 0
var passed = 0
func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
  if ok { passed += 1; print("ok   \(label)") } else { failures += 1; print("FAIL \(label)" + (detail().isEmpty ? "" : ": \(detail())")) }
}
let env = ProcessInfo.processInfo.environment
let browserPid: pid_t = 77_777
let fakeBundle = "test.margin.fake-safari"

// ---- the stand-in extension -------------------------------------------------------------

final class Fake {
  let process = Process()
  let input = Pipe()
  let output = Pipe()
  var events: [JSONObject] = []
  private var buffer = Data()

  init() {
    process.executableURL = URL(fileURLWithPath: env["MARGIN_NODE"] ?? "/opt/homebrew/bin/node")
    process.arguments = [env["MARGIN_FAKE_EXTENSION"]!]
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    output.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      DispatchQueue.main.async { MainActor.assumeIsolated { Fake.current?.take(data) } }
    }
    Fake.current = self
  }
  nonisolated(unsafe) static weak var current: Fake?

  func start() throws { try process.run() }

  private func take(_ data: Data) {
    buffer.append(data)
    while let nl = buffer.firstIndex(of: 0x0a) {
      let line = buffer[buffer.startIndex..<nl]
      buffer = Data(buffer[(nl + 1)...])
      if let o = (try? JSONSerialization.jsonObject(with: line)) as? JSONObject {
        if env["MARGIN_APP_VERBOSE"] != nil { print("  fake:", String(decoding: line, as: UTF8.self).prefix(200)) }
        events.append(o)
      }
    }
  }

  func tell(_ command: JSONObject) {
    guard var data = jsonText(command) else { return }
    data.append(0x0a)
    input.fileHandleForWriting.write(data)
  }

  // The first event (from `since` on) that matches.
  func first(_ ev: String, since: Int = 0, _ test: (JSONObject) -> Bool = { _ in true }) -> JSONObject? {
    events.dropFirst(since).first { $0["ev"] as? String == ev && test($0) }
  }
  func all(_ ev: String, since: Int = 0, _ test: (JSONObject) -> Bool = { _ in true }) -> [JSONObject] {
    events.dropFirst(since).filter { $0["ev"] as? String == ev && test($0) }
  }

  func stop() { process.terminate() }
}

struct FakeDispatch: ExtensionDispatch {
  func dispatch(_ name: String, _ info: JSONObject) { Fake.current?.tell(["native": ["name": name, "info": info]]) }
}

final class ScriptedApps: AppWatch {
  var frontPid: pid_t? = 1
  var onChange: ((String) -> Void)?
  func pids(of bundleId: String) -> Set<pid_t> { bundleId == fakeBundle ? [browserPid] : [] }
  func start() {}
  func stop() {}
  func bringToFront(_ pid: pid_t?) { frontPid = pid; onChange?("app activated") }
}

// The browser's windows as the window server would list them, with the overlays (this process's) above them.
final class ScriptedWindows: WindowSource {
  var browser: [ServerWindow] = []
  weak var shell: Shell?
  var somethingBetween = false
  func windows(of pids: Set<pid_t>) -> [ServerWindow] {
    var out: [ServerWindow] = []
    var order = 0
    for w in browser.sorted(by: { $0.order < $1.order }) {
      if let overlay = shell?.overlays.values.first(where: { $0.isShown && $0.aboveWindow == w.number }) {
        out.append(ServerWindow(number: overlay.windowNumber, pid: ProcessInfo.processInfo.processIdentifier, bounds: overlay.frameTopLeft, order: order))
        order += 1
        if somethingBetween {
          out.append(ServerWindow(number: 1, pid: 4242, bounds: w.bounds.insetBy(dx: 100, dy: 100), order: order))
          order += 1
        }
      }
      out.append(ServerWindow(number: w.number, pid: w.pid, layer: w.layer, bounds: w.bounds, onScreen: w.onScreen, alpha: w.alpha, order: order))
      order += 1
    }
    return out
  }
}

final class FakeKeys: HotKeyRegistrar {
  var onHit: ((UInt32) -> Void)?
  var held: [UInt32: Combo] = [:]
  func register(_ combo: Combo, id: UInt32) -> Bool { held[id] = combo; return true }
  func unregister(id: UInt32) { held[id] = nil }
  func press(_ text: String) { if let id = held.first(where: { $0.value == Combo.parse(text) })?.key { onHit?(id) } }
}

// A plain window of this process standing in for a browser window, off every display.
func standIn(_ topLeft: CGRect) -> NSWindow {
  let w = NSWindow(contentRect: ScreenGeometry.appKitRect(topLeft), styleMask: [.borderless], backing: .buffered, defer: false)
  w.isReleasedWhenClosed = false
  w.backgroundColor = .white
  w.orderBack(nil)
  return w
}

func until(_ seconds: Double, _ test: () -> Bool) async -> Bool {
  let end = Date().addingTimeInterval(seconds)
  while Date() < end {
    if test() { return true }
    try? await Task.sleep(nanoseconds: 20_000_000)
  }
  return test()
}

func js(_ web: WKWebView, _ code: String) async -> Any? {
  try? await web.callAsyncJavaScript(code, arguments: [:], in: nil, contentWorld: .page)
}

func png(_ web: WKWebView, to path: String) async -> NSBitmapImageRep? {
  let config = WKSnapshotConfiguration()
  config.afterScreenUpdates = true
  guard let image = try? await web.takeSnapshot(configuration: config), let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
        let data = rep.representation(using: .png, properties: [:]) else { return nil }
  try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  try? data.write(to: URL(fileURLWithPath: path))
  return rep
}

// A real press (an NSEvent to the panel, which never becomes key) at a point of the web view (from its top left).
func press(_ overlay: OverlayController, at p: CGPoint) {
  let h = overlay.webView.bounds.height
  let at = NSPoint(x: p.x, y: h - p.y)
  for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
    if let e = NSEvent.mouseEvent(with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: overlay.panel.windowNumber,
                                  context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
      overlay.panel.sendEvent(e)
    }
  }
}

func rect(_ v: Any?) -> CGRect? {
  guard let a = v as? [Any], a.count == 4 else { return nil }
  let n = a.compactMap(num)
  return n.count == 4 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
}

@MainActor
func scenario() async {
  let started = Date()
  let fake = Fake()
  do { try fake.start() } catch { check("the fake extension starts", false, "\(error)"); return }
  guard await until(5, { fake.first("ready") != nil }) else { return check("the fake extension starts", false) }

  let note = Notification.Name("io.tirth.margin.test.\(ProcessInfo.processInfo.processIdentifier)")
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: note,
                        timing: .init(tick: 0.5, dead: 1.5, keep: 30, hello: 2, request: 5, safariSettled: 2))
  let windows = ScriptedWindows()
  let apps = ScriptedApps()
  let keys = FakeKeys()
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.bundleIds = ["safari": fakeBundle]
  let dataRoot = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: dataRoot) }
  options.dataRoot = dataRoot
  let shell = Shell(link: link, windows: windows, apps: apps, hotKeys: keys, options: options)
  windows.shell = shell
  shell.start()

  // Two browser windows of profile P1 (one full screen, one not) and one of P2, off every display.
  let r7 = CGRect(x: -20000, y: -20000, width: 1280, height: 800)
  let r8 = CGRect(x: -18000, y: -20000, width: 900, height: 700)
  let r9 = CGRect(x: -16000, y: -20000, width: 1024, height: 700)
  let w7 = standIn(r7), w8 = standIn(r8), w9 = standIn(r9)
  windows.browser = [ServerWindow(number: w7.windowNumber, pid: browserPid, bounds: r7, order: 0),
                     ServerWindow(number: w8.windowNumber, pid: browserPid, bounds: r8, order: 1),
                     ServerWindow(number: w9.windowNumber, pid: browserPid, bounds: r9, onScreen: true, order: 2)]
  func win(_ id: Int, _ r: CGRect, _ state: String, focused: Bool = false) -> JSONObject {
    ["windowId": id, "left": r.minX, "top": r.minY, "width": r.width, "height": r.height, "state": state, "focused": focused, "activeTabId": 13]
  }

  // ---- getting linked ----
  check("listening on 127.0.0.1", await until(3, { link.port != nil }))
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { return check("wantLink", false) }
  link.wantLink(nonce: nonce)
  check("wantLink answered into the extension: the port, version 2", await until(3, { fake.first("link") != nil }) && fake.first("link")?["port"] as? Int == Int(link.port ?? 0) && fake.first("link")?["v"] as? Int == 2)

  var mark = fake.events.count
  fake.tell(["do": "connect", "id": "bad", "token": "nope"])
  check("a socket with the wrong token: turned away", await until(3, { fake.first("close", since: mark) != nil || fake.first("error", since: mark) != nil }) && fake.first("welcome", since: mark) == nil)
  mark = fake.events.count
  fake.tell(["do": "connect", "id": "web", "origin": "https://evil.example"])
  check("a socket from a web page's origin: turned away", await until(3, { fake.first("close", since: mark) != nil || fake.first("error", since: mark) != nil }) && fake.first("welcome", since: mark) == nil)

  mark = fake.events.count
  let t0 = Date()
  fake.tell(["do": "connect", "id": "A", "profile": "P1", "chunkBytes": 16384, "windows": [win(7, r7, "fullscreen", focused: true), win(8, r8, "normal")]])
  check("welcomed with the app's key", await until(3, { fake.first("welcome", since: mark) != nil }) && fake.first("welcome", since: mark)?["ok"] as? Bool == true)
  check("linked: profile P1, its state mirrored", await until(3, { shell.links["safari:P1"]?.mirror.hasState == true }))
  check("the theme in pieces, put together", await until(3, { shell.links["safari:P1"]?.themeId == "arcadia" }) && (fake.first("sent", since: mark) { $0["what"] as? String == "theme" }?["parts"] as? Int ?? 0) > 1,
        "\(fake.first("sent", since: mark) { $0["what"] as? String == "theme" } ?? [:])")

  // ---- nothing until the browser is in front ----
  shell.track()
  check("another app in front: nothing done yet", !shell.started && shell.overlays.isEmpty)
  apps.bringToFront(browserPid)
  let k7 = WindowKey(link: "safari:P1", windowId: 7), k8 = WindowKey(link: "safari:P1", windowId: 8)
  check("the browser in front: its windows matched", await until(3, { shell.matches[k7] == w7.windowNumber && shell.matches[k8] == w8.windowNumber }), "\(shell.matches)")
  check("an overlay for the full-screen window, none for the other", await until(3, { shell.overlays[k7] != nil }) && shell.overlays[k8] == nil)
  guard let o7 = shell.overlays[k7] else { return }
  check("drawn, then shown over its window", await until(15, { o7.isReady && o7.isShown }), "ready \(o7.isReady) shown \(o7.isShown)")
  let shownAfter = Date().timeIntervalSince(t0)
  check("at its window's bounds, just above it", o7.panel.frame == ScreenGeometry.appKitRect(r7) && o7.aboveWindow == w7.windowNumber && o7.panel.collectionBehavior == OverlayController.collectionBehavior,
        "\(o7.panel.frame)")
  check("off every display", !NSScreen.screens.contains { $0.frame.intersects(o7.panel.frame) })

  // ---- layout → setLayout ----
  check("where the page goes, sent as setLayout for window 7", await until(10, { fake.first("setLayout", since: mark) != nil }))
  let layout = fake.first("setLayout", since: mark)?["msg"] as? JSONObject ?? [:]
  let insets = layout["insets"] as? JSONObject ?? [:]
  check("Arcadia docked: the page beside the 260 px sidebar, an 8 px frame", layout["windowId"] as? Int == 7 && layout["seq"] as? Int == 1 && num(insets["left"]) == 260 && num(insets["top"]) == 8
        && num(insets["right"]) == 8 && num(insets["bottom"]) == 8 && same(layout["container"], ["width": 1280, "height": 800]), "\(layout)")
  check("its corner radius", (num(layout["radius"]) ?? 0) > 0, "\(layout["radius"] ?? "none")")

  // ---- the picture ----
  let shot = env["MARGIN_APP_SHOT"] ?? "build/overlay.png"
  if let rep = await png(o7.webView, to: shot) {
    let sx = Double(rep.pixelsWide) / 1280, sy = Double(rep.pixelsHigh) / 800
    let alpha = { (x: Double, y: Double) in rep.colorAt(x: Int(x * sx), y: Int(y * sy))?.alphaComponent ?? -1 }
    check("the picture: the sidebar drawn, the page slot left empty (\(shot))", alpha(120, 400) > 0.9 && alpha(800, 400) < 0.05 && alpha(1276, 400) > 0.9,
          "sidebar \(alpha(120, 400)) slot \(alpha(800, 400)) frame \(alpha(1276, 400))")
  } else { check("a picture of the overlay", false) }
  let rows = await js(o7.webView, "return [...document.querySelectorAll('[data-tab-id]')].map((e) => e.textContent.trim().replace(/\\s+/g, ' '))") as? [String] ?? []
  check("the sidebar's rows from the fake's state", rows.contains { $0.contains("Mail") } && rows.contains { $0.contains("No icon here") }, "\(rows)")

  // ---- pass-through ----
  guard let slot = o7.slot else { return check("the slot", false) }
  check("the slot in screen points", slot.rect == CGRect(x: r7.minX + 260, y: r7.minY + 8, width: 1280 - 268, height: 800 - 16), "\(slot.rect)")
  check("nothing of Arcadia's over the page while docked", !slot.captureAll && slot.hits.allSatisfy { !$0.intersects(slot.rect.insetBy(dx: 20, dy: 20)) }, "\(slot.hits)")
  check("the page gets the pointer over the slot, Margin over the sidebar", PassThrough.pageGets(CGPoint(x: r7.minX + 700, y: r7.minY + 400), slot) && !PassThrough.pageGets(CGPoint(x: r7.minX + 100, y: r7.minY + 400), slot))

  // ---- a click → a request ----
  mark = fake.events.count
  let row = rect(await js(o7.webView, "const r = document.querySelector('[data-tab-id=\"12\"]')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null"))
  if let row {
    let t1 = Date()
    press(o7, at: CGPoint(x: row.midX, y: row.midY))
    let asked = await until(3, { fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "activateTab" } != nil })
    let req = fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "activateTab" }?["msg"] as? JSONObject ?? [:]
    check("a real press on a tab's row: activateTab for it, for window 7 (\(Int(Date().timeIntervalSince(t1) * 1000)) ms)", asked && (req["payload"] as? JSONObject)?["tabId"] as? Int == 12 && req["windowId"] as? Int == 7, "\(req)")
  } else { check("tab 12's row", false) }

  // ---- deltas, a gap, a resync ----
  mark = fake.events.count
  fake.tell(["do": "retitle", "id": "A", "tabId": 12, "title": "Inbox (3)"])
  check("a delta taken into the mirror", await until(5, { (shell.links["safari:P1"]?.mirror.seq ?? 0) >= 2 }))
  var title = ""
  for _ in 0..<100 {
    title = await js(o7.webView, "return document.querySelector('[data-tab-id=\"12\"]')?.textContent ?? ''") as? String ?? ""
    if title.contains("Inbox (3)") { break }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  check("the new title in the sidebar", title.contains("Inbox (3)"), title)
  mark = fake.events.count
  fake.tell(["do": "delta", "id": "A", "skip": true, "changes": ["archive": ["newValue": []]]])
  check("a number missed: the state asked for again", await until(3, { fake.first("resync", since: mark) != nil }))
  check("and taken again", await until(3, { shell.links["safari:P1"]?.mirror.isResyncing == false && shell.links["safari:P1"]?.mirror.hasState == true }))
  let seqBefore = shell.links["safari:P1"]?.mirror.seq ?? 0
  fake.tell(["do": "retitle", "id": "A", "tabId": 13, "title": "Docs v2"])
  check("deltas follow on from the new snapshot", await until(3, { (shell.links["safari:P1"]?.mirror.seq ?? 0) == seqBefore + 1 }))

  // ---- the window resized ----
  mark = fake.events.count
  let r7b = CGRect(x: -20000, y: -20000, width: 1200, height: 760)
  windows.browser[0] = ServerWindow(number: w7.windowNumber, pid: browserPid, bounds: r7b, order: 0)
  fake.tell(["do": "windows", "id": "A", "list": [win(7, r7b, "fullscreen", focused: true), win(8, r8, "normal")]])
  check("the window resized: the overlay follows", await until(3, { o7.panel.frame == ScreenGeometry.appKitRect(r7b) }), "\(o7.panel.frame)")
  check("and the new layout goes as setLayout number 2", await until(10, { fake.first("setLayout", since: mark) != nil })
        && (fake.first("setLayout", since: mark)?["msg"] as? JSONObject)?["seq"] as? Int == 2 && same((fake.first("setLayout", since: mark)?["msg"] as? JSONObject)?["container"], ["width": 1200, "height": 760]),
        "\(fake.first("setLayout", since: mark) ?? [:])")

  // ---- stacking ----
  let reorders = o7.reorders
  windows.somethingBetween = true
  shell.track()
  check("something between the overlay and its window: put back above it", o7.reorders == reorders + 1)
  windows.somethingBetween = false
  shell.track()
  check("in its place: left alone", o7.reorders == reorders + 1)

  // ---- themes ----
  fake.tell(["do": "theme", "id": "A", "theme": "neo-brutalism", "corrupt": true])
  try? await Task.sleep(nanoseconds: 400_000_000)
  check("a theme whose pieces don't add up: refused, Arcadia kept", shell.links["safari:P1"]?.themeId == "arcadia")
  mark = fake.events.count
  fake.tell(["do": "theme", "id": "A", "theme": "neo-brutalism"])
  check("another theme: taken", await until(5, { shell.links["safari:P1"]?.themeId == "neo-brutalism" }))
  check("and drawn: its layout sent", await until(10, { fake.first("setLayout", since: mark) != nil }))
  let neo = fake.first("setLayout", since: mark)?["msg"] as? JSONObject ?? [:]
  check("Neo-brutalism's page is somewhere else", num((neo["insets"] as? JSONObject)?["left"]) != 260, "\(neo)")
  if env["MARGIN_APP_SHOT"] != nil { _ = await png(o7.webView, to: (shot as NSString).deletingPathExtension + "-neo.png") }
  fake.tell(["do": "theme", "id": "A", "theme": "arcadia"])
  check("back to Arcadia", await until(5, { shell.links["safari:P1"]?.themeId == "arcadia" }))

  // ---- keys ----
  shell.track()
  check("the browser in front with its overlay: Margin's keys held", shortcutsHeld(shell, keys, 5))
  mark = fake.events.count
  keys.press("Ctrl+Meta+ArrowDown")
  check("⌃⌘↓: navigate next-tab for window 7", await until(3, { fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "navigate" } != nil })
        && ((fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "navigate" }?["msg"] as? JSONObject)?["payload"] as? JSONObject)?["action"] as? String == "next-tab")
  apps.bringToFront(1)
  check("another app in front: let go", await until(2, { keys.held.isEmpty && !shell.shortcuts.isActive }))
  apps.bringToFront(browserPid)
  check("back: held again", await until(2, { keys.held.count == 5 }))

  // ---- the palette and typing ----
  keys.press("Meta+KeyT")
  check("⌘T: the palette opens in the front window's overlay", await until(5, { o7.hasKeyboard }))
  let field = await js(o7.webView, "return document.activeElement?.localName ?? ''") as? String
  check("its field has the focus (the overlay would be the key panel; the browser stays in front)", field == "input", field ?? "")
  shell.pressed(CGPoint(x: r7.minX + 700, y: r7.minY + 400)) // on the page
  check("a press on the page: the keyboard goes back to the browser", await until(3, { !o7.hasKeyboard }) && o7.handedBack == 1)
  check("and the palette closes", (await waitJS(o7.webView, "return !document.querySelector('.palette-layer')")))

  // ---- a second profile, a copy not in charge, a newer link ----
  mark = fake.events.count
  fake.tell(["do": "connect", "id": "B", "profile": "P2", "windows": [win(9, r9, "fullscreen")]])
  let k9 = WindowKey(link: "safari:P2", windowId: 9)
  check("a second profile's link, its window's overlay", await until(15, { shell.links.count == 2 && shell.overlays[k9]?.isShown == true }))
  mark = fake.events.count
  fake.tell(["do": "connect", "id": "C", "profile": "P1", "owner": false])
  check("a copy not in charge: closed, the profile's link kept", await until(3, { fake.first("close", since: mark) { $0["id"] as? String == "C" } != nil })
        && fake.first("close", since: mark) { $0["id"] as? String == "C" }?["code"] as? Int == 1008 && shell.links["safari:P1"]?.connection.hello.instanceId == "fake-A")
  mark = fake.events.count
  fake.tell(["do": "connect", "id": "A2", "profile": "P1", "windows": [win(7, r7b, "fullscreen", focused: true)]])
  check("a newer link for the same profile takes over", await until(3, { fake.first("close", since: mark) { $0["id"] as? String == "A" } != nil && shell.links["safari:P1"]?.connection.hello.instanceId == "fake-A2" }))
  check("and its window's overlay comes back", await until(15, { shell.overlays[k7]?.isShown == true && shell.overlays[k7] !== o7 }))

  // ---- a silent copy ----
  mark = fake.events.count
  fake.tell(["do": "mute", "id": "B", "on": true])
  check("a copy that stops answering: closed after the limit", await until(4, { shell.links["safari:P2"] == nil }) && shell.overlays[k9] == nil)

  // ---- quitting ----
  mark = fake.events.count
  var stopped = false
  shell.stop { stopped = true }
  check("quitting: goodbye to the copies", await until(3, { stopped && fake.first("bye", since: mark) != nil }))
  check("nothing the app sent was over 1 MB", fake.first("tooBig") == nil)
  for w in [w7, w8, w9] { w.close() }
  fake.stop()
  print(String(format: "  timings: linked to overlay shown %.0f ms; whole run %.1f s", shownAfter * 1000, Date().timeIntervalSince(started)))
}

func shortcutsHeld(_ shell: Shell, _ keys: FakeKeys, _ n: Int) -> Bool { shell.shortcuts.isActive && keys.held.count == n }

func waitJS(_ web: WKWebView, _ code: String) async -> Bool {
  for _ in 0..<60 {
    if await js(web, code) as? Bool == true { return true }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  return false
}

func same(_ a: Any?, _ b: Any?) -> Bool {
  guard let a, let b else { return a == nil && b == nil }
  return NSDictionary(dictionary: ["v": a]).isEqual(to: ["v": b])
}

final class Runner: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    if env["MARGIN_APP_VERBOSE"] != nil { Diagnostics.echo = { print("  app:", $0) } }
    Task { @MainActor in
      await scenario()
      await dataScenario()
      print(failures == 0 ? "all \(passed) end-to-end checks passed" : "\(failures) of \(passed + failures) end-to-end checks failed")
      exit(failures == 0 ? 0 : 1)
    }
  }
}

@main enum E2E {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let runner = Runner()
    app.delegate = runner
    Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { _ in print("FAIL timed out"); exit(1) }
    withExtendedLifetime(runner) { app.run() }
  }
}
