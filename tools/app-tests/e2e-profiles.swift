// Spaces across profiles end to end (part of e2e.swift's run): the real link,
// shell and overlays against fake-extension.mts playing two Safari profiles,
// P1 with a full-screen window and P2 with none, in a temporary data folder.
// The overlay over P1's window draws every space of both profiles in one
// order with P2's marked; a click on P2's space has the app drive the switch:
// P2's copy opens its window (a stand-in window, off screen, in front as its
// full-screen Space would be), and only then is P1's window closed, so one
// window is left, with its overlay drawing P2's spaces. Then the previous-space
// key goes back across, and a profile renamed is in every overlay and on disk.
// With the handoff's gate off (Shell.Options.handoff, as the app ships), that
// switch is the close-based one exactly as before.
// Then the handoff (handoffScenario): the same shell with its gate on, the
// switch's Space reads, parker and freezer stand-ins (FakeSpaceWorld, the real
// SpaceParker over it, FakeFreezer), and a stand-in for the window server and
// macOS's Spaces that both read (SpaceWindows), played as Safari would from
// what the fake copies say.
import AppKit

@MainActor
func profilesScenario() async {
  let fake = Fake()
  do { try fake.start() } catch { return check("profiles: the fake extension starts", false, "\(error)") }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("profiles: the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-profiles-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }

  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.profiles.\(ProcessInfo.processInfo.processIdentifier)"),
                        timing: .init(tick: 0.5, dead: 3, keep: 30, hello: 2, request: 5, safariSettled: 2))
  let windows = ScriptedWindows()
  let apps = ScriptedApps()
  let keys = FakeKeys()
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.bundleIds = ["safari": fakeBundle]
  options.dataRoot = root
  let shell = Shell(link: link, windows: windows, apps: apps, hotKeys: keys, options: options)
  windows.shell = shell
  shell.start()
  check("profiles: the handoff's gate off: no handoff world for the switch", !shell.handoffOn && shell.switcher.handoffWorld == nil)
  guard await until(3, { link.port != nil }) else { return check("profiles: listening", false) }
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { return check("profiles: wantLink", false) }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { return check("profiles: linked", false) }

  // Full-screen windows have the display's bounds: every one the same (off screen here).
  let full = CGRect(x: -20000, y: -20000, width: 1280, height: 800)
  let bounds: JSONObject = ["left": full.minX, "top": full.minY, "width": full.width, "height": full.height]
  let w7 = standIn(full)
  windows.browser = [ServerWindow(number: w7.windowNumber, pid: browserPid, bounds: full, onScreen: true, order: 0)]
  let win7: JSONObject = ["windowId": 7, "left": full.minX, "top": full.minY, "width": full.width, "height": full.height, "state": "fullscreen", "focused": true, "activeTabId": 13]
  let p2Spaces: [JSONObject] = [["id": "job", "name": "Job", "emoji": "💼", "color": "#00b894"], ["id": "home", "name": "Office", "emoji": "🏢", "color": "#0984e3"]]
  fake.tell(["do": "connect", "id": "A", "profile": "P1", "windows": [win7], "data": ["acked": 0], "newWindow": bounds])
  // P1 first seen (its sockets race otherwise): the names below go by when each was first seen.
  _ = await until(5, { shell.links["safari:P1"] != nil })
  fake.tell(["do": "connect", "id": "B", "profile": "P2", "windows": [], "data": ["acked": 0], "spaces": p2Spaces, "newWindow": bounds])
  check("profiles: both copies linked, their data sets stored", await until(8, { fake.all("dataAck").count >= 2 && shell.links.count == 2 }))
  apps.bringToFront(browserPid)
  let k7 = WindowKey(link: "safari:P1", windowId: 7)
  guard await until(15, { shell.overlays[k7]?.isReady == true && shell.overlays[k7]?.isShown == true }), let o7 = shell.overlays[k7] else { return check("profiles: P1's overlay drawn", false) }

  // ---- one order, both profiles ----
  let chips = "return [...document.querySelectorAll('.chip')].map((c) => c.getAttribute('title') + (c.classList.contains('foreign') ? ' *' : '') + (c.querySelector('.profile-mark') ? ' m' : ''))"
  do { let ok = await waitJS(o7.webView, "return document.querySelectorAll('.chip').length === 5 && document.querySelectorAll('.chip.foreign .profile-mark').length === 2"); let seen = "\(await js(o7.webView, chips) ?? "")"; check("profiles: every space of both, P1's then P2's, P2's marked", ok, seen) }
  let titles = await js(o7.webView, chips) as? [String] ?? []
  check("profiles: named until the person names them (Profile 1 and 2 by when first seen)", titles == ["Home · Profile 1", "Deep Work · Profile 1", "Side · Profile 1", "Job · Profile 2 * m", "Office · Profile 2 * m"], "\(titles)")
  check("profiles: a divider where the profile changes", await js(o7.webView, "return document.querySelectorAll('.profile-divider').length") as? Int == 1)
  check("profiles: browser.json written", FileManager.default.fileExists(atPath: root.appendingPathComponent("safari/browser.json").path))

  // ---- a click on P2's space: the switch, one window at a time ----
  var mark = fake.events.count
  // A real press on the chip (the runtime switches on press, as Arc does).
  if let chip = rect(await js(o7.webView, "const r = document.querySelector('.chip.foreign[title^=\"Office\"]')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null")) {
    press(o7, at: CGPoint(x: chip.midX, y: chip.midY))
  } else { check("switch: P2's chip found", false) }
  check("switch: P2's copy asked to open the space's window, full screen", await until(3, { fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "openSpaceWindow" } != nil }))
  let open = fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "openSpaceWindow" }
  check("switch: by P2's copy, for its space", open?["id"] as? String == "B" && ((open?["msg"] as? JSONObject)?["payload"] as? JSONObject)?["spaceId"] as? String == "home")
  check("switch: P1's window not closed before P2's is in front", fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "closeWindow" } == nil)
  // macOS's slide to the new full-screen Space: the new window on screen, the old one not.
  let w90 = standIn(full)
  windows.browser = [ServerWindow(number: w90.windowNumber, pid: browserPid, bounds: full, onScreen: true, order: 0),
                     ServerWindow(number: w7.windowNumber, pid: browserPid, bounds: full, onScreen: false, order: 1)]
  shell.burst("test: the Space slid")
  check("switch: then P1's window closed", await until(5, { fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "closeWindow" && $0["id"] as? String == "A" } != nil }))
  windows.browser.removeAll { $0.number == w7.windowNumber }
  w7.close()
  check("switch: no drafts asked, nothing parked (the gate off: as before)", fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "windowDrafts" } == nil
        && fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "setWindowState" } == nil)
  check("switch: done, one window left (P2's)", await until(5, { !shell.switcher.busy }) && shell.switcher.history.last?.hasPrefix("done") == true
        && (shell.links["safari:P1"]?.mirror.windows.isEmpty ?? false) && shell.links["safari:P2"]?.mirror.windows.count == 1, "\(shell.switcher.history)")
  let k90 = WindowKey(link: "safari:P2", windowId: 90)
  check("switch: P2's window gets its overlay, P1's goes", await until(15, { shell.overlays[k90]?.isShown == true && shell.overlays[k7] == nil }))
  guard let o90 = shell.overlays[k90] else { return }
  do { let ok = await waitJS(o90.webView, "const c = [...document.querySelectorAll('.chip')]; return c.length === 5 && c.filter((x) => x.classList.contains('foreign')).length === 3 && c.find((x) => x.classList.contains('active'))?.getAttribute('title') === 'Office · Profile 2'"); let seen = "\(await js(o90.webView, chips) ?? "")"; check("switch: P2's overlay draws the same order, P1's spaces marked now, its space active", ok, seen) }

  // ---- ⌃⌘←: the previous space in the one order is in the same profile: today's switch ----
  mark = fake.events.count
  keys.press("Alt+Meta+ArrowLeft")
  check("key, same profile: the copy's own navigate", await until(3, { fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "navigate" && $0["id"] as? String == "B" } != nil }))
  // ⌃⌘→ from Office (last): wraps to P1's first space: across again.
  try? await Task.sleep(nanoseconds: 1_600_000_000) // past the keys' chaining
  mark = fake.events.count
  keys.press("Alt+Meta+ArrowRight")
  check("key, across: P1's copy asked for a window (it has none now)", await until(3, { fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "openSpaceWindow" && $0["id"] as? String == "A" } != nil }),
        "\(fake.all("req", since: mark).map { ($0["msg"] as? JSONObject)?["type"] ?? "" })")
  let w91 = standIn(full)
  windows.browser = [ServerWindow(number: w91.windowNumber, pid: browserPid, bounds: full, onScreen: true, order: 0),
                     ServerWindow(number: w90.windowNumber, pid: browserPid, bounds: full, onScreen: false, order: 1)]
  shell.burst("test: the Space slid back")
  check("key, across: P2's window closed after, one window again", await until(5, { fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "closeWindow" && $0["id"] as? String == "B" } != nil }))
  windows.browser.removeAll { $0.number == w90.windowNumber }
  w90.close()
  check("key, across: done", await until(5, { !shell.switcher.busy }) && shell.switcher.history.last?.hasPrefix("done") == true, "\(shell.switcher.history.suffix(3))")

  // ---- a profile named, everywhere and on disk ----
  let k91 = WindowKey(link: "safari:P1", windowId: 90) // P1's copy numbers its windows from 90 too
  guard await until(15, { shell.overlays[k91]?.isShown == true }), let o91 = shell.overlays[k91] else { return check("profiles: P1's new window's overlay", false, "\(shell.overlays.keys)") }
  shell.performAcross(from: o91, "profile.rename", ["profile": "P2", "name": "Work", "emoji": "💼", "color": "#e17055"])
  do { let ok = await waitJS(o91.webView, "return [...document.querySelectorAll('.chip')].some((c) => c.getAttribute('title') === 'Job · Work')"); let seen = "\(await js(o91.webView, chips) ?? "")"; check("rename: in the overlay's chips at once", ok, seen) }
  let file = (try? Data(contentsOf: root.appendingPathComponent("safari/browser.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject }
  check("rename: kept in browser.json", ((file?["profiles"] as? JSONObject)?["P2"] as? JSONObject)?["name"] as? String == "Work")
  // A space moved in the whole order.
  shell.performAcross(from: o91, "space.move", ["profile": "P2", "space": "job", "dir": -1])
  do { let ok = await waitJS(o91.webView, "const t = [...document.querySelectorAll('.chip')].map((c) => c.getAttribute('title')); return t.indexOf('Job · Work') === 2"); let seen = "\(await js(o91.webView, chips) ?? "")"; check("move: P2's Job before P1's Side", ok, seen) }
  check("profiles: nothing the app sent was over 1 MB", fake.first("tooBig") == nil)
  var stopped = false
  shell.stop { stopped = true }
  _ = await until(3, { stopped })
  w91.close()
  await handoffScenario()
}

// ---- the handoff ----

// The window server and macOS's Spaces in one stand-in: each browser window is a stand-in NSWindow
// (its number the window's), placed in the Spaces of a FakeSpaceWorld, which the switch's Space reads
// and the parker use; the shell's window source lists the same windows from it (on screen: in the
// active Space), the one last in front first, each shown overlay just above its window (on screen
// whatever its window is: macOS keeping it in the Space showing, so the own-Space checks have
// something to suspect).
final class SpaceWindows: WindowSource {
  let world: FakeSpaceWorld
  weak var shell: Shell?
  let desktop: UInt64 = 1
  private(set) var fs: [UInt64] = []
  private var nextFs: UInt64 = 100
  private var front: [Int] = [] // most recently in front first
  var extra: [ServerWindow] = [] // the browser's other windows (a dialog), in front
  var stands: [Int: NSWindow] = [:]

  init(world: FakeSpaceWorld) {
    self.world = world
    world.active = desktop
    sync()
  }

  private func sync() {
    world.displayList = [DisplaySpaces(display: "Main", current: world.active, spaces: [ManagedSpace(id: desktop, type: 0)] + fs.map { ManagedSpace(id: $0, type: 4) })]
  }
  private func raise(_ n: Int) { front.removeAll { $0 == n }; front.insert(n, at: 0) }

  // A new window (a stand-in for it): in a full-screen Space of its own, made the active one, or on the Desktop.
  @discardableResult func add(_ bounds: CGRect, fullScreen: Bool) -> Int {
    let w = standIn(bounds)
    let n = w.windowNumber
    stands[n] = w
    world.windows[n] = .init(pid: browserPid, bounds: bounds, spaces: [desktop])
    if fullScreen { enter(n, bounds) } else { raise(n); sync() }
    return n
  }
  func enter(_ n: Int, _ full: CGRect) {
    let s = nextFs
    nextFs += 1
    fs.append(s)
    world.windows[n]?.spaces = [s]
    world.windows[n]?.bounds = full
    world.active = s
    raise(n)
    sync()
  }
  func exit(_ n: Int, _ normal: CGRect) {
    let old = world.windows[n]?.spaces.filter { fs.contains($0) } ?? []
    fs.removeAll { old.contains($0) }
    world.windows[n]?.spaces = [desktop]
    world.windows[n]?.bounds = normal
    if let a = world.active, old.contains(a) { world.active = desktop }
    sync()
  }
  func focus(_ n: Int) {
    if let s = world.windows[n]?.spaces.first(where: { fs.contains($0) || $0 == desktop }) { world.active = s }
    raise(n)
    sync()
  }
  func remove(_ n: Int) {
    let old = world.windows[n]?.spaces.filter { fs.contains($0) } ?? []
    fs.removeAll { old.contains($0) }
    world.windows[n] = nil
    if let a = world.active, old.contains(a) { world.active = desktop }
    front.removeAll { $0 == n }
    stands.removeValue(forKey: n)?.close()
    sync()
  }

  func windows(of pids: Set<pid_t>) -> [ServerWindow] {
    let rank = { (n: Int) in (self.world.window(n)?.onScreen == true ? 0 : 1, self.front.firstIndex(of: n) ?? Int.max, n) }
    var out: [ServerWindow] = extra
    for n in world.windows.keys.sorted(by: { rank($0) < rank($1) }) {
      guard let w = world.window(n) else { continue }
      if let overlay = shell?.overlays.values.first(where: { $0.isShown && $0.aboveWindow == n }) {
        out.append(ServerWindow(number: overlay.windowNumber, pid: ProcessInfo.processInfo.processIdentifier, bounds: overlay.frameTopLeft, onScreen: true))
      }
      out.append(w)
    }
    return out.enumerated().map { i, w in ServerWindow(number: w.number, pid: w.pid, layer: w.layer, bounds: w.bounds, onScreen: w.onScreen, alpha: w.alpha, order: i) }
  }
}

// What the scenario's watchers see while a switch runs (shared with their tasks).
final class HandoffWatch {
  var drive = true
  var watching = true
  var coverDrawn = false, coverHeard = false
  var aOverlayAtNormal: Bool?
  var bShownWhile: String?
  var pressed = false
  var suspected = false // an own-Space suspicion of a window the switch moved
}

@MainActor
func handoffScenario() async {
  let seen = HandoffWatch()
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("handoff: " + label, ok, detail()) }
  let fake = Fake()
  do { try fake.start() } catch { return check("the fake extension starts", false, "\(error)") }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-handoff-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }

  let full = CGRect(x: -20000, y: -20000, width: 1280, height: 800)
  let normal1 = CGRect(x: -19900, y: -19920, width: 1000, height: 600)
  let normal2 = CGRect(x: -19880, y: -19900, width: 1040, height: 640)
  let clock = RunLoopClock()
  let world = FakeSpaceWorld(clock: clock)
  let windows = SpaceWindows(world: world)
  let freezer = FakeFreezer(clock: clock)
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.handoff.\(ProcessInfo.processInfo.processIdentifier)"),
                        timing: .init(tick: 0.5, dead: 3, keep: 30, hello: 2, request: 5, safariSettled: 2))
  let apps = ScriptedApps()
  let keys = FakeKeys()
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.overlay.ownSpace = true
  options.harnessOwnSpaceCheck = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.bundleIds = ["safari": fakeBundle]
  options.dataRoot = root
  options.switchClock = clock
  options.handoff = true
  options.handoffParts = HandoffParts(reads: world, parker: SpaceParker(reads: world, bridge: world, clock: clock), freezer: freezer)
  var passedQuit: [(pid_t, Bool)] = []
  options.passQuitKeys = { pid, keep in passedQuit.append((pid, keep)) }
  var asksBeforeQuit = true
  options.asksBeforeQuit = { asksBeforeQuit }
  options.setAskBeforeQuit = { asksBeforeQuit = $0 }
  options.fillsDisplay = { $0 == full }
  // A Margin.app that crashed with P2's window parked: it came back by itself to the Desktop, and its
  // marker is in the data folder (§13.2). The same Safari is still running.
  func box(_ r: CGRect) -> JSONObject { ["left": r.minX, "top": r.minY, "width": r.width, "height": r.height] }
  let n7 = windows.add(full, fullScreen: true)
  let n8 = windows.add(normal2, fullScreen: false)
  windows.focus(n7)
  try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  let marker = ParkingMarker(pid: 999_999, build: nil, at: Date().timeIntervalSince1970 * 1000 - 60_000, count: 1,
                             windows: [.init(number: n8, link: "safari:P2", windowId: 8, copy: "fake-B", pid: browserPid, bounds: [normal2.minX, normal2.minY, normal2.width, normal2.height])],
                             shown: [.init(link: "safari:P1", number: n7)])
  try? JSONEncoder().encode(marker).write(to: root.appendingPathComponent(ParkingMarker.fileName))
  let shell = Shell(link: link, windows: windows, apps: apps, hotKeys: keys, options: options)
  windows.shell = shell
  shell.start()
  check("the gate on, with the Space reads: the shell is the switch's handoff world", shell.handoffOn && shell.switcher.handoffWorld != nil && shell.parkingOn)
  shell.recoverParked()
  check("0: after a crash, the marker's window still there is parked again, with no handoff", await until(2, { shell.parking?.entries[n8]?.phase == .parked })
        && world.spaces(of: n8) == [] && shell.switcher.session.runs == 0 && shell.parking?.lastShown["safari:P1"] == n7)
  guard await until(3, { link.port != nil }) else { return check("listening", false) }
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { return check("wantLink", false) }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { return check("linked", false) }

  // P1's window 7 in full screen in front; P2's window 8 a normal window, parked.
  var numbers: [String: Int] = ["A#7": n7, "B#8": n8] // a copy's window → its stand-in
  var normals: [Int: CGRect] = [n7: normal1, n8: normal2]
  let win7: JSONObject = box(full).merging(["windowId": 7, "state": "fullscreen", "focused": true, "activeTabId": 13]) { $1 }
  let win8: JSONObject = box(normal2).merging(["windowId": 8, "state": "normal", "focused": false, "activeTabId": 13]) { $1 }
  let p2Spaces: [JSONObject] = [["id": "job", "name": "Job", "emoji": "💼", "color": "#00b894"], ["id": "home", "name": "Office", "emoji": "🏢", "color": "#0984e3"]]
  fake.tell(["do": "connect", "id": "A", "profile": "P1", "windows": [win7], "newWindow": box(full), "play": ["enterMs": 300, "exitMs": 80, "normal": box(normal1)]])
  fake.tell(["do": "connect", "id": "B", "profile": "P2", "windows": [win8], "spaces": p2Spaces, "newWindow": box(full), "nextWindow": 95,
             "play": ["enterMs": 300, "exitMs": 80, "normal": box(normal2)]])

  // Safari's side of the window server, from what the copies say they did (a few ms behind, as macOS is).
  var heard = 0
  Task { @MainActor in
    while seen.drive {
      for e in fake.events.dropFirst(heard) {
        let id = e["id"] as? String ?? "", w = int(e["windowId"]) ?? -1
        switch e["ev"] as? String {
        case "landed":
          guard let n = numbers["\(id)#\(w)"] else { break }
          if e["state"] as? String == "fullscreen" {
            // Already in full screen (its own Space, the display's bounds): only focused. Else it enters a Space of its own.
            if world.windows[n]?.bounds == full, world.windows[n]?.spaces.contains(where: { windows.fs.contains($0) }) == true { windows.focus(n) } else {
              // Its new Space active at once, its bounds the display's a moment later (macOS's animation).
              windows.enter(n, full.insetBy(dx: 40, dy: 30))
              DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { if world.windows[n] != nil { world.windows[n]?.bounds = full; shell.burst("test: in full screen") } }
            }
          } else {
            windows.exit(n, normals[n] ?? normal1)
          }
        case "made":
          let n = windows.add(full, fullScreen: true)
          numbers["\(id)#\(w)"] = n
          normals[n] = normal2
        case "closed":
          if let n = numbers.removeValue(forKey: "\(id)#\(w)") { windows.remove(n) }
        case "req":
          let msg = e["msg"] as? JSONObject
          if msg?["type"] as? String == "focusWindow", let n = numbers["\(id)#\(int((msg?["payload"] as? JSONObject)?["windowId"]) ?? -1)"] { windows.focus(n) }
        default:
          continue
        }
        shell.burst("test: the window server moved")
      }
      heard = fake.events.count
      try? await Task.sleep(nanoseconds: 3_000_000)
    }
  }
  defer { seen.drive = false }

  check("both copies linked", await until(8, { shell.links.count == 2 && shell.links.values.allSatisfy(\.mirror.hasState) }))
  apps.bringToFront(browserPid)
  let k7 = WindowKey(link: "safari:P1", windowId: 7), k8 = WindowKey(link: "safari:P2", windowId: 8)
  guard await until(15, { shell.overlays[k7]?.isShown == true && shell.matches[k8] == n8 }), let o7 = shell.overlays[k7] else {
    return check("P1's overlay drawn, P2's parked window bound", false, "\(shell.matches)")
  }
  let reqs = { (id: String, type: String, since: Int) in fake.all("req", since: since) { $0["id"] as? String == id && ($0["msg"] as? JSONObject)?["type"] as? String == type } }
  let payload = { (e: JSONObject) in (e["msg"] as? JSONObject)?["payload"] as? JSONObject ?? [:] }
  let parkedSaid = { (id: String, windowId: Int, on: Bool, since: Int) in
    fake.first("message", since: since) { e in let m = e["msg"] as? JSONObject; return e["id"] as? String == id && m?["k"] as? String == "parked" && int(m?["windowId"]) == windowId && m?["on"] as? Bool == on } != nil
  }
  let drawnOff = { (id: String, windowId: Int, since: Int) in fake.first("drawn", since: since) { $0["id"] as? String == id && int($0["windowId"]) == windowId && $0["on"] as? Bool == false } != nil }
  check("0: the parked window bound on the registry's record, its copy told, drawn on", await until(3, { parkedSaid("B", 8, true, 0) })
        && fake.first("drawn") { $0["id"] as? String == "B" && int($0["windowId"]) == 8 && $0["on"] as? Bool == true } != nil && !drawnOff("B", 8, 0))

  // ---- 1. P1 → P2: the show variant, park+freeze ----
  var mark = fake.events.count
  Task { @MainActor in
    var at = mark
    while seen.watching {
      if shell.suspectsOwnSpace(k7) || shell.suspectsOwnSpace(k8) { seen.suspected = true }
      if shell.switcher.run?.coverAt != nil { seen.coverHeard = true }
      if !seen.coverDrawn, shell.switcher.run != nil, await js(o7.webView, "return !!document.querySelector('.switch-cover')") as? Bool == true {
        seen.coverDrawn = true
        // The page's own words, said for it: a panel off every display draws no frames to count
        // (ui/switch-cover.ts), so its `switch.coverShown` and B's `framed` are posted as the bridge would.
        if shell.switcher.run?.coverAt == nil { shell.perform(from: o7, "switch.coverShown", nil) }
      }
      if let b = shell.overlays[k8], b.isShown, shell.switcher.run?.shownAt != nil, shell.switcher.run?.framedAt == nil { b.pageSaid("framed", ["mode": "fullscreen"]) }
      if seen.aOverlayAtNormal == nil, let r = fake.all("req", since: at).first(where: { $0["id"] as? String == "A" && ($0["msg"] as? JSONObject)?["type"] as? String == "setWindowState" }) {
        if payload(r)["state"] as? String == "normal" { seen.aOverlayAtNormal = shell.overlays[k7]?.isShown ?? false }
        at = fake.events.count
      }
      try? await Task.sleep(nanoseconds: 4_000_000)
    }
  }
  // (To P2's second space, Office: its window 8 shows its first, Job, until then, so the sidebar can be seen showing the wrong one.)
  shell.performAcross(from: o7, "profile.switch", ["profile": "P2", "space": "home"])
  check("1: a handoff, not the close-based switch", shell.switcher.run != nil && shell.switcher.busy, "\(shell.switcher.history.suffix(3))")
  let done1 = await until(8, { !shell.switcher.busy })
  seen.watching = false
  check("1: done", done1 && shell.switcher.history.contains { $0.hasPrefix("done") || $0.contains("handoff: ") } && shell.switcher.session.lines.last?.contains("park+freeze") == true,
        "\(shell.switcher.session.lines.last ?? "-") \(shell.switcher.history.suffix(6))")
  check("1: the cover drawn in A's overlay, and its word heard (the freeze starts on it)", seen.coverDrawn && seen.coverHeard)
  check("1: B's overlay framed (R4) from its page's word", shell.switcher.session.lines.last?.contains("overlay framed -") == false, "\(shell.switcher.session.lines.last ?? "-")")
  check("1: frozen once and revealed", freezer.calls.contains { $0.hasPrefix("freeze") } && freezer.calls.contains { $0.contains("reveal 1") } && !freezer.isLive, "\(freezer.calls)")
  check("1: A's overlay ordered out before A was asked to leave full screen", seen.aOverlayAtNormal == false, "\(String(describing: seen.aOverlayAtNormal))")
  check("1: A's drafts asked before it could be closed", !reqs("A", "windowDrafts", mark).isEmpty)
  check("1: A parked, in no user Space, B in front in full screen", shell.parking?.isParked(n7) == true && world.spaces(of: n7) == [] && world.window(n8)?.onScreen == true
        && windows.fs.contains(world.active ?? 0))
  // The same sidebar kept through the switch (Shell.handOverOverlay): A's, handed to B under the freeze, shown over B;
  // B's own (made for its parked window) is A's now, hidden.
  check("1: the sidebar kept: A's handed to B and shown over it, B's own A's now and hidden",
        await until(5, { shell.overlays[k8]?.isShown == true }) && shell.overlays[k8] === o7 && o7.key == k8 && shell.overlays[k7].map { !$0.isShown && $0.key == k7 } ?? true,
        "\(String(describing: shell.overlays[k8]?.key)) \(String(describing: shell.overlays[k7]?.isShown))")
  check("1: its page took B's window in place, not loaded again", await waitJS(o7.webView, "return window.marginApp && document.querySelectorAll('.chip').length > 0") && o7.isReady)
  // Tirth, 2026-11-07: after a switch the sidebar showed the new space's tabs, then another space's: the handed page
  // was given the old window's hello (built before its key changed), and went on drawing window 7.
  let drawsFor = await js(o7.webView, "return marginApp.windowId()") as? Int
  check("1: the kept sidebar's page draws for B's window (8) now, not A's (7)", drawsFor == 8, "\(String(describing: drawsFor))")
  let activeChip = "const c = document.querySelector('.chip.active'); return c ? (c.classList.contains('foreign') ? 'foreign ' : '') + c.getAttribute('data-space-id') : null"
  let chip1 = await js(o7.webView, activeChip) as? String
  try? await Task.sleep(nanoseconds: 1_500_000_000)
  let chip2 = await js(o7.webView, activeChip) as? String
  let chipsSeen = await js(o7.webView, "return [...document.querySelectorAll('.chip')].map((c) => c.getAttribute('title') + (c.classList.contains('active') ? ' [active]' : '') + (c.classList.contains('foreign') ? ' [foreign]' : '') + (c.classList.contains('switching') ? ' [switching]' : '')).join(' | ')") as? String ?? "-"
  check("1: the kept sidebar shows the space switched to (P2's home, its own now), and still does 1.5 s on", chip1 == "home" && chip2 == "home",
        "\(chip1 ?? "nil") then \(chip2 ?? "nil"); chips: \(chipsSeen)")
  check("1: P1's copy told its window is parked", await until(3, { parkedSaid("A", 7, true, mark) }))
  check("1: A's drawn stayed on through the park", !drawnOff("A", 7, mark))
  check("1: no layout to the parked window", fake.first("setLayout", since: mark) { $0["id"] as? String == "A" && int(($0["msg"] as? JSONObject)?["windowId"]) == 7 } == nil)
  check("1: the own-Space checks left the switch's windows alone", !seen.suspected && !shell.ownSpaceFellBack)
  let hello = shell.overlays[k7].flatMap { (try? JSONSerialization.jsonObject(with: Data(shell.hello(for: $0).utf8))) as? JSONObject }
  check("1: the parked window's hello says full screen though its copy says normal", hello?["mode"] as? String == "fullscreen"
        && ExtWindow.parse(shell.links["safari:P1"]?.mirror.windows ?? [], link: "safari:P1").first?.state == "normal")
  // Its copy's list again (the window still normal): held from its overlay.
  let pushes7 = shell.windowsPushes[k7] ?? 0
  fake.tell(["do": "windows", "id": "A", "list": [box(normal1).merging(["windowId": 7, "state": "normal", "focused": false, "activeTabId": 12]) { $1 }]])
  try? await Task.sleep(nanoseconds: 300_000_000)
  check("1: no windows push to the parked window's overlay", (shell.windowsPushes[k7] ?? 0) == pushes7 && shell.windowsHeld.contains(k7), "\(shell.windowsPushes)")
  // A palette for the parked window (its new-tab page): dropped, with no drawn off and no paletteDropped.
  mark = fake.events.count
  fake.tell(["do": "send", "id": "A", "msg": ["k": "push", "windowId": 7, "msg": ["type": "palette", "newTab": true]]])
  try? await Task.sleep(nanoseconds: 1_700_000_000)
  check("1: a palette for the parked window dropped quietly", !drawnOff("A", 7, mark) && reqs("A", "paletteDropped", mark).isEmpty && !shell.holdsPalette(k7))

  // ---- 2. P2 → P1: the parked target; its overlay from the app's reads; the keys mid-switch ----
  fake.tell(["do": "play", "id": "A", "play": ["listLagMs": 500]])
  let p1Spaces = (shell.links["safari:P1"]?.mirror.value("spaces") as? [Any] ?? []).compactMap { ($0 as? JSONObject)?["id"] as? String }
  guard p1Spaces.count >= 2, let o8 = shell.overlays[k8] else { return check("P1's spaces and P2's overlay", false) }
  try? await Task.sleep(nanoseconds: 300_000_000) // past the cooldown
  mark = fake.events.count
  seen.watching = true
  Task { @MainActor in
    while seen.watching {
      if shell.suspectsOwnSpace(k7) || shell.suspectsOwnSpace(k8) { seen.suspected = true }
      if seen.bShownWhile == nil, shell.overlays[k7]?.isShown == true {
        seen.bShownWhile = ExtWindow.parse(shell.links["safari:P1"]?.mirror.windows ?? [], link: "safari:P1").first { $0.key == k7 }?.state
      }
      if !seen.pressed, shell.switcher.phase == .frozen {
        seen.pressed = true
        keys.press("Alt+Meta+ArrowRight")
        keys.press("Meta+KeyT")
      }
      try? await Task.sleep(nanoseconds: 4_000_000)
    }
  }
  let runs = shell.switcher.session.runs
  shell.performAcross(from: o8, "profile.switch", ["profile": "P1", "space": p1Spaces[0]])
  let done2 = await until(8, { !shell.switcher.busy && seen.pressed })
  seen.watching = false
  check("2: done, to the parked window", done2 && shell.switcher.session.lines.last?.contains("parked target") == true, "\(shell.switcher.session.lines.last ?? "-")")
  check("2: B's overlay shown from the app's reads, before its copy said full screen", seen.bShownWhile == "normal", "\(String(describing: seen.bShownWhile))")
  check("2: the hot keys stayed on mid-switch: the space key asked of the switch, ⌘T dropped", shell.switcher.history.contains { $0.contains("asked mid-switch") }
        && o7.paletteKeyAt == nil && o8.paletteKeyAt == nil && reqs("A", "navigate", mark).isEmpty && reqs("B", "navigate", mark).isEmpty, "\(shell.switcher.history.suffix(8))")
  check("2: the queued space shown in the window landed on, no second handoff", await until(3, { reqs("A", "setSpace", mark).contains { payload($0)["spaceId"] as? String == p1Spaces[1] && int(payload($0)["windowId"]) == 7 } })
        && shell.switcher.session.runs == runs + 1)
  let told2 = await until(3, { parkedSaid("A", 7, false, mark) && parkedSaid("B", 8, true, mark) })
  check("2: 7 shown and no longer parked, 8 parked, each copy told", shell.parking?.isParked(n7) == false && shell.parking?.isParked(n8) == true && told2)
  check("2: drawn on for 7 through the show", !drawnOff("A", 7, mark))
  check("2: the own-Space checks left the switch's windows alone", !seen.suspected && !shell.ownSpaceFellBack)
  check("2: its overlay hears the list once its copy says full screen", await until(3, { !shell.windowsHeld.contains(k7) && (shell.windowsPushes[k7] ?? 0) > pushes7 }))

  // ---- 3. a wake: a parked window back by itself is parked again, never handed off ----
  try? await Task.sleep(nanoseconds: 300_000_000)
  mark = fake.events.count
  let runs3 = shell.switcher.session.runs
  apps.onChange?("woke")
  world.comeBack(n8, to: windows.desktop)
  shell.burst("test: a wake")
  check("3: back after a wake: parked again, quietly", await until(3, { world.spaces(of: n8) == [] && shell.parking?.entries[n8]?.phase == .parked }))
  // Its copy heard focus on it as macOS brought it back: the system's too, so no handoff either (§2.6).
  fake.tell(["do": "send", "id": "B", "msg": ["k": "push", "windowId": 8, "msg": ["type": "parkedActivity", "windowId": 8, "why": "focus"]]])
  try? await Task.sleep(nanoseconds: 300_000_000)
  check("3: no handoff for it", shell.switcher.session.runs == runs3 && !shell.switcher.busy && reqs("B", "setWindowState", mark).isEmpty)

  // ---- 4. a parked window used: none while a switch is busy, then one handoff to it ----
  check("4: the wake's 3 s over", await until(4, { shell.parking?.inSystemWindow == false }))
  shell.switcher.start(.init(profile: "safari:P9", space: "x"), from: "safari:P1", windowId: 7) // waits for a profile that isn't open
  // (Its window asked for under a freeze first, which Safari can't be here: revealed at once, then waiting.)
  check("4: a switch waiting for a profile", await until(2, { shell.switcher.phase == .waitingForProfile }), "\(shell.switcher.phase)")
  fake.tell(["do": "send", "id": "B", "msg": ["k": "push", "windowId": 8, "msg": ["type": "parkedActivity", "windowId": 8, "why": "focus"]]])
  check("4: used while a switch is busy: left", await until(2, { shell.activitySaid.contains(k8) }))
  shell.switcher.start(.init(profile: "safari:P1", space: p1Spaces[1]), from: "safari:P1", windowId: 7) // back: the wait ends
  check("4: …and no handoff from it", await until(2, { !shell.switcher.busy }) && shell.parking?.isParked(n8) == true)
  try? await Task.sleep(nanoseconds: 300_000_000)
  mark = fake.events.count
  fake.tell(["do": "send", "id": "B", "msg": ["k": "push", "windowId": 8, "msg": ["type": "parkedActivity", "windowId": 8, "tabId": 13, "why": "tab"]]])
  fake.tell(["do": "send", "id": "B", "msg": ["k": "push", "windowId": 8, "msg": ["type": "parkedActivity", "windowId": 8, "why": "focus"]]])
  check("4: used while parked: a handoff to that window", await until(3, { shell.switcher.busy && shell.switcher.target?.profile == "safari:P2" }))
  check("4: done, 8 in front, 7 parked", await until(8, { !shell.switcher.busy }) && shell.parking?.isParked(n7) == true && world.window(n8)?.onScreen == true,
        "\(shell.switcher.session.lines.last ?? "-")")
  check("4: one handoff for the burst", reqs("B", "setWindowState", mark).filter { payload($0)["state"] as? String == "fullscreen" }.count == 1)

  // ---- 5. a dialog over A: no handoff, and the notice says why ----
  try? await Task.sleep(nanoseconds: 300_000_000)
  windows.extra = [ServerWindow(number: 4711, pid: browserPid, bounds: full.insetBy(dx: 400, dy: 250))]
  mark = fake.events.count
  shell.performAcross(from: o8, "profile.switch", ["profile": "P1", "space": p1Spaces[0]])
  check("5: a dialog in A blocks the switch, with its notice", await until(2, { !shell.switcher.busy }) && shell.switchNotice?["noticeKind"] as? String == "dialog-open"
        && reqs("B", "setWindowState", mark).isEmpty && reqs("A", "setWindowState", mark).isEmpty, "\(String(describing: shell.switchNotice))")
  windows.extra = []

  // ---- 6. the shown window closed by the person: every parked window closes too (§13.8) ----
  mark = fake.events.count
  let runs6 = shell.switcher.session.runs
  fake.tell(["do": "windows", "id": "B", "list": [JSONObject]()])
  windows.remove(n8)
  numbers["B#8"] = nil
  check("6: ⌘W on the shown window: its parked windows closing", await until(3, { shell.parkedEnding }))
  // The parked window made key as the shown one went (§6.6): its copy says it was used. Not handed off to.
  fake.tell(["do": "send", "id": "A", "msg": ["k": "push", "windowId": 7, "msg": ["type": "parkedActivity", "windowId": 7, "why": "focus"]]])
  check("6: ⌘W on the shown window: the parked one closed by its copy", await until(4, { reqs("A", "closeWindow", mark).contains { int(payload($0)["windowId"]) == 7 } }))
  check("6: … and its use meanwhile started no handoff", shell.switcher.session.runs == runs6 && reqs("A", "setWindowState", mark).isEmpty, "\(shell.switcher.history.suffix(3))")
  check("6: nothing parked any more", await until(3, { shell.parking?.entries.isEmpty == true && world.windows[n7] == nil }))

  // ---- 7. a new window, then a switch to a profile with none: the create variant; then quit ----
  try? await Task.sleep(nanoseconds: 300_000_000)
  let n9 = windows.add(full, fullScreen: true)
  numbers["A#9"] = n9
  normals[n9] = normal1
  fake.tell(["do": "windows", "id": "A", "list": [box(full).merging(["windowId": 9, "state": "fullscreen", "focused": true, "activeTabId": 13]) { $1 }]])
  let k9 = WindowKey(link: "safari:P1", windowId: 9)
  guard await until(10, { shell.overlays[k9]?.isShown == true }), let o9 = shell.overlays[k9] else { return check("7: the person's new window drawn", false, "\(shell.matches)") }
  mark = fake.events.count
  shell.performAcross(from: o9, "profile.switch", ["profile": "P2", "space": "home"])
  check("7: done, a new window made for P2 under the freeze", await until(10, { !shell.switcher.busy }) && shell.switcher.session.lines.last?.contains("new window") == true
        && reqs("B", "openSpaceWindow", mark).count == 1 && reqs("B", "setWindowState", mark).isEmpty, "\(shell.switcher.session.lines.last ?? "-")")
  let k95 = WindowKey(link: "safari:P2", windowId: 95)
  check("7: the new window's overlay shown, 9 parked", await until(5, { shell.overlays[k95]?.isShown == true }) && shell.parking?.isParked(n9) == true)

  // ---- 8. Safari in front with every window parked, no switch to explain it (§6.2): the last shown ----
  try? await Task.sleep(nanoseconds: 300_000_000)
  guard let n95 = numbers["B#95"] else { return check("8: the made window's stand-in", false) }
  world.windows[n95]?.spaces = [] // gone from every user Space, by no doing of Margin's
  apps.bringToFront(1)
  shell.burst("test: another app")
  try? await Task.sleep(nanoseconds: 200_000_000)
  mark = fake.events.count
  apps.bringToFront(browserPid)
  check("8: a handoff with no window to leave, to the window last parked", await until(3, { shell.switcher.busy && shell.switcher.target?.profile == "safari:P1" && shell.switcher.leaving == nil }),
        "\(shell.switcher.history.suffix(3))")
  check("8: done, 9 in front again", await until(8, { !shell.switcher.busy }) && world.window(n9)?.onScreen == true && shell.parking?.isParked(n9) == false
        && shell.switcher.session.lines.last?.contains("keep") == true, "\(shell.switcher.session.lines.last ?? "-")")
  // Back to P2's window (still the copy's, in full screen as it says), so one is parked for the quit.
  try? await Task.sleep(nanoseconds: 300_000_000)
  guard let o9again = shell.overlays[k9], await until(5, { o9again.isShown }) else { return check("8: 9's overlay back", false) }
  shell.performAcross(from: o9again, "profile.switch", ["profile": "P2", "space": "home"])
  check("8: then to P2's window again: 9 parked", await until(8, { !shell.switcher.busy }) && shell.parking?.isParked(n9) == true, "\(shell.switcher.session.lines.last ?? "-")")

  // ---- 9. Safari restored a window Margin had parked before it quit (Tirth, 2026-11-07): its copy says so
  // (`wasParked`, background/parked-restore.ts); the app closes it by its copy, once. One Margin has parked now
  // (9: a Margin update keeps them alive and out of sight) isn't. ----
  let mark9 = fake.events.count
  fake.tell(["do": "windows", "id": "A", "list": [
    box(normal1).merging(["windowId": 9, "state": "normal", "focused": false, "activeTabId": 13, "wasParked": true]) { $1 },
    box(normal2).merging(["windowId": 31, "state": "normal", "focused": false, "activeTabId": 14, "wasParked": true]) { $1 },
  ]])
  let closed31 = await until(3, { reqs("A", "closeWindow", mark9).contains { int(payload($0)["windowId"]) == 31 } })
  try? await Task.sleep(nanoseconds: 600_000_000)
  check("9: a parked window Safari restored after a quit: closed by its copy, once", closed31 && reqs("A", "closeWindow", mark9).filter { int(payload($0)["windowId"]) == 31 }.count == 1,
        "\(reqs("A", "closeWindow", mark9).map { payload($0) })")
  check("9: one Margin has parked now: left alone, still parked", !reqs("A", "closeWindow", mark9).contains { int(payload($0)["windowId"]) == 9 } && shell.parking?.isParked(n9) == true)
  fake.tell(["do": "windows", "id": "A", "list": [box(normal1).merging(["windowId": 9, "state": "normal", "focused": false, "activeTabId": 13]) { $1 }]])
  try? await Task.sleep(nanoseconds: 300_000_000)

  // ---- 10. ⌘Q in Safari with a window parked (Tirth, 2026-11-07): Margin's first, the parked window closed by its
  // copy, then the keys passed on to Safari. ----
  let mark10 = fake.events.count
  check("10: with Safari in front and a window parked, ⌘Q is Margin's first", await until(3, { keys.held.values.contains(Combo.parse("Meta+KeyQ")!) }))
  // Over Margin's layout: Margin's prompt first. Cancel: nothing closed, nothing passed on.
  keys.press("Meta+KeyQ")
  check("10: ⌘Q over Margin's layout: Margin's quit prompt, nothing done yet", shell.quitPrompt != nil && passedQuit.isEmpty && reqs("A", "closeWindow", mark10).isEmpty)
  shell.quitPrompt?.choose(.cancel)
  try? await Task.sleep(nanoseconds: 400_000_000)
  check("10: cancelled: no window closed, Safari not told to quit, the prompt gone", shell.quitPrompt == nil && passedQuit.isEmpty && reqs("A", "closeWindow", mark10).isEmpty)
  // Again, and Quit (its button).
  keys.press("Meta+KeyQ")
  guard let prompt10 = shell.quitPrompt, let quitButton = (prompt10.contentView as? QuitPromptView)?.buttons.first(where: { $0.title == "Quit" }) else { return check("10: the prompt again", false) }
  quitButton.press()
  let asked10 = await until(3, { reqs("A", "closeWindow", mark10).contains { int(payload($0)["windowId"]) == 9 } })
  check("10: the parked window closed by its copy before Safari quits", asked10, "\(reqs("A", "closeWindow", mark10).map { payload($0) })")
  check("10: then ⌘Q passed on to Safari, once, not keeping windows", await until(3, { passedQuit.count == 1 }) && passedQuit.first?.0 == browserPid && passedQuit.first?.1 == false,
        "\(passedQuit.map { "\($0.0) \($0.1)" })")
  check("10: ⌘Q let go meanwhile (the keys passed on reach Safari)", !keys.held.values.contains(Combo.parse("Meta+KeyQ")!))
  check("10: asked again after a plain Quit (only Always quit stops it)", asksBeforeQuit)
  // (Safari didn't really quit here: back to P1, a window made for it, so P2's is parked for Margin's own quit.)
  try? await Task.sleep(nanoseconds: 2_200_000_000)
  guard let o95 = shell.overlays[k95], await until(5, { o95.isShown }) else { return check("10: P2's window still shown", false) }
  shell.performAcross(from: o95, "profile.switch", ["profile": "P1", "space": p1Spaces[0]])
  check("10: then to P1 again: P2's window parked", await until(10, { !shell.switcher.busy }) && shell.parking?.entries.isEmpty == false, "\(shell.switcher.session.lines.last ?? "-")")
  // Always quit: no prompt from then on; the parked window still closed first, then the keys passed on.
  try? await Task.sleep(nanoseconds: 2_200_000_000)
  check("10: ⌘Q Margin's again (a window parked)", await until(3, { keys.held.values.contains(Combo.parse("Meta+KeyQ")!) }))
  let markAlways = fake.events.count
  let parkedBefore = shell.parking?.entries.values.compactMap(\.key) ?? []
  keys.press("Meta+KeyQ")
  (shell.quitPrompt?.contentView as? QuitPromptView)?.buttons.first(where: { $0.title == "Always quit" })?.press()
  let copyOf = { (k: WindowKey) in k.link == "safari:P1" ? "A" : "B" }
  let closedAlways = await until(3, { parkedBefore.allSatisfy { k in reqs(copyOf(k), "closeWindow", markAlways).contains { int(payload($0)["windowId"]) == k.windowId } } })
  let passedAlways = await until(3, { passedQuit.count == 2 })
  check("10: Always quit: the parked window closed, the keys passed on, and not asked again", !parkedBefore.isEmpty && closedAlways && passedAlways && !asksBeforeQuit,
        "\(parkedBefore) \(passedQuit.count) \(asksBeforeQuit)")
  // DEV-HOOK: the development switch in Settings turns the prompt back on.
  check("10: after Always quit, the app tells Settings the prompt is off", shell.devSwitches()["askBeforeQuit"] as? Bool == false)
  if let shown = shell.overlays.values.first(where: { $0.isShown }) { shell.performAcross(from: shown, "switch.askBeforeQuit", ["on": true]) }
  check("10: the development switch turns it back on", asksBeforeQuit && shell.devSwitches()["askBeforeQuit"] as? Bool == true)
  // (Back again for Margin's own quit below.)
  try? await Task.sleep(nanoseconds: 2_200_000_000)
  guard let o95b = shell.overlays[k95] ?? shell.overlays.values.first(where: { $0.isShown }), await until(5, { o95b.isShown }) else { return check("10: a window shown again", false) }
  shell.performAcross(from: o95b, "profile.switch", ["profile": o95b.key.link == "safari:P1" ? "P2" : "P1", "space": o95b.key.link == "safari:P1" ? "home" : p1Spaces[0]])
  check("10: switched again: a window parked for Margin's quit", await until(10, { !shell.switcher.busy }) && shell.parking?.entries.isEmpty == false, "\(shell.switcher.session.lines.last ?? "-")")
  let parkedAtQuit = (shell.parking?.entries.values.compactMap(\.key) ?? [])
  mark = fake.events.count
  var stopped = false
  shell.stop { stopped = true }
  let copyId = { (k: WindowKey) in k.link == "safari:P1" ? "A" : "B" }
  check("quit: every parked window closed by its copy, then the rest", await until(3, { stopped }) && !parkedAtQuit.isEmpty
        && parkedAtQuit.allSatisfy { k in reqs(copyId(k), "closeWindow", mark).contains { int(payload($0)["windowId"]) == k.windowId } }
        && shell.parking?.entries.isEmpty == true, "\(parkedAtQuit)")
  check("quit: the crash marker gone", !FileManager.default.fileExists(atPath: shell.parkingMarkerURL.path))
  check("nothing the app sent was over 1 MB", fake.first("tooBig") == nil)
  for w in windows.stands.values { w.close() }
}
