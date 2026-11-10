// iCloud Tabs' reader (CloudTabs.swift, SafariFiles.swift), part of
// tests.swift's run, against a stand-in for Safari's CloudTabs.db made here in
// a temporary folder with the schema Safari 27.2 has and a writer connection
// in WAL mode like Safari's, never Safari's own file and never its path: the
// order the positions say (zlib JSON, as Safari writes them), the fallback to
// when a tab was viewed, this Mac's own rows and devices with no tabs left
// out, only web pages, the device types, Safari's day-rounded record time, a
// missing file, no permission, a busy database, a file that isn't Safari's,
// a database changed while open, the watcher following the write-ahead log
// (few reads for many writes, none when nothing changed), what's sent to the
// overlays and what the log says (counts only).
import AppKit
import Foundation
import SQLite3

final class FakeCloud {
    let folder: URL
    private(set) var db: OpaquePointer?

    init() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-cloud-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    deinit { if let db { sqlite3_close(db) } }

    var dbPath: String { folder.appendingPathComponent("CloudTabs.db").path }

    static let schema = """
    CREATE TABLE cloud_tab_devices (device_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_name TEXT,device_type_identifier TEXT,has_duplicate_device_name BOOLEAN DEFAULT 0,is_ephemeral_device BOOLEAN DEFAULT 0,last_modified REAL NOT NULL);
    CREATE TABLE cloud_tabs (tab_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_uuid TEXT NOT NULL,position BLOB NOT NULL,title TEXT,url TEXT NOT NULL,is_showing_reader BOOLEAN DEFAULT 0,is_pinned BOOLEAN DEFAULT 0,reader_scroll_position_page_index INTEGER,scene_id TEXT,last_viewed_time REAL DEFAULT 0,topic_title TEXT,FOREIGN KEY(device_uuid) REFERENCES cloud_tab_devices(device_uuid) ON DELETE CASCADE);
    CREATE INDEX cloud_tabs__device_uuid ON cloud_tabs (device_uuid);
    CREATE TABLE cloud_tab_close_requests (close_request_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,destination_device_uuid TEXT NOT NULL,url TEXT NOT NULL,tab_uuid TEXT NOT NULL,FOREIGN KEY(destination_device_uuid) REFERENCES cloud_tab_devices(device_uuid) ON DELETE CASCADE);
    CREATE TABLE metadata (key TEXT NOT NULL UNIQUE, value);
    """

    func open(schema: String = FakeCloud.schema) {
        sqlite3_open(dbPath, &db)
        exec("PRAGMA journal_mode=WAL")
        exec(schema)
    }

    func close() {
        if let db { sqlite3_close(db) }
        db = nil
    }

    @discardableResult func exec(_ sql: String) -> Int32 { sqlite3_exec(db, sql, nil, nil, nil) }

    // A position as Safari writes it: zlib (header, deflate, Adler-32) around the sort values' JSON.
    static func position(_ values: [(Double, String)], header: [UInt8] = [0x78, 0xDA], check: Bool = true) -> Data {
        let json = try! JSONSerialization.data(withJSONObject: ["sortValues": values.map { ["changeID": 0, "sortValue": $0.0, "deviceIdentifier": $0.1] as [String: Any] }])
        let deflated = try! (json as NSData).compressed(using: .zlib) as Data
        var a: UInt32 = 1, b: UInt32 = 0
        for byte in json { a = (a + UInt32(byte)) % 65521; b = (b + a) % 65521 }
        let adler = (b << 16) | a
        return Data(header) + deflated + (check ? Data([UInt8(adler >> 24), UInt8(adler >> 16 & 0xff), UInt8(adler >> 8 & 0xff), UInt8(adler & 0xff)]) : Data())
    }

    func device(_ id: String, _ name: String, _ type: String, modified: Double, duplicate: Bool = false, ephemeral: Bool = false) {
        run("INSERT INTO cloud_tab_devices (device_uuid, system_fields, device_name, device_type_identifier, has_duplicate_device_name, is_ephemeral_device, last_modified) VALUES (?,?,?,?,?,?,?)") { stmt, bind in
            bind.text(1, id); bind.blob(2, Data([0x62, 0x70])); bind.text(3, name); bind.text(4, type)
            sqlite3_bind_int(stmt, 5, duplicate ? 1 : 0); sqlite3_bind_int(stmt, 6, ephemeral ? 1 : 0); sqlite3_bind_double(stmt, 7, modified)
        }
    }

    func tab(_ id: String, device: String, title: String, url: String, position: Data, pinned: Bool = false, viewed: Double = 0) {
        run("INSERT INTO cloud_tabs (tab_uuid, system_fields, device_uuid, position, title, url, is_pinned, last_viewed_time) VALUES (?,?,?,?,?,?,?,?)") { stmt, bind in
            bind.text(1, id); bind.blob(2, Data([0x62, 0x70])); bind.text(3, device); bind.blob(4, position); bind.text(5, title); bind.text(6, url)
            sqlite3_bind_int(stmt, 7, pinned ? 1 : 0); sqlite3_bind_double(stmt, 8, viewed)
        }
    }

    struct Binder {
        let stmt: OpaquePointer?
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        func text(_ i: Int32, _ s: String) { sqlite3_bind_text(stmt, i, s, -1, transient) }
        func blob(_ i: Int32, _ d: Data) { _ = d.withUnsafeBytes { sqlite3_bind_blob(stmt, i, $0.baseAddress, Int32(d.count), transient) } }
    }

    private func run(_ sql: String, _ bind: (OpaquePointer?, Binder) -> Void) {
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        bind(stmt, Binder(stmt: stmt))
        sqlite3_step(stmt)
        sqlite3_finalize(stmt)
    }

    // Made-up devices and tabs (never anyone's own), times as Safari keeps them (seconds since 2001).
    static let phone = "11111111-0000-4000-8000-000000000001"
    static let air = "11111111-0000-4000-8000-000000000002"
    static let thisMac = "11111111-0000-4000-8000-000000000003"
    static let thisMacAgain = "11111111-0000-4000-8000-000000000004"
    static let pad = "11111111-0000-4000-8000-000000000005"
    static let vision = "11111111-0000-4000-8000-000000000006"
    static let now = Date().timeIntervalSinceReferenceDate
    static let day: Double = 86_400

    func standard() {
        open()
        exec("INSERT INTO metadata (key, value) VALUES ('use_manatee_container', 1)")
        let midnight = (FakeCloud.now / FakeCloud.day).rounded(.down) * FakeCloud.day
        device(Self.phone, "Test iPhone", "com.apple.iphone-13-pro-9", modified: midnight)
        device(Self.air, "Studio Air", "com.apple.macbookair-15-2025-silver", modified: midnight - Self.day)
        device(Self.thisMac, "Test Mac", "com.apple.macbookpro-14-2021-space-gray", modified: midnight)
        device(Self.thisMacAgain, "Test Mac", "com.apple.macbookpro-14-2021-space-gray", modified: midnight)
        device(Self.pad, "Spare iPad", "com.apple.ipad-air-11-m2", modified: midnight - 3 * Self.day) // no tabs
        device(Self.vision, "Test iPhone", "com.apple.apple-vision-pro", modified: midnight - 2 * Self.day, duplicate: true, ephemeral: true)
        // The phone's tabs: positions out of insert order, one a list longer than another it begins.
        tab("P-3", device: Self.phone, title: "Third", url: "https://three.example/", position: Self.position([(4782, "C")]), viewed: Self.now - 60)
        tab("P-1", device: Self.phone, title: "First", url: "https://one.example/", position: Self.position([(-689, "A")]), pinned: true, viewed: Self.now - 600)
        tab("P-2b", device: Self.phone, title: "Second, after", url: "https://two.example/b", position: Self.position([(3782, "B"), (10, "X")]), viewed: Self.now - 300)
        tab("P-2", device: Self.phone, title: "Second", url: "https://two.example/", position: Self.position([(3782, "B")]), viewed: Self.now - 400)
        tab("P-x", device: Self.phone, title: "Not a web page", url: "file:///Users/someone/notes.txt", position: Self.position([(9000, "D")]))
        // The Air's: no positions that read, so newest viewed first.
        tab("A-1", device: Self.air, title: "Older", url: "https://older.example/", position: Data([1, 2, 3]), viewed: Self.now - 9000)
        tab("A-2", device: Self.air, title: "Newer", url: "https://newer.example/", position: Data(), viewed: Self.now - 8000)
        // This Mac's own rows have tabs here too (they mustn't show).
        tab("M-1", device: Self.thisMac, title: "Mine", url: "https://mine.example/", position: Self.position([(1, "M")]), viewed: Self.now)
        tab("V-1", device: Self.vision, title: "Immersive", url: "https://vision.example/", position: Self.position([(1, "V")]), viewed: Self.now - 2 * Self.day)
    }

    func remove() {
        close()
        try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: dbPath)
        try? FileManager.default.removeItem(at: folder)
    }
}

func cloudTabsTests() {
    // ---- the pieces ----
    check("cloud: kinds", ["com.apple.iphone-13-pro-9", "com.apple.ipad-air-11-m2", "com.apple.macbookpro-14-2021-space-gray", "com.apple.imac-24-2023-blue",
                           "com.apple.apple-vision-pro", "com.apple.realitydevice-14-1", "com.apple.ipod-touch-7", "com.example.toaster", ""].map(CloudTabs.kind)
          == ["phone", "pad", "mac", "mac", "vision", "vision", "phone", "other", "other"])
    let p = CloudTabs.position(FakeCloud.position([(-689, "AB12")]))
    check("cloud: a position as Safari writes it (78 DA, deflate, Adler-32)", p?.values.first?.0 == -689 && p?.values.first?.1 == "AB12", "\(String(describing: p?.values))")
    check("cloud: zlib's other headers, and with no check after the stream", CloudTabs.position(FakeCloud.position([(1, "a")], header: [0x78, 0x9C])) != nil
          && CloudTabs.position(FakeCloud.position([(1, "a")], header: [0x78, 0x01], check: false)) != nil)
    check("cloud: positions that don't read: none", CloudTabs.position(nil) == nil && CloudTabs.position(Data([0x78, 0xDA, 1, 2])) == nil && CloudTabs.position(Data("{}".utf8)) == nil
          && CloudTabs.position(FakeCloud.position([])) == nil)
    let pos = { (v: [(Double, String)]) in CloudTabs.Position(values: v) }
    check("cloud: the order: by value, then by the device that wrote it, a list before a longer one it begins",
          CloudTabs.before(pos([(1, "a")]), pos([(2, "a")])) && CloudTabs.before(pos([(1, "a")]), pos([(1, "b")])) && CloudTabs.before(pos([(1, "a")]), pos([(1, "a"), (0, "z")]))
          && !CloudTabs.before(pos([(1, "a"), (0, "z")]), pos([(1, "a")])) && CloudTabs.before(pos([(1, "a"), (0, "z")]), pos([(1, "a"), (5, "z")])))
    check("cloud: this Mac: a Mac with its name (case, spaces and apostrophes aside), never another kind or another name",
          CloudTabs.isThisMac(name: " test MAC ", kind: "mac", thisMac: "Test Mac") && CloudTabs.isThisMac(name: "Nora\u{2019}s Mac", kind: "mac", thisMac: "Nora's Mac")
          && !CloudTabs.isThisMac(name: "Test Mac", kind: "phone", thisMac: "Test Mac") && !CloudTabs.isThisMac(name: "Test Mac 2", kind: "mac", thisMac: "Test Mac")
          && !CloudTabs.isThisMac(name: "Test Mac", kind: "mac", thisMac: nil) && !CloudTabs.isThisMac(name: "", kind: "mac", thisMac: ""))
    check("cloud: this Mac's own name is read", CloudTabs.thisMacName().map { !$0.isEmpty } ?? true)

    // ---- the reader ----
    let cloud = FakeCloud()
    defer { cloud.remove() }
    check("cloud: no file: no data (iCloud Tabs off)", CloudTabs.read(cloud.folder, thisMac: "Test Mac") == .noData)
    check("cloud: no folder: no data", CloudTabs.read(cloud.folder.appendingPathComponent("none"), thisMac: "Test Mac") == .noData)
    cloud.standard()
    guard case .read(let report) = CloudTabs.read(cloud.folder, thisMac: "Test Mac") else { return check("cloud: read", false, "\(CloudTabs.read(cloud.folder, thisMac: "Test Mac"))") }
    let ids = report.devices.map(\.id)
    check("cloud: other devices only, the one used most recently first; this Mac's two rows and the device with no tabs left out",
          ids == [FakeCloud.phone, FakeCloud.air, FakeCloud.vision] && report.own == 2 && report.empty == 1, "\(ids) own \(report.own) empty \(report.empty)")
    let phone = report.devices.first { $0.id == FakeCloud.phone }
    check("cloud: a device's tabs in Safari's order (its positions)", phone?.tabs.map(\.id) == ["P-1", "P-2", "P-2b", "P-3"], "\(phone?.tabs.map(\.id) ?? [])")
    check("cloud: web pages only", report.dropped == 1 && !(phone?.tabs.contains { $0.url.hasPrefix("file:") } ?? true))
    check("cloud: pinned, titles, addresses", phone?.tabs.first?.pinned == true && phone?.tabs.first?.title == "First" && phone?.tabs.first?.url == "https://one.example/" && phone?.tabs[1].pinned == false)
    check("cloud: times in seconds since 1970", abs((phone?.tabs.first?.viewedAt ?? 0) - (FakeCloud.now - 600 + CloudTabs.referenceDate)) < 0.01)
    let air = report.devices.first { $0.id == FakeCloud.air }
    check("cloud: no positions that read: newest viewed first", air?.tabs.map(\.id) == ["A-2", "A-1"], "\(air?.tabs.map(\.id) ?? [])")
    let vision = report.devices.first { $0.id == FakeCloud.vision }
    check("cloud: kinds, a duplicate name and an ephemeral device as Safari says", phone?.kind == "phone" && air?.kind == "mac" && vision?.kind == "vision"
          && vision?.duplicateName == true && vision?.ephemeral == true && phone?.duplicateName == false)
    guard case .read(let withMine) = CloudTabs.read(cloud.folder, thisMac: "Another Mac") else { return check("cloud: read as another Mac", false) }
    check("cloud: on a Mac with another name, the Test Mac rows are another Mac's", withMine.devices.contains { $0.id == FakeCloud.thisMac } && withMine.own == 0 && withMine.empty == 2)

    // What the overlays get, and what the log says.
    let json = CloudTabs.json(.read(report)) ?? [:]
    let first = (json["devices"] as? [JSONObject])?.first ?? [:]
    let firstTab = (first["tabs"] as? [JSONObject])?.first ?? [:]
    check("cloud: sent to the overlays: ready, devices with their tabs, times in milliseconds", json["status"] as? String == "ready" && first["id"] as? String == FakeCloud.phone
          && first["name"] as? String == "Test iPhone" && first["kind"] as? String == "phone" && firstTab["pinned"] as? Bool == true
          && abs((num(firstTab["viewedAt"]) ?? 0) - (FakeCloud.now - 600 + CloudTabs.referenceDate) * 1000) < 1, "\(first)")
    check("cloud: the states sent", CloudTabs.json(.noAccess)?["status"] as? String == "noAccess" && CloudTabs.json(.noData)?["status"] as? String == "noData"
          && CloudTabs.json(.failed("x"))?["status"] as? String == "failed" && CloudTabs.json(.busy) == nil)
    let said = CloudTabs.describe(.read(report))
    check("cloud: the log says counts, never a title, an address or a name", said.contains("3 other devices") && said.contains("7 tabs") && said.contains("2 of this Mac's")
          && !said.contains("Test iPhone") && !said.contains("Studio") && !said.contains("example") && !said.contains("First"), said)

    // A database changed while it's open (Safari writing, its log growing): read again, the new row there.
    cloud.tab("P-4", device: FakeCloud.phone, title: "Fourth", url: "https://four.example/", position: FakeCloud.position([(9999, "E")]), viewed: FakeCloud.now)
    check("cloud: written while open: the log read through", { if case .read(let r) = CloudTabs.read(cloud.folder, thisMac: "Test Mac") { return r.devices.first?.tabs.last?.id == "P-4" }; return false }())

    // Busy: a connection holding the database exclusively.
    cloud.close()
    var holder: OpaquePointer?
    sqlite3_open(cloud.dbPath, &holder)
    sqlite3_exec(holder, "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE metadata SET value = value;", nil, nil, nil)
    check("cloud: a busy database: busy, nothing used", CloudTabs.read(cloud.folder, thisMac: "Test Mac", busyTimeoutMs: 50) == .busy)
    sqlite3_close(holder)
    cloud.open(schema: "")

    // No permission (as without Full Disk Access).
    try? FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: cloud.dbPath)
    check("cloud: no permission: nothing read", CloudTabs.read(cloud.folder, thisMac: "Test Mac") == .noAccess)
    try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: cloud.dbPath)

    // Safari closed (no log): the file alone, nothing made beside it.
    cloud.close()
    try? FileManager.default.removeItem(atPath: cloud.dbPath + "-wal")
    try? FileManager.default.removeItem(atPath: cloud.dbPath + "-shm")
    let files = try? FileManager.default.contentsOfDirectory(atPath: cloud.folder.path).sorted()
    check("cloud: Safari closed: still read", { if case .read(let r) = CloudTabs.read(cloud.folder, thisMac: "Test Mac") { return r.devices.count == 3 }; return false }())
    check("cloud: and nothing made in Safari's folder, nothing written", (try? FileManager.default.contentsOfDirectory(atPath: cloud.folder.path).sorted()) == files)

    // Not Safari 27.2's tables, and an empty file (iCloud Tabs never synced).
    let odd = FakeCloud()
    odd.open(schema: "CREATE TABLE cloud_tabs (id INTEGER PRIMARY KEY, title TEXT);")
    check("cloud: not the tables Safari has: nothing used", { if case .failed = CloudTabs.read(odd.folder, thisMac: nil) { return true }; return false }())
    odd.remove()
    let blank = FakeCloud()
    blank.open(schema: "")
    check("cloud: an empty file: no data", CloudTabs.read(blank.folder, thisMac: nil) == .noData)
    blank.remove()

    // ---- the watcher ----
    cloud.open(schema: "")
    var options = CloudTabsWatcher.Options()
    options.debounce = 0.15
    options.latency = 0.05
    options.retry = 0.3
    options.thisMac = "Test Mac"
    let watcher = CloudTabsWatcher(folder: cloud.folder, options: options)
    var outcomes: [CloudTabs.Outcome] = []
    watcher.onChange = { outcomes.append($0) }
    watcher.start()
    waitUntil(3) { !outcomes.isEmpty }
    check("cloud watcher: the first read", { if case .read(let r) = outcomes.last { return r.devices.count == 3 }; return false }(), "\(outcomes.map(CloudTabs.describe))")
    waitUntil(0.5) { false } // FSEvents takes a moment to start sending a new stream's events
    cloud.exec("UPDATE cloud_tabs SET title = 'First, renamed' WHERE tab_uuid = 'P-1'")
    waitUntil(5) { if case .read(let r) = outcomes.last { return r.devices.first?.tabs.first?.title == "First, renamed" }; return false }
    check("cloud watcher: a write to the log picked up", { if case .read(let r) = outcomes.last { return r.devices.first?.tabs.first?.title == "First, renamed" }; return false }())
    let reads = watcher.reads
    for n in 0..<20 { cloud.exec("UPDATE cloud_tabs SET reader_scroll_position_page_index = \(n) WHERE tab_uuid = 'P-1'") }
    waitUntil(1.5) { false }
    check("cloud watcher: many writes at once: few reads", watcher.reads - reads <= 4, "\(watcher.reads - reads) reads")
    check("cloud watcher: nothing shown changed: nothing handed on", outcomes.count == 2, "\(outcomes.count)")
    let skippedBefore = watcher.skipped, readsBefore = watcher.reads
    watcher.readNow()
    waitUntil(1) { watcher.skipped > skippedBefore }
    check("cloud watcher: the files as at the last read: not read again", watcher.skipped == skippedBefore + 1 && watcher.reads == readsBefore, "skipped \(watcher.skipped - skippedBefore), read \(watcher.reads - readsBefore)")
    cloud.tab("P-5", device: FakeCloud.phone, title: "Fifth", url: "https://five.example/", position: FakeCloud.position([(10_500, "F")]), viewed: FakeCloud.now)
    waitUntil(5) { if case .read(let r) = outcomes.last { return r.devices.first?.tabs.contains { $0.id == "P-5" } == true }; return false }
    check("cloud watcher: a tab opened on the phone", { if case .read(let r) = outcomes.last { return r.devices.first?.tabs.last?.id == "P-5" }; return false }())
    try? FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: cloud.dbPath)
    cloud.exec("UPDATE cloud_tabs SET title = 'Again' WHERE tab_uuid = 'P-1'")
    waitUntil(5) { outcomes.last == .noAccess }
    check("cloud watcher: the permission withdrawn: said", outcomes.last == .noAccess)
    try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: cloud.dbPath)
    waitUntil(5) { if case .read = outcomes.last { return true }; return false }
    check("cloud watcher: given again: read again with no change in Safari (the retry)", { if case .read(let r) = outcomes.last { return r.devices.first?.tabs.first?.title == "Again" }; return false }())
    watcher.stop()
    check("cloud watcher: stopped", !watcher.running)
    check("cloud watcher: the files that matter", CloudTabsWatcher.matters("/x/Safari/CloudTabs.db-wal") && CloudTabsWatcher.matters("/x/Safari/CloudTabs.db")
          && !CloudTabsWatcher.matters("/x/Safari/CloudTabs.db-shm") && !CloudTabsWatcher.matters("/x/Safari/SafariTabs.db-wal"))
}
