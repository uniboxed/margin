// Opening Margin through the real shell (part of e2e.swift's run;
// app/platforms/macos/shell/ShellEnter.swift): the real link and shell against
// fake-extension.mts, a stand-in for the running apps, and a recorder in place
// of NSWorkspace (no browser is opened).
//
// What it follows: Margin opened with no browser running opens one, once, and
// waits; its copy linked and its window listed, that window is asked for in
// full screen and in front, once; opened again with two windows, the one used
// last is asked for and the browser brought to the front; two asks at once are
// one request, both answered; nothing linking within the wait is a failure the
// app can show its set-up window for; quitting ends one under way.
import AppKit

final class EnterApps: AppWatch {
  var running = false
  var frontPid: pid_t? = 1
  var onChange: ((String) -> Void)?
  func pids(of bundleId: String) -> Set<pid_t> { running && bundleId == fakeBundle ? [browserPid] : [] }
  func start() {}
  func stop() {}
}

@MainActor
func enterScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("open: \(label)", ok, detail()) }
  let fake = Fake()
  do { try fake.start() } catch { check("fake extension starts", false); return }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { check("fake extension starts", false); return }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-enter-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.enter.\(ProcessInfo.processInfo.processIdentifier)"))
  let windows = ScriptedWindows(), apps = EnterApps()
  var opened: [String] = []
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root
  options.bundleIds = ["safari": fakeBundle]
  options.enter = true
  options.enterWait = 2
  options.enterEvery = 0.05
  options.openBrowser = { opened.append($0); return true }
  var saw: [String] = []
  options.sawBrowser = { saw.append($0) }
  let shell = Shell(link: link, windows: windows, apps: apps, hotKeys: FakeKeys(), options: options)
  windows.shell = shell
  shell.start()
  var stopped = false
  defer { if !stopped { shell.stop {} } }
  guard await until(3, { link.port != nil }) else { check("link listens", false); return }
  func focusAsks(since: Int = 0) -> [JSONObject] {
    fake.all("req", since: since) { ($0["msg"] as? JSONObject)?["type"] as? String == "focusWindow" }.compactMap { ($0["msg"] as? JSONObject)?["payload"] as? JSONObject }
  }
  func win(_ id: Int, state: String = "normal", focused: Bool = false, focusedAt: Double? = nil) -> JSONObject {
    var w: JSONObject = ["windowId": id, "left": -20000, "top": -20000, "width": 1200, "height": 800, "state": state, "focused": focused]
    if let focusedAt { w["focusedAt"] = focusedAt }
    return w
  }
  let key = WindowKey(link: "safari:P", windowId: 1)

  // ---- no browser running: one opened, once, and waited for ----
  var results: [EnterResult] = []
  shell.enter { results.append($0) }
  check("no browser running: Margin's last browser is opened at once", opened == [fakeBundle], "\(opened)")
  try? await Task.sleep(nanoseconds: 400_000_000)
  check("waiting for it: not opened a second time", opened.count == 1, "\(opened)")
  check("waiting for it: nothing answered, no window asked for", results.isEmpty && focusAsks().isEmpty && shell.entering != nil)

  // ---- its copy links with a window: asked for in full screen, once ----
  apps.running = true
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { check("link requested", false); return }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { check("linked", false); return }
  fake.tell(["do": "connect", "id": "P", "profile": "P", "windows": [win(1, focused: true)]])
  guard await until(5, { !results.isEmpty }) else { check("its copy linked with a window: answered", false, "\(opened) \(focusAsks())"); return }
  check("its copy linked with a window: that window is the answer", results == [.window(key)], "\(results)")
  let asks = focusAsks()
  check("the window asked of its copy once, in full screen", asks.count == 1 && int(asks.first?["windowId"]) == 1 && asks.first?["fullscreen"] as? Bool == true, "\(asks)")
  check("the browser started for it isn't opened again", opened.count == 1, "\(opened)")
  check("nothing left under way", shell.entering == nil)
  check("the browser linked is told (the one opened next time)", saw == ["safari"], "\(saw)")

  // ---- opened again, two windows: the one used last, the browser brought forward; two asks, one request ----
  let now = Date().timeIntervalSince1970 * 1000
  fake.tell(["do": "windows", "id": "P", "list": [win(1, focusedAt: now - 60_000), win(2, state: "fullscreen", focusedAt: now - 5_000)]])
  guard await until(3, { shell.windows(of: "safari:P").count == 2 }) else { check("two windows listed", false); return }
  let mark = fake.events.count
  var again: [EnterResult] = [], both: [EnterResult] = []
  shell.enter { again.append($0) }
  shell.enter { both.append($0) }
  guard await until(5, { !again.isEmpty && !both.isEmpty }) else { check("opened again: answered", false); return }
  let second = WindowKey(link: "safari:P", windowId: 2)
  check("opened again: the window used last", again == [.window(second)] && both == [.window(second)], "\(again) \(both)")
  let asks2 = focusAsks(since: mark)
  check("two asks at once are one request", asks2.count == 1 && int(asks2.first?["windowId"]) == 2 && asks2.first?["fullscreen"] as? Bool == true, "\(asks2)")
  check("its browser brought to the front (opened once more)", opened == [fakeBundle, fakeBundle], "\(opened)")

  // ---- nothing links: a failure, said ----
  fake.tell(["do": "close", "id": "P"])
  guard await until(5, { shell.links.isEmpty }) else { check("its link closed", false); return }
  apps.running = false
  var failed: [EnterResult] = []
  let started = Date()
  shell.enter { failed.append($0) }
  guard await until(5, { !failed.isEmpty }) else { check("nothing links: answered", false); return }
  let took = Date().timeIntervalSince(started)
  var why = ""
  if case .failed(let text)? = failed.first { why = text }
  check("nothing links within the wait: a failure that says so", why.contains("no browser's copy of Margin linked"), "\(failed)")
  check("only after the wait", took >= 1.9 && took < 4, "\(took)")
  check("the browser opened for it once", opened.count == 3, "\(opened)")

  // ---- quitting ends one under way ----
  var quit: [EnterResult] = []
  shell.enter { quit.append($0) }
  stopped = true
  shell.stop {}
  guard await until(3, { !quit.isEmpty }) else { check("quitting: answered", false); return }
  check("quitting ends one under way", quit == [.failed("Margin is quitting")] && shell.entering == nil, "\(quit)")
}
