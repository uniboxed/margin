// Safari's profile names (SafariProfiles.swift, BrowserProfiles.swift), part
// of tests.swift's run, against a stand-in for Safari's folder made here in a
// temporary folder (its tab database with the schema Safari 27.2 has, each
// profile's Extensions.plist), never Safari's own: the profiles read, the
// default profile, a copy linked to its profile, another extension's entry
// and an unsigned build's, Safari closed (no write-ahead log: nothing made
// beside the database), a busy database, no permission, no Safari, a
// database that isn't Safari's, a rename and a new profile picked up by the
// watcher, and the names used: Safari's over a typed one, Edit Profile
// keeping the name, the typed names back without the permission, a profile
// deleted in Safari, and the symbol's picture.
import AppKit
import Foundation
import SQLite3

// Safari's folder as Safari 27.2 lays it out, with a writer connection like Safari's (WAL).
final class FakeSafari {
    let folder: URL
    private(set) var db: OpaquePointer?

    init() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-safari-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    deinit { if let db { sqlite3_close(db) } }

    var dbPath: String { folder.appendingPathComponent("SafariTabs.db").path }

    func open(schema: String = FakeSafari.schema) {
        sqlite3_open(dbPath, &db)
        exec("PRAGMA journal_mode=WAL")
        exec(schema)
    }

    func close() {
        if let db { sqlite3_close(db) }
        db = nil
    }

    @discardableResult func exec(_ sql: String) -> Int32 { sqlite3_exec(db, sql, nil, nil, nil) }

    static let schema = """
    CREATE TABLE bookmarks (id INTEGER PRIMARY KEY AUTOINCREMENT, special_id INTEGER DEFAULT 0, parent INTEGER, type INTEGER, title TEXT,
      url TEXT, num_children INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, order_index INTEGER NOT NULL, external_uuid TEXT UNIQUE,
      server_id TEXT, deleted INTEGER DEFAULT 0, extra_attributes BLOB DEFAULT NULL, local_attributes BLOB DEFAULT NULL, subtype INTEGER DEFAULT 0);
    CREATE TABLE windows_profiles (id INTEGER PRIMARY KEY, active_tab_group_id INTEGER, profile_id INTEGER, window_id INTEGER);
    """

    // A row; `extra` its settings as a property list.
    func row(id: Int, parent: Int?, type: Int, subtype: Int, title: String, uuid: String, server: String?, url: String? = nil,
             deleted: Bool = false, order: Int = 0, extra: [String: Any]? = nil) {
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "INSERT INTO bookmarks (id, parent, type, subtype, title, external_uuid, server_id, url, deleted, order_index, extra_attributes) VALUES (?,?,?,?,?,?,?,?,?,?,?)", -1, &stmt, nil)
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_int(stmt, 1, Int32(id))
        if let parent { sqlite3_bind_int(stmt, 2, Int32(parent)) } else { sqlite3_bind_null(stmt, 2) }
        sqlite3_bind_int(stmt, 3, Int32(type))
        sqlite3_bind_int(stmt, 4, Int32(subtype))
        sqlite3_bind_text(stmt, 5, title, -1, transient)
        sqlite3_bind_text(stmt, 6, uuid, -1, transient)
        if let server { sqlite3_bind_text(stmt, 7, server, -1, transient) } else { sqlite3_bind_null(stmt, 7) }
        if let url { sqlite3_bind_text(stmt, 8, url, -1, transient) } else { sqlite3_bind_null(stmt, 8) }
        sqlite3_bind_int(stmt, 9, deleted ? 1 : 0)
        sqlite3_bind_int(stmt, 10, Int32(order))
        if let extra, let data = try? PropertyListSerialization.data(fromPropertyList: extra, format: .binary, options: 0) {
            _ = data.withUnsafeBytes { sqlite3_bind_blob(stmt, 11, $0.baseAddress, Int32(data.count), transient) }
        } else { sqlite3_bind_null(stmt, 11) }
        sqlite3_step(stmt)
        sqlite3_finalize(stmt)
    }

    // A profile's Extensions.plist (Profiles/<server id>/WebExtensions/).
    func extensions(_ server: String, _ states: [String: Any]) {
        let dir = folder.appendingPathComponent("Profiles/\(server)/WebExtensions", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try! PropertyListSerialization.data(fromPropertyList: states, format: .binary, options: 0)
        try! data.write(to: dir.appendingPathComponent("Extensions.plist"), options: .atomic)
    }

    // Tirth's, as the probe found it (2026-11-05), with made-up ids.
    static let personalServer = "A8C3B0E9-0000-4000-8000-000000000001"
    static let testServer = "CDC954CA-0000-4000-8000-000000000002"
    static let personalCopy = "8D454F81-4100-489D-BA9F-E788BEC2DAEB"
    static let testCopy = "11111111-2222-4333-8444-555555555555"

    func standard() {
        open()
        row(id: 0, parent: nil, type: 1, subtype: 0, title: "Root", uuid: "Root", server: nil)
        row(id: 5, parent: 0, type: 1, subtype: 2, title: "Work", uuid: "DefaultProfile", server: "DefaultProfile", order: 0, extra: ["SymbolImageName": "person.fill"])
        row(id: 1562, parent: 0, type: 1, subtype: 2, title: "Personal", uuid: "A90745BB-0000-4000-8000-000000000003", server: Self.personalServer, order: 1,
            extra: ["SymbolImageName": "person.lanyardcard.fill", "StartPageSectionsData": Data([1, 2, 3])])
        row(id: 1568, parent: 0, type: 1, subtype: 2, title: "Test", uuid: "E21D06D2-0000-4000-8000-000000000004", server: Self.testServer, order: 2, extra: ["SymbolImageName": "person.lanyardcard.fill"])
        row(id: 1600, parent: 0, type: 1, subtype: 2, title: "Old", uuid: "0LD00000-0000-4000-8000-000000000005", server: "0LD00000-0000-4000-8000-000000000006", deleted: true, order: 3)
        row(id: 1764, parent: 0, type: 1, subtype: 0, title: "A tab group", uuid: "32D59E44-0000-4000-8000-000000000007", server: "TG1")
        row(id: 1765, parent: 1764, type: 0, subtype: 0, title: "A page", uuid: "32D59E44-0000-4000-8000-000000000008", server: "T1", url: "https://example.com/private")
        extensions(Self.personalServer, [
            "io.tirth.margin.Extension (ABCDE12345)": ["Enabled": true, "ProfileIdentifier": Self.personalCopy],
            "com.example.other.Extension (ZZZZZ99999)": ["Enabled": true, "ProfileIdentifier": "99999999-9999-4999-8999-999999999999"],
        ])
        extensions(Self.testServer, ["com.example.other.Extension (ZZZZZ99999)": ["Enabled": true, "ProfileIdentifier": "99999999-9999-4999-8999-999999999998"]])
    }

    func remove() {
        close()
        try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: dbPath)
        try? FileManager.default.removeItem(at: folder)
    }
}

func waitUntil(_ seconds: TimeInterval, _ done: () -> Bool) {
    let until = Date().addingTimeInterval(seconds)
    while !done(), Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
}

func safariProfilesTests() {
    let personal = "s-" + FakeSafari.personalCopy.lowercased()
    let test = "s-" + FakeSafari.testCopy.lowercased()

    // ---- the reader ----
    let safari = FakeSafari()
    defer { safari.remove() }
    check("safari: no database yet, the folder readable: access", SafariProfiles.access(safari.folder) == .granted)
    check("safari: no database: no Safari data", SafariProfiles.read(safari.folder) == .noSafari)
    safari.standard()
    check("safari: Safari open (its log there)", FileManager.default.fileExists(atPath: safari.dbPath + "-wal"))
    guard case .read(let list) = SafariProfiles.read(safari.folder) else { return check("safari: read", false, "\(SafariProfiles.read(safari.folder))") }
    check("safari: the profiles, in Safari's order, not the deleted one nor tab groups", list.map(\.name) == ["Work", "Personal", "Test"], "\(list.map(\.name))")
    check("safari: the default profile is s-default", list.first?.serverId == "DefaultProfile" && list.first?.margin == "s-default")
    check("safari: a copy linked through Margin's entry in its profile's Extensions.plist", list.count > 1 && list[1].margin == personal, "\(list.map { $0.margin ?? "-" })")
    check("safari: another extension's entry is never taken for Margin's", list.count > 2 && list[2].margin == nil)
    check("safari: the symbols", list.map(\.symbol) == ["person.fill", "person.lanyardcard.fill", "person.lanyardcard.fill"], "\(list.map(\.symbol))")
    check("safari: Safari's ids", list.count > 2 && list[1].serverId == FakeSafari.personalServer && list[2].serverId == FakeSafari.testServer)
    check("safari: the log says names and ids, never a page", !SafariProfiles.describe(.read(list)).contains("example.com") && SafariProfiles.describe(.read(list)).contains("“Personal”"))
    // An unsigned build's entry ("(UNSIGNED)"), and one whose id isn't a UUID.
    safari.extensions(FakeSafari.testServer, ["io.tirth.margin.Extension (UNSIGNED)": ["ProfileIdentifier": FakeSafari.testCopy]])
    check("safari: an unsigned build's entry", SafariProfiles.marginProfile(safari.folder, folders: [FakeSafari.testServer], extensionId: SafariProfiles.marginExtension) == test)
    safari.extensions(FakeSafari.testServer, ["io.tirth.margin.Extension (UNSIGNED)": ["ProfileIdentifier": "not a uuid"]])
    check("safari: an id that isn't a UUID: no link", SafariProfiles.marginProfile(safari.folder, folders: [FakeSafari.testServer], extensionId: SafariProfiles.marginExtension) == nil)
    check("safari: a folder name that isn't an id: never read", SafariProfiles.marginProfile(safari.folder, folders: ["../Profiles"], extensionId: SafariProfiles.marginExtension) == nil)
    check("safari: a symbol that isn't a symbol's name: none", SafariProfiles.symbol(try? PropertyListSerialization.data(fromPropertyList: ["SymbolImageName": "../x y"], format: .binary, options: 0)) == "")

    // A busy database: another connection holding it (exclusive locking, as no reader can get past).
    safari.close()
    let holder = FakeSafari.holder(safari.dbPath)
    check("safari: held: its log there", FileManager.default.fileExists(atPath: safari.dbPath + "-wal"))
    let busy = SafariProfiles.read(safari.folder, busyTimeoutMs: 50)
    check("safari: a busy database: busy, nothing used", busy == .busy, "\(busy)")
    sqlite3_close(holder)
    safari.open(schema: "")
    check("safari: let go: read again", { if case .read = SafariProfiles.read(safari.folder) { return true }; return false }())

    // No write-ahead log (macOS's SQLite keeps an empty one when Safari closes;
    // with none there): the file read alone, nothing made beside it.
    safari.close()
    try? FileManager.default.removeItem(atPath: safari.dbPath + "-wal")
    try? FileManager.default.removeItem(atPath: safari.dbPath + "-shm")
    let before = try? FileManager.default.contentsOfDirectory(atPath: safari.folder.path).sorted()
    check("safari: no log", !FileManager.default.fileExists(atPath: safari.dbPath + "-wal"), "\(before ?? [])")
    check("safari: closed: still read", { if case .read(let l) = SafariProfiles.read(safari.folder) { return l.count == 3 }; return false }())
    check("safari: closed: nothing made in Safari's folder", (try? FileManager.default.contentsOfDirectory(atPath: safari.folder.path).sorted()) == before)

    // No permission: the database can't be opened (as without Full Disk Access).
    try? FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: safari.dbPath)
    check("safari: no permission: denied", SafariProfiles.access(safari.folder) == .denied)
    check("safari: no permission: nothing read", SafariProfiles.read(safari.folder) == .noAccess)
    try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: safari.dbPath)
    check("safari: no folder: no Safari", SafariProfiles.access(safari.folder.appendingPathComponent("none")) == .noSafari)

    // Not Safari 27.2's table: nothing used.
    let odd = FakeSafari()
    odd.open(schema: "CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, title TEXT, type INTEGER);")
    check("safari: not the table Safari has: not read", { if case .failed = SafariProfiles.read(odd.folder) { return true }; return false }())
    odd.remove()

    // ---- the watcher ----
    safari.open(schema: "") // Safari again (its log back)
    var options = SafariProfileWatcher.Options()
    options.debounce = 0.15
    options.latency = 0.05
    options.retry = 0.3
    let watcher = SafariProfileWatcher(folder: safari.folder, options: options)
    var outcomes: [SafariProfiles.Outcome] = []
    watcher.onChange = { outcomes.append($0) }
    watcher.start()
    waitUntil(3) { !outcomes.isEmpty }
    check("watcher: the first read", { if case .read(let l) = outcomes.last { return l.count == 3 }; return false }(), "\(outcomes)")
    waitUntil(0.5) { false } // FSEvents takes a moment to start sending a new stream's events
    safari.exec("UPDATE bookmarks SET title = 'Home' WHERE id = 1562")
    waitUntil(5) { if case .read(let l) = outcomes.last { return l.contains { $0.name == "Home" } }; return false }
    check("watcher: a rename in Safari picked up", { if case .read(let l) = outcomes.last { return l.map(\.name) == ["Work", "Home", "Test"] }; return false }(), "\(outcomes.last.map(SafariProfiles.describe) ?? "nothing")")
    let reads = watcher.reads
    for n in 0..<20 { safari.exec("UPDATE bookmarks SET num_children = \(n) WHERE id = 1764") }
    waitUntil(1.5) { false }
    check("watcher: many writes at once: few reads", watcher.reads - reads <= 4, "\(watcher.reads - reads) reads")
    check("watcher: nothing new: nothing handed on", outcomes.count == 2, "\(outcomes.count)")
    safari.extensions(FakeSafari.testServer, ["io.tirth.margin.Extension (ABCDE12345)": ["ProfileIdentifier": FakeSafari.testCopy]])
    waitUntil(5) { if case .read(let l) = outcomes.last { return l.last?.margin == test }; return false }
    check("watcher: Margin turned on in another profile: linked", { if case .read(let l) = outcomes.last { return l.last?.margin == test }; return false }())
    try? FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: safari.dbPath)
    safari.exec("UPDATE bookmarks SET title = 'Home 2' WHERE id = 1562")
    waitUntil(5) { outcomes.last == .noAccess }
    check("watcher: the permission withdrawn: said", outcomes.last == .noAccess)
    try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: safari.dbPath)
    waitUntil(5) { if case .read = outcomes.last { return true }; return false }
    check("watcher: given again: read again without a change in Safari (the retry)", { if case .read(let l) = outcomes.last { return l.contains { $0.name == "Home 2" } }; return false }())
    watcher.stop()
    check("watcher: the files that matter", SafariProfileWatcher.matters("/x/Safari/SafariTabs.db-wal") && SafariProfileWatcher.matters("/x/Safari/Profiles/ABC/WebExtensions/Extensions.plist")
          && !SafariProfileWatcher.matters("/x/Safari/SafariTabs.db-shm") && !SafariProfileWatcher.matters("/x/Safari/Profiles/ABC/History.db-wal"))

    // ---- the names used ----
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-names-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let bp = BrowserProfiles(browser: "safari", root: root)
    bp.refresh(spaces: ["s-default": ["a"], personal: ["b"], "s-9": ["c"]], linked: ["s-default", personal])
    bp.rename(personal, name: "Typed", emoji: "🏠", color: "#00b894")
    let safariList = [
        SafariProfile(serverId: "DefaultProfile", uuid: "DefaultProfile", name: "Work", symbol: "person.fill", margin: "s-default"),
        SafariProfile(serverId: FakeSafari.personalServer, uuid: "A9", name: "Personal", symbol: "person.lanyardcard.fill", margin: personal),
        SafariProfile(serverId: FakeSafari.testServer, uuid: "E2", name: "Test", symbol: "", margin: test),
    ]
    check("names: Safari's read: changed", bp.useBrowserNames(safariList))
    check("names: Safari's win over a typed one", bp.name("s-default") == "Work" && bp.name(personal) == "Personal", bp.name(personal))
    check("names: a profile Safari doesn't name keeps Margin's", bp.name("s-9") == "Profile 3", bp.name("s-9"))
    check("names: the same again: nothing changed", !bp.useBrowserNames(safariList))
    bp.rename(personal, name: "Something else", emoji: "🎒", color: "#e17055")
    check("names: Edit Profile keeps Safari's name, the emoji and color change", bp.name(personal) == "Personal" && bp.info[personal]?.emoji == "🎒" && bp.color(personal) == "#e17055")
    check("names: the typed name is kept for later", bp.info[personal]?.name == "Typed")
    let across = bp.across(for: "s-default", spaces: [:], counts: [:], linked: ["s-default"], symbol: { $0.isEmpty ? nil : "data:image/png;base64,AAAA" })
    let entry = (across["profiles"] as? [JSONObject])?.first { $0["id"] as? String == personal }
    check("names: across says the name is Safari's, with its symbol", entry?["nameFrom"] as? String == "safari" && entry?["symbol"] as? String == "data:image/png;base64,AAAA" && entry?["name"] as? String == "Personal")
    let other = (across["profiles"] as? [JSONObject])?.first { $0["id"] as? String == "s-9" }
    check("names: and nothing for Margin's own", other?["nameFrom"] == nil && other?["symbol"] == nil)
    bp.refresh(spaces: ["s-default": ["a"], personal: ["b"], "s-9": ["c"], test: ["d"]], linked: ["s-default", personal, test])
    check("names: a profile seen after the read gets Safari's name at once", bp.name(test) == "Test" && bp.info[test]?.browserId == FakeSafari.testServer)
    let reloaded = BrowserProfiles(browser: "safari", root: root)
    check("names: Safari's ids kept in browser.json", reloaded.info[personal]?.browserId == FakeSafari.personalServer && reloaded.info[personal]?.browserName == "Personal")
    check("names: never Safari's name as the typed one", reloaded.name(personal) == "Typed")
    // The copy's entry unreadable this time (Margin turned off there): the profile still has its name, by Safari's id.
    var noEntry = safariList
    noEntry[1].margin = nil
    bp.useBrowserNames(noEntry)
    check("names: known by Safari's id when the copy's entry is missing", bp.name(personal) == "Personal")
    check("names: renamed in Safari", bp.useBrowserNames(safariList.map { var p = $0; if p.margin == test { p.name = "Testing" }; return p }) && bp.name(test) == "Testing")
    // No permission any more: the typed names again.
    check("names: no permission: changed", bp.dropBrowserNames())
    check("names: no permission: typed and default names", bp.name(personal) == "Typed" && bp.name("s-default") == "Default" && bp.name(test) == "Profile 4", "\(bp.name(test))")
    bp.useBrowserNames(safariList)
    // Deleted in Safari: the last name it gave stays (as typed); a typed one stays.
    let gone = safariList.filter { $0.margin != test && $0.margin != personal }
    check("names: deleted in Safari: changed", bp.useBrowserNames(gone))
    check("names: deleted in Safari: its last name kept", bp.name(test) == "Test" && bp.info[test]?.named == true && bp.info[test]?.browserId == "")
    check("names: deleted in Safari, a name typed before: that name", bp.name(personal) == "Typed")
    check("names: and saved", BrowserProfiles(browser: "safari", root: root).name(test) == "Test")

    // ---- the symbol's picture ----
    let picture = ProfileSymbols.dataURL("person.fill")
    check("symbol: a PNG data URL", picture?.hasPrefix("data:image/png;base64,") == true && (picture?.count ?? 0) > 60, "\(picture?.prefix(40) ?? "none")")
    check("symbol: made once", ProfileSymbols.dataURL("person.fill") == picture)
    check("symbol: not a symbol: none", ProfileSymbols.dataURL("no.such.symbol.margin") == nil && ProfileSymbols.dataURL("") == nil)
}

extension FakeSafari {
    // A connection that keeps every reader out: WAL with exclusive locking, a write begun.
    static func holder(_ path: String) -> OpaquePointer? {
        var h: OpaquePointer?
        sqlite3_open(path, &h)
        sqlite3_exec(h, "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE bookmarks SET num_children = num_children WHERE id = 0;", nil, nil, nil)
        return h
    }
}
