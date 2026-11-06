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
// `check` for scenarios that wrap it in a local one of the same name.
func e2eCheck(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { check(label, ok, detail()) }
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
  var onRelease: ((UInt32) -> Void)?
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
  options.reconnectGrace = 1.5
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

  // ---- what the copy says about the window's pages (Margin 2 Phase 2 step 7) ----
  // A notice: the copy pushes only its kind; the overlay draws Margin's words in Arcadia's notice part.
  func pushTo7(_ msg: JSONObject) { fake.tell(["do": "send", "id": "A", "msg": ["k": "push", "windowId": 7, "msg": msg]]) }
  pushTo7(["type": "notice", "kind": "not-responding", "tabId": 13])
  check("a notice pushed for window 7: Margin's words in the theme's notice part, with its buttons",
        await waitJS(o7.webView, "const n = document.querySelector('.notice'); return !!n && n.querySelector('.text')?.textContent.includes('isn’t responding on this page') && [...n.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|') === 'Reload|Not now'"))
  mark = fake.events.count
  if let button = rect(await js(o7.webView, "const b = [...document.querySelectorAll('.notice button')].find((x) => x.textContent.trim() === 'Reload')?.getBoundingClientRect(); return b ? [b.x, b.y, b.width, b.height] : null")) {
    press(o7, at: CGPoint(x: button.midX, y: button.midY))
    let asked = await until(3, { fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "noticeAction" } != nil })
    let req = fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "noticeAction" }?["msg"] as? JSONObject ?? [:]
    let payload = req["payload"] as? JSONObject ?? [:]
    check("its Reload pressed: noticeAction for tab 13, for window 7", asked && payload["notice"] as? String == "not-responding" && payload["action"] as? String == "reload" && payload["tabId"] as? Int == 13 && req["windowId"] as? Int == 7, "\(req)")
    check("and the notice goes", await waitJS(o7.webView, "return !document.querySelector('.notice')"))
  } else { check("the notice's Reload button", false) }
  pushTo7(["type": "notice", "kind": "say what I tell you", "tabId": 13])
  pushTo7(["type": "switch-failed", "tabId": 12, "reason": "That tab is no longer open"])
  check("a switch the copy made that didn't happen: why, in Margin's words (an unknown kind: nothing)", await waitJS(o7.webView, "return document.querySelector('.notice .text')?.textContent === 'That tab is no longer open.'"))
  // Loading: the tab in front (13) and a row (12).
  pushTo7(["type": "loading", "tabIds": [12, 13]])
  check("tabs loading: tab 12's row and Arcadia's pill for the tab in front, no hover", await waitJS(o7.webView, "return document.querySelector('[data-tab-id=\"12\"]')?.classList.contains('busy') && document.querySelector('.arcadia')?.classList.contains('loading') && getComputedStyle(document.querySelector('.loader')).visibility === 'visible'"))
  pushTo7(["type": "loading", "tabIds": []])
  check("and done", await waitJS(o7.webView, "return !document.querySelector('.busy') && !document.querySelector('.arcadia.loading')"))
  // A gesture in the page in front: the badge over the page, never taking the pointer.
  pushTo7(["type": "gesture", "tabId": 13, "kind": "pull", "state": "armed", "progress": 1, "direction": 0])
  check("a pull in the page: Arcadia's badge over the page, armed", await waitJS(o7.webView, "const g = document.querySelector('.gesture.pull'); return !!g && g.classList.contains('armed') && getComputedStyle(g).pointerEvents === 'none'"))
  pushTo7(["type": "gesture", "tabId": 13, "kind": "pull", "state": "idle", "progress": 0, "direction": 0])
  check("let go without reloading: gone", await waitJS(o7.webView, "return !document.querySelector('.gesture')"))

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

  // ---- the left edge, and the pointer peek needs (Phase 2 step 8) ----
  let guardFrame = CGRect(x: o7.frameTopLeft.minX, y: o7.frameTopLeft.minY, width: EdgeGuard.width, height: o7.frameTopLeft.height)
  check("docked: the edge guarded too (a fast move from the page reaches the edge in one step), and no pointer positions wanted", await until(5, { o7.edgeFrame == guardFrame && o7.pointerWant.mode == .none }), "\(String(describing: o7.edgeFrame)) \(o7.pointerWant)")
  let stateNow = shell.links["safari:P1"]?.mirror.stateJSON().flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject } ?? [:]
  let settings = (stateNow["settings"] as? JSONObject) ?? [:]
  func keepOpen(_ on: Bool) { var s = settings; s["sidebarPinnedOpen"] = on; fake.tell(["do": "delta", "id": "A", "changes": ["settings": ["newValue": s]]]) }
  keepOpen(false)
  check("the guard: the window's left edge, its height, above the overlay, never ignoring the mouse", o7.edgePanel?.frame == ScreenGeometry.appKitRect(guardFrame) && o7.edgePanel?.isVisible == true
        && o7.edgePanel?.ignoresMouseEvents == false && o7.edgePanel?.collectionBehavior == o7.panel.collectionBehavior,
        "\(String(describing: o7.edgePanel?.frame))")
  check("hidden: the edges' positions wanted (peek's reveal zone)", await until(5, { o7.pointerWant.mode == .edges }) && o7.pointerWant.mode == .edges && o7.pointerWant.edges.contains("left") && o7.pointerWant.wants(CGPoint(x: 2, y: 300), in: o7.frameTopLeft.size) && !o7.pointerWant.wants(CGPoint(x: 600, y: 300), in: o7.frameTopLeft.size), "\(o7.pointerWant)")
  // The pointer at the guard: its position reaches the page's peek (the guard is inside the overlay's frame).
  let pushesBefore = shell.pointerPushes
  shell.pointerMovedForTests(CGPoint(x: r7.minX + 600, y: r7.minY + 300))
  check("over the page with the sidebar hidden: nothing handed to the page", shell.pointerPushes == pushesBefore)
  shell.pointerMovedForTests(CGPoint(x: r7.minX + 1, y: r7.minY + 300))
  let peeked = await waitJS(o7.webView, "return !!document.querySelector('[data-sidebar=\"peek\"]')")
  check("at the left edge (over the guard): handed in, and peek brings the sidebar out", shell.pointerPushes == pushesBefore + 1 && peeked, "pushes \(shell.pointerPushes - pushesBefore)")
  check("out: every position wanted (to put it away again)", await until(3, { o7.pointerWant.mode == .all }), "\(o7.pointerWant)")
  try? await Task.sleep(nanoseconds: 60_000_000)
  shell.pointerMovedForTests(CGPoint(x: r7.minX + 700, y: r7.minY + 400))
  let away = await waitJS(o7.webView, "return document.querySelector('[data-sidebar]')?.getAttribute('data-sidebar') === 'hidden'")
  check("the pointer back over the page: handed in, and the sidebar goes again", away && o7.pointerWant.mode == .edges, "\(o7.pointerWant)")
  o7.hide("a test")
  check("the guard goes with its overlay", o7.edgeFrame == nil && o7.edgePanel?.isVisible == false)
  shell.track()
  check("and comes back with it", await until(3, { o7.isShown && o7.edgeFrame != nil }))
  keepOpen(true)
  check("docked again: no positions wanted", await until(5, { o7.pointerWant.mode == .none }))

  // ---- the active Space changing (Phase 2 step 8: the overlay was seen over the desktop) ----
  let w7Server = windows.browser[0]
  windows.browser[0] = ServerWindow(number: w7Server.number, pid: w7Server.pid, bounds: w7Server.bounds, onScreen: false, order: 0)
  apps.onChange?("Space changed")
  check("a Space change with its window gone from the screen: put away at once, in the same turn", !o7.isShown && shell.spaceChanged)
  windows.browser[0] = w7Server
  check("shown again once the window server says its window is on screen", await until(3, { o7.isShown }))

  // ---- the Web Inspector docked at the bottom of the window (Phase 2 step 8) ----
  let rw = w7Server.bounds
  var docked7 = win(7, rw, "fullscreen", focused: true)
  docked7["activeTabId"] = 12
  docked7["viewport"] = ["x": 0, "y": 0, "width": rw.width, "height": rw.height - 300]
  mark = fake.events.count
  fake.tell(["do": "windows", "id": "A", "list": [docked7, win(8, r8, "normal")]])
  check("the inspector docked at the bottom: the overlay over the part above it only", await until(3, { o7.frameTopLeft == CGRect(x: rw.minX, y: rw.minY, width: rw.width, height: rw.height - 300) }), "\(o7.frameTopLeft)")
  check("the theme laid out there, setLayout's insets still from the window's edges (the inspector's 300 pt in the bottom)",
        await until(10, { (fake.all("setLayout", since: mark).last.flatMap { ($0["msg"] as? JSONObject)?["insets"] as? JSONObject }).map { num($0["bottom"]).map { $0 >= 300 } ?? false } ?? false }),
        "\(fake.all("setLayout", since: mark).last ?? [:])")
  check("nothing of Margin's over the inspector: the pointer is Safari's there", !o7.frameTopLeft.contains(CGPoint(x: rw.minX + 600, y: rw.maxY - 100)))
  mark = fake.events.count
  fake.tell(["do": "windows", "id": "A", "list": [win(7, rw, "fullscreen", focused: true), win(8, r8, "normal")]])
  let wholeAgain = await until(3, { o7.frameTopLeft == rw })
  let insetsAgain = await until(10, { (fake.all("setLayout", since: mark).last.flatMap { ($0["msg"] as? JSONObject)?["insets"] as? JSONObject }).map { num($0["bottom"]).map { $0 < 50 } ?? false } ?? false })
  check("closed: the whole window again, and its layout", wholeAgain && insetsAgain)

  // ---- keys ----
  shell.track()
  check("the browser in front with its overlay: Margin's keys held", shortcutsHeld(shell, keys, 6))
  mark = fake.events.count
  keys.press("Ctrl+Meta+ArrowDown")
  check("⌃⌘↓: navigate next-tab for window 7", await until(3, { fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "navigate" } != nil })
        && ((fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "navigate" }?["msg"] as? JSONObject)?["payload"] as? JSONObject)?["action"] as? String == "next-tab")
  apps.bringToFront(1)
  check("another app in front: let go", await until(2, { keys.held.isEmpty && !shell.shortcuts.isActive }))
  apps.bringToFront(browserPid)
  check("back: held again", await until(2, { keys.held.count == 6 }))
  // The copy's Settings shortcuts (its `keys`): held instead of the defaults, at once.
  fake.tell(["do": "send", "id": "A", "msg": ["k": "keys", "bindings": ["next-tab": ["Alt+Meta+ArrowDown", "Ctrl+Meta+ArrowDown"], "toggle-sidebar": ["Alt+KeyK"]]]])
  check("the copy's keys: held as it says", await until(3, { Set(keys.held.values).contains(Combo.parse("Alt+Meta+ArrowDown")!) && Set(keys.held.values).contains(Combo.parse("Alt+KeyK")!) && !Set(keys.held.values).contains(Combo.parse("Alt+KeyS")!) }))
  mark = fake.events.count
  keys.press("Alt+KeyK")
  // Keep open is on in the fake's state: the overlay's sidebar.toggle turns it off (a request to the copy).
  check("its sidebar key: the overlay's sidebar toggled (Keep open off, asked of the copy)", await until(3, { fake.first("req", since: mark) { (($0["msg"] as? JSONObject)?["type"] as? String) == "updateSettings" } != nil }))

  // ---- the palette and typing ----
  let keyAt = Date()
  keys.press("Meta+KeyT")
  check("⌘T: the palette opens in the front window's overlay", await until(5, { o7.hasKeyboard }))
  let keyboardMs = Date().timeIntervalSince(keyAt) * 1000
  check("its web view is the panel's first responder (what's typed reaches the field)", o7.panel.firstResponder === o7.webView, "\(String(describing: o7.panel.firstResponder))")
  _ = await waitJS(o7.webView, "return marginApp.stats().palette.length > 0")
  let opened = (await js(o7.webView, "return JSON.stringify(marginApp.stats().palette.at(-1))") as? String) ?? "{}"
  let openWork = (try? JSONSerialization.jsonObject(with: Data(opened.utf8)) as? JSONObject)?["workMs"] as? Double ?? 999
  check("the palette's opening is quick: \(openWork) ms of work in its page, the keyboard \(Int(keyboardMs)) ms after the key", openWork < 50 && keyboardMs < 500)
  // Typing: each key re-ranks the rows and draws them (an input event, then the work it starts).
  let typing = await js(o7.webView, """
    const f = document.activeElement; const word = 'docs inbox'; let worst = 0; let sum = 0;
    for (let i = 1; i <= word.length; i++) { const t = performance.now(); f.value = word.slice(0, i); f.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.palette-layer')?.getBoundingClientRect(); const ms = performance.now() - t; worst = Math.max(worst, ms); sum += ms; }
    return JSON.stringify({ worst, mean: sum / word.length, rows: document.querySelectorAll('[m-action="palette.run"]').length });
    """) as? String ?? "{}"
  let typed = (try? JSONSerialization.jsonObject(with: Data(typing.utf8)) as? JSONObject) ?? [:]
  check("typing in the palette: no key's work near a long task (\(typing))", (typed["worst"] as? Double ?? 999) < 50)
  let pstats = await js(o7.webView, "return JSON.stringify(marginApp.stats())") as? String ?? "{}"
  print(String(format: "  timings: ⌘T to the overlay's keyboard %.0f ms; the palette %@; typing %@; the page's counts %@", keyboardMs, opened, typing, pstats))
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

  // ---- a link dropping, and coming back in time ----
  let o7b = shell.overlays[k7]
  fake.tell(["do": "close", "id": "A2"])
  check("a copy's link dropping: its overlay kept, dimmed", await until(3, { shell.links["safari:P1"] == nil && shell.isReconnecting("safari:P1") && shell.overlays[k7] === o7b }))
  fake.tell(["do": "connect", "id": "A3", "profile": "P1", "windows": [win(7, r7b, "fullscreen", focused: true)]])
  check("back within the grace: the same overlay, shown", await until(5, { shell.links["safari:P1"] != nil && !shell.isReconnecting("safari:P1") && shell.overlays[k7] === o7b && o7b?.isShown == true }))
  if let o7b { check("no longer dimmed", await waitJS(o7b.webView, "return !document.documentElement.hasAttribute('data-reconnecting')")) }

  // ---- a silent copy ----
  mark = fake.events.count
  fake.tell(["do": "mute", "id": "B", "on": true])
  check("a copy that stops answering: closed after the limit", await until(4, { shell.links["safari:P2"] == nil }))
  check("its overlay kept a moment, dimmed, saying it's reconnecting", shell.isReconnecting("safari:P2") && shell.overlays[k9] != nil)
  if let o9 = shell.overlays[k9] { check("the note shown", await waitJS(o9.webView, "return document.documentElement.hasAttribute('data-reconnecting') && !!document.getElementById('margin-reconnecting')")) }
  check("then closed, the copy not back", await until(3, { shell.overlays[k9] == nil && !shell.isReconnecting("safari:P2") }))

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
      await profilesScenario()
      await windowsScenario()
      await windowsScenario(ownSpace: true)
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
