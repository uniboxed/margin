// A slow Safari copy never leaves Margin stuck (docs/LINK-RESILIENCE.md, both parts joined; part of e2e.swift's run,
// MARGIN_E2E_ONLY=resilience alone): the shell, the session and the engine (the stand-in window manager) over the real
// link, against fake-extension.mts's `stall` mode. While the copy is stalled (alive: its window reports keep coming,
// nothing it reads handled), an app picked after a web item's tab switch is shown at once and the switch cancelled; a
// pick in another Margin window is shown at once too, the stalled show's window keeping its item as its card; a show
// whose link closed lands once its copy links again, its window still there, Safari's menu never pressed for it.
import AppKit

@MainActor
func resilienceScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("resilience: \(label)", ok, detail()) }
  let started = Date()
  let fake = Fake()
  do { try fake.start() } catch { return check("the fake extension starts", false, "\(error)") }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-resilience-\(UUID().uuidString)")
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
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.resilience.\(ProcessInfo.processInfo.processIdentifier)"))
  let shell = Shell(link: link, apps: ScriptedApps(), hotKeys: FakeKeys(), options: options)
  shell.start()
  var stopped = false
  defer { if !stopped { shell.stop {} } }
  guard await until(3, { link.port != nil }) else { return check("the link listens", false) }
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { return check("the link asked for", false) }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { return check("linked", false) }
  let newWindow: JSONObject = ["left": -20000, "top": -20000, "width": 1200, "height": 800]
  func connect() { fake.tell(["do": "connect", "id": "S", "profile": "s-default", "windows": [], "newWindow": newWindow]) }
  connect()
  guard await until(5, { shell.isLinked("safari:s-default") }) else { return check("the copy linked", false) }

  let made = shell.makeMarginWindows()
  let library = shell.library
  guard let session = shell.hosted, let engine = shell.host else { return check("the library, the session and the engine", false) }
  _ = made.source.perform("updateSettings", ["patch": ["sidebarPinnedOpen": true]])
  let c = made.open()
  defer { made.closeAll() }
  world.marginWindow = c.window.windowNumber
  c.hostedBounds = { world.bounds(window: $0) }
  world.display = c.contentFrame
  // (Safari's window its copy makes, and its full screen, in the stand-in window manager too: as e2e-glue.swift.)
  let ask = engine.requestSafariWindow
  engine.requestSafariWindow = { profile in
    let made = await ask?(profile)
    if made != nil, let pid = world.running(bundleId: safariIdentifier).first?.pid { world.addWindow(pid) }
    return made
  }
  let fullScreen = engine.safariFullScreen
  engine.safariFullScreen = { profile, id, on in
    let ok = await fullScreen?(profile, id, on) ?? false
    if ok, let host = engine.hosts.values.first(where: { $0.safariWindow == id }) { _ = await world.setFullScreen(pid: host.pid, window: host.window, on) }
    return ok
  }
  guard await until(15, { c.isReady }) else { return check("Margin's window's page drawn", false) }
  let space = library.spaces().first?.id ?? ""
  func add(_ value: JSONObject) -> String { ((library.perform("addItem", value.merging(["spaceId": space]) { a, _ in a }).result as? JSONObject)?["tabId"] as? String) ?? "" }
  let safari = HostTarget.safariWindow("s-default").id, notes = HostTarget.app("com.apple.Notes").id
  // The copy's window reports while it's stalled: alive (any bytes), never reading.
  func reporting(while going: @escaping () -> Bool) {
    Task { @MainActor in
      while going() {
        fake.tell(["do": "windows", "id": "S", "list": []])
        try? await Task.sleep(nanoseconds: 300_000_000)
      }
    }
  }
  func stall(_ ms: Int) async {
    let mark = fake.events.count
    fake.tell(["do": "stall", "id": "S", "ms": ms])
    _ = await until(2, { fake.first("stalled", since: mark) != nil })
  }
  func drain() async {
    let mark = fake.events.count
    fake.tell(["do": "stall", "id": "S", "ms": 0])
    var draining = true
    reporting(while: { draining })
    _ = await until(15, { fake.first("drained", since: mark) != nil })
    draining = false
  }

  // ---- a web item shown: its window and its tab ----
  _ = library.perform("newTab", ["windowId": c.id, "url": "https://one.example/", "title": "One"])
  let w1 = library.items().first { $0.value["url"] as? String == "https://one.example/" }?.id ?? ""
  guard await until(10, { engine.shown == safari && session.shown[c.id] == w1 }) else { return check("a web item shown", false, "\(session.done.suffix(6))") }
  await session.idle()
  let w2 = add(["url": "https://two.example/", "title": "Two"])
  let app = add(["target": ItemTarget.app(bundleId: "com.apple.Notes", name: "Notes").json])

  // ---- the copy stalled: a tab switch waits for it; an app picked meanwhile is shown at once, the switch cancelled ----
  await stall(8000)
  var stalled = true
  reporting(while: { stalled })
  var mark = fake.events.count
  let pushMark = c.pushed.count
  _ = library.perform("activateTab", ["windowId": c.id, "tabId": w2])
  _ = await until(1, { c.showingLabel == "Two" })
  let waiting = session.shown[c.id] == w1 && c.showingLabel == "Two"
  // (Its copy slow for `slowSay`, 3 s: the loader says so, "Safari is slow…" drawn by the page over the loader.)
  let saidSlow = await until(5, { c.pushed.dropFirst(pushMark).contains { $0.contains(#""type":"pageState","state":"loading""#) && $0.contains(#""slow":true"#) } })
  let drawnSlow = await waitJS(c.webView, "return document.querySelector('m-page-slow')?.textContent === 'Safari is slow\\u2026'")
  check("its copy slow for 3 s (no ack): its loader says so, the page drawing \"Safari is slow…\"", saidSlow && drawnSlow, "\(c.pushed.suffix(3))")
  let picked = Date()
  _ = library.perform("activateTab", ["windowId": c.id, "tabId": app])
  let atOnce = await until(2.5, { engine.shown == notes && session.shown[c.id] == app })
  let took = Date().timeIntervalSince(picked)
  check("a tab switch waiting for a stalled copy: its loader up (the item's title), the item shown before still shown", waiting, "\(String(describing: c.showingLabel)) \(String(describing: session.shown[c.id]))")
  check("an app picked meanwhile: shown at once (\(String(format: "%.1f", took)) s of an 8 s stall), the switch overtaken, never \"wasn't shown\"",
        atOnce && took < 2.5 && session.done.contains { $0.hasPrefix("\(w2): overtaken while its copy was asked for its tab") } && !session.done.contains { $0.contains("wasn't shown") },
        "\(String(describing: engine.shown)) \(session.done.suffix(4))")
  stalled = false
  await drain()
  check("the switch's request cancelled through the link: the copy dropped it before it ran (no tab of it shown)",
        fake.first("cancel", since: mark)?["started"] as? Bool == false && !fake.all("hostShow", since: mark).contains { ($0["payload"] as? JSONObject)?["itemId"] as? String == w2 },
        "\(String(describing: fake.first("cancel", since: mark))) \(fake.all("hostShow", since: mark).count)")
  await session.idle()

  // ---- its link closed while a show waits, its window still there: the show lands once the copy links again, Safari's
  // menu never pressed for it (its copy is only reconnecting) ----
  await stall(60_000)
  mark = fake.events.count
  let doneMark = session.done.count
  _ = library.perform("activateTab", ["windowId": c.id, "tabId": w1])
  _ = await until(2, { session.done.dropFirst(doneMark).isEmpty == false || c.showingLabel == "One" })
  fake.tell(["do": "close", "id": "S"])
  let went = await until(5, { !shell.isLinked("safari:s-default") && session.done.dropFirst(doneMark).contains { $0.contains("its copy's link went down") } })
  connect()
  let landed = await until(10, { engine.shown == safari && session.shown[c.id] == w1 })
  await session.idle()
  let lines = Array(session.done.dropFirst(doneMark))
  check("a show whose link closed: said, asked again once its copy linked again, shown", went && landed && lines.contains("\(w1): shown in Safari window 90"), "\(lines)")
  check("… with its window still there: no wake of the profile, Safari's menu never pressed", !lines.contains { $0.contains("a Safari profile") }, "\(lines)")

  // ---- a second Margin window: a pick there while the first's tab switch waits for the stalled copy, shown at once ----
  let other = made.open()
  _ = await until(5) { other.isFullScreen }
  guard await until(15, { other.isReady }) else { return check("a second Margin window's page drawn", false) }
  // (The stand-in window manager knows one Margin window in Margin's Space: the second one from now on.)
  other.hostedBounds = { world.bounds(window: $0) }
  world.marginWindow = other.window.windowNumber
  world.display = other.contentFrame
  await stall(4000)
  stalled = true
  reporting(while: { stalled })
  _ = library.perform("activateTab", ["windowId": c.id, "tabId": w2])
  _ = await until(1, { c.showingLabel == "Two" })
  let picked2 = Date()
  _ = library.perform("activateTab", ["windowId": other.id, "tabId": app])
  let app2 = app
  let there = await until(2.5, { engine.shown == notes && session.hostingWindow == other.id })
  let took2 = Date().timeIntervalSince(picked2)
  check("a pick in another Margin window while the first's show waits for its stalled copy: shown at once (\(String(format: "%.1f", took2)) s of a 4 s stall), the first's pick still wanted",
        there && took2 < 2.5 && session.requested[c.id] == w2 && !app2.isEmpty, "\(String(describing: engine.shown)) \(String(describing: session.hostingWindow)) \(session.done.suffix(4))")
  stalled = false
  await drain()
  _ = await until(5, { session.requested[c.id] == nil })
  await session.idle()
  check("… the copy answers after: its tab in front in Safari, the later pick keeps the engine, the first window keeps the item as its card",
        engine.shown == notes && session.hostingWindow == other.id && session.elsewhere[c.id] == w2 && session.done.contains { $0.hasPrefix("\(w2): its tab in front in Safari window") },
        "\(String(describing: engine.shown)) \(session.elsewhere) \(session.done.suffix(4))")
  // ---- Margin quits with its copy stalled (its Safari window still hosted, parked): the copy's requests made for the
  // quit waited for no longer than the engine's quitWait after the quit began, its window left in the marker ----
  await stall(60_000)
  stalled = true
  reporting(while: { stalled })
  let quitMark = session.done.count
  let quitAt = Date()
  var quitDone = false
  stopped = true
  var engineLines: [String] = []
  let echo = Diagnostics.echo
  Diagnostics.echo = { line in engineLines.append(line); echo?(line) }
  shell.stop { quitDone = true }
  let ended = await until(20, { quitDone })
  Diagnostics.echo = echo
  let quitTook = Date().timeIntervalSince(quitAt)
  stalled = false
  let wait = engine.options.quitWait
  let quitLines = Array(session.done.dropFirst(quitMark))
  check("Margin's quit with its copy stalled: over within the engine's quitWait (\(String(format: "%.1f", quitTook)) s of \(wait) s, not the link's 40 s)",
        ended && quitTook <= wait + 2, "\(quitLines)")
  // (The engine keeps it in its marker, closed by its poll or the next launch; here the Safari Margin started quits with
  // Margin, its windows with it, so the marker's entry goes after.)
  check("… its Safari window's close unanswered, said, and kept in the engine's marker to close later",
        quitLines.contains("at quit: closeWindow for s-default unanswered after quitWait (\(String(format: "%.1f", wait)) s): left in the marker")
          && engineLines.contains { $0.contains("Margin asked for wasn't closed") && $0.contains("kept in the marker, closed later") },
        "\(quitLines) \(engineLines.filter { $0.contains("marker") })")
  print(String(format: "  timings: the resilience scenario %.1f s", Date().timeIntervalSince(started)))
}
