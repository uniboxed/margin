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

  let rev1 = fake.first("dataAck") { $0["id"] as? String == "A" }?["rev"] as? String ?? ""
  check("the first ack carries the set's rev", !rev1.isEmpty && shell.data.store.load(p1)?.rev == rev1, rev1)

  // ---- relinking with nothing changed: no snapshot ----
  check("the link closed", await close("A", shell, "safari:P1"))
  check("a profile not linked: all its Margin tabs not open", shell.notOpenTabs(p1).count == tabs && shell.notOpenTabs(p1, space: "work").count == 1)
  mark = fake.events.count
  connect("A1", "P1", ["acked": t0, "rev": rev1, "queue": []])
  check("relink with the set's rev and nothing queued: no data.snapshot, only data.ack with the same rev", await until(5, { fake.first("dataAck", since: mark) != nil })
        && fake.first("dataSnapshot", since: mark) == nil && fake.first("dataAck", since: mark)?["rev"] as? String == rev1)

  // ---- relinking after an app-side change: the snapshot ----
  mark = fake.events.count
  check("an app-side change while linked", shell.data.change(p1, [DataChange(collection: "settings", id: "appSide", item: DataItem(updatedAt: t0 + 500, value: true))]))
  check("goes to the copy as data.changes, with no rev", await until(3, { fake.first("dataChanges", since: mark) != nil }) && fake.first("dataAck", since: mark) == nil)
  check("A1's link closed", await close("A1", shell, "safari:P1"))
  mark = fake.events.count
  connect("A1b", "P1", ["acked": t0, "rev": rev1, "queue": []])
  check("relink after an app-side change (the copy's rev is older): the snapshot, then data.ack with its rev", await until(5, { fake.first("dataAck", since: mark) != nil })
        && fake.first("dataSnapshot", since: mark) != nil && fake.first("dataSnapshot", since: mark)?["rev"] as? String == shell.data.store.load(p1)?.rev
        && fake.first("dataAck", since: mark)?["rev"] as? String == shell.data.store.load(p1)?.rev && shell.data.store.load(p1)?.rev != rev1)
  check("A1b's link closed", await close("A1b", shell, "safari:P1"))

  // ---- relinking with a queue and a rev the app doesn't know ----
  mark = fake.events.count
  let queue = [change("spaces", "work", t0 + 1000, space("Focus", 1)), change("pins", "pd", t0 + 1001),
               change("tabs", "t-queued0001", t0 + 1002, ["url": "https://queued.example/", "title": "Q", "icon": "", "spaceId": "work", "order": 9, "lastUsed": t0 + 1002])]
  connect("A2", "P1", ["acked": t0, "rev": "7-0123456789", "queue": queue])
  check("relink with a rev the app doesn't know: the queue merged, the whole set sent back, then data.ack upTo the queue's newest", await until(5, { fake.first("dataAck", since: mark) != nil })
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

  // ---- relinking in step with a queue: no snapshot, the losing change answered ----
  let lastB = fake.all("dataAck") { $0["id"] as? String == "B" }.last ?? [:]
  check("P2's link closed", await close("B", shell, "safari:P2"))
  mark = fake.events.count
  connect("B2", "P2", ["acked": num(lastB["upTo"]) ?? 0, "rev": lastB["rev"] as? String ?? "",
                       "queue": [change("spaces", "side", t0 + 2500, space("P2 side", 2)), change("spaces", "home", t0 + 100, space("Older", 0))]])
  check("relink with the set's rev and a queue: merged, no data.snapshot", await until(5, { fake.first("dataAck", since: mark) != nil }) && fake.first("dataSnapshot", since: mark) == nil
        && named(shell, p2, "side") == "P2 side" && named(shell, p2, "home") == "P2 home")
  let answered = (fake.first("dataChanges", since: mark)?["changes"] as? [JSONObject])?.first ?? [:]
  check("the queued change that lost answered with the app's item, before data.ack with the new rev", answered["id"] as? String == "home" && ((answered["value"] as? JSONObject)?["name"] as? String) == "P2 home"
        && (ackIndex(mark, "dataChanges") ?? .max) < (ackIndex(mark, "dataAck") ?? .min)
        && fake.first("dataAck", since: mark)?["rev"] as? String == shell.data.store.load(p2)?.rev && shell.data.store.load(p2)?.rev != lastB["rev"] as? String)

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
  mark = fake.events.count
  fake.tell(["do": "dataHello", "id": "A3", "queue": []]) // the copy's rev is from before the app's change: brought up to it
  check("a hello with the rev from before the app's change: the snapshot again", await until(5, { fake.first("dataAck", since: mark) != nil }) && fake.first("dataSnapshot", since: mark) != nil)
  let lastAck = fake.all("dataAck") { $0["id"] as? String == "A3" }.last ?? [:]
  let lastAcked = num(lastAck["upTo"]) ?? 0
  shell.data.store.crashAfterWrites = shell.data.store.scheduled + 2 // set.json's new rev, settings
  mark = fake.events.count
  let crashed = [change("settings", "archiveAfterHours", t0 + 6000, 72), change("spaces", "home", t0 + 6001, space("Base", 0))]
  fake.tell(["do": "dataChanges", "id": "A3", "changes": crashed])
  check("a crash mid-write (settings written, spaces not)", await until(3, { shell.data.store.crashed }))
  try? await Task.sleep(nanoseconds: 300_000_000)
  check("nothing confirmed to the copy", fake.first("dataAck", since: mark) == nil)
  let leftover = ((try? fm.contentsOfDirectory(atPath: dir1.appendingPathComponent("items").path)) ?? []).filter { $0.hasSuffix(".tmp") }
  check("a temporary file left where it died", leftover.count == 1, "\(leftover)")
  let diskRev = (try? Data(contentsOf: dir1.appendingPathComponent("set.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject }?["rev"] as? String
  var stopped = false
  shell.stop { stopped = true }
  _ = await until(3, { stopped })
  guard let relaunched = await launch() else { return check("data: relaunched", false) }
  shell = relaunched
  mark = fake.events.count
  connect("A4", "P1", ["acked": lastAcked, "rev": lastAck["rev"] as? String ?? "", "queue": crashed])
  check("relaunched: the copy's unconfirmed queue merged again, then data.ack", await until(5, { fake.first("dataAck", since: mark) != nil }) && num(fake.first("dataAck", since: mark)?["upTo"]) == t0 + 6001)
  check("the crashed save had already given set.json a new rev (written first): the copy's rev is older, so the snapshot",
        diskRev != nil && diskRev != lastAck["rev"] as? String && fake.first("dataSnapshot", since: mark) != nil, "\(diskRev ?? "nil") vs \(lastAck["rev"] ?? "nil")")
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

// A signing change end to end (ShellProfiles.swift carryOver): the real link
// and shell, its data in a temporary folder, Safari's folder a stand-in
// (fake-safari.swift) the shell watches as Margin.app does. Personal's copy
// links as s-a…; then a build signed otherwise: Safari's entry for it
// removed and a new one with a new id, whose copy says hello before the
// plist says so. Its hello is held, the read maps it, and Personal's set is
// carried to the new id; then the switch back carries it back.
@MainActor
func carryScenario() async {
  let started = Date()
  let fake = Fake()
  do { try fake.start() } catch { return check("carry: the fake extension starts", false, "\(error)") }
  guard await until(5, { fake.first("ready") != nil }) else { return check("carry: the fake extension starts", false) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-carry-\(UUID().uuidString)", isDirectory: true)
  let safari = FakeSafari()
  defer { try? FileManager.default.removeItem(at: root); safari.remove() }
  safari.standard()
  let ext = SafariProfiles.marginExtension
  let idA = "A0A0A0A0-1111-4222-8333-444444444444", idB = "B0B0B0B0-1111-4222-8333-444444444444"
  let sA = "s-" + idA.lowercased(), sB = "s-" + idB.lowercased()
  let pA = DataProfile(browser: "safari", profile: sA), pB = DataProfile(browser: "safari", profile: sB)
  let day = { (d: Int) in Date(timeIntervalSinceReferenceDate: 783_000_000 + Double(d) * 86_400) }
  func personal(team: [String: Any], unsigned: [String: Any]?) {
    var states: [String: Any] = ["\(ext) (TEAMX00000)": team]
    if let unsigned { states["\(ext) (UNSIGNED)"] = unsigned }
    safari.extensions(FakeSafari.personalServer, states)
  }
  personal(team: ["Enabled": true, "AddedDate": day(0), "ProfileIdentifier": idA], unsigned: nil)
  var said: [String] = []
  let echo = Diagnostics.echo
  Diagnostics.echo = { said.append($0); echo?($0) }
  defer { Diagnostics.echo = echo }

  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("io.tirth.margin.test.carry.\(ProcessInfo.processInfo.processIdentifier)"),
                        timing: .init(tick: 0.5, dead: 3, keep: 30, hello: 2, request: 5, safariSettled: 2))
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.bundleIds = ["safari": fakeBundle]
  options.dataRoot = root
  options.safariData = safari.folder
  options.safariWatch.debounce = 0.1
  options.safariWatch.latency = 0.05
  options.safariWatch.retry = 0.3
  options.safariWatch.busyRetry = 0.2
  options.safariWatch.team = "TEAMX00000"
  let shell = Shell(link: link, windows: ScriptedWindows(), apps: ScriptedApps(), hotKeys: FakeKeys(), options: options)
  shell.start()
  func maps(_ id: String) -> Bool { if case .read(let l)? = shell.safariNames?.last { return l.contains { $0.margin == id } }; return false }
  guard await until(3, { link.port != nil }), await until(3, { maps(sA) }) else { return check("carry: linked, Safari's profiles read", false) }
  var mark = fake.events.count
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink", since: mark) != nil }), let nonce = fake.first("wantLink", since: mark)?["nonce"] as? String else { return check("carry: wantLink", false) }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link", since: mark) != nil }) else { return check("carry: the link", false) }
  func connect(_ id: String, _ profile: String) { fake.tell(["do": "connect", "id": id, "profile": profile, "theme": NSNull(), "data": ["acked": 0]]) }
  func close(_ id: String, _ key: String) async -> Bool {
    let m = fake.events.count
    fake.tell(["do": "close", "id": id])
    return await until(3, { fake.first("close", since: m) { $0["id"] as? String == id } != nil && shell.links[key] == nil })
  }
  func named(_ p: DataProfile, _ space: String) -> String? { (shell.data.values("spaces", of: p)[space] as? JSONObject)?["name"] as? String }
  let profiles = shell.profilesOf("safari")

  // Personal's copy, signed by the team: its first set, linked to Safari's profile.
  mark = fake.events.count
  connect("A", sA)
  check("carry: Personal's first copy: no set, no hold (the read maps it): data.need", await until(3, { fake.first("dataNeed", since: mark) != nil }))
  check("carry: its set stored", await until(3, { fake.first("dataAck", since: mark) != nil }) && named(pA, "work") == "Deep Work")
  check("carry: linked to Safari's profile", await until(3, { profiles.info[sA]?.browserId == FakeSafari.personalServer }) && profiles.name(sA) == "Personal")
  let t = (Date().timeIntervalSince1970 * 1000).rounded()
  check("carry: a space renamed", shell.data.change(pA, [DataChange(collection: "spaces", id: "work", item: DataItem(updatedAt: t, value: ["name": "Carried", "emoji": "", "color": "#000", "order": 1]))]))
  check("carry: Personal's copy goes", await close("A", "safari:\(sA)"))

  // A build signed otherwise: a new copy's hello before Safari's plist says so.
  mark = fake.events.count
  let saidBefore = said.count
  connect("B", sB)
  try? await Task.sleep(nanoseconds: 400_000_000)
  check("carry: the new id's hello held, no data.need", fake.first("dataNeed", since: mark) == nil && shell.data.holding == [pB] && shell.links["safari:\(sB)"] != nil)
  personal(team: ["Enabled": false, "AddedDate": day(0), "RemovedDate": day(3), "ProfileIdentifier": idA], unsigned: ["Enabled": true, "AddedDate": day(3), "ProfileIdentifier": idB])
  check("carry: Safari's read maps Personal to the new id: Personal's set to its copy", await until(3, { fake.first("dataSnapshot", since: mark) != nil })
        && (fake.first("dataSnapshot", since: mark)?["spaces"] as? JSONObject)?["work"] as? String == "Carried" && fake.first("dataNeed", since: mark) == nil,
        "\(fake.first("dataSnapshot", since: mark) ?? [:])")
  check("carry: then data.ack", await until(3, { fake.first("dataAck", since: mark) != nil }))
  check("carry: the new id has the set, the old one none (put away)", named(pB, "work") == "Carried" && shell.data.profiles(browser: "safari").map(\.profile).contains(sB)
        && !shell.data.profiles(browser: "safari").map(\.profile).contains(sA)
        && ((try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("safari/.archived").path)) ?? []).count == 1)
  check("carry: one Personal, the old id forgotten", await until(2, { profiles.info[sA]?.hidden == true }) && profiles.name(sB) == "Personal"
        && profiles.profilesShown.filter { profiles.name($0) == "Personal" } == [sB], "\(profiles.profilesShown)")
  check("carry: said in the log", said.dropFirst(saidBefore).contains { $0.contains("\(sA) → \(sB) (Safari profile \(FakeSafari.personalServer)): data carried over") }
        && said.dropFirst(saidBefore).contains { $0.contains("data.hello held up to") })
  check("carry: the new copy's link gone", await close("B", "safari:\(sB)"))

  // The switch back: the team's build again (its entry added again, its old id), the plist read first.
  personal(team: ["Enabled": true, "AddedDate": day(5), "RemovedDate": day(3), "ProfileIdentifier": idA], unsigned: ["Enabled": false, "AddedDate": day(3), "RemovedDate": day(5), "ProfileIdentifier": idB])
  check("carry back: Safari's read maps Personal to the old id again", await until(3, { maps(sA) }))
  mark = fake.events.count
  connect("A2", sA)
  check("carry back: the set comes back at once, no data.need", await until(3, { fake.first("dataAck", since: mark) != nil })
        && (fake.first("dataSnapshot", since: mark)?["spaces"] as? JSONObject)?["work"] as? String == "Carried" && fake.first("dataNeed", since: mark) == nil)
  check("carry back: under the old id again", named(pA, "work") == "Carried" && !shell.data.profiles(browser: "safari").map(\.profile).contains(sB) && profiles.name(sA) == "Personal")
  var stopped = false
  shell.stop { stopped = true }
  _ = await until(3, { stopped })
  fake.stop()
  print(String(format: "  timings: the carry scenario %.1f s", Date().timeIntervalSince(started)))
}
