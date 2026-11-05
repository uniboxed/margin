// A one-off look (Phase 2, 2026-11-05) at where Safari keeps its profiles'
// names, for Tirth's decision to show Safari's own names: Safari's data is
// readable only with Full Disk Access, which Margin.app has been given. Read
// only, never written. What it logs (Margin.app's log, category shell): the
// names of the files in Safari's data folders, the tab database's tables and
// columns, and the rows that can be profiles or tab groups (their id, parent,
// type, subtype, title, uuid, hidden, deleted; never an address). Removed once
// the real reader is built.

import Foundation
import SQLite3

enum SafariProfileProbe {
    static func run() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dirs = [
            home.appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library/Safari"),
            home.appendingPathComponent("Library/Safari"),
        ]
        for dir in dirs {
            do {
                let names = try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted()
                Diagnostics.note("profile probe: \(dir.path): \(names.joined(separator: ", "))")
            } catch {
                Diagnostics.note("profile probe: \(dir.path): not readable (\(error.localizedDescription))")
            }
        }
        for dir in dirs {
            let db = dir.appendingPathComponent("SafariTabs.db")
            guard FileManager.default.isReadableFile(atPath: db.path) else { continue }
            read(db)
        }
    }

    private static func read(_ url: URL) {
        var handle: OpaquePointer?
        guard sqlite3_open_v2("file:\(url.path)?mode=ro", &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK, let db = handle else {
            Diagnostics.note("profile probe: \(url.lastPathComponent) didn't open")
            return
        }
        defer { sqlite3_close(db) }
        let tables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map { $0[0] }
        Diagnostics.note("profile probe: \(url.lastPathComponent) tables: \(tables.joined(separator: ", "))")
        for table in tables {
            let cols = rows(db, "PRAGMA table_info(\"\(table)\")").map { $0.count > 1 ? $0[1] : "?" }
            Diagnostics.note("profile probe: \(table)(\(cols.joined(separator: ", ")))")
        }
        guard tables.contains("bookmarks") else { return }
        let cols = Set(rows(db, "PRAGMA table_info(bookmarks)").map { $0.count > 1 ? $0[1] : "" })
        let want = ["id", "parent", "type", "subtype", "title", "external_uuid", "hidden", "deleted", "special_id", "num_children"].filter(cols.contains)
        // Folders only (type 1): profiles and tab groups are folders; tabs and bookmarks (with addresses) aren't read.
        let sql = "SELECT \(want.joined(separator: ", ")) FROM bookmarks WHERE type = 1 ORDER BY parent, id LIMIT 200"
        for row in rows(db, sql) {
            Diagnostics.note("profile probe: folder " + zip(want, row).map { "\($0)=\($1)" }.joined(separator: " "))
        }
        if cols.contains("extra_attributes") {
            for row in rows(db, "SELECT id, length(extra_attributes) FROM bookmarks WHERE type = 1 AND extra_attributes IS NOT NULL LIMIT 50") {
                Diagnostics.note("profile probe: folder \(row[0]) has extra_attributes (\(row[1]) bytes)")
            }
        }
    }

    private static func rows(_ db: OpaquePointer, _ sql: String) -> [[String]] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            Diagnostics.note("profile probe: query failed: \(String(cString: sqlite3_errmsg(db)))")
            return []
        }
        defer { sqlite3_finalize(stmt) }
        var out: [[String]] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let n = sqlite3_column_count(stmt)
            out.append((0..<n).map { i in sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? "null" })
        }
        return out
    }
}
