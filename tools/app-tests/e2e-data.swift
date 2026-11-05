// Margin.app's lasting data end to end (part of e2e.swift's run): the real
// link and shell with their DataSync and DataStore, in a temporary folder,
// against fake-extension.mjs's data messages (its converter and refill are
// the extension's own, shared/data-set.js): the first link, a relink with a
// queue, a second profile kept apart, a wiped cache refilled, the app's own
// change, and a crash mid-write followed by a relaunch.
import AppKit

@MainActor
func dataScenario() async {
  let started = Date()
  let fake = Fake()
  do { try fake.start() } catch { return check("data: the fake extension starts", false, "\(error)") }
  guard await until(5, { fake.first("ready") != nil }) else { return check("data: the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-data-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let fm = FileManager.default
  let p1 = DataProfile(browser: "safari", profile: "P1"), p2 = DataProfile(browser: "safari", profile: "P2")
  // "P1" on disk: capitals written out (DataStore.fileName).
  let dir1 = root.appendingPathComponent("safari/%501"), dir2 = root.appendingPathComponent("safari/%502")

  // A shell with its data in `root`, linked to the fake (its own port and token: a launch of the app).
  var launches = 0
  func launch() async -> Shell? {
    launches += 1
    let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("io.tirth.margin.test.data.\(ProcessInfo.processInfo.processIdentifier).\(launches)"),
                          timing: .init(tick: 0.5, dead: 3, keep: 30, hello: 2, request: 5, safariSettled: 2))
    var options = Shell.Options()
    options.harness = true
    options.overlay.harness = true
    options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
    options.bundleIds = ["safari": fakeBundle]
    options.dataRoot = root
    let shell = Shell(link: link, windows: ScriptedWindows(), apps: ScriptedApps(), hotKeys: FakeKeys(), options: options)
    shell.start()
    guard await until(3, { link.port != nil }) else { return nil }
    let mark = fake.events.count
    fake.tell(["do": "wantLink"])
    guard await until(3, { fake.first("wantLink", since: mark) != nil }), let nonce = fake.first("wantLink", since: mark)?["nonce"] as? String else { return nil }
    link.wantLink(nonce: nonce)
    guard await until(3, { fake.first("link", since: mark) != nil }) else { return nil }
    return shell
  }
  func connect(_ id: String, _ profile: String, _ data: JSONObject) {
    fake.tell(["do": "connect", "id": id, "profile": profile, "theme": NSNull(), "data": data])
  }
  func close(_ id: String, _ shell: Shell, _ key: String) async -> Bool {
    let mark = fake.events.count
    fake.tell(["do": "close", "id": id])
    return await until(3, { fake.first("close", since: mark) { $0["id"] as? String == id } != nil && shell.links[key] == nil })
  }
  func change(_ c: String, _ id: String, _ at: Double, _ value: Any? = nil) -> JSONObject {
    value.map { ["collection": c, "id": id, "updatedAt": at, "value": $0] } ?? ["collection": c, "id": id, "updatedAt": at, "deleted": true]
  }
  func space(_ name: String, _ order: Int) -> JSONObject { ["name": name, "emoji": "", "color": "#000", "order": order] }
  func named(_ shell: Shell, _ p: DataProfile, _ space: String) -> String? { (shell.data.values("spaces", of: p)[space] as? JSONObject)?["name"] as? String }
  func ackIndex(_ since: Int, _ ev: String) -> Int? { fake.events.dropFirst(since).firstIndex { $0["ev"] as? String == ev } }

  guard var shell = await launch() else { return check("data: linked", false) }
  let t0 = (Date().timeIntervalSince1970 * 1000).rounded() - 60_000

  // ---- the first link: the converter's set, stored ----
  var mark = fake.events.count
  connect("A", "P1", ["acked": 0, "parts": 3, "now": t0, "icons": 20])
  check("data, first link: the app has no set and asks for the whole set", await until(5, { fake.first("dataNeed", since: mark) != nil })
        && fake.first("dataNeed", since: mark)?["all"] as? Bool == true && fake.first("dataNeed", since: mark)?["profile"] as? String == "P1")
  check("the converter's set (1.2 MB of site icons, in 3 parts) stored, then data.ack upTo its newest", await until(5, { fake.first("dataAck", since: mark) != nil })
        && num(fake.first("dataAck", since: mark)?["upTo"]) == t0, "\(fake.first("dataAck", since: mark) ?? [:])")
  check("no data.snapshot back on the first link", fake.first("dataSnapshot", since: mark) == nil)
  let collections = ["spaces", "pins", "folders", "tabs", "archive", "settings", "themeSettings", "siteIcons", "userThemes"]
  check("on disk: set.json and a file per collection", fm.fileExists(atPath: dir1.appendingPathComponent("set.json").path)
        && collections.allSatisfy { fm.fileExists(atPath: dir1.appendingPathComponent("items/\($0).json").path) },
        "\((try? fm.contentsOfDirectory(atPath: dir1.appendingPathComponent("items").path)) ?? [])")
  check("the read API: P1's spaces and site icons", named(shell, p1, "work") == "Deep Work" && shell.data.values("siteIcons", of: p1).count == 28 && shell.data.profiles().map(\.key) == ["safari:P1"])
  let tabs = shell.data.marginTabs(of: p1).count
  check("its Margin tabs: the copy's open tabs", tabs == 7, "\(tabs)")

  // ---- relinking with a queue ----
  check("the link closed", await close("A", shell, "safari:P1"))
  check("a profile not linked: all its Margin tabs not open", shell.notOpenTabs(p1).count == tabs && shell.notOpenTabs(p1, space: "work").count == 1)
  mark = fake.events.count
  let queue = [change("spaces", "work", t0 + 1000, space("Focus", 1)), change("pins", "pd", t0 + 1001),
               change("tabs", "t-queued0001", t0 + 1002, ["url": "https://queued.example/", "title": "Q", "icon": "", "spaceId": "work", "order": 9, "lastUsed": t0 + 1002])]
  connect("A2", "P1", ["acked": t0, "queue": queue])
  check("relink: the queue merged, the whole set sent back, then data.ack upTo the queue's newest", await until(5, { fake.first("dataAck", since: mark) != nil })
        && num(fake.first("dataAck", since: mark)?["upTo"]) == t0 + 1002 && (ackIndex(mark, "dataSnapshot") ?? .max) < (ackIndex(mark, "dataAck") ?? .min))
  let back = fake.first("dataSnapshot", since: mark) ?? [:]
  check("the set back in parts (over 1 MB in all), none over 1 MB", (back["parts"] as? Int ?? 0) >= 2 && (back["bytes"] as? Int ?? 0) > 1_000_000 && fake.first("tooBig") == nil,
        "\(back["parts"] ?? 0) parts, \(back["bytes"] ?? 0) bytes")
  check("with the queue in it", (back["spaces"] as? JSONObject)?["work"] as? String == "Focus" && (back["counts"] as? JSONObject)?["pins"] as? Int == 4 && (back["counts"] as? JSONObject)?["siteIcons"] as? Int == 28,
        "\(back["counts"] ?? [:])")
  let refilled = back["refilled"] as? JSONObject ?? [:]
  check("and the copy's cache refilled from it (stateFromDataSet)", (refilled["spaces"] as? [String]) == ["Home", "Focus", "Side"] && ((refilled["keptTabs"] as? [String]) ?? []).contains("t-queued0001"), "\(refilled)")
  check("on disk, the version before kept as a backup", (try? String(contentsOf: dir1.appendingPathComponent("items/spaces.json"), encoding: .utf8))?.contains("Focus") == true
        && fm.fileExists(atPath: dir1.appendingPathComponent("items/spaces.json.bak").path))

  // ---- a second profile, kept apart ----
  mark = fake.events.count
  connect("B", "P2", ["acked": 0, "now": t0])
  check("P2's first link: its own set", await until(5, { fake.first("dataAck", since: mark) { $0["id"] as? String == "B" } != nil }) && fm.fileExists(atPath: dir2.appendingPathComponent("set.json").path)
        && named(shell, p2, "work") == "Deep Work")
  let p1Spaces = try? Data(contentsOf: dir1.appendingPathComponent("items/spaces.json"))
  mark = fake.events.count
  fake.tell(["do": "dataChanges", "id": "B", "changes": [change("spaces", "home", t0 + 2000, space("P2 home", 0))]])
  check("a change from P2's copy: into P2's set", await until(5, { fake.first("dataAck", since: mark) { $0["id"] as? String == "B" } != nil }) && named(shell, p2, "home") == "P2 home")
  fake.tell(["do": "dataChanges", "id": "B", "profile": "P1", "changes": [change("spaces", "home", t0 + 3000, space("Hijack", 0))]])
  try? await Task.sleep(nanoseconds: 300_000_000)
  check("P1's set and files untouched by P2's copy, even when it names P1", named(shell, p1, "home") == "Home" && (try? Data(contentsOf: dir1.appendingPathComponent("items/spaces.json"))) == p1Spaces
        && fake.all("dataAck", since: mark) { $0["id"] as? String == "B" }.count == 1)

  // ---- a wiped cache ----
  check("P1's link closed", await close("A2", shell, "safari:P1"))
  mark = fake.events.count
  let fresh = t0 + 4000
  connect("A3", "P1", ["wiped": true, "acked": 0, "queue": [change("tabs", "t-sincewipe1", fresh, ["url": "https://after.example/", "title": "After", "icon": "", "spaceId": "home", "order": 1, "lastUsed": fresh])]])
  check("Safari wiped the copy's storage: the app's set back to it, with what it did since", await until(5, { fake.first("dataAck", since: mark) != nil })
        && num(fake.first("dataAck", since: mark)?["upTo"]) == fresh)
  let refill = (fake.first("dataSnapshot", since: mark)?["refilled"] as? JSONObject) ?? [:]
  check("its cache refilled: the spaces, pins and tabs it had lost", (refill["spaces"] as? [String]) == ["Home", "Focus", "Side"] && refill["pins"] as? Int == 4
        && ((refill["keptTabs"] as? [String]) ?? []).contains("t-queued0001") && ((refill["keptTabs"] as? [String]) ?? []).contains("t-sincewipe1"), "\(refill)")

  // ---- the app's own change ----
  mark = fake.events.count
  let mine = DataChange(collection: "spaces", id: "side", item: DataItem(updatedAt: t0 + 5000, value: space("Studio", 2)))
  check("the app's own change: stored", shell.data.change(p1, [mine]))
  check("and sent to P1's copy, not P2's", await until(3, { fake.first("dataChanges", since: mark) != nil }) && fake.first("dataChanges", since: mark)?["id"] as? String == "A3"
        && ((fake.first("dataChanges", since: mark)?["changes"] as? [JSONObject])?.first?["id"] as? String) == "side" && fake.all("dataChanges", since: mark).count == 1)

  // ---- a crash mid-write, then a relaunch ----
  let lastAcked = num(fake.all("dataAck") { $0["id"] as? String == "A3" }.last?["upTo"]) ?? 0
  shell.data.store.crashAfterWrites = shell.data.store.scheduled + 1
  mark = fake.events.count
  let crashed = [change("settings", "archiveAfterHours", t0 + 6000, 72), change("spaces", "home", t0 + 6001, space("Base", 0))]
  fake.tell(["do": "dataChanges", "id": "A3", "changes": crashed])
  check("a crash mid-write (settings written, spaces not)", await until(3, { shell.data.store.crashed }))
  try? await Task.sleep(nanoseconds: 300_000_000)
  check("nothing confirmed to the copy", fake.first("dataAck", since: mark) == nil)
  let leftover = ((try? fm.contentsOfDirectory(atPath: dir1.appendingPathComponent("items").path)) ?? []).filter { $0.hasSuffix(".tmp") }
  check("a temporary file left where it died", leftover.count == 1, "\(leftover)")
  var stopped = false
  shell.stop { stopped = true }
  _ = await until(3, { stopped })
  guard let relaunched = await launch() else { return check("data: relaunched", false) }
  shell = relaunched
  mark = fake.events.count
  connect("A4", "P1", ["acked": lastAcked, "queue": crashed])
  check("relaunched: the copy's unconfirmed queue merged again, then data.ack", await until(5, { fake.first("dataAck", since: mark) != nil }) && num(fake.first("dataAck", since: mark)?["upTo"]) == t0 + 6001)
  check("both changes in, nothing from before lost, the temporary file gone", named(shell, p1, "home") == "Base" && shell.data.values("settings", of: p1)["archiveAfterHours"] as? Int == 72
        && named(shell, p1, "side") == "Studio" && named(shell, p1, "work") == "Focus" && shell.data.store.removedTemps == 1 && shell.data.store.recovered.isEmpty)
  check("P2's set as it was", named(shell, p2, "home") == "P2 home")
  check("data: nothing the app sent was over 1 MB, nothing refused", fake.first("tooBig") == nil && shell.data.unsent == 0)
  stopped = false
  shell.stop { stopped = true }
  _ = await until(3, { stopped })
  fake.stop()
  print(String(format: "  timings: the data scenario %.1f s", Date().timeIntervalSince(started)))
}
