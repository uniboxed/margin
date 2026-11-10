// A stand-in for Safari's folder (tools/app-tests, unit and end to end): its
// tab database with the schema Safari 27.2 has, in a temporary folder, and
// each profile's Extensions.plist. Never Safari's own folder.
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
            "com.unibox.margin.Extension (ABCDE12345)": ["Enabled": true, "ProfileIdentifier": Self.personalCopy],
            "com.example.other.Extension (ZZZZZ99999)": ["Enabled": true, "ProfileIdentifier": "99999999-9999-4999-8999-999999999999"],
        ])
        extensions(Self.testServer, ["com.example.other.Extension (ZZZZZ99999)": ["Enabled": true, "ProfileIdentifier": "99999999-9999-4999-8999-999999999998"]])
    }

    // Margin's entries as standard() has them again.
    func standardExtensions() {
        extensions(Self.personalServer, [
            "com.unibox.margin.Extension (ABCDE12345)": ["Enabled": true, "ProfileIdentifier": Self.personalCopy],
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

extension FakeSafari {
    // A connection that keeps every reader out: WAL with exclusive locking, a write begun.
    static func holder(_ path: String) -> OpaquePointer? {
        var h: OpaquePointer?
        sqlite3_open(path, &h)
        sqlite3_exec(h, "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE bookmarks SET num_children = num_children WHERE id = 0;", nil, nil, nil)
        return h
    }
}
