// The overlay's keyboard and its page's focus, end to end (part of e2e.swift's
// run; DECISIONS.md "Margin 2: Safari reliability", the keyboard and the
// page's focus): the real link, shell and overlays against fake-extension.mts,
// one profile whose window has Margin's new-tab page in front (the overlay
// draws the launcher). The harness never makes a panel key, so what's checked
// is the decision: whether the overlay has the keyboard (`hasKeyboard`), what
// its page last said (`pageWantsKeyboard`), the shows that gave the keyboard to
// a field focused while hidden (`keyOnShow`), the times the page was told to
// let go (`blurs`), and the page's own focus. Never a field focused in a page
// whose overlay doesn't have the keyboard once it's shown; never the keyboard
// in an overlay that isn't shown.
import AppKit
import WebKit

@MainActor
func keyboardScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("keyboard: \(label)", ok, detail()) }
  let started = Date()
  let fake = Fake()
  do { try fake.start() } catch { return check("the fake extension starts", false, "\(error)") }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-keyboard-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.keyboard.\(ProcessInfo.processInfo.processIdentifier)"),
                        timing: .init(tick: 0.5, dead: 3, keep: 30, hello: 2, request: 5, safariSettled: 2))
  let windows = ScriptedWindows()
  let apps = ScriptedApps()
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.bundleIds = ["safari": fakeBundle]
  options.dataRoot = root
  var said: [String] = []
  let echo = Diagnostics.echo
  Diagnostics.echo = { said.append($0); echo?($0) }
  defer { Diagnostics.echo = echo }
  let shell = Shell(link: link, windows: windows, apps: apps, hotKeys: FakeKeys(), options: options)
  windows.shell = shell
  shell.start()
  guard await until(3, { link.port != nil }) else { return check("listening", false) }
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { return check("wantLink", false) }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { return check("linked", false) }

  // Window 1 (full screen, the new-tab page in front) and, later, window 2 (new, its own bounds).
  let r1 = CGRect(x: -20000, y: -20000, width: 1280, height: 800)
  let r2 = CGRect(x: -18000, y: -20000, width: 1200, height: 760)
  let r3 = CGRect(x: -16000, y: -20000, width: 1240, height: 780)
  let w1 = standIn(r1), w2 = standIn(r2), w3 = standIn(r3)
  defer { w1.close(); w2.close(); w3.close() }
  // The window server's list: which are on screen, the first in front.
  func place(_ list: [(NSWindow, CGRect, Bool)]) {
    windows.browser = list.enumerated().map { i, e in ServerWindow(number: e.0.windowNumber, pid: browserPid, bounds: e.1, onScreen: e.2, order: i) }
  }
  func win(_ id: Int, _ r: CGRect, focused: Bool = false, created: Double? = nil) -> JSONObject {
    var o: JSONObject = ["windowId": id, "left": r.minX, "top": r.minY, "width": r.width, "height": r.height, "state": "fullscreen", "focused": focused, "activeTabId": 13]
    if let created { o["createdAt"] = created }
    return o
  }
  let k1 = WindowKey(link: "safari:P1", windowId: 1), k2 = WindowKey(link: "safari:P1", windowId: 2)
  // The page's focus: what has it (an input's m-input, or its element's name), and whether the palette is open.
  func focused(_ o: OverlayController) async -> String {
    (await js(o.webView, "const a = document.activeElement; return a && a !== document.body ? (a.getAttribute('m-input') ?? a.localName) : ''") as? String) ?? "?"
  }
  func paletteOpen(_ o: OverlayController) async -> Bool { await js(o.webView, "return !!document.querySelector('.palette-layer')") as? Bool ?? false }
  // A field of Margin's focused without the keyboard (seen in real use: typing went to Safari).
  func fieldWithoutKeys(_ o: OverlayController) async -> Bool {
    let f = await focused(o)
    return !o.hasKeyboard && (f == "input" || f == "palette" || f == "launcher")
  }
  // The palette opened in the page itself (as the copy's push would, past the shell's hold).
  func openPaletteInPage(_ o: OverlayController) async {
    _ = await js(o.webView, #"marginApp.receive(JSON.stringify({ type: 'push', msg: { type: 'palette', newTab: false } })); return true"#)
  }
  func ticks(_ n: Int) async {
    for _ in 0..<n { shell.track(); try? await Task.sleep(nanoseconds: 120_000_000) }
  }

  // ---- Margin.app starting with a new-tab page in front: the keys stay with Safari ----
  place([(w1, r1, true)])
  fake.tell(["do": "connect", "id": "A", "profile": "P1", "newTabPage": 13, "windows": [win(1, r1, focused: true)]])
  check("linked", await until(8, { shell.links["safari:P1"]?.mirror.hasState == true }))
  apps.bringToFront(browserPid)
  check("the overlay over the new-tab page's window shown", await until(15, { shell.overlays[k1]?.isShown == true }))
  guard let o1 = shell.overlays[k1] else { return }
  check("its launcher drawn", await waitJS(o1.webView, "return !!document.querySelector('[m-input=\"launcher\"]')"))
  try? await Task.sleep(nanoseconds: 400_000_000)
  var f = await focused(o1)
  check("at the start, the launcher isn't focused and the overlay doesn't take the keyboard",
        f != "launcher" && !o1.hasKeyboard && !o1.pageWantsKeyboard && !said.contains { $0.hasPrefix("\(k1) took the keyboard") }, "\(f) \(o1.hasKeyboard)")

  // ---- a relink: a new overlay over the same window, the keys still Safari's ----
  fake.tell(["do": "connect", "id": "A2", "profile": "P1", "newTabPage": 13, "windows": [win(1, r1, focused: true)]])
  check("a relink: the newer link's overlay shown", await until(15, { shell.links["safari:P1"]?.connection.hello.instanceId == "fake-A2" && shell.overlays[k1] !== o1 && shell.overlays[k1]?.isShown == true }))
  guard let o1b = shell.overlays[k1] else { return }
  _ = await waitJS(o1b.webView, "return !!document.querySelector('[m-input=\"launcher\"]')")
  try? await Task.sleep(nanoseconds: 400_000_000)
  f = await focused(o1b)
  check("a relink with a new-tab page in front doesn't take the keyboard", f != "launcher" && !o1b.hasKeyboard && !o1b.pageWantsKeyboard, f)

  // ---- a new window in front, Safari's own (New Window): its launcher takes the typing as it shows ----
  var from = said.count
  place([(w2, r2, true), (w1, r1, true)])
  fake.tell(["do": "windows", "id": "A2", "list": [win(1, r1), win(2, r2, focused: true, created: Date().timeIntervalSince1970 * 1000)]])
  check("a new window: its overlay shown", await until(15, { shell.overlays[k2]?.isShown == true }))
  guard let o2 = shell.overlays[k2] else { return }
  var ok = await until(3, { o2.hasKeyboard })
  f = await focused(o2)
  let palette2 = await paletteOpen(o2)
  check("a new window in front, Safari's own: its launcher focused (no palette), the keyboard the overlay's", ok && !palette2 && f == "launcher", "\(f) \(palette2)")
  let shownAt = said[from...].firstIndex { $0.hasPrefix("overlay shown over \(k2)") }
  let tookAt = said[from...].firstIndex { $0.hasPrefix("\(k2) took the keyboard") }
  check("and only after it showed", shownAt != nil && tookAt != nil && tookAt! > shownAt!, "\(Array(said[from...]).filter { $0.contains("\(k2)") })")
  var loose = await fieldWithoutKeys(o1b)
  check("the window behind keeps nothing focused", !loose && !o1b.hasKeyboard)
  shell.pressed(CGPoint(x: r2.minX + 700, y: r2.minY + 400)) // on the page
  ok = await until(3, { !o2.hasKeyboard })
  f = await focused(o2)
  check("a press on the page: the keyboard back to Safari, the launcher let go", ok && f != "palette" && f != "launcher", f)
  check("and the log says why", said.contains("\(k2) gave the keyboard back: a press on the page or another app"))

  // ---- a field focused while the overlay is hidden, then shown over the front window ----
  place([(w1, r1, false), (w2, r2, true)])
  check("window 1 off screen: its overlay put away", await until(3, { !o1b.isShown }))
  from = said.count
  await openPaletteInPage(o1b)
  check("the palette focused in the hidden overlay: wanted, but the keyboard isn't taken", await until(3, { o1b.pageWantsKeyboard }) && !o1b.hasKeyboard)
  check("and the log says it waits", said[from...].contains("\(k1): a field of its page has the focus, but the overlay isn't shown: the keyboard waits for it to show"))
  await ticks(3) // each one puts it away again
  check("reads that keep it hidden: still wanted, the page not told to let go", o1b.pageWantsKeyboard && o1b.blurs == 0 && !o1b.hasKeyboard && !o1b.isShown)
  place([(w1, r1, true), (w2, r2, true)])
  check("shown over the front window within 2 s: the keyboard taken as it shows", await until(3, { o1b.isShown && o1b.hasKeyboard }) && o1b.keyOnShow == 1, "keyOnShow \(o1b.keyOnShow)")
  f = await focused(o1b)
  check("its page told nothing, the palette's field still focused", o1b.blurs == 0 && f == "palette", "\(f) blurs \(o1b.blurs)")

  // ---- put away with the palette open, then shown again: no field focused without the keyboard ----
  place([(w1, r1, false), (w2, r2, true)])
  check("put away with the palette open: the keyboard given back, the page told to let go", await until(3, { !o1b.isShown && !o1b.hasKeyboard }) && o1b.blurs == 1)
  ok = await until(3, { !o1b.pageWantsKeyboard })
  var open = await paletteOpen(o1b)
  f = await focused(o1b)
  check("the page let go: the palette closed, no field focused, it said so", ok && !open && f == "", "open \(open) focused \(f)")
  check("the log says why", said.contains { $0.hasPrefix("\(k1) gave the keyboard back: put away: ") })
  place([(w1, r1, true), (w2, r2, true)])
  ok = await until(3, { o1b.isShown })
  loose = await fieldWithoutKeys(o1b)
  check("shown again: no field focused without the keyboard", ok && !loose && !o1b.hasKeyboard && o1b.keyOnShow == 1)

  // ---- a field focused while hidden, then shown when it isn't the front window's ----
  place([(w1, r1, false), (w2, r2, true)])
  _ = await until(3, { !o1b.isShown })
  await openPaletteInPage(o1b)
  check("focused while hidden again", await until(3, { o1b.pageWantsKeyboard }))
  place([(w2, r2, true), (w1, r1, true)]) // window 2 in front
  check("shown behind the front window: the keyboard not taken, the page told to let go", await until(3, { o1b.isShown }) && !o1b.hasKeyboard && o1b.keyOnShow == 1 && o1b.blurs == 2)
  ok = await until(3, { !o1b.pageWantsKeyboard })
  open = await paletteOpen(o1b)
  f = await focused(o1b)
  check("the page let go of it: no field focused, the palette closed", ok && !open && f == "", "open \(open) focused \(f)")
  check("the log says why", said.contains("\(k1): its page told to let go of the focus: shown, but not over the front window"))

  // ---- focused while hidden, shown over the front window more than 2 s later: let go ----
  place([(w1, r1, false), (w2, r2, true)])
  _ = await until(3, { !o1b.isShown })
  await openPaletteInPage(o1b)
  check("focused while hidden, a third time", await until(3, { o1b.pageWantsKeyboard }))
  try? await Task.sleep(nanoseconds: UInt64((OverlayController.focusFresh + 0.3) * 1_000_000_000))
  place([(w1, r1, true), (w2, r2, true)])
  check("shown over the front window after 2 s: the keyboard not taken, the page told to let go", await until(3, { o1b.isShown }) && !o1b.hasKeyboard && o1b.keyOnShow == 1 && o1b.blurs == 3)
  ok = await until(3, { !o1b.pageWantsKeyboard })
  f = await focused(o1b)
  check("and nothing of it focused", ok && f == "", f)

  // ---- a press while a hidden overlay's field is focused: it lets go then ----
  place([(w1, r1, false), (w2, r2, true)])
  _ = await until(3, { !o1b.isShown })
  await openPaletteInPage(o1b)
  _ = await until(3, { o1b.pageWantsKeyboard })
  shell.pressed(CGPoint(x: r2.minX + 700, y: r2.minY + 400))
  check("a press while it's hidden: the page told to let go at once", o1b.blurs == 4 && !o1b.pageWantsKeyboard)
  place([(w1, r1, true), (w2, r2, true)])
  ok = await until(3, { o1b.isShown })
  loose = await fieldWithoutKeys(o1b)
  check("then shown over the front window: no keyboard, nothing focused", ok && !o1b.hasKeyboard && o1b.keyOnShow == 1 && !loose)

  // ---- a window made from another (⌘N, the palette's New window): the palette over its new tab, as ⌘T's ----
  shell.madeFromWindow("safari:P1", SpaceWindowAnswer(["windowId": 3, "state": "fullscreen"])!, asked: Date().timeIntervalSince1970)
  place([(w3, r3, true), (w1, r1, true), (w2, r2, true)])
  fake.tell(["do": "windows", "id": "A2", "list": [win(1, r1), win(2, r2), win(3, r3, focused: true, created: Date().timeIntervalSince1970 * 1000)]])
  let k3 = WindowKey(link: "safari:P1", windowId: 3)
  check("a window made from another: its overlay shown", await until(15, { shell.overlays[k3]?.isShown == true }))
  guard let o3 = shell.overlays[k3] else { return }
  ok = await until(3, { o3.hasKeyboard })
  let palette3 = await paletteOpen(o3)
  f = await focused(o3)
  check("a window made from another (⌘N): the palette open over its new tab, as ⌘T's, the keyboard the overlay's", ok && palette3 && f == "palette", "\(f) \(palette3)")

  // Never the keyboard in an overlay that isn't shown, all along.
  check("never the keyboard while not shown (the log)", !said.contains { $0.contains("took the keyboard") && $0.contains("isn't shown") })
  var stopped = false
  shell.stop { stopped = true }
  _ = await until(3, { stopped })
  print(String(format: "  timings: the keyboard scenario %.1f s", Date().timeIntervalSince(started)))
}
