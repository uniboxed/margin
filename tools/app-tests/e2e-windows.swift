// Which window is which, end to end (part of e2e.swift's run): the real link,
// shell, binder and overlays against fake-extension.mjs playing two Safari
// profiles with several windows: P1 with two full-screen windows, P2 with one
// full-screen window and one normal window, the three full-screen ones with
// the same bounds (one display). Stand-in windows off screen; which macOS Space
// shows is played with their on-screen flags, the copies' focus flags lagging
// the switch and disagreeing. Checked all along (every 20 ms): an overlay is
// only ever shown over its own window; a window that can't be told yet has
// none shown.
import AppKit

@MainActor
func windowsScenario(ownSpace: Bool = false) async {
  // With `ownSpace` (the app's default since 2026-11-05) an overlay stays in its window's Space while
  // that Space isn't showing, so it's already drawn when it comes back: checked below.
  let tag = ownSpace ? "windows (own Space)" : "windows"
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
    e2eCheck(label.replacingOccurrences(of: "windows:", with: "\(tag):"), ok, detail())
  }
  let fake = Fake()
  do { try fake.start() } catch { return check("windows: the fake extension starts", false, "\(error)") }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("windows: the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-windows-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("io.tirth.margin.test.windows.\(ProcessInfo.processInfo.processIdentifier)"),
                        timing: .init(tick: 0.5, dead: 3, keep: 30, hello: 2, request: 5, safariSettled: 2))
  let windows = ScriptedWindows()
  let apps = ScriptedApps()
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.bundleIds = ["safari": fakeBundle]
  options.dataRoot = root
  options.overlay.ownSpace = ownSpace
  var said: [String] = []
  let echo = Diagnostics.echo
  Diagnostics.echo = { said.append($0); echo?($0) }
  defer { Diagnostics.echo = echo }
  let shell = Shell(link: link, windows: windows, apps: apps, hotKeys: FakeKeys(), options: options)
  windows.shell = shell
  shell.start()
  guard await until(3, { link.port != nil }) else { return check("windows: listening", false) }
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { return check("windows: wantLink", false) }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { return check("windows: linked", false) }

  let full = CGRect(x: -20000, y: -20000, width: 1280, height: 800)
  let desk = CGRect(x: -16000, y: -20000, width: 900, height: 700)
  let wA = standIn(full), wB = standIn(full), wC = standIn(full), wD = standIn(desk)
  var stand = [wA, wB, wC, wD]
  defer { for w in stand { w.close() } }
  let p1 = "safari:P1", p2 = "safari:P2"
  let a1 = WindowKey(link: p1, windowId: 1), a2 = WindowKey(link: p1, windowId: 2), b1 = WindowKey(link: p2, windowId: 1), b5 = WindowKey(link: p2, windowId: 5)
  var truth: [WindowKey: Int] = [a1: wA.windowNumber, a2: wB.windowNumber, b1: wC.windowNumber, b5: wD.windowNumber]
  // The Space showing `front`: it on screen (in front), the others off.
  func space(_ front: NSWindow, also: NSWindow? = nil) {
    var order = 0
    windows.browser = stand.map { w in
      let on = w == front || w == also
      order += 1
      return ServerWindow(number: w.windowNumber, pid: browserPid, bounds: w == wD ? desk : full, onScreen: on, order: w == front ? 0 : order)
    }
    shell.burst("test: Space changed")
  }
  let now = { Date().timeIntervalSince1970 * 1000 }
  var focusAt: [WindowKey: Double] = [:]
  func win(_ key: WindowKey, _ r: CGRect, _ state: String, focused: Bool = false, created: Double? = nil) -> JSONObject {
    var o: JSONObject = ["windowId": key.windowId, "left": r.minX, "top": r.minY, "width": r.width, "height": r.height, "state": state, "focused": focused, "activeTabId": 13]
    if let at = focusAt[key] { o["focusedAt"] = at }
    if let created { o["createdAt"] = created }
    return o
  }
  // Each copy's report: its windows, the one it calls focused.
  var p1List: [WindowKey] = [a1, a2]
  var created: [WindowKey: Double] = [:]
  func report1(focused: WindowKey?) {
    fake.tell(["do": "windows", "id": "A", "list": p1List.map { win($0, full, "fullscreen", focused: $0 == focused, created: created[$0]) }])
  }
  func report2(focused: WindowKey?) {
    fake.tell(["do": "windows", "id": "B", "list": [win(b1, full, "fullscreen", focused: focused == b1), win(b5, desk, "normal", focused: focused == b5)]])
  }

  space(wA)
  focusAt[a1] = now() - 10_000
  fake.tell(["do": "connect", "id": "A", "profile": "P1", "windows": p1List.map { win($0, full, "fullscreen", focused: $0 == a1) }])
  fake.tell(["do": "connect", "id": "B", "profile": "P2", "windows": [win(b1, full, "fullscreen"), win(b5, desk, "normal")]])
  check("windows: both copies linked", await until(8, { shell.links[p1]?.mirror.hasState == true && shell.links[p2]?.mirror.hasState == true }))
  apps.bringToFront(browserPid)

  // Watched all along: an overlay shown only over its own window.
  final class Watch { var on = true; var wrong: [String] = []; var looks = 0; var truth: [WindowKey: Int] = [:] }
  let watch = Watch()
  watch.truth = truth
  let watcher = Task { @MainActor in
    while watch.on {
      watch.looks += 1
      for (key, o) in shell.overlays where o.isShown {
        // (With `ownSpace`, an overlay kept in a Space that isn't showing can't be seen: only those whose
        // window is on screen are judged, so a window closed away from its Space isn't counted before the
        // shell hears of it.)
        if ownSpace, let above = o.aboveWindow, windows.browser.first(where: { $0.number == above })?.onScreen != true { continue }
        if let above = o.aboveWindow, watch.truth[key] != above { watch.wrong.append("\(key)'s overlay over \(above), its window is \(watch.truth[key].map(String.init) ?? "gone")") }
      }
      for (key, n) in shell.matches where watch.truth[key] != nil && watch.truth[key] != n { watch.wrong.append("\(key) bound to \(n)") }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
  }

  check("windows: the normal window (bounds of its own) bound at once", await until(3, { shell.matches[b5] == wD.windowNumber }), "\(shell.matches)")
  try? await Task.sleep(nanoseconds: 1_000_000_000)
  check("windows: three full-screen windows with the same bounds, just linked: none bound on a guess, no overlay shown over them",
        shell.matches[a1] == nil && shell.matches[a2] == nil && shell.matches[b1] == nil && !shell.overlays.values.contains { $0.isShown && $0.key != b5 }, "\(shell.matches)")
  check("windows: and the log says why", said.contains { $0.contains("safari:P1#1 (fullscreen") && $0.contains("3 windows have its bounds") })

  // A Space switch to P2's full-screen window: the slide (both on screen), P2's copy hears the focus and says so
  // 0.3 s late; P1's copy still calls its window focused for 0.6 s more.
  space(wC, also: wA)
  let switched = now()
  try? await Task.sleep(nanoseconds: 300_000_000)
  space(wC)
  focusAt[b1] = switched + 20
  report2(focused: b1)
  try? await Task.sleep(nanoseconds: 600_000_000)
  report1(focused: nil)
  check("windows: a focus change with the front window changing then: P2's window bound, its overlay shown over it",
        await until(15, { shell.matches[b1] == wC.windowNumber && shell.overlays[b1]?.isShown == true && shell.overlays[b1]?.aboveWindow == wC.windowNumber }), "\(shell.matches)")
  check("windows: P1's two still can't be told apart: nothing shown over them", shell.matches[a1] == nil && shell.matches[a2] == nil && shell.overlays[a1]?.isShown != true)

  // Back to P1's first window: the same lag the other way. Then P1's other one is the only free window left.
  space(wA, also: wC)
  let back = now()
  try? await Task.sleep(nanoseconds: 250_000_000)
  space(wA)
  focusAt[a1] = back + 30
  try? await Task.sleep(nanoseconds: 400_000_000)
  report1(focused: a1)
  try? await Task.sleep(nanoseconds: 500_000_000)
  report2(focused: nil)
  check("windows: P1's window bound by its focus change, P1's other by elimination", await until(6, { shell.matches[a1] == wA.windowNumber && shell.matches[a2] == wB.windowNumber }), "\(shell.matches)")
  if ownSpace {
    check("windows: P1's overlay over its window, P2's kept in its own Space (not showing), still over its window",
          await until(15, { shell.overlays[a1]?.isShown == true && shell.overlays[b1]?.isShown == true && shell.overlays[b1]?.aboveWindow == wC.windowNumber }))
  } else {
    check("windows: P1's overlay over its window, P2's put away (its Space not showing)", await until(15, { shell.overlays[a1]?.isShown == true && shell.overlays[b1]?.isShown == false }))
  }
  let putAwayBefore = said.filter { $0.contains("overlay put away") }.count

  // Swipes back and forth with the flags lagging and disagreeing (Tirth's log): nothing changes hands.
  let bound = shell.matches
  for (to, key, link) in [(wC, b1, "B"), (wB, a2, "A"), (wA, a1, "A"), (wC, b1, "B")] {
    let from = windows.browser.first { $0.onScreen }.flatMap { s in stand.first { $0.windowNumber == s.number } }
    space(to, also: from)
    let at = now()
    try? await Task.sleep(nanoseconds: 200_000_000)
    space(to)
    try? await Task.sleep(nanoseconds: 450_000_000)
    focusAt[key] = at + 10
    if link == "A" { report1(focused: key); report2(focused: nil) } else { report2(focused: key); report1(focused: nil) }
    try? await Task.sleep(nanoseconds: 900_000_000)
  }
  check("windows: four swipes with the copies' flags lagging: every binding held", shell.matches == bound, "\(shell.matches)")
  if ownSpace {
    check("windows: swiping between placed windows: no overlay put away or shown again",
          said.filter { $0.contains("overlay put away") }.count == putAwayBefore && shell.overlays[b1]?.aboveWindow == wC.windowNumber && shell.overlays[a1]?.aboveWindow == wA.windowNumber,
          "\(said.filter { $0.contains("overlay put away") }.suffix(3))")
  } else {
    check("windows: the overlay in front is the front window's own", await until(5, { shell.overlays[b1]?.isShown == true && shell.overlays[b1]?.aboveWindow == wC.windowNumber
      && shell.overlays.values.filter(\.isShown).count == 1 }))
  }

  // P1's second window closed: its binding and overlay go. A new full-screen window: bound to its own window.
  p1List = [a1]
  report1(focused: nil)
  windows.browser.removeAll { $0.number == wB.windowNumber }
  stand.removeAll { $0 == wB }
  wB.close()
  truth[a2] = nil
  watch.truth = truth
  check("windows: a window closed: its binding dropped, its overlay closed", await until(3, { shell.matches[a2] == nil && shell.overlays[a2] == nil }))
  let wE = standIn(full)
  stand.append(wE)
  let a3 = WindowKey(link: p1, windowId: 3)
  truth[a3] = wE.windowNumber
  watch.truth = truth
  windows.browser.append(ServerWindow(number: wE.windowNumber, pid: browserPid, bounds: full, onScreen: false, order: 20))
  shell.burst("test: a new window")
  created[a3] = now()
  p1List = [a1, a3]
  report1(focused: nil)
  check("windows: a new full-screen window bound to its own window", await until(4, { shell.matches[a3] == wE.windowNumber }), "\(shell.matches)")

  watch.on = false
  _ = await watcher.value
  check("windows: never an overlay over another window, never a binding wrong (\(watch.looks) looks)", watch.wrong.isEmpty && watch.looks > 100, "\(watch.wrong.prefix(5))")
  // Which rule binds a window first depends on timing (a loaded Mac's reads come late:
  // focus moved, or settled focus, or elimination); each binding must be logged with one.
  let why = ["focus moved", "the only free window with its bounds", "settled focus", "made by Margin", "created", "two focus changes said so", "its bounds"]
  let bindingLines = said.filter { $0.contains(" is window ") }
  let saidWhy = { (prefix: String) in bindingLines.contains { line in line.hasPrefix(prefix) && why.contains { line.contains($0) } } }
  check("windows: every binding made in the log with why", saidWhy("safari:P2#1 is window \(wC.windowNumber): ")
        && saidWhy("safari:P1#2 is window \(wB.windowNumber): ")
        // Closed in both at once: whichever the binder hears first says why (the browser's
        // window list, or the window server's), and either way the binding goes with a reason.
        && said.contains { $0.hasPrefix("safari:P1#2 is no longer window \(wB.windowNumber): closed in the browser") || $0.hasPrefix("safari:P1#2 is no longer window \(wB.windowNumber): window \(wB.windowNumber) is gone from the window server") },
        "\(bindingLines.filter { $0.contains("P2#1") || $0.contains("P1#2") }.prefix(4))")
  var stopped = false
  shell.stop { stopped = true }
  _ = await until(3, { stopped })
}
