// Overlays through a window closing, a link dropping and Safari's own sidebar
// (part of e2e.swift's run; DECISIONS.md "Margin 2: Safari reliability", the
// own-Space fallback, overlays kept through a drop, Safari's sidebar slide):
// the real link, shell and overlays against fake-extension.mts, one profile's
// full-screen windows as stand-ins. Spaces are played by on-screen flags: an
// overlay reads as on screen when its window does, or always while `stuck`
// (macOS keeping an overlay in the Space showing, the case the own-Space
// fallback is for), and the own-Space check runs in the harness
// (`harnessOwnSpaceCheck`).
import AppKit
import WebKit

// The real shell's ahead-of-visit path, including its retry bookkeeping. A web view not ready yet is normal:
// it must not start the five-second cooldown for a refused Space move. Both browser windows stay off every
// display, and all Space reads/moves are in FakeSpaceWorld (no private macOS calls, no real browser).
@MainActor
func preparedWindowsScenario() async {
  func check(_ label: String, _ ok: Bool) { e2eCheck("prepared windows: \(label)", ok) }
  let fake = Fake()
  do { try fake.start() } catch { check("fake extension starts", false); return }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { check("fake extension starts", false); return }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-prepared-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.prepared.\(ProcessInfo.processInfo.processIdentifier)"))
  let windows = ScriptedWindows(), apps = ScriptedApps()
  let world = FakeSpaceWorld(clock: RunLoopClock())
  world.active = 10
  world.displayList = [DisplaySpaces(display: "Main", current: 10, spaces: [ManagedSpace(id: 10, type: 4), ManagedSpace(id: 11, type: 4)])]
  var modelFrames: [Int: CGRect] = [:]
  var modelReads = 0
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.overlay.ownSpace = true
  options.harnessAheadPlacement = true
  options.fillsDisplay = { $0.width >= 1000 && $0.height >= 760 }
  options.modelBounds = { number in modelReads += 1; return modelFrames[number] }

  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root
  options.bundleIds = ["safari": fakeBundle]
  let shell = Shell(link: link, windows: windows, apps: apps, hotKeys: FakeKeys(), options: options)
  shell.spaceReads = world
  windows.shell = shell
  windows.overlayOnScreen = { $0.onScreen }
  let r1 = CGRect(x: -20000, y: -20000, width: 1200, height: 800)
  let r2 = CGRect(x: -18000, y: -20000, width: 1100, height: 760)
  let a = standIn(r1), b = standIn(r2)
  modelFrames[a.windowNumber] = r1; modelFrames[b.windowNumber] = r2
  defer { a.close(); b.close() }
  world.windows[a.windowNumber] = .init(pid: browserPid, bounds: r1, spaces: [10])
  world.windows[b.windowNumber] = .init(pid: browserPid, bounds: r2, spaces: [11])
  func show(_ second: Bool) {
    world.active = second ? 11 : 10
    world.displayList = [DisplaySpaces(display: "Main", current: world.active, spaces: [ManagedSpace(id: 10, type: 4), ManagedSpace(id: 11, type: 4)])]
    windows.browser = [ServerWindow(number: a.windowNumber, pid: browserPid, bounds: r1, onScreen: !second),
                       ServerWindow(number: b.windowNumber, pid: browserPid, bounds: r2, onScreen: second)]
  }
  show(false)
  shell.start()
  defer { shell.stop {} }
  guard await until(3, { link.port != nil }) else { check("link listens", false); return }
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { check("link requested", false); return }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { check("linked", false); return }
  let wins: [JSONObject] = [
    ["windowId": 1, "left": r1.minX, "top": r1.minY, "width": r1.width, "height": r1.height, "state": "fullscreen", "focused": true],
    ["windowId": 2, "left": r2.minX, "top": r2.minY, "width": r2.width, "height": r2.height, "state": "fullscreen", "focused": false],
  ]
  fake.tell(["do": "connect", "id": "P", "profile": "P", "windows": wins])
  apps.bringToFront(browserPid)
  let k1 = WindowKey(link: "safari:P", windowId: 1), k2 = WindowKey(link: "safari:P", windowId: 2)
  guard await until(10, { shell.overlays[k1] != nil && shell.overlays[k2] != nil }), let o1 = shell.overlays[k1], let o2 = shell.overlays[k2] else { check("both overlays created", false); return }
  // The first placement was already asked while o2 was loading. Give the stand-in overlay windows their
  // initial Desktop membership, so the fake move can update it, as the real bridge does.
  for o in [o1, o2] { for n in [o.windowNumber, o.catcher.windowNumber] + (o.edgePanel.map { [$0.windowNumber] } ?? []) {
    world.windows[n] = .init(pid: ProcessInfo.processInfo.processIdentifier, bounds: o.frameTopLeft, spaces: o === o1 ? [10] : [1])
  } }
  guard await until(15, { o2.isReady }) else { check("background page draws", false); return }
  let readyAt = Date()
  let prepared = await until(1, { o2.isShown && o2.aheadPending })
  check("ready background window placed without the five-second cooldown", prepared)
  guard prepared else { return }
  check("preparation moves only the overlay into that window's Space", await until(1, { world.spaces(of: o2.windowNumber) == [11] }) && world.spaces(of: b.windowNumber) == [11])
  check("placed within one second of drawing", Date().timeIntervalSince(readyAt) < 1.5)
  guard await until(15, { o1.isReady && o1.isShown }) else { check("front overlay draws", false); return }
  // Deferred NSPanel helpers receive their real window numbers only when first ordered. Register those
  // numbers too: the stand-in otherwise loses the successful move sent before that number was in its table.
  for (o, space) in [(o1, UInt64(10)), (o2, UInt64(11))] {
    for n in o.spaceWindowNumbers.union([o.catcher.windowNumber]) where world.windows[n] == nil {
      if o === o2 { check("deferred background helper was included in the prepared move", world.calls.contains("add \(n) → 11")) }
      world.windows[n] = .init(pid: ProcessInfo.processInfo.processIdentifier, bounds: o.frameTopLeft, spaces: [space])
    }
  }
  let ids = [o1.windowNumber, o2.windowNumber]
  let origins = [await js(o1.webView, "performance.timeOrigin"), await js(o2.webView, "performance.timeOrigin")]
  let movesBeforeVisits = world.calls.count
  let visitsAt = ProcessInfo.processInfo.systemUptime
  var kept = true
  for i in 0..<20 {
    show(i % 2 == 0)
    shell.spaceDidChange()
    kept = kept && o1.isShown && o2.isShown && !o1.isConcealed && !o2.isConcealed
  }
  check("twenty Space visits keep both layouts already shown, before any extension reply", kept)
  print(String(format: "  timings: twenty prepared Space reads %.1f ms", (ProcessInfo.processInfo.systemUptime - visitsAt) * 1000))
  check("ordinary Space visits make no additional Space moves", world.calls.count == movesBeforeVisits)
  check("visits reuse the same two native windows", ids == [shell.overlays[k1]?.windowNumber, shell.overlays[k2]?.windowNumber].compactMap { $0 })
  let after = [await js(o1.webView, "performance.timeOrigin"), await js(o2.webView, "performance.timeOrigin")]
  check("visits never reload either web view", zip(origins, after).allSatisfy { same($0, $1) })
  check("verified own-Space layers participate in Mission Control", [o1, o2].allSatisfy { o in
    [o.panel, o.catcher, o.edgePanel].compactMap { $0 }.allSatisfy { $0.collectionBehavior == OverlayController.ownSpacePreviewBehavior }
  })
  let readsBeforeOrdinary = modelReads
  for _ in 0..<10 { shell.track() }
  check("ordinary reads do not add model-geometry IPC", modelReads == readsBeforeOrdinary)
  let beforeFrames = [o1.frameTopLeft, o2.frameTopLeft]
  let priorMoves = world.calls.count
  var heldThroughPresentation = true
  for i in 0..<20 {
    let scale = i < 10 ? 0.2 + Double(i) * 0.03 : 0.5 - Double(i - 10) * 0.03
    windows.browser = [ServerWindow(number: a.windowNumber, pid: browserPid, bounds: CGRect(x: r1.minX + 150, y: r1.minY + 80, width: r1.width * scale, height: r1.height * scale), onScreen: i % 3 != 0),
                       ServerWindow(number: b.windowNumber, pid: browserPid, bounds: CGRect(x: r2.minX + 80, y: r2.minY + 40, width: r2.width * scale, height: r2.height * scale), onScreen: i % 2 == 0)]
    shell.track()
    heldThroughPresentation = heldThroughPresentation && o1.isShown && o2.isShown && !o1.isConcealed && !o2.isConcealed && [o1.frameTopLeft, o2.frameTopLeft] == beforeFrames
  }
  check("twenty transformed presentation reads never hide or resize either native layout", heldThroughPresentation)
  check("presentation does not move either native layout between Spaces", world.calls.count == priorMoves)
  show(false); shell.track()
  check("return is already shown on the same synchronous read", o1.isShown && !o1.isConcealed && o1.frameTopLeft == r1)
  check("presentation and return reuse each WebView", zip(origins, [await js(o1.webView, "performance.timeOrigin"), await js(o2.webView, "performance.timeOrigin")]).allSatisfy { same($0, $1) })
  windows.noList = true
  shell.track()
  check("a missing batch read does not blank layouts independently confirmed in their full-screen Spaces", !o1.isConcealed && !o2.isConcealed)
  world.unknown = true
  shell.track()
  check("an unknown Space read still conceals rather than guessing", o1.isConcealed && o2.isConcealed)
  world.unknown = false
  shell.track()
  check("independent confirmation restores a concealed layout without waiting for the batch", !o1.isConcealed && !o2.isConcealed)
  let saved = world.windows[b.windowNumber]
  world.windows[b.windowNumber] = nil
  shell.track()
  check("a closed window is concealed even while its old binding is kept", o2.isConcealed && !o1.isConcealed)
  world.windows[b.windowNumber] = saved
  world.windows[o2.windowNumber]?.spaces = [1]
  shell.track()
  check("an overlay displaced onto the Desktop stays concealed", o2.isConcealed)
  world.windows[o2.windowNumber]?.spaces = [11]
  shell.track()
  world.windows[o2.catcher.windowNumber]?.spaces = [1]
  shell.track()
  check("a pointer catcher in another Space also keeps the whole overlay concealed", o2.isConcealed)
  shell.track()
  check("concealing a misplaced catcher cannot make it safe to reveal on the next read", o2.isConcealed)
  world.windows[o2.catcher.windowNumber]?.spaces = [11]
  world.windows[b.windowNumber]?.bounds.size.width -= 40
  shell.track()
  check("a resized window is concealed until its new frame can be read", o2.isConcealed)
  world.windows[b.windowNumber] = saved
  world.windows[b.windowNumber]?.pid = 42
  shell.track()
  check("a window number belonging to another process never keeps the overlay visible", o2.isConcealed)
  world.windows[b.windowNumber] = saved
  windows.noList = false
  shell.track()
  // A real move refused by macOS still backs off: no repeated private calls on every poll. Loading never
  // reaches the bridge; refusal does, and the same ready view is retried after the existing five seconds.
  let callsBefore = world.calls.count
  o2.hide("test a refused move")
  world.refuseAdds = [true]
  shell.track()
  let refusedCalls = world.calls.count
  check("a refused Space move is kept hidden", !o2.isShown && refusedCalls > callsBefore)
  for _ in 0..<20 { shell.track() }
  check("a real move failure keeps its cooldown without hammering the bridge", world.calls.count == refusedCalls)
  check("the ready view is retried after the real failure's cooldown", await until(6, { o2.isShown && o2.aheadPending }))
}

@MainActor
func overlaysScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("overlays: \(label)", ok, detail()) }
  let started = Date()
  let fake = Fake()
  do { try fake.start() } catch { return check("the fake extension starts", false, "\(error)") }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-overlays-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.overlays.\(ProcessInfo.processInfo.processIdentifier)"),
                        timing: .init(tick: 0.5, dead: 3, keep: 30, hello: 2, request: 5, safariSettled: 2))
  let windows = ScriptedWindows()
  let apps = ScriptedApps()
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.overlay.ownSpace = true
  options.harnessOwnSpaceCheck = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.bundleIds = ["safari": fakeBundle]
  options.dataRoot = root
  options.reconnectGrace = 3
  var said: [String] = []
  let echo = Diagnostics.echo
  Diagnostics.echo = { said.append($0); echo?($0) }
  defer { Diagnostics.echo = echo }
  let shell = Shell(link: link, windows: windows, apps: apps, hotKeys: FakeKeys(), options: options)
  windows.shell = shell
  var stuck = false
  // macOS lists an overlay just ordered in as on screen a moment later, not at once (`lag`: 150 ms after it's
  // first listed over its window; a real session's log 2026-11-07 10:44:49, 10:52:17: the check judged it 5 ms after).
  var lag = false
  var firstListed: [Int: Date] = [:]
  windows.overlayOnScreen = { w in
    let first = firstListed[w.number] ?? Date()
    firstListed[w.number] = first
    if lag, Date().timeIntervalSince(first) < 0.15 { return false }
    return w.onScreen || stuck
  }
  shell.start()
  guard await until(3, { link.port != nil }) else { return check("listening", false) }
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { return check("wantLink", false) }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { return check("linked", false) }

  let r1 = CGRect(x: -20000, y: -20000, width: 1280, height: 800)
  let r2 = CGRect(x: -18000, y: -20000, width: 1200, height: 760)
  // Each run of "Safari" its own windows (a window number is never used again for another window; the
  // binder never binds a closed window's number again).
  var made: [NSWindow] = []
  defer { for w in made { w.close() } }
  func newWindows() -> (NSWindow, NSWindow) {
    let pair = (standIn(r1), standIn(r2))
    made += [pair.0, pair.1]
    return pair
  }
  var (w1, w2) = newWindows()
  func place(_ list: [(NSWindow, CGRect, Bool)]) {
    windows.browser = list.enumerated().map { i, e in ServerWindow(number: e.0.windowNumber, pid: browserPid, bounds: e.1, onScreen: e.2, order: i) }
  }
  func win(_ id: Int, _ r: CGRect, focused: Bool = false, state: String = "fullscreen", viewport: JSONObject? = nil) -> JSONObject {
    var o: JSONObject = ["windowId": id, "left": r.minX, "top": r.minY, "width": r.width, "height": r.height, "state": state, "focused": focused, "activeTabId": 13]
    if let viewport { o["viewport"] = viewport }
    return o
  }
  let k1 = WindowKey(link: "safari:P1", windowId: 1), k2 = WindowKey(link: "safari:P1", windowId: 2)
  func saidSince(_ from: Int) -> [String] { Array(said.dropFirst(from)) }
  // Linked as copy `copy` (the same copy linking again keeps its windows' bindings), both windows shown.
  func connect(_ id: String, copy: String, _ list: [JSONObject]) async -> Bool {
    fake.tell(["do": "connect", "id": id, "profile": "P1", "instanceId": copy, "windows": list])
    return await until(15, { shell.links["safari:P1"]?.connection.hello.instanceId == copy && shell.links["safari:P1"]?.mirror.hasState == true })
  }
  func drop(_ id: String) async -> Bool {
    fake.tell(["do": "close", "id": id])
    return await until(5, { shell.links["safari:P1"] == nil })
  }

  // ---- linked, two full-screen windows, each overlay in its window's own Space ----
  place([(w1, r1, true), (w2, r2, true)])
  check("linked", await connect("A", copy: "copy-1", [win(1, r1, focused: true), win(2, r2)]))
  apps.bringToFront(browserPid)
  check("both overlays shown", await until(15, { shell.overlays[k1]?.isShown == true && shell.overlays[k2]?.isShown == true }))
  guard let o1 = shell.overlays[k1], let o2 = shell.overlays[k2] else { return }
  check("in their window's own Space", o1.panel.collectionBehavior == OverlayController.ownSpaceBehavior && o2.panel.collectionBehavior == OverlayController.ownSpaceBehavior)
  check("all native layers hide in Mission Control without joining other Spaces", [o1, o2].allSatisfy { o in
    [o.panel, o.catcher, o.edgePanel].compactMap { $0 }.allSatisfy {
      $0.collectionBehavior.contains(.transient) && !$0.collectionBehavior.contains(.managed)
        && !$0.collectionBehavior.contains(.stationary) && !$0.collectionBehavior.contains(.canJoinAllSpaces)
    }
  })
  try? await Task.sleep(nanoseconds: 400_000_000) // (the check after each placement passes: overlay and window on screen together)
  check("the check after placing them: no fallback", !shell.ownSpaceFellBack)

  // ---- a window ordered out a read before it leaves the list (a close, Safari quitting: a real session's log, 21:57:20) ----
  stuck = true
  place([(w1, r1, false), (w2, r2, true)])
  shell.track()
  check("its overlay on screen while it isn't: put away at once, looked at again, no fallback yet", !o1.isShown && shell.suspectsOwnSpace(k1) && !shell.ownSpaceFellBack)
  check("the log says what was read", said.contains { $0.hasPrefix("\(k1): its overlay (window \(o1.windowNumber)) reads on screen while its window \(w1.windowNumber) is listed off screen (") })
  place([(w2, r2, true)])
  shell.track()
  check("gone from the list the next read: no fallback", !shell.suspectsOwnSpace(k1) && !shell.ownSpaceFellBack)
  check("and the log says why", said.contains("\(k1): no own-Space fallback: window \(w1.windowNumber) left the window server's list (closed, or the browser quit)"))
  try? await Task.sleep(nanoseconds: 500_000_000)
  check("still none 0.5 s on, the other overlay where it was", !shell.ownSpaceFellBack && o2.isShown && o2.panel.collectionBehavior == OverlayController.ownSpaceBehavior)
  stuck = false
  place([(w1, r1, true), (w2, r2, true)])
  check("listed again (a blip of the list): shown again", await until(3, { o1.isShown }))

  // ---- one window closed (⌘W) while the other stays open ----
  stuck = true
  place([(w1, r1, false), (w2, r2, true)])
  shell.track()
  check("⌘W: ordered out first, its overlay put away, looked at again", !o1.isShown && shell.suspectsOwnSpace(k1))
  place([(w2, r2, true)])
  fake.tell(["do": "windows", "id": "A", "list": [win(2, r2, focused: true)]])
  check("then gone: its overlay closed", await until(3, { shell.overlays[k1] == nil }))
  try? await Task.sleep(nanoseconds: 500_000_000)
  check("no fallback, the other overlay still in its own Space and shown", !shell.ownSpaceFellBack && o2.isShown && o2.panel.collectionBehavior == OverlayController.ownSpaceBehavior)

  // ---- Safari quitting: its last window ordered out, then gone, the link dropped with no goodbye ----
  place([(w2, r2, false)])
  shell.track()
  check("quitting: ordered out first, looked at again", !o2.isShown && shell.suspectsOwnSpace(k2))
  place([])
  check("the link drops", await drop("A"))
  try? await Task.sleep(nanoseconds: 500_000_000)
  shell.track()
  check("no fallback", !shell.ownSpaceFellBack && !shell.suspectsOwnSpace(k2))
  check("then its overlays close after the grace", await until(5, { shell.overlays.isEmpty }))
  stuck = false

  // ---- a dropped link: kept overlays follow the windows ----
  (w1, w2) = newWindows()
  place([(w1, r1, true), (w2, r2, true)])
  check("linked again (Safari open again)", await connect("B", copy: "copy-2", [win(1, r1, focused: true), win(2, r2)]))
  check("its overlays shown", await until(15, { shell.overlays[k1]?.isShown == true && shell.overlays[k2]?.isShown == true }))
  weak var gone1: OverlayController?, gone2: OverlayController?
  weak var panel2: OverlayPanel?
  var from = 0, at = Date(), ok = false
  do { // (no strong reference to them kept past this block)
  guard let p1 = shell.overlays[k1], let p2 = shell.overlays[k2] else { return }
  (gone1, gone2, panel2) = (p1, p2, p2.panel)
  // A relink 1 s later, the windows as they were: no put-away, no show (nothing blinks).
  from = said.count
  check("the link drops: its overlays kept", await drop("B") && shell.isReconnecting("safari:P1") && p1.isShown && p2.isShown)
  let tracksAtDrop = shell.tracks
  try? await Task.sleep(nanoseconds: 1_000_000_000)
  check("the window server still read while it's away", shell.tracks > tracksAtDrop + 2, "\(shell.tracks - tracksAtDrop) reads")
  check("back 1 s later, the same copy", await connect("B2", copy: "copy-2", [win(1, r1, focused: true), win(2, r2)]) && !shell.isReconnecting("safari:P1"))
  try? await Task.sleep(nanoseconds: 500_000_000)
  check("the same overlays, shown all along: none put away or shown again", shell.overlays[k1] === p1 && shell.overlays[k2] === p2 && p1.isShown && p2.isShown
        && !saidSince(from).contains { $0.hasPrefix("overlay put away (\(k1))") || $0.hasPrefix("overlay put away (\(k2))") || $0.hasPrefix("overlay shown over \(k1)") || $0.hasPrefix("overlay shown over \(k2)") },
        "\(saidSince(from).filter { $0.contains("overlay") })")
  // A window that leaves full screen while its link is away: put away within a read, not after the grace.
  check("the link drops again", await drop("B2") && shell.isReconnecting("safari:P1"))
  at = Date()
  let windowed = CGRect(x: r1.minX, y: r1.minY, width: 900, height: 600)
  place([(w1, windowed, true), (w2, r2, true)])
  ok = await until(1, { !p1.isShown })
  check("a window out of full screen meanwhile: its overlay put away within a read (\(Int(Date().timeIntervalSince(at) * 1000)) ms)", ok && shell.isReconnecting("safari:P1") && p2.isShown)
  check("the log says why", said.contains { $0.hasPrefix("overlay put away (\(k1)): its window moved or changed size (out of full screen?), while its link is reconnecting") })
  check("back: the windowed one stays without, the other kept", await connect("B3", copy: "copy-2", [win(1, windowed, state: "normal"), win(2, r2, focused: true)]) && !p1.isShown && p2.isShown)
  // Safari quitting: every window gone, the link dropped with no goodbye: put away within a read.
  at = Date()
  fake.tell(["do": "close", "id": "B3"])
  place([])
  ok = await until(1.5, { !p2.isShown })
  check("Safari quitting: its overlay put away within a read or so (\(Int(Date().timeIntervalSince(at) * 1000)) ms), not after the 3 s grace", ok && Date().timeIntervalSince(at) < 2.5)
  check("its windows gone: why, in the log", said.contains { $0.hasPrefix("overlay put away (\(k2)): its window is gone from the window server, while its link is reconnecting") })
  }
  // Closed after the grace, and nothing of them left (each panel and its controller let go).
  check("closed once the grace is over", await until(5, { shell.overlays.isEmpty && !shell.isReconnecting("safari:P1") }))
  check("no overlay panel left after the grace (each let go)", await until(3, { gone1 == nil && gone2 == nil && panel2 == nil }), "\(gone1 == nil) \(gone2 == nil) \(panel2 == nil)")

  // ---- a link dropping while the browser isn't in front: put away at once ----
  (w1, w2) = newWindows()
  place([(w1, r1, true), (w2, r2, true)])
  check("linked again", await connect("C", copy: "copy-3", [win(1, r1, focused: true), win(2, r2)]))
  check("shown", await until(15, { shell.overlays[k1]?.isShown == true && shell.overlays[k2]?.isShown == true }))
  apps.frontPid = 1
  shell.track()
  from = said.count
  check("dropped with another app in front: kept but put away at once", await drop("C") && shell.isReconnecting("safari:P1") && shell.overlays[k1]?.isShown == false && shell.overlays[k2]?.isShown == false)
  check("the log says so", saidSince(from).contains { $0.hasPrefix("safari:P1 dropped (") && $0.hasSuffix("put away (the browser isn't in front)") }, "\(saidSince(from))")
  check("back: shown again once the browser is in front", await connect("C2", copy: "copy-3", [win(1, r1, focused: true), win(2, r2)]))
  apps.bringToFront(browserPid)
  check("both shown again", await until(5, { shell.overlays[k1]?.isShown == true && shell.overlays[k2]?.isShown == true }))

  // ---- the own-Space fallback, still there for the real case: an overlay kept on screen without its window ----
  stuck = true
  place([(w1, r1, false), (w2, r2, true)])
  shell.track()
  at = Date()
  check("an overlay on screen while its window is listed off screen: looked at again", shell.suspectsOwnSpace(k1) && !shell.ownSpaceFellBack)
  ok = await until(2, { shell.ownSpaceFellBack })
  check("still so 0.3 s on, no Space change, the link up: every overlay joins every Space (\(Int(Date().timeIntervalSince(at) * 1000)) ms)", ok && Date().timeIntervalSince(at) >= Shell.ownSpaceWait
        && shell.overlays[k2]?.panel.collectionBehavior == OverlayController.collectionBehavior)
  check("the log says why", said.contains { $0.contains("\(k1): its overlay read on screen while its window \(w1.windowNumber) didn't, and ") && $0.hasSuffix("overlays join every Space again, until no link and no overlay is left") })
  stuck = false
  place([(w1, r1, true), (w2, r2, true)])
  check("after the fallback: both shown again, in every Space", await until(3, { shell.overlays[k1]?.isShown == true && shell.overlays[k2]?.isShown == true })
        && shell.overlays[k1]?.panel.collectionBehavior == OverlayController.collectionBehavior)

  // Every link gone and every overlay closed (Safari quit): the next run of Safari gets its own Spaces again.
  fake.tell(["do": "close", "id": "C2"])
  place([])
  check("Safari quits: links and overlays gone", await until(6, { shell.links.isEmpty && shell.overlays.isEmpty }))
  check("the fallback ends with them", !shell.ownSpaceFellBack && said.contains("no link and no overlay left: overlays join only their window's Space again"))
  (w1, w2) = newWindows()
  place([(w1, r1, true)])
  // (Its page drawn only after several reads, as when Safari opens: each read before tried to show it.)
  lag = true
  check("Safari open again", await connect("D", copy: "copy-4", [win(1, r1, focused: true)]))
  apps.bringToFront(browserPid)
  check("its overlay shown, in its window's own Space", await until(15, { shell.overlays[k1]?.isShown == true }) && shell.overlays[k1]?.panel.collectionBehavior == OverlayController.ownSpaceBehavior)
  try? await Task.sleep(nanoseconds: 600_000_000)
  check("a check asked before it could be shown doesn't judge it the moment it's shown: no fallback (macOS lists it on screen 150 ms later)",
        !shell.ownSpaceFellBack && shell.overlays[k1]?.isShown == true && shell.overlays[k1]?.panel.collectionBehavior == OverlayController.ownSpaceBehavior,
        "fell back: \(shell.ownSpaceFellBack)")
  lag = false

  var stopped = false
  shell.stop { stopped = true }
  _ = await until(3, { stopped })
  print(String(format: "  timings: the overlays scenario %.1f s", Date().timeIntervalSince(started)))
}

// Safari's own sidebar sliding in and out under Margin's docked one, its own run: an overlay made to
// join every Space (as e2e.swift's), whose page measures again when it's resized (one made in its
// window's own Space off every display doesn't, in the harness), so "no setLayout" means something.
@MainActor
func sidebarSlideScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("Safari's sidebar: \(label)", ok, detail()) }
  let started = Date()
  let fake = Fake()
  do { try fake.start() } catch { return check("the fake extension starts", false, "\(error)") }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-slide-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.slide.\(ProcessInfo.processInfo.processIdentifier)"),
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
  let r1 = CGRect(x: -20000, y: -20000, width: 1280, height: 800)
  let r2 = CGRect(x: -18000, y: -20000, width: 1200, height: 760)
  let w1 = standIn(r1), w2 = standIn(r2)
  defer { w1.close(); w2.close() }
  windows.browser = [ServerWindow(number: w2.windowNumber, pid: browserPid, bounds: r2, order: 0), ServerWindow(number: w1.windowNumber, pid: browserPid, bounds: r1, order: 1)]
  // (`tab`: the tab in front; a change redraws the overlay's page, which then measures the slot again:
  // in the harness a resize alone doesn't, its web views off every display draw no frames.)
  func win(_ id: Int, _ r: CGRect, focused: Bool = false, viewport: JSONObject? = nil, tab: Int = 13) -> JSONObject {
    var o: JSONObject = ["windowId": id, "left": r.minX, "top": r.minY, "width": r.width, "height": r.height, "state": "fullscreen", "focused": focused, "activeTabId": tab]
    if let viewport { o["viewport"] = viewport }
    return o
  }
  let k2 = WindowKey(link: "safari:P1", windowId: 2)
  fake.tell(["do": "connect", "id": "S", "profile": "P1", "windows": [win(1, r1), win(2, r2, focused: true)]])
  check("linked", await until(8, { shell.links["safari:P1"]?.mirror.hasState == true }))
  apps.bringToFront(browserPid)
  check("its overlay shown", await until(15, { shell.overlays[k2]?.isShown == true }))
  guard let q = shell.overlays[k2] else { return }
  // The page told it was resized, as a drawn page would be at its next frame (in the harness its web
  // view, off every display, draws none): it measures the slot again, and a new layout goes as setLayout.
  func resized() async { _ = await js(q.webView, "dispatchEvent(new Event('resize')); return innerWidth") }
  // ---- Safari's own sidebar sliding in and out under Margin's docked one (a real session's log, 19:37:14.956-18.706) ----
  check("Margin's sidebar docked: no pointer positions wanted, the edge guarded", await until(5, { q.pointerWant.mode == .none && q.edgeFrame != nil && q.layout != nil }))
  try? await Task.sleep(nanoseconds: 800_000_000) // (the layout sent and settled)
  var mark = fake.events.count
  // The logged left parts (x, width in a 1512 pt window) and when each came, replayed in this 1200 pt one.
  let slide: [(at: Double, x: Double, right: Double)] = [
    (14.956, 19, 0), (15.098, 213, 0), (15.184, 238, 0), (15.233, 239, 0), (15.375, 240, 0), (15.961, 177, 0), (16.042, 54, 0), (16.265, 2, 0),
    (17.685, 115, 0), (17.803, 222, 0), (17.854, 237, 0), (17.927, 240, 0), (18.326, 215, 0), (18.419, 84, 0), (18.653, 2, 0), (18.706, 0, 1),
  ]
  var frames: Set<String> = []
  var guarded = true
  var prev = slide[0].at
  for (i, step) in slide.enumerated() {
    try? await Task.sleep(nanoseconds: UInt64(max(0, step.at - prev) * 1_000_000_000))
    prev = step.at
    let vp: JSONObject = ["x": step.x, "y": 0, "width": r2.width - step.x - step.right, "height": r2.height]
    fake.tell(["do": "windows", "id": "S", "list": [win(1, r1), win(2, r2, focused: true, viewport: vp, tab: i % 2 == 0 ? 12 : 13)]])
    try? await Task.sleep(nanoseconds: 40_000_000)
    await resized()
    frames.insert("\(q.frameTopLeft)")
    guarded = guarded && q.edgeFrame != nil
  }
  try? await Task.sleep(nanoseconds: 50_000_000)
  fake.tell(["do": "windows", "id": "S", "list": [win(1, r1), win(2, r2, focused: true)]])
  try? await Task.sleep(nanoseconds: 300_000_000)
  frames.insert("\(q.frameTopLeft)")
  check("Safari's sidebar sliding in and out twice: the overlay over the whole window all along", frames == ["\(r2)"], "\(frames)")
  check("no setLayout sent during the slide", fake.first("setLayout", since: mark) == nil, "\(fake.all("setLayout", since: mark).count)")
  check("the edge guard placed all along", guarded && q.edgeFrame != nil)
  check("the log says what the first part on the left did", said.contains { $0.hasPrefix("\(k2): a part on the left, 19 pt (guessed), appeared: the pointer at (") && $0.hasSuffix("left under Margin's docked sidebar (\(Int(Shell.dockedLeft(q) ?? 0)) pt)") },
        "\(said.filter { $0.contains("a part on the left") })")
  // A left part wider than Margin's docked sidebar (the Web Inspector docked on the left, 500 pt): carved out at once.
  mark = fake.events.count
  fake.tell(["do": "windows", "id": "S", "list": [win(1, r1), win(2, r2, focused: true, viewport: ["x": 500, "y": 0, "width": r2.width - 500, "height": r2.height], tab: 12)]])
  check("a 500 pt inspector on the left: carved out", await until(2, { q.frameTopLeft == CGRect(x: r2.minX + 500, y: r2.minY, width: r2.width - 500, height: r2.height) }), "\(q.frameTopLeft)")
  await resized()
  check("and its layout sent, from the window's edges", await until(5, { (fake.all("setLayout", since: mark).last.flatMap { ($0["msg"] as? JSONObject)?["insets"] as? JSONObject }).map { (num($0["left"]) ?? 0) >= 500 } ?? false }),
        "\(fake.all("setLayout", since: mark).map { ($0["msg"] as? JSONObject)?["insets"] ?? "" }) \(String(describing: q.layout))")
  check("the guard away (the inspector is Safari's)", q.edgeFrame == nil)
  fake.tell(["do": "windows", "id": "S", "list": [win(1, r1), win(2, r2, focused: true)]])
  check("gone: the whole window again, the guard back", await until(2, { q.frameTopLeft == r2 && q.edgeFrame != nil }))
  // Safari's sidebar sliding away with the pointer over the page (each step measured by a pointer event): still under Margin's.
  fake.tell(["do": "windows", "id": "S", "list": [win(1, r1), win(2, r2, focused: true, viewport: ["x": 180, "y": 0, "width": r2.width - 180, "height": r2.height, "measured": true], tab: 12)]])
  try? await Task.sleep(nanoseconds: 300_000_000)
  await resized()
  check("a measured part under the docked sidebar: still the whole window", q.frameTopLeft == r2, "\(q.frameTopLeft)")
  check("and the log says it was measured", said.contains { $0.hasPrefix("\(k2): a part on the left, 180 pt (measured), appeared") })
  fake.tell(["do": "windows", "id": "S", "list": [win(1, r1), win(2, r2, focused: true)]])
  // Margin's sidebar hidden: Safari's sidebar shows through, carved out at once as before.
  let stateNow = shell.links["safari:P1"]?.mirror.stateJSON().flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject } ?? [:]
  let settings = (stateNow["settings"] as? JSONObject) ?? [:]
  func keepOpen(_ on: Bool) { var s = settings; s["sidebarPinnedOpen"] = on; fake.tell(["do": "delta", "id": "S", "changes": ["settings": ["newValue": s]]]) }
  keepOpen(false)
  check("Margin's sidebar hidden", await until(5, { q.pointerWant.mode != .none }), "\(q.pointerWant)")
  fake.tell(["do": "windows", "id": "S", "list": [win(1, r1), win(2, r2, focused: true, viewport: ["x": 240, "y": 0, "width": r2.width - 240, "height": r2.height])]])
  check("hidden: Safari's sidebar (240 pt) carved out", await until(2, { q.frameTopLeft.minX == r2.minX + 240 }), "\(q.frameTopLeft)")
  fake.tell(["do": "windows", "id": "S", "list": [win(1, r1), win(2, r2, focused: true, viewport: ["x": 0, "y": 0, "width": r2.width, "height": r2.height - 300])]])
  check("the inspector at the bottom: carved out as before", await until(2, { q.frameTopLeft == CGRect(x: r2.minX, y: r2.minY, width: r2.width, height: r2.height - 300) }), "\(q.frameTopLeft)")
  keepOpen(true)
  fake.tell(["do": "windows", "id": "S", "list": [win(1, r1), win(2, r2, focused: true)]])
  check("back to the whole window", await until(2, { q.frameTopLeft == r2 }))

  var stopped = false
  shell.stop { stopped = true }
  _ = await until(3, { stopped })
  print(String(format: "  timings: the Safari sidebar scenario %.1f s", Date().timeIntervalSince(started)))
}
