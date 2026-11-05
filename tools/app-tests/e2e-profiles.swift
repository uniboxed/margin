// Spaces across profiles end to end (part of e2e.swift's run): the real link,
// shell and overlays against fake-extension.mjs playing two Safari profiles,
// P1 with a full-screen window and P2 with none, in a temporary data folder.
// The overlay over P1's window draws every space of both profiles in one
// order with P2's marked; a click on P2's space has the app drive the switch:
// P2's copy opens its window (a stand-in window, off screen, in front as its
// full-screen Space would be), and only then is P1's window closed, so one
// window is left, with its overlay drawing P2's spaces. Then the previous-space
// key goes back across, and a profile renamed is in every overlay and on disk.
import AppKit

@MainActor
func profilesScenario() async {
  let fake = Fake()
  do { try fake.start() } catch { return check("profiles: the fake extension starts", false, "\(error)") }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("profiles: the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-profiles-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }

  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("io.tirth.margin.test.profiles.\(ProcessInfo.processInfo.processIdentifier)"),
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
  check("switch: done, one window left (P2's)", await until(5, { !shell.switcher.busy }) && shell.switcher.history.last?.hasPrefix("done") == true
        && (shell.links["safari:P1"]?.mirror.windows.isEmpty ?? false) && shell.links["safari:P2"]?.mirror.windows.count == 1, "\(shell.switcher.history)")
  let k90 = WindowKey(link: "safari:P2", windowId: 90)
  check("switch: P2's window gets its overlay, P1's goes", await until(15, { shell.overlays[k90]?.isShown == true && shell.overlays[k7] == nil }))
  guard let o90 = shell.overlays[k90] else { return }
  do { let ok = await waitJS(o90.webView, "const c = [...document.querySelectorAll('.chip')]; return c.length === 5 && c.filter((x) => x.classList.contains('foreign')).length === 3 && c.find((x) => x.classList.contains('active'))?.getAttribute('title') === 'Office · Profile 2'"); let seen = "\(await js(o90.webView, chips) ?? "")"; check("switch: P2's overlay draws the same order, P1's spaces marked now, its space active", ok, seen) }

  // ---- ⌃⌘←: the previous space in the one order is in the same profile: today's switch ----
  mark = fake.events.count
  keys.press("Ctrl+Meta+ArrowLeft")
  check("key, same profile: the copy's own navigate", await until(3, { fake.first("req", since: mark) { ($0["msg"] as? JSONObject)?["type"] as? String == "navigate" && $0["id"] as? String == "B" } != nil }))
  // ⌃⌘→ from Office (last): wraps to P1's first space: across again.
  try? await Task.sleep(nanoseconds: 1_600_000_000) // past the keys' chaining
  mark = fake.events.count
  keys.press("Ctrl+Meta+ArrowRight")
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
}
