// Checks of Margin.app's lasting data (app/platforms/macos/shell/DataSync.swift, over margin-core's data sync and
// store), part of tests.swift's run: the data messages against a stand-in copy, through the Mac's wrapper (its
// sends to each link, its callbacks, the hold's timer). The merge's vectors and the files themselves (atomic writes,
// backups, a crash mid-write, revisions, later formats left alone, the names on disk) are margin-core's tests now:
// app/shared/core/src/data/set.rs (`the_vectors`, `the_vectors_through_the_files`), store.rs and sync.rs.
import Foundation

final class FakePeer: DataPeer {
  let hello: LinkMessage.Hello
  var isUp = true
  var sent: [(kind: String, body: JSONObject)] = []
  init(_ profile: String, epoch: String = "e1", browser: String = "safari") {
    hello = LinkMessage.Hello(epoch: epoch, profile: profile, browser: browser, ext: nil, owner: true, instanceId: nil, origin: nil, since: nil, pid: nil)
  }
  func sendData(_ kind: String, _ body: JSONObject) -> Bool {
    // As the link would: encoded, and refused over 1 MB.
    guard let text = AppMessage.data(kind: kind, body: body).encode(), let o = object(text) else { return false }
    sent.append((kind, o))
    return true
  }
  var kinds: [String] { sent.map(\.kind) }
  func take() -> [(kind: String, body: JSONObject)] { defer { sent = [] }; return sent }
}

// The whole set from data.snapshot parts (the last transfer's).
func assembled(_ sent: [(kind: String, body: JSONObject)]) -> (set: JSONObject, parts: Int)? {
  let snaps = sent.filter { $0.kind == "data.snapshot" }
  guard let transfer = snaps.last?.body["transfer"] as? String else { return nil }
  let mine = snaps.filter { $0.body["transfer"] as? String == transfer }
  guard let parts = mine.first?.body["parts"] as? Int, mine.count == parts else { return nil }
  var items: JSONObject = [:]
  for m in mine {
    for (c, list) in (m.body["set"] as? JSONObject)?["items"] as? JSONObject ?? [:] {
      var into = items[c] as? JSONObject ?? [:]
      into.merge(list as? JSONObject ?? [:]) { _, b in b }
      items[c] = into
    }
  }
  return (["format": 1, "items": items], parts)
}

func tempFolder(_ name: String) -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("margin-app-tests-\(name)-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

// A profile's set as a copy's data.snapshot carries it ({ format, items }).
func setJSON(_ items: JSONObject?) -> JSONObject? { items.map { ["format": 1, "items": $0] } }
func isDeleted(_ item: JSONObject?) -> Bool { item?["deleted"] as? Bool == true }
// Changes as a set's items: { collection: { id: item } }.
func itemsJSON(_ changes: [DataChange]) -> JSONObject {
  var items: JSONObject = [:]
  for c in changes {
    var list = items[c.collection] as? JSONObject ?? [:]
    list[c.id] = c.item.json
    items[c.collection] = list
  }
  return items
}

extension DataSync {
  // One stored item ({ updatedAt, value } or { updatedAt, deleted: true }), and a live value's name.
  func item(_ p: DataProfile, _ collection: String, _ id: String) -> JSONObject? { (set(of: p)?[collection] as? JSONObject)?[id] as? JSONObject }
  func name(_ p: DataProfile, _ collection: String, _ id: String) -> String? { (values(collection, of: p)[id] as? JSONObject)?["name"] as? String }

  // A profile's set made as a copy's first link makes it (data.hello, data.need, its data.snapshot), the link then
  // gone. Its acked: the newest of its items.
  func seed(_ p: DataProfile, _ changes: [DataChange]) {
    let peer = FakePeer(p.profile, epoch: "seed-\(p.profile)", browser: p.browser)
    linkUp(peer)
    received(peer, "data.hello", ["profile": p.profile, "format": 1, "acked": 0, "queue": []])
    received(peer, "data.snapshot", ["profile": p.profile, "format": 1, "set": ["format": 1, "items": itemsJSON(changes)]])
    linkDown(peer)
  }
}

func space(_ name: String, _ order: Int = 0) -> JSONObject { ["name": name, "emoji": "", "color": "#000", "order": order] }
func change(_ c: String, _ id: String, _ at: Double, _ value: Any? = nil) -> DataChange {
  DataChange(collection: c, id: id, item: value.map { DataItem(updatedAt: at, value: $0) } ?? .tombstone(at))
}

extension Tests {
  static func dataSync() {
    if case .data(let kind, let body)? = LinkMessage.decode(#"{"k":"data.hello","profile":"P1","format":1,"acked":5,"queue":[]}"#) {
      check("data.hello: a data message, as it came", kind == "data.hello" && num(body["acked"]) == 5 && body["profile"] as? String == "P1")
    } else { check("data.hello decodes", false) }
    let ack = object(AppMessage.data(kind: "data.ack", body: ["upTo": 5, "profile": "P1"]).encode())
    check("data.ack from the app", ack?["k"] as? String == "data.ack" && num(ack?["upTo"]) == 5 && ack?["profile"] as? String == "P1")
    check("a data message from the app over 1 MB: refused", AppMessage.data(kind: "data.changes", body: ["x": String(repeating: "x", count: LinkProtocol.maxAppMessage)]).encode() == nil)
    let root = tempFolder("sync")
    defer { try? FileManager.default.removeItem(at: root) }
    let sync = DataSync(root: root, background: false)
    sync.testClock(1000) // the tests' times are small: no tombstone is old
    var changed: [String] = []
    sync.onChange = { p, c in changed.append("\(p.key) \(c.sorted().joined(separator: ","))") }
    let p1 = DataProfile(browser: "safari", profile: "P1"), p2 = DataProfile(browser: "safari", profile: "P2")

    // ---- the first link ----
    let a = FakePeer("P1")
    sync.linkUp(a)
    let queued = change("settings", "x", 50, 1).json
    sync.received(a, "data.hello", ["profile": "P1", "format": 1, "acked": 0, "queue": [queued]])
    check("first link: no set, so data.need { all: true }, naming the profile and epoch", a.kinds == ["data.need"] && a.sent[0].body["all"] as? Bool == true
          && a.sent[0].body["profile"] as? String == "P1" && a.sent[0].body["epoch"] as? String == "e1" && sync.set(of: p1) == nil)
    a.sent = []
    let converted: JSONObject = ["format": 1, "items": ["spaces": ["personal": ["updatedAt": 0, "value": space("Personal")], "work": ["updatedAt": 40, "value": space("Work", 1)]],
                                                        "pins": [String: Any](), "settings": ["x": ["updatedAt": 0, "value": 0]]]]
    let items = converted["items"] as! JSONObject
    sync.received(a, "data.snapshot", ["profile": "P1", "format": 1, "transfer": "t1", "part": 1, "parts": 2, "set": ["format": 1, "items": ["spaces": items["spaces"]!]]])
    check("a part of the copy's snapshot: waits for the rest", a.sent.isEmpty && sync.set(of: p1) == nil)
    sync.received(a, "data.snapshot", ["profile": "P1", "format": 1, "transfer": "t1", "part": 0, "parts": 2, "set": ["format": 1, "items": ["pins": items["pins"]!, "settings": items["settings"]!]]])
    let first = sync.stored(p1)
    check("the converter's set stored as the profile's, the held queue under it", sync.values("spaces", of: p1).count == 2 && (first?.items["pins"] as? JSONObject)?.isEmpty == true
          && sync.values("settings", of: p1)["x"] as? Int == 1)
    check("then data.ack upTo its newest, with the set's rev, and no snapshot back", a.kinds == ["data.ack"] && num(a.sent[0].body["upTo"]) == 50 && first?.acked == 50
          && a.sent[0].body["rev"] as? String == first?.rev && first?.rev.hasPrefix("1-") == true, "\(a.sent)")
    check("the app's UI told", changed == ["safari:P1 pins,settings,spaces"], "\(changed)")
    a.sent = []

    // ---- linked: changes both ways ----
    sync.received(a, "data.changes", ["profile": "P1", "changes": [change("spaces", "work", 60, space("Job", 1)).json, change("spaces", "personal", -5, space("Old")).json]])
    check("a change taken, one older than the app's sent back as the app has it, then ack", a.kinds == ["data.changes", "data.ack"]
          && ((a.sent[0].body["changes"] as? [JSONObject])?.first?["id"] as? String) == "personal" && num((a.sent[0].body["changes"] as? [JSONObject])?.first?["updatedAt"]) == 0
          && num(a.sent[1].body["upTo"]) == 60 && sync.name(p1, "spaces", "work") == "Job", "\(a.sent)")
    a.sent = []
    check("the app's own change: stored and sent to the copy", sync.change(p1, [change("spaces", "personal", 70, space("Home"))]) && a.kinds == ["data.changes"] && sync.stored(p1)?.acked == 60
          && sync.name(p1, "spaces", "personal") == "Home")
    a.sent = []
    check("one that loses: nothing sent", sync.change(p1, [change("spaces", "personal", 1, space("Nope"))]) && a.sent.isEmpty && sync.name(p1, "spaces", "personal") == "Home")
    check("for a profile with no set: refused", !sync.change(p2, [change("spaces", "x", 1, space("X"))]))

    // ---- another profile ----
    let b = FakePeer("P2", epoch: "e2")
    sync.linkUp(b)
    sync.received(b, "data.changes", ["profile": "P1", "changes": [change("spaces", "work", 999, space("Hijacked")).json]])
    check("a message naming another profile: refused", b.sent.isEmpty && sync.name(p1, "spaces", "work") == "Job")
    sync.received(b, "data.changes", ["profile": "P2", "changes": [change("spaces", "work", 100, space("P2 work")).json]])
    check("changes before a set: the whole set asked for, the changes held", b.kinds == ["data.need"])
    b.sent = []
    sync.received(b, "data.snapshot", ["profile": "P2", "format": 1, "set": ["format": 1, "items": ["spaces": ["work": ["updatedAt": 90, "value": space("W")]]]]])
    check("P2's own set: its snapshot with the held change on top", sync.name(p2, "spaces", "work") == "P2 work" && b.kinds == ["data.ack"] && num(b.sent[0].body["upTo"]) == 100)
    check("P1's set untouched by P2's", sync.name(p1, "spaces", "work") == "Job" && sync.values("spaces", of: p1).count == 2)
    sync.received(b, "data.changes", ["profile": "P2", "epoch": "e1", "changes": [change("spaces", "work", 200, space("other epoch")).json]])
    check("another epoch's message: left", sync.name(p2, "spaces", "work") == "P2 work")

    // ---- relinking with a queue ----
    sync.linkDown(a)
    let a2 = FakePeer("P1", epoch: "e3")
    sync.linkUp(a2)
    sync.received(a, "data.changes", ["profile": "P1", "changes": [change("spaces", "work", 999, space("Stale link")).json]])
    check("a link gone: its messages left", sync.name(p1, "spaces", "work") == "Job")
    sync.received(a2, "data.hello", ["profile": "P1", "format": 1, "acked": 60, "queue": [change("pins", "p1", 80, ["url": "https://p.test/"]).json, change("spaces", "work", 65).json]])
    let back = assembled(a2.sent)
    check("relink: the queue merged and stored, the whole set sent back, then ack", a2.kinds.last == "data.ack" && a2.kinds.dropLast().allSatisfy { $0 == "data.snapshot" } && back != nil
          && same(back?.set, setJSON(sync.set(of: p1))) && num(a2.sent.last?.body["upTo"]) == 80, "\(a2.kinds)")
    check("the deletion kept, the new pin in", isDeleted(sync.item(p1, "spaces", "work")) && sync.values("pins", of: p1)["p1"] != nil
          && sync.values("spaces", of: p1)["personal"] != nil)
    let reread = DataSync(root: root, background: false)
    check("on disk too", reread.set(of: p1) != nil && same(reread.set(of: p1), sync.set(of: p1)) && reread.stored(p1)?.acked == 80)

    // ---- the app's files older than what it confirmed (restored from a backup) ----
    a2.sent = []
    sync.received(a2, "data.hello", ["profile": "P1", "format": 1, "acked": 500, "queue": [change("pins", "p2", 501, ["url": "https://q.test/"]).json]])
    check("the copy confirmed more than the app's files have: the whole set asked for", a2.kinds == ["data.need"])
    a2.sent = []
    sync.received(a2, "data.snapshot", ["profile": "P1", "format": 1, "set": ["format": 1, "items": ["pins": ["p3": ["updatedAt": 400, "value": ["url": "https://r.test/"]]]]]])
    let restored = sync.stored(p1)
    check("its snapshot merged into what the app has, sent back merged, then ack", sync.values("pins", of: p1).keys.sorted() == ["p1", "p2", "p3"] && sync.values("spaces", of: p1)["personal"] != nil
          && a2.kinds.last == "data.ack" && num(a2.sent.last?.body["upTo"]) == 501 && same(assembled(a2.sent)?.set, setJSON(restored?.items)) && restored?.acked == 501)

    // ---- a wiped cache: acked 0, a queue of what's new ----
    a2.sent = []
    sync.received(a2, "data.hello", ["profile": "P1", "format": 1, "acked": 0, "queue": [change("tabs", "t-new0000001", 600, ["url": "https://new.test/", "spaceId": "personal", "order": 0]).json]])
    check("a wiped cache: the app's set back to it, with what it did since", assembled(a2.sent).map { (($0.set["items"] as? JSONObject)?["pins"] as? JSONObject)?.count == 3 } == true
          && sync.values("tabs", of: p1)["t-new0000001"] != nil && num(a2.sent.last?.body["upTo"]) == 600)

    // ---- parts (how a set is cut, and changes batched: margin-core's sync.rs tests; here the messages) ----
    let bigChanges = (0..<60).map { change("siteIcons", "https://site\($0).test", Double($0), ["data": "data:image/png;base64," + String(repeating: "A", count: 300)]) }
      + [change("archive", "huge", 1, ["blob": String(repeating: "B", count: 5000)])]
    var bigItems = itemsJSON(bigChanges)
    bigItems["folders"] = JSONObject()
    let c = FakePeer("P7", epoch: "e7")
    sync.linkUp(c)
    sync.received(c, "data.hello", ["profile": "P7", "format": 1, "acked": 0, "queue": []])
    sync.received(c, "data.snapshot", ["profile": "P7", "format": 1, "set": ["format": 1, "items": bigItems]])
    check("P7's first set stored, its empty collection too", c.kinds == ["data.need", "data.ack"] && (sync.set(of: DataProfile(browser: "safari", profile: "P7"))?["folders"] as? JSONObject)?.isEmpty == true)
    c.sent = []
    sync.partBytes = 2000
    sync.received(c, "data.hello", ["profile": "P7", "format": 1, "acked": 0, "queue": []])
    let snap = assembled(c.sent)
    check("data.snapshot in parts, each under the budget plus its envelope, the left-out item named in part 0", (snap?.parts ?? 0) > 5 && c.sent.allSatisfy { (jsonText($0.body)?.count ?? .max) < 2300 }
          && ((c.sent.first?.body["omitted"] as? [[String]])?.first ?? []) == ["archive", "huge"], "\(c.sent.map { jsonText($0.body)?.count ?? 0 })")
    check("every collection named in the first part, an empty one too", ((c.sent.first?.body["set"] as? JSONObject)?["items"] as? JSONObject).map {
      ($0["folders"] as? JSONObject)?.isEmpty == true && $0["siteIcons"] != nil && $0["archive"] != nil } == true)
    check("the parts add up to the set (but what was left out)", ((snap?.set["items"] as? JSONObject)?["siteIcons"] as? JSONObject)?.count == 60
          && ((snap?.set["items"] as? JSONObject)?["archive"] as? JSONObject)?.isEmpty == true)
    sync.partBytes = 900_000
    let huge = FakePeer("P8")
    sync.linkUp(huge)
    let icons = (0..<40).map { change("siteIcons", "https://s\($0).test", 1, ["data": String(repeating: "C", count: 60_000)]) }
    sync.received(huge, "data.hello", ["profile": "P8", "format": 1, "acked": 0, "queue": []])
    sync.received(huge, "data.snapshot", ["profile": "P8", "format": 1, "set": ["format": 1, "items": itemsJSON(icons)]])
    huge.sent = []
    sync.received(huge, "data.hello", ["profile": "P8", "format": 1, "acked": 0, "queue": []])
    check("2.4 MB of site icons: in parts, none over 1 MB, nothing refused", (assembled(huge.sent)?.parts ?? 0) >= 3 && sync.unsent == 0
          && ((assembled(huge.sent)?.set["items"] as? JSONObject)?["siteIcons"] as? JSONObject)?.count == 40, "\(huge.kinds) unsent \(sync.unsent)")

    // ---- revisions: no snapshot for a copy that has the app's set ----
    sync.linkDown(a2)
    let a3 = FakePeer("P1", epoch: "e4")
    sync.linkUp(a3)
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 600, "queue": []])
    let revNow = sync.stored(p1)?.rev ?? "?"
    check("a hello with no rev (never, or wiped): the snapshot, its part 0 and the ack carrying the set's rev", a3.kinds.first == "data.snapshot" && a3.sent[0].body["rev"] as? String == revNow
          && a3.sent.last?.kind == "data.ack" && a3.sent.last?.body["rev"] as? String == revNow && a3.sent.dropFirst().allSatisfy { $0.body["rev"] == nil || $0.kind == "data.ack" })
    a3.sent = []
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 600, "rev": revNow, "queue": []])
    check("a hello with the set's rev and nothing queued: no snapshot, only data.ack with the same rev", a3.kinds == ["data.ack"] && a3.sent[0].body["rev"] as? String == revNow
          && sync.stored(p1)?.rev == revNow)
    a3.sent = []
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 600, "rev": revNow,
                                     "queue": [change("pins", "p9", 700, ["url": "https://p9.test/"]).json, change("spaces", "personal", 2, space("Older")).json]])
    let revQueued = sync.stored(p1)?.rev ?? "?"
    check("the set's rev with a queue: merged, no snapshot, the change that lost answered, then data.ack with the new rev", a3.kinds == ["data.changes", "data.ack"]
          && ((a3.sent[0].body["changes"] as? [JSONObject])?.first?["id"] as? String) == "personal" && num(a3.sent[1].body["upTo"]) == 700
          && a3.sent[1].body["rev"] as? String == revQueued && revQueued != revNow && sync.values("pins", of: p1)["p9"] != nil)
    a3.sent = []
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 700, "rev": "3-00000000ff", "queue": []])
    check("a rev the app doesn't know (an older backup, another Mac): the snapshot", a3.kinds.first == "data.snapshot" && a3.kinds.last == "data.ack")
    a3.sent = []
    sync.received(a3, "data.changes", ["profile": "P1", "changes": [change("folders", "fb", 710, ["name": "B"]).json]])
    let revChanged = sync.stored(p1)?.rev ?? "?"
    check("linked, in step: data.ack for the copy's changes carries the new rev", a3.kinds == ["data.ack"] && a3.sent[0].body["rev"] as? String == revChanged && revChanged != revQueued)
    a3.sent = []
    sync.change(p1, [change("folders", "fa", 720, ["name": "A"])])
    check("the app's own change: sent without a rev, the set's rev moved on", a3.kinds == ["data.changes"] && a3.sent[0].body["rev"] == nil && sync.stored(p1)?.rev != revChanged)
    a3.sent = []
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 710, "rev": revChanged, "queue": []])
    check("a hello after an app-side change: the copy's rev is older, the snapshot", a3.kinds.first == "data.snapshot" && assembled(a3.sent).map { same($0.set, setJSON(sync.set(of: p1))) } == true)
    let unsynced = FakePeer("P1", epoch: "e5")
    sync.linkDown(a3)
    sync.linkUp(unsynced)
    sync.received(unsynced, "data.changes", ["profile": "P1", "changes": [change("folders", "fc", 730, ["name": "C"]).json]])
    check("changes on a link that hasn't said data.hello: acked without a rev (the app can't say what the copy has)", unsynced.kinds == ["data.ack"] && unsynced.sent[0].body["rev"] == nil)

    // ---- a write that fails: nothing confirmed ----
    let d = FakePeer("P1", epoch: "e9")
    sync.linkDown(unsynced)
    sync.linkUp(d)
    // The profile's folders made read-only: no file of the save can be written.
    let dir = root.appendingPathComponent("safari/" + DataNames.fileName("P1")), itemsDir = dir.appendingPathComponent("items")
    let fm = FileManager.default
    let revBefore = sync.stored(p1)?.rev
    check("P1's folder where the store keeps it (capitals written out)", FileManager.default.fileExists(atPath: dir.appendingPathComponent("set.json").path), dir.path)
    try? fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: itemsDir.path)
    try? fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
    var lines: [String] = []
    let echo = Diagnostics.echo
    Diagnostics.echo = { lines.append($0) }
    sync.received(d, "data.changes", ["profile": "P1", "changes": [change("spaces", "personal", 9999, space("Lost")).json]])
    Diagnostics.echo = echo
    try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path)
    try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: itemsDir.path)
    check("a write that fails: no data.ack (the copy keeps its queue)", d.sent.isEmpty, "\(d.kinds)")
    check("and said: nothing confirmed to the copy", lines.contains { $0.hasPrefix("warning: ") && $0.contains("safari:P1: not stored: nothing confirmed to the copy") }, "\(lines)")
    check("the memory as the files have it (the change that failed dropped)", sync.name(p1, "spaces", "personal") == "Home" && sync.stored(p1)?.acked == 730 && sync.stored(p1)?.rev == revBefore)
    let afterFail = DataSync(root: root, background: false)
    check("and the files as before it", afterFail.name(p1, "spaces", "personal") == "Home" && afterFail.stored(p1)?.acked == 730)
  }

  // A profile's set carried to a new id (a signing change): DataSync's hold and carry.
  static func dataCarry() {
    let root = tempFolder("carry")
    defer { try? FileManager.default.removeItem(at: root) }
    let sync = DataSync(root: root, background: false)
    sync.testClock(5000)
    var carried: [String] = []
    sync.onCarried = { old, new, why in carried.append("\(old.profile)>\(new.profile) \(why)") }
    let pA = DataProfile(browser: "safari", profile: "s-aaaa"), pB = DataProfile(browser: "safari", profile: "s-bbbb")
    sync.seed(pA, [change("spaces", "work", 100, space("Deep Work")), change("spaces", "side", 90, space("Side", 1)), change("settings", "theme", 100, "arcadia")])
    check("carry: the old set seeded (acked its newest)", sync.stored(pA)?.acked == 100 && sync.values("spaces", of: pA).count == 2)
    let oldDir = root.appendingPathComponent("safari/s-aaaa")

    // ---- a hello before Safari's read: held, then carried over ----
    let b = FakePeer("s-bbbb")
    sync.linkUp(b)
    var asked: [String] = []
    var askedWith: [Set<String>] = []
    sync.beforeNeed = { p, withSets in asked.append(p.profile); askedWith.append(withSets); return .hold }
    let fresh = [change("spaces", "space1", 200, space("Space 1")).json, change("settings", "theme", 300, "neo").json]
    sync.received(b, "data.hello", ["profile": "s-bbbb", "format": 1, "acked": 0, "queue": fresh])
    check("carry: a new id's hello with no set, beforeNeed says hold: nothing sent yet", b.sent.isEmpty && asked == ["s-bbbb"] && sync.holding == [pB] && sync.set(of: pB) == nil)
    check("carry: beforeNeed told the browser's profiles with a set", askedWith == [["s-aaaa"]], "\(askedWith)")
    check("carry: not from a linked profile", { let a = FakePeer("s-aaaa"); sync.linkUp(a); defer { sync.linkDown(a) }; return !sync.carry(from: pA, to: pB, why: "x") }())
    sync.received(b, "data.changes", ["profile": "s-bbbb", "changes": [change("pins", "pnew", 700, ["url": "https://new.test/"]).json]])
    check("carry: a change while the hello is held: kept, nothing sent", b.sent.isEmpty && sync.set(of: pB) == nil)
    check("carry: under way", sync.carry(from: pA, to: pB, why: "Safari profile X"))
    check("carry: the change made while held taken after it", sync.values("pins", of: pB)["pnew"] != nil && b.kinds.last == "data.ack" && num(b.sent.last?.body["upTo"]) == 700, "\(b.kinds)")
    let bSet = sync.set(of: pB)
    check("carry: the new id has the old set's spaces and settings", sync.name(pB, "spaces", "work") == "Deep Work"
          && sync.values("spaces", of: pB).count == 2 && sync.values("settings", of: pB)["theme"] as? String == "arcadia", "\(bSet ?? [:])")
    check("carry: the new copy's own defaults left out (deleted), not merged in", isDeleted(sync.item(pB, "spaces", "space1")) && num(sync.item(pB, "settings", "theme")?["updatedAt"]) == 100
          && (num(sync.item(pB, "spaces", "space1")?["updatedAt"]) ?? 0) > 200)
    let back = assembled(b.sent)
    check("carry: the held hello answered as a relink: the set to the copy, then data.ack", b.kinds.suffix(2) == ["data.ack", "data.ack"] && b.kinds.dropLast(2).allSatisfy { $0 == "data.snapshot" } && b.kinds.count >= 3
          && back?.set != nil && (((back?.set["items"] as? JSONObject)?["spaces"] as? JSONObject)?["work"] as? JSONObject) != nil && !b.kinds.contains("data.need"), "\(b.kinds)")
    check("carry: the old set put away, out of the profiles", sync.profiles(browser: "safari") == [pB] && !FileManager.default.fileExists(atPath: oldDir.path)
          && ((try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("safari/.archived").path)) ?? []).count == 1 && sync.set(of: pA) == nil)
    check("carry: said", carried == ["s-aaaa>s-bbbb Safari profile X"] && sync.holding.isEmpty)
    check("carry: acked: the old set's, then the held change's", sync.stored(pB)?.acked == 700, "\(sync.stored(pB)?.acked ?? -1)")
    check("carry: again: nothing (the old set is gone)", !sync.carry(from: pA, to: pB, why: "x"))

    // ---- the hold runs out: data.need, as without it ----
    // (The hold's end is the core's clock's: the test clock moved past it, the wrapper's timer lets it go.)
    sync.holdFor = 0.05
    let c = FakePeer("s-cccc")
    sync.linkUp(c)
    sync.received(c, "data.hello", ["profile": "s-cccc", "format": 1, "acked": 0, "queue": []])
    check("hold: nothing at first", c.sent.isEmpty && sync.holding == [DataProfile(browser: "safari", profile: "s-cccc")])
    sync.testClock(5000 + 60)
    waitUntil(1) { !c.sent.isEmpty }
    check("hold: run out: data.need", c.kinds == ["data.need"] && sync.holding.isEmpty, "\(c.kinds)")
    sync.testClock(5000)
    sync.holdFor = 3

    // ---- no read (beforeNeed not set, or .ask): data.need at once ----
    sync.beforeNeed = nil
    let g = FakePeer("s-gggg")
    sync.linkUp(g)
    sync.received(g, "data.hello", ["profile": "s-gggg", "format": 1, "acked": 0, "queue": []])
    check("no Safari read: a fresh set as today (data.need at once)", g.kinds == ["data.need"])

    // ---- after the new copy's first set: carried if it's untouched ----
    let pE = DataProfile(browser: "safari", profile: "s-eeee"), pF = DataProfile(browser: "safari", profile: "s-ffff"), pD = DataProfile(browser: "safari", profile: "s-dddd")
    sync.seed(pE, [change("spaces", "home", 100, space("Home E")), change("pins", "pe", 100, ["url": "https://e.test/"])])
    var first: [String] = []
    sync.onFirstSet = { p in
      first.append(p.profile)
      if p == pF { sync.carry(from: pE, to: pF, why: "Safari profile Y") }
    }
    let f = FakePeer("s-ffff")
    sync.linkUp(f)
    sync.received(f, "data.hello", ["profile": "s-ffff", "format": 1, "acked": 0, "queue": []])
    check("late: no set, data.need", f.kinds == ["data.need"])
    f.sent = []
    sync.received(f, "data.snapshot", ["profile": "s-ffff", "format": 1, "set": ["format": 1, "items": ["spaces": ["d1": ["updatedAt": 400, "value": space("Space 1")]], "pins": [String: Any]()]]])
    let fSet = sync.stored(pF)
    check("late: the first set stored, then carried over", first == ["s-ffff"] && sync.name(pF, "spaces", "home") == "Home E"
          && isDeleted(sync.item(pF, "spaces", "d1")) && sync.values("pins", of: pF).count == 1 && sync.set(of: pE) == nil, "\(fSet?.items ?? [:])")
    let fBack = assembled(f.sent)
    check("late: the copy got the carried set and an ack with its rev", f.kinds.first == "data.ack" && f.kinds.last == "data.ack" && f.kinds.contains("data.snapshot")
          && same(fBack?.set, setJSON(fSet?.items)) && f.sent.last?.body["rev"] as? String == fSet?.rev, "\(f.kinds)")
    // A copy that has sent changes since its first set: never.
    sync.seed(pE, [change("spaces", "home", 100, space("Home E"))])
    let d = FakePeer("s-dddd")
    sync.linkUp(d)
    sync.received(d, "data.hello", ["profile": "s-dddd", "format": 1, "acked": 0, "queue": []])
    sync.received(d, "data.snapshot", ["profile": "s-dddd", "format": 1, "set": ["format": 1, "items": ["spaces": ["d1": ["updatedAt": 400, "value": space("Space 1")]]]]])
    check("touched: the first set is rev 1", sync.stored(pD)?.rev.hasPrefix("1-") == true)
    sync.received(d, "data.changes", ["profile": "s-dddd", "changes": [change("spaces", "d1", 500, space("Mine")).json]])
    check("touched: a copy that sent changes since: no carry", !sync.carry(from: pE, to: pD, why: "x") && sync.name(pD, "spaces", "d1") == "Mine"
          && sync.set(of: pE) != nil)
    // While its copy's snapshot is on its way: not yet.
    let h = FakePeer("s-hhhh")
    sync.linkUp(h)
    sync.received(h, "data.hello", ["profile": "s-hhhh", "format": 1, "acked": 0, "queue": []])
    check("awaiting its copy's snapshot: not yet", !sync.carry(from: pE, to: DataProfile(browser: "safari", profile: "s-hhhh"), why: "x"))

    // ---- the switch back: the old id links again, the set comes back ----
    sync.linkDown(b)
    let a2 = FakePeer("s-aaaa", epoch: "e9")
    sync.linkUp(a2)
    sync.beforeNeed = { p, _ in p == pA ? .carry(from: pB, why: "Safari profile X") : .ask }
    sync.received(a2, "data.hello", ["profile": "s-aaaa", "format": 1, "acked": 0, "queue": [change("spaces", "space1b", 600, space("Space 1")).json]])
    check("switch back: carried back at once, as a relink", sync.name(pA, "spaces", "work") == "Deep Work"
          && isDeleted(sync.item(pA, "spaces", "space1b")) && a2.kinds.last == "data.ack" && a2.kinds.contains("data.snapshot") && !a2.kinds.contains("data.need")
          && sync.set(of: pB) == nil && sync.profiles(browser: "safari").contains(pA) && !sync.profiles(browser: "safari").contains(pB), "\(a2.kinds)")
    check("switch back: said", carried.last == "s-bbbb>s-aaaa Safari profile X")
  }
}
