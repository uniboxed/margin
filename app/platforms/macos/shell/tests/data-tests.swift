// Checks of Margin.app's lasting data (app/platforms/macos/shell/DataSet.swift,
// DataStore.swift, DataSync.swift), part of tests.swift's run: the merge
// against the JSON vectors the extension's reference runs
// (tests/fixtures/data-merge/, read where MARGIN_DATA_VECTORS says), the
// files in a temporary folder (atomic writes, backups, a crash mid-write,
// later formats left alone), and the data messages against a stand-in copy.
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

// A store writing at once, its clock at 1 s after 1970 (the tests' times are small: no tombstone is old).
func testStore(_ root: URL) -> DataStore {
  let store = DataStore(root: root, background: false)
  store.now = { 1000 }
  return store
}

func tempFolder(_ name: String) -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("margin-app-tests-\(name)-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

func space(_ name: String, _ order: Int = 0) -> JSONObject { ["name": name, "emoji": "", "color": "#000", "order": order] }
func change(_ c: String, _ id: String, _ at: Double, _ value: Any? = nil) -> DataChange {
  DataChange(collection: c, id: id, item: value.map { DataItem(updatedAt: at, value: $0) } ?? .tombstone(at))
}

extension Tests {
  static func dataMerge() {
    let dir = ProcessInfo.processInfo.environment["MARGIN_DATA_VECTORS"] ?? "../../tests/fixtures/data-merge"
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
    check("the merge's vectors found (\(dir))", names.count >= 8, "\(names.count)")
    let root = tempFolder("vectors")
    defer { try? FileManager.default.removeItem(at: root) }
    for name in names {
      guard let data = FileManager.default.contents(atPath: dir + "/" + name), let v = object(data) else { check("vector \(name) reads", false); continue }
      let base = v["base"] is NSNull ? nil : v["base"]
      let got = DataSet.merge(base, v["changes"])
      check("vector \(name): \(v["description"] as? String ?? "")", same(got.json, v["expected"]), "\(jsonString(got.json) ?? "")")
      // Its result as changes into nothing gives it again (a snapshot taken whole).
      let expected = DataSet(json: v["expected"])
      check("vector \(name): its result as changes gives it again", same(DataSet.merge(nil, expected.changes().map(\.json)).json, v["expected"]))
      // And through the files: saved, read back by another store, the same.
      let p = DataProfile(browser: "safari", profile: name)
      let store = DataStore(root: root, background: false)
      store.now = { 0 } // no tombstone is old
      store.save(p, .init(set: got, acked: 0), changed: nil)
      let readBack = DataStore(root: root, background: false).load(p)?.set.json
      check("vector \(name): through the files", same(readBack, v["expected"]), "\(readBack.flatMap(jsonString) ?? "nil")")
    }
    check("true is JSON's true, not 1", isTrue(true as NSNumber) && !isTrue(1 as NSNumber) && !isTrue(nil) && !isTrue("true"))
    check("deleted: 1 isn't a deletion", DataChange(json: ["collection": "a", "id": "b", "updatedAt": 1, "deleted": 1]) == nil)
    check("an id of 257 characters: not a change", DataChange(json: ["collection": "a", "id": String(repeating: "x", count: 257), "updatedAt": 1, "value": 1]) == nil)
    check("an updatedAt of true: not a change", DataChange(json: ["collection": "a", "id": "b", "updatedAt": true, "value": 1]) == nil)
    check("a value of null is a value", DataChange(json: ["collection": "a", "id": "b", "updatedAt": 1, "value": NSNull()])?.item.deleted == false)
    var set = DataSet()
    set.merge([change("spaces", "a", 1, space("A")), change("spaces", "b", 2)])
    check("changes in a fixed order, by collection and id", DataSet.merge(nil, set.changes().map(\.json)).json.description.count > 0 && set.changes().map(\.id) == ["a", "b"])
    check("live values", set.liveValues("spaces").keys.sorted() == ["a"])
    check("the newest time", set.newest == 2)
    var tomb = DataSet()
    tomb.merge((0..<2005).map { change("pins", "p\($0)", Double(1000 + $0)) } + [change("pins", "live", 1, ["url": "x"]), change("folders", "old", 5), change("folders", "new", 500)])
    let touched = tomb.pruneTombstones(before: 100)
    check("tombstones: older than the limit go", tomb.item("folders", "old") == nil && tomb.item("folders", "new") != nil)
    check("tombstones: 2,000 a collection, the newest kept", tomb.items["pins"]!.values.filter(\.deleted).count == 2000 && tomb.item("pins", "p2004") != nil && tomb.item("pins", "p4") == nil && tomb.item("pins", "p5") != nil)
    check("tombstones: live items stay; which collections lost any", tomb.item("pins", "live") != nil && touched == ["pins", "folders"])
  }

  static func dataStore() {
    check("names on disk: dots, capitals and colons written out", DataStore.fileName("..") == "%2E%2E" && DataStore.fileName("Ab:c.d") == "%41b%3Ac%2Ed" && DataStore.fileName("p-1_x") == "p-1_x")
    check("a long name: its hash", DataStore.fileName(String(repeating: "é", count: 100)).hasPrefix("~") && DataStore.fileName(String(repeating: "é", count: 100)).count == 65)
    check("Margin's collections by their names, any other written out after x-", DataStore.collectionFileName("themeSettings") == "themeSettings"
          && DataStore.collectionFileName("Spaces") == "x-%53paces" && DataStore.collectionFileName("laterThing") == "x-later%54hing")
    let root = tempFolder("store")
    defer { try? FileManager.default.removeItem(at: root) }
    let p1 = DataProfile(browser: "safari", profile: "P1")
    let store = testStore(root)
    check("no data set for a profile never linked", store.load(p1) == nil)
    var set = DataSet()
    set.merge([change("spaces", "a", 10, space("A")), change("pins", "p", 11, ["url": "https://p.test/"]), change("pins", "gone", 12)])
    var saved: Bool?
    store.save(p1, .init(set: set, acked: 12), changed: nil) { saved = $0 }
    let dir = store.directory(p1)
    let fm = FileManager.default
    check("saved: set.json and a file per collection", saved == true && fm.fileExists(atPath: dir.appendingPathComponent("set.json").path)
          && fm.fileExists(atPath: dir.appendingPathComponent("items/spaces.json").path) && fm.fileExists(atPath: dir.appendingPathComponent("items/pins.json").path))
    check("inside the root", dir.path.hasPrefix(root.path + "/safari/"))
    let again = testStore(root).load(p1)
    check("read back by another store (a relaunch): the same set and acked", again.map { same($0.set.json, set.json) && $0.acked == 12 } == true)
    let spacesFile = dir.appendingPathComponent("items/spaces.json")
    let before = try? Data(contentsOf: spacesFile)
    let pinsBefore = (try? fm.attributesOfItem(atPath: dir.appendingPathComponent("items/pins.json").path))?[.modificationDate] as? Date
    set.merge([change("spaces", "a", 20, space("A2"))])
    store.save(p1, .init(set: set, acked: 20), changed: ["spaces"])
    check("a change to one collection: the version before kept as its backup", (try? Data(contentsOf: URL(fileURLWithPath: spacesFile.path + ".bak"))) == before && before != nil)
    check("and the other collections' files left alone", ((try? fm.attributesOfItem(atPath: dir.appendingPathComponent("items/pins.json").path))?[.modificationDate] as? Date) == pinsBefore
          && !fm.fileExists(atPath: dir.appendingPathComponent("items/pins.json.bak").path))
    // A file damaged (by hand, a disk fault): its backup is read.
    try? Data("{\"format\":1,\"coll".utf8).write(to: spacesFile)
    try? Data("half".utf8).write(to: dir.appendingPathComponent("items/.spaces.json.1234.tmp"))
    let fresh = testStore(root)
    let recovered = fresh.load(p1)
    check("a damaged file: its backup read instead", fresh.recovered == ["spaces.json"] && (recovered?.set.liveValues("spaces")["a"] as? JSONObject)?["name"] as? String == "A")
    check("a temporary file left over: removed", fresh.removedTemps == 1 && !fm.fileExists(atPath: dir.appendingPathComponent("items/.spaces.json.1234.tmp").path))
    check("the rest read as saved", recovered?.set.item("pins", "gone")?.deleted == true && recovered?.acked == 20)

    // Revisions: new at every save that changes the set, not otherwise; kept in set.json.
    let revs = testStore(root)
    guard let r0 = revs.load(p1)?.rev, var r = revs.load(p1) else { return check("a rev", false) }
    revs.save(p1, r, changed: [])
    check("a save that changes nothing: the same rev", revs.load(p1)?.rev == r0)
    r.set.merge([change("folders", "f", 25, ["name": "F"])])
    revs.save(p1, r, changed: ["folders"])
    let r1 = revs.load(p1)?.rev ?? ""
    check("a save that changes something: a new rev, numbered on", r1 != r0 && Int(r1.split(separator: "-")[0]) == (Int(r0.split(separator: "-")[0]) ?? -9) + 1 && r1.count > 4)
    check("the rev read back from set.json", testStore(root).load(p1)?.rev == r1)
    check("revs never repeat (random after the number)", DataStore.nextRev("4-aa") != DataStore.nextRev("4-aa") && DataStore.nextRev("4-aa").hasPrefix("5-") && DataStore.nextRev(nil).hasPrefix("1-"))

    // A crash mid-write: set.json's new rev, one file, the next left as a temporary file.
    if let recovered { testStore(root).save(p1, recovered, changed: nil) } // the damaged file written whole again
    let crashy = testStore(root)
    guard var base = crashy.load(p1) else { return check("loaded for the crash", false) }
    let revBefore = base.rev
    base.set.merge([change("pins", "p", 30, ["url": "https://p2.test/"]), change("spaces", "a", 30, space("A3"))])
    base.acked = 30
    crashy.crashAfterWrites = 2
    var called = false
    crashy.save(p1, base, changed: ["pins", "spaces"]) { _ in called = true }
    check("a crash: nothing said after it", !called && crashy.crashed)
    let afterCrash = testStore(root)
    let read = afterCrash.load(p1)
    check("after a crash mid-write: the files whole, the one written new, the next as it was", (read?.set.liveValues("pins")["p"] as? JSONObject)?["url"] as? String == "https://p2.test/"
          && (read?.set.liveValues("spaces")["a"] as? JSONObject)?["name"] as? String == "A" && afterCrash.recovered.isEmpty)
    check("and acked as it was (set.json is written last), but the rev already new (written first)", read?.acked == 20 && read?.rev != revBefore && read?.rev.isEmpty == false)
    check("its temporary file removed", afterCrash.removedTemps == 1)
    let p3 = DataProfile(browser: "safari", profile: "P3")
    let firstCrash = testStore(root)
    firstCrash.crashAfterWrites = 1
    firstCrash.save(p3, .init(set: set, acked: 1), changed: nil)
    check("a crash during a profile's first write: no data set (set.json never written)", testStore(root).load(p3) == nil)

    // Tombstones past their time go as it's saved.
    let pruner = testStore(root)
    pruner.now = { 100 * 24 * 3600 * 1000 }
    var old = DataSet()
    old.merge([change("pins", "ancient", 1), change("pins", "recent", 99 * 24 * 3600 * 1000)])
    let p4 = DataProfile(browser: "safari", profile: "P4")
    pruner.save(p4, .init(set: old, acked: 0), changed: [])
    check("tombstones older than 60 days dropped as it's saved, in the file too", pruner.load(p4)?.set.item("pins", "ancient") == nil
          && testStore(root).load(p4)?.set.item("pins", "recent") != nil && testStore(root).load(p4)?.set.item("pins", "ancient") == nil)

    // A later format's data is left alone.
    let p5 = DataProfile(browser: "safari", profile: "P5")
    let later = testStore(root)
    later.save(p5, .init(set: set, acked: 1), changed: nil)
    let manifest = later.directory(p5).appendingPathComponent("set.json")
    try? Data(#"{"format":2,"browser":"safari","profile":"P5","acked":1}"#.utf8).write(to: manifest)
    let reader = testStore(root)
    var refused: Bool?
    check("a later format's set: not read", reader.load(p5) == nil)
    reader.save(p5, .init(set: set, acked: 2), changed: nil) { refused = !$0 }
    check("and never written over", refused == true && (try? Data(contentsOf: manifest)) == Data(#"{"format":2,"browser":"safari","profile":"P5","acked":1}"#.utf8))

    let odd = DataProfile(browser: "safari", profile: "..")
    reader.save(odd, .init(set: set, acked: 1), changed: nil)
    check("a profile called ..: a folder of its own inside the root", fm.fileExists(atPath: root.appendingPathComponent("safari/%2E%2E/set.json").path))
    reader.save(DataProfile(browser: "chrome", profile: "P1"), .init(set: set, acked: 1), changed: nil)
    let listed = testStore(root).profiles()
    check("every profile with a set, by its real name", listed.map(\.key) == ["chrome:P1", "safari:..", "safari:P1", "safari:P4", "safari:P5"], "\(listed)")
    check("of one browser", testStore(root).profiles(browser: "chrome").map(\.key) == ["chrome:P1"])

    // On a queue of its own: called back on the main thread, in order.
    let queued = DataStore(root: root, background: true)
    queued.now = { 1000 }
    var order: [Int] = []
    let p6 = DataProfile(browser: "safari", profile: "P6")
    queued.save(p6, .init(set: set, acked: 1), changed: nil) { _ in order.append(1) }
    queued.save(p6, .init(set: set, acked: 2), changed: ["spaces"]) { _ in order.append(2) }
    check("in memory at once", queued.load(p6)?.acked == 2)
    let until = Date().addingTimeInterval(5)
    while order.count < 2, Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    check("written in order, then called back", order == [1, 2] && testStore(root).load(p6)?.acked == 2)
  }

  static func dataSync() {
    if case .data(let kind, let body)? = LinkMessage.decode(#"{"k":"data.hello","profile":"P1","format":1,"acked":5,"queue":[]}"#) {
      check("data.hello: a data message, as it came", kind == "data.hello" && num(body["acked"]) == 5 && body["profile"] as? String == "P1")
    } else { check("data.hello decodes", false) }
    let ack = object(AppMessage.data(kind: "data.ack", body: ["upTo": 5, "profile": "P1"]).encode())
    check("data.ack from the app", ack?["k"] as? String == "data.ack" && num(ack?["upTo"]) == 5 && ack?["profile"] as? String == "P1")
    check("a data message from the app over 1 MB: refused", AppMessage.data(kind: "data.changes", body: ["x": String(repeating: "x", count: LinkProtocol.maxAppMessage)]).encode() == nil)
    let root = tempFolder("sync")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = testStore(root)
    let sync = DataSync(store: store)
    var changed: [String] = []
    sync.onChange = { p, c in changed.append("\(p.key) \(c.sorted().joined(separator: ","))") }
    let p1 = DataProfile(browser: "safari", profile: "P1"), p2 = DataProfile(browser: "safari", profile: "P2")

    // ---- the first link ----
    let a = FakePeer("P1")
    sync.linkUp(a)
    let queued = change("settings", "x", 50, 1).json
    sync.received(a, "data.hello", ["profile": "P1", "format": 1, "acked": 0, "queue": [queued]])
    check("first link: no set, so data.need { all: true }, naming the profile and epoch", a.kinds == ["data.need"] && a.sent[0].body["all"] as? Bool == true
          && a.sent[0].body["profile"] as? String == "P1" && a.sent[0].body["epoch"] as? String == "e1" && store.load(p1) == nil)
    a.sent = []
    let converted: JSONObject = ["format": 1, "items": ["spaces": ["personal": ["updatedAt": 0, "value": space("Personal")], "work": ["updatedAt": 40, "value": space("Work", 1)]],
                                                        "pins": [String: Any](), "settings": ["x": ["updatedAt": 0, "value": 0]]]]
    let items = converted["items"] as! JSONObject
    sync.received(a, "data.snapshot", ["profile": "P1", "format": 1, "transfer": "t1", "part": 1, "parts": 2, "set": ["format": 1, "items": ["spaces": items["spaces"]!]]])
    check("a part of the copy's snapshot: waits for the rest", a.sent.isEmpty && store.load(p1) == nil)
    sync.received(a, "data.snapshot", ["profile": "P1", "format": 1, "transfer": "t1", "part": 0, "parts": 2, "set": ["format": 1, "items": ["pins": items["pins"]!, "settings": items["settings"]!]]])
    let first = store.load(p1)
    check("the converter's set stored as the profile's, the held queue under it", first?.set.liveValues("spaces").count == 2 && first?.set.items["pins"]?.isEmpty == true
          && first?.set.liveValues("settings")["x"] as? Int == 1)
    check("then data.ack upTo its newest, with the set's rev, and no snapshot back", a.kinds == ["data.ack"] && num(a.sent[0].body["upTo"]) == 50 && first?.acked == 50
          && a.sent[0].body["rev"] as? String == first?.rev && first?.rev.hasPrefix("1-") == true, "\(a.sent)")
    check("the app's UI told", changed == ["safari:P1 pins,settings,spaces"])
    a.sent = []

    // ---- linked: changes both ways ----
    sync.received(a, "data.changes", ["profile": "P1", "changes": [change("spaces", "work", 60, space("Job", 1)).json, change("spaces", "personal", -5, space("Old")).json]])
    check("a change taken, one older than the app's sent back as the app has it, then ack", a.kinds == ["data.changes", "data.ack"]
          && ((a.sent[0].body["changes"] as? [JSONObject])?.first?["id"] as? String) == "personal" && num((a.sent[0].body["changes"] as? [JSONObject])?.first?["updatedAt"]) == 0
          && num(a.sent[1].body["upTo"]) == 60 && (store.load(p1)?.set.liveValues("spaces")["work"] as? JSONObject)?["name"] as? String == "Job")
    a.sent = []
    check("the app's own change: stored and sent to the copy", sync.change(p1, [change("spaces", "personal", 70, space("Home"))]) && a.kinds == ["data.changes"] && store.load(p1)?.acked == 60)
    a.sent = []
    check("one that loses: nothing sent", sync.change(p1, [change("spaces", "personal", 1, space("Nope"))]) && a.sent.isEmpty)
    check("for a profile with no set: refused", !sync.change(p2, [change("spaces", "x", 1, space("X"))]))

    // ---- another profile ----
    let b = FakePeer("P2", epoch: "e2")
    sync.linkUp(b)
    sync.received(b, "data.changes", ["profile": "P1", "changes": [change("spaces", "work", 999, space("Hijacked")).json]])
    check("a message naming another profile: refused", b.sent.isEmpty && (store.load(p1)?.set.liveValues("spaces")["work"] as? JSONObject)?["name"] as? String == "Job")
    sync.received(b, "data.changes", ["profile": "P2", "changes": [change("spaces", "work", 100, space("P2 work")).json]])
    check("changes before a set: the whole set asked for, the changes held", b.kinds == ["data.need"])
    b.sent = []
    sync.received(b, "data.snapshot", ["profile": "P2", "format": 1, "set": ["format": 1, "items": ["spaces": ["work": ["updatedAt": 90, "value": space("W")]]]]])
    check("P2's own set: its snapshot with the held change on top", (store.load(p2)?.set.liveValues("spaces")["work"] as? JSONObject)?["name"] as? String == "P2 work" && b.kinds == ["data.ack"] && num(b.sent[0].body["upTo"]) == 100)
    check("P1's set untouched by P2's", (store.load(p1)?.set.liveValues("spaces")["work"] as? JSONObject)?["name"] as? String == "Job" && store.load(p1)?.set.liveValues("spaces").count == 2)
    sync.received(b, "data.changes", ["profile": "P2", "epoch": "e1", "changes": [change("spaces", "work", 200, space("other epoch")).json]])
    check("another epoch's message: left", (store.load(p2)?.set.liveValues("spaces")["work"] as? JSONObject)?["name"] as? String == "P2 work")

    // ---- relinking with a queue ----
    sync.linkDown(a)
    let a2 = FakePeer("P1", epoch: "e3")
    sync.linkUp(a2)
    sync.received(a, "data.changes", ["profile": "P1", "changes": [change("spaces", "work", 999, space("Stale link")).json]])
    check("a link gone: its messages left", (store.load(p1)?.set.liveValues("spaces")["work"] as? JSONObject)?["name"] as? String == "Job")
    sync.received(a2, "data.hello", ["profile": "P1", "format": 1, "acked": 60, "queue": [change("pins", "p1", 80, ["url": "https://p.test/"]).json, change("spaces", "work", 65).json]])
    let back = assembled(a2.sent)
    check("relink: the queue merged and stored, the whole set sent back, then ack", a2.kinds.last == "data.ack" && a2.kinds.dropLast().allSatisfy { $0 == "data.snapshot" } && back != nil
          && same(back?.set, store.load(p1)?.set.json) && num(a2.sent.last?.body["upTo"]) == 80, "\(a2.kinds)")
    check("the deletion kept, the new pin in", store.load(p1)?.set.item("spaces", "work")?.deleted == true && store.load(p1)?.set.liveValues("pins")["p1"] != nil
          && store.load(p1)?.set.liveValues("spaces")["personal"] != nil)
    let reread = testStore(root).load(p1)
    check("on disk too", reread.map { same($0.set.json, store.load(p1)?.set.json) && $0.acked == 80 } == true)

    // ---- the app's files older than what it confirmed (restored from a backup) ----
    a2.sent = []
    sync.received(a2, "data.hello", ["profile": "P1", "format": 1, "acked": 500, "queue": [change("pins", "p2", 501, ["url": "https://q.test/"]).json]])
    check("the copy confirmed more than the app's files have: the whole set asked for", a2.kinds == ["data.need"])
    a2.sent = []
    sync.received(a2, "data.snapshot", ["profile": "P1", "format": 1, "set": ["format": 1, "items": ["pins": ["p3": ["updatedAt": 400, "value": ["url": "https://r.test/"]]]]]])
    let restored = store.load(p1)
    check("its snapshot merged into what the app has, sent back merged, then ack", restored?.set.liveValues("pins").keys.sorted() == ["p1", "p2", "p3"] && restored?.set.liveValues("spaces")["personal"] != nil
          && a2.kinds.last == "data.ack" && num(a2.sent.last?.body["upTo"]) == 501 && same(assembled(a2.sent)?.set, restored?.set.json) && restored?.acked == 501)

    // ---- a wiped cache: acked 0, a queue of what's new ----
    a2.sent = []
    sync.received(a2, "data.hello", ["profile": "P1", "format": 1, "acked": 0, "queue": [change("tabs", "t-new0000001", 600, ["url": "https://new.test/", "spaceId": "personal", "order": 0]).json]])
    check("a wiped cache: the app's set back to it, with what it did since", assembled(a2.sent).map { (($0.set["items"] as? JSONObject)?["pins"] as? JSONObject)?.count == 3 } == true
          && store.load(p1)?.set.liveValues("tabs")["t-new0000001"] != nil && num(a2.sent.last?.body["upTo"]) == 600)

    // ---- parts ----
    var big = DataSet()
    big.merge((0..<60).map { change("siteIcons", "https://site\($0).test", Double($0), ["data": "data:image/png;base64," + String(repeating: "A", count: 300)]) } + [change("archive", "huge", 1, ["blob": String(repeating: "B", count: 5000)])])
    big.items["folders"] = [:]
    let (parts, omitted) = DataSync.parts(of: big, budget: 2000)
    check("a set in parts within the budget", parts.count > 5 && parts.allSatisfy { (jsonText($0)?.count ?? .max) <= 2000 }, "\(parts.map { jsonText($0)?.count ?? 0 })")
    check("every collection named in the first part, an empty one too", (parts[0]["folders"] as? JSONObject)?.isEmpty == true && parts[0]["siteIcons"] != nil && parts[0]["archive"] != nil)
    check("an item too big for any part: left out, named", omitted.map(\.id) == ["huge"])
    var whole: JSONObject = [:]
    for part in parts { for (c, l) in part { var into = whole[c] as? JSONObject ?? [:]; into.merge(l as! JSONObject) { _, b in b }; whole[c] = into } }
    check("the parts add up to the set (but what was left out)", (whole["siteIcons"] as? JSONObject)?.count == 60 && (whole["archive"] as? JSONObject)?.isEmpty == true)
    let (batches, _) = DataSync.batches(of: big.changes(), budget: 3000)
    check("changes in batches within the budget, in order", batches.count > 5 && batches.allSatisfy { (jsonText($0)?.count ?? .max) <= 3000 } && batches.flatMap { $0 }.count == 60)
    sync.partBytes = 2000
    let c = FakePeer("P7", epoch: "e7")
    sync.linkUp(c)
    store.save(DataProfile(browser: "safari", profile: "P7"), .init(set: big, acked: 0), changed: nil)
    sync.received(c, "data.hello", ["profile": "P7", "format": 1, "acked": 0, "queue": []])
    let snap = assembled(c.sent)
    check("data.snapshot in parts, each under the budget plus its envelope, the left-out item named in part 0", (snap?.parts ?? 0) > 5 && c.sent.allSatisfy { (jsonText($0.body)?.count ?? .max) < 2300 }
          && ((c.sent.first?.body["omitted"] as? [[String]])?.first ?? []) == ["archive", "huge"], "\(c.sent.map { jsonText($0.body)?.count ?? 0 })")
    sync.partBytes = 900_000
    let huge = FakePeer("P8")
    sync.linkUp(huge)
    var icons = DataSet()
    icons.merge((0..<40).map { change("siteIcons", "https://s\($0).test", 1, ["data": String(repeating: "C", count: 60_000)]) })
    store.save(DataProfile(browser: "safari", profile: "P8"), .init(set: icons, acked: 0), changed: nil)
    sync.received(huge, "data.hello", ["profile": "P8", "format": 1, "acked": 0, "queue": []])
    check("2.4 MB of site icons: in parts, none over 1 MB, nothing refused", (assembled(huge.sent)?.parts ?? 0) >= 3 && sync.unsent == 0
          && ((assembled(huge.sent)?.set["items"] as? JSONObject)?["siteIcons"] as? JSONObject)?.count == 40)

    // ---- revisions: no snapshot for a copy that has the app's set ----
    sync.linkDown(a2)
    let a3 = FakePeer("P1", epoch: "e4")
    sync.linkUp(a3)
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 600, "queue": []])
    let revNow = store.load(p1)?.rev ?? "?"
    check("a hello with no rev (never, or wiped): the snapshot, its part 0 and the ack carrying the set's rev", a3.kinds.first == "data.snapshot" && a3.sent[0].body["rev"] as? String == revNow
          && a3.sent.last?.kind == "data.ack" && a3.sent.last?.body["rev"] as? String == revNow && a3.sent.dropFirst().allSatisfy { $0.body["rev"] == nil || $0.kind == "data.ack" })
    a3.sent = []
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 600, "rev": revNow, "queue": []])
    check("a hello with the set's rev and nothing queued: no snapshot, only data.ack with the same rev", a3.kinds == ["data.ack"] && a3.sent[0].body["rev"] as? String == revNow
          && store.load(p1)?.rev == revNow)
    a3.sent = []
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 600, "rev": revNow,
                                     "queue": [change("pins", "p9", 700, ["url": "https://p9.test/"]).json, change("spaces", "personal", 2, space("Older")).json]])
    let revQueued = store.load(p1)?.rev ?? "?"
    check("the set's rev with a queue: merged, no snapshot, the change that lost answered, then data.ack with the new rev", a3.kinds == ["data.changes", "data.ack"]
          && ((a3.sent[0].body["changes"] as? [JSONObject])?.first?["id"] as? String) == "personal" && num(a3.sent[1].body["upTo"]) == 700
          && a3.sent[1].body["rev"] as? String == revQueued && revQueued != revNow && store.load(p1)?.set.liveValues("pins")["p9"] != nil)
    a3.sent = []
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 700, "rev": "3-00000000ff", "queue": []])
    check("a rev the app doesn't know (an older backup, another Mac): the snapshot", a3.kinds.first == "data.snapshot" && a3.kinds.last == "data.ack")
    a3.sent = []
    sync.received(a3, "data.changes", ["profile": "P1", "changes": [change("folders", "fb", 710, ["name": "B"]).json]])
    let revChanged = store.load(p1)?.rev ?? "?"
    check("linked, in step: data.ack for the copy's changes carries the new rev", a3.kinds == ["data.ack"] && a3.sent[0].body["rev"] as? String == revChanged && revChanged != revQueued)
    a3.sent = []
    sync.change(p1, [change("folders", "fa", 720, ["name": "A"])])
    check("the app's own change: sent without a rev, the set's rev moved on", a3.kinds == ["data.changes"] && a3.sent[0].body["rev"] == nil && store.load(p1)?.rev != revChanged)
    a3.sent = []
    sync.received(a3, "data.hello", ["profile": "P1", "format": 1, "acked": 710, "rev": revChanged, "queue": []])
    check("a hello after an app-side change: the copy's rev is older, the snapshot", a3.kinds.first == "data.snapshot" && assembled(a3.sent).map { same($0.set, store.load(p1)?.set.json) } == true)
    let unsynced = FakePeer("P1", epoch: "e5")
    sync.linkDown(a3)
    sync.linkUp(unsynced)
    sync.received(unsynced, "data.changes", ["profile": "P1", "changes": [change("folders", "fc", 730, ["name": "C"]).json]])
    check("changes on a link that hasn't said data.hello: acked without a rev (the app can't say what the copy has)", unsynced.kinds == ["data.ack"] && unsynced.sent[0].body["rev"] == nil)

    // ---- a write that fails: nothing confirmed ----
    let d = FakePeer("P1", epoch: "e9")
    sync.linkDown(unsynced)
    sync.linkUp(d)
    store.crashAfterWrites = 0
    sync.received(d, "data.changes", ["profile": "P1", "changes": [change("spaces", "personal", 9999, space("Lost")).json]])
    check("a crash mid-write: no data.ack (the copy keeps its queue)", d.sent.isEmpty)
    let afterCrash = testStore(root)
    check("and the files as before it", (afterCrash.load(p1)?.set.liveValues("spaces")["personal"] as? JSONObject)?["name"] as? String == "Home" && afterCrash.load(p1)?.acked == 730)
  }

  // A profile's set carried to a new id (a signing change): DataSync's hold and carry.
  static func dataCarry() {
    let root = tempFolder("carry")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = testStore(root)
    let sync = DataSync(store: store)
    sync.now = { 5000 }
    var carried: [String] = []
    sync.onCarried = { old, new, why in carried.append("\(old.profile)>\(new.profile) \(why)") }
    let pA = DataProfile(browser: "safari", profile: "s-aaaa"), pB = DataProfile(browser: "safari", profile: "s-bbbb")
    func seed(_ p: DataProfile, _ changes: [DataChange], acked: Double = 100) {
      var set = DataSet()
      set.merge(changes)
      store.save(p, DataStore.Stored(set: set, acked: acked), changed: nil)
    }
    seed(pA, [change("spaces", "work", 100, space("Deep Work")), change("spaces", "side", 90, space("Side", 1)), change("settings", "theme", 100, "arcadia")])
    let oldDir = store.directory(pA)

    // ---- a hello before Safari's read: held, then carried over ----
    let b = FakePeer("s-bbbb")
    sync.linkUp(b)
    var asked: [String] = []
    sync.beforeNeed = { p in asked.append(p.profile); return .hold }
    let fresh = [change("spaces", "space1", 200, space("Space 1")).json, change("settings", "theme", 300, "neo").json]
    sync.received(b, "data.hello", ["profile": "s-bbbb", "format": 1, "acked": 0, "queue": fresh])
    check("carry: a new id's hello with no set, beforeNeed says hold: nothing sent yet", b.sent.isEmpty && asked == ["s-bbbb"] && sync.holding == [pB] && store.load(pB) == nil)
    check("carry: not from a linked profile", { let a = FakePeer("s-aaaa"); sync.linkUp(a); defer { sync.linkDown(a) }; return !sync.carry(from: pA, to: pB, why: "x") }())
    sync.received(b, "data.changes", ["profile": "s-bbbb", "changes": [change("pins", "pnew", 700, ["url": "https://new.test/"]).json]])
    check("carry: a change while the hello is held: kept, nothing sent", b.sent.isEmpty && store.load(pB) == nil)
    check("carry: under way", sync.carry(from: pA, to: pB, why: "Safari profile X"))
    check("carry: the change made while held taken after it", store.load(pB)?.set.liveValues("pins")["pnew"] != nil && b.kinds.last == "data.ack" && num(b.sent.last?.body["upTo"]) == 700, "\(b.kinds)")
    let bSet = store.load(pB)
    check("carry: the new id has the old set's spaces and settings", (bSet?.set.liveValues("spaces")["work"] as? JSONObject)?["name"] as? String == "Deep Work"
          && bSet?.set.liveValues("spaces").count == 2 && bSet?.set.liveValues("settings")["theme"] as? String == "arcadia", "\(bSet?.set.json ?? [:])")
    check("carry: the new copy's own defaults left out (deleted), not merged in", bSet?.set.item("spaces", "space1")?.deleted == true && bSet?.set.item("settings", "theme")?.updatedAt == 100 && (bSet?.set.item("spaces", "space1")?.updatedAt ?? 0) > 200)
    let back = assembled(b.sent)
    check("carry: the held hello answered as a relink: the set to the copy, then data.ack", b.kinds.suffix(2) == ["data.ack", "data.ack"] && b.kinds.dropLast(2).allSatisfy { $0 == "data.snapshot" } && b.kinds.count >= 3
          && back?.set != nil && (((back?.set["items"] as? JSONObject)?["spaces"] as? JSONObject)?["work"] as? JSONObject) != nil && !b.kinds.contains("data.need"), "\(b.kinds)")
    check("carry: the old set put away, out of the profiles", store.profiles(browser: "safari") == [pB] && !FileManager.default.fileExists(atPath: oldDir.path)
          && ((try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("safari/.archived").path)) ?? []).count == 1 && store.load(pA) == nil)
    check("carry: said", carried == ["s-aaaa>s-bbbb Safari profile X"] && sync.holding.isEmpty)
    check("carry: acked: the old set's, then the held change's", store.load(pB)?.acked == 700, "\(store.load(pB)?.acked ?? -1)")
    check("carry: again: nothing (the old set is gone)", !sync.carry(from: pA, to: pB, why: "x"))

    // ---- the hold runs out: data.need, as without it ----
    sync.holdFor = 0.05
    let c = FakePeer("s-cccc")
    sync.linkUp(c)
    sync.received(c, "data.hello", ["profile": "s-cccc", "format": 1, "acked": 0, "queue": []])
    check("hold: nothing at first", c.sent.isEmpty)
    waitUntil(1) { !c.sent.isEmpty }
    check("hold: run out: data.need", c.kinds == ["data.need"], "\(c.kinds)")
    sync.holdFor = 3

    // ---- no read (beforeNeed not set, or .ask): data.need at once ----
    sync.beforeNeed = nil
    let g = FakePeer("s-gggg")
    sync.linkUp(g)
    sync.received(g, "data.hello", ["profile": "s-gggg", "format": 1, "acked": 0, "queue": []])
    check("no Safari read: a fresh set as today (data.need at once)", g.kinds == ["data.need"])

    // ---- after the new copy's first set: carried if it's untouched ----
    let pE = DataProfile(browser: "safari", profile: "s-eeee"), pF = DataProfile(browser: "safari", profile: "s-ffff"), pD = DataProfile(browser: "safari", profile: "s-dddd")
    seed(pE, [change("spaces", "home", 100, space("Home E")), change("pins", "pe", 100, ["url": "https://e.test/"])])
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
    let fSet = store.load(pF)
    check("late: the first set stored, then carried over", first == ["s-ffff"] && (fSet?.set.liveValues("spaces")["home"] as? JSONObject)?["name"] as? String == "Home E"
          && fSet?.set.item("spaces", "d1")?.deleted == true && fSet?.set.liveValues("pins").count == 1 && store.load(pE) == nil, "\(fSet?.set.json ?? [:])")
    let fBack = assembled(f.sent)
    check("late: the copy got the carried set and an ack with its rev", f.kinds.first == "data.ack" && f.kinds.last == "data.ack" && f.kinds.contains("data.snapshot")
          && same(fBack?.set, fSet?.set.json) && f.sent.last?.body["rev"] as? String == fSet?.rev, "\(f.kinds)")
    // A copy that has sent changes since its first set: never.
    seed(pE, [change("spaces", "home", 100, space("Home E"))])
    let d = FakePeer("s-dddd")
    sync.linkUp(d)
    sync.received(d, "data.hello", ["profile": "s-dddd", "format": 1, "acked": 0, "queue": []])
    sync.received(d, "data.snapshot", ["profile": "s-dddd", "format": 1, "set": ["format": 1, "items": ["spaces": ["d1": ["updatedAt": 400, "value": space("Space 1")]]]]])
    check("touched: the first set is rev 1", store.load(pD)?.rev.hasPrefix("1-") == true)
    sync.received(d, "data.changes", ["profile": "s-dddd", "changes": [change("spaces", "d1", 500, space("Mine")).json]])
    check("touched: a copy that sent changes since: no carry", !sync.carry(from: pE, to: pD, why: "x") && (store.load(pD)?.set.liveValues("spaces")["d1"] as? JSONObject)?["name"] as? String == "Mine"
          && store.load(pE) != nil)
    // While its copy's snapshot is on its way: not yet.
    let h = FakePeer("s-hhhh")
    sync.linkUp(h)
    sync.received(h, "data.hello", ["profile": "s-hhhh", "format": 1, "acked": 0, "queue": []])
    check("awaiting its copy's snapshot: not yet", !sync.carry(from: pE, to: DataProfile(browser: "safari", profile: "s-hhhh"), why: "x"))

    // ---- the switch back: the old id links again, the set comes back ----
    sync.linkDown(b)
    let a2 = FakePeer("s-aaaa", epoch: "e9")
    sync.linkUp(a2)
    sync.beforeNeed = { p in p == pA ? .carry(from: pB, why: "Safari profile X") : .ask }
    sync.received(a2, "data.hello", ["profile": "s-aaaa", "format": 1, "acked": 0, "queue": [change("spaces", "space1b", 600, space("Space 1")).json]])
    check("switch back: carried back at once, as a relink", (store.load(pA)?.set.liveValues("spaces")["work"] as? JSONObject)?["name"] as? String == "Deep Work"
          && store.load(pA)?.set.item("spaces", "space1b")?.deleted == true && a2.kinds.last == "data.ack" && a2.kinds.contains("data.snapshot") && !a2.kinds.contains("data.need")
          && store.load(pB) == nil && store.profiles(browser: "safari").contains(pA) && !store.profiles(browser: "safari").contains(pB), "\(a2.kinds)")
    check("switch back: said", carried.last == "s-bbbb>s-aaaa Safari profile X")
  }
}
