// iCloud Tabs (Tirth, 2026-11-05): the tabs open in Safari on the person's
// other Apple devices, read from Safari's own file with Full Disk Access
// (the permission Safari's profile names already use: SafariProfiles.swift),
// read only, kept in step while Margin.app runs, and drawn by Margin's UI in
// a live folder in each Safari window's sidebar and in the command palette
// (ShellCloudTabs.swift sends it to the overlays; extension/shared/cloud-tabs.ts
// and ui/view-model.ts shape it for themes). DECISIONS.md "Margin 2: iCloud Tabs".
//
// Where Safari keeps them (Safari 27.2, read on Tirth's Mac: the schema,
// counts and formats only, never a title, an address or a device's name):
//
//   ~/Library/Containers/com.apple.Safari/Data/Library/Safari/CloudTabs.db
//     SQLite in WAL mode, one file for all of Safari's profiles (no profile
//     folder has one). Tables:
//     cloud_tab_devices  device_uuid, device_name, device_type_identifier
//                        ("com.apple.iphone-13-pro-9",
//                        "com.apple.macbookpro-14-2021-space-gray"…),
//                        has_duplicate_device_name, is_ephemeral_device,
//                        last_modified (seconds since 2001; rounded to the
//                        local day in what Safari stores)
//     cloud_tabs         tab_uuid, device_uuid, position, title, url,
//                        is_pinned, last_viewed_time (seconds since 2001,
//                        to the second)…
//     cloud_tab_close_requests  Safari's own: Margin never writes, so it
//                        offers no closing of a remote tab
//     metadata           only `use_manatee_container` and
//                        `server_change_token`: nothing says which device is
//                        this Mac
//
// - **This Mac** has its own rows (with no tabs, on Tirth's Mac: two of them,
//   both named as the Mac is, both of its model): a device is taken to be
//   this Mac when it's a Mac named as this Mac is named (System Settings ›
//   General › Sharing's name, SCDynamicStoreCopyComputerName). A device with
//   no tabs isn't shown either, as in Safari.
// - **The order** of a device's tabs: `position` is zlib-compressed JSON,
//   `{"sortValues":[{"changeID":0,"sortValue":-689,"deviceIdentifier":"<uuid>"}]}`,
//   a fractional-index position: compared value by value (sortValue, then
//   deviceIdentifier), a shorter list before one it begins. A tab whose
//   position doesn't read goes after those that do, newest viewed first.
// - **Device types:** iPhone (and iPod), iPad, Mac, Apple Vision, or another.
//
// The log says counts only, never a title, an address or a name.

import Foundation
import SQLite3
import SystemConfiguration

nonisolated struct CloudTab: Equatable, Sendable {
    var id: String
    var title: String
    var url: String
    var pinned: Bool
    var viewedAt: Double // seconds since 1970; 0 when Safari has none
}

nonisolated struct CloudDevice: Equatable, Sendable {
    var id: String
    var name: String
    var kind: String // phone, pad, mac, vision, other
    var model: String // Safari's device_type_identifier
    var modifiedAt: Double // seconds since 1970
    var ephemeral: Bool
    var duplicateName: Bool
    var tabs: [CloudTab]
}

nonisolated enum CloudTabs {
    struct Report: Equatable, Sendable {
        var devices: [CloudDevice] // other devices with tabs, most recently used first
        var own = 0 // this Mac's rows, left out
        var empty = 0 // devices with no tabs, left out
        var dropped = 0 // tabs that aren't web pages, or past the caps
    }
    enum Outcome: Equatable, Sendable {
        case read(Report)
        case noAccess // Full Disk Access not given (or withdrawn)
        case noData // no iCloud Tabs file: iCloud Tabs off, or never synced
        case busy // locked for longer than the busy timeout: try again soon
        case failed(String) // not what Safari 27.2 writes: nothing used
    }

    static let file = "CloudTabs.db"
    static let watchedFiles = ["CloudTabs.db", "CloudTabs.db-wal"]
    static let referenceDate: Double = 978_307_200 // 2001-01-01, Safari's (Core Data's) epoch, in seconds since 1970
    static let maxDevices = 50
    static let maxTabs = 500 // per device
    static let maxTitle = 300
    static let maxURL = 4096

    // This Mac's name as Safari gives it to its own rows: the computer's name.
    static func thisMacName() -> String? {
        SCDynamicStoreCopyComputerName(nil, nil) as String?
    }

    // A device's kind, from Safari's type identifier.
    static func kind(_ identifier: String) -> String {
        let id = identifier.lowercased()
        if id.contains("iphone") || id.contains("ipod") { return "phone" }
        if id.contains("ipad") { return "pad" }
        if id.contains("vision") || id.contains("realitydevice") { return "vision" }
        if id.contains("mac") { return "mac" }
        return "other"
    }

    static func sameName(_ a: String, _ b: String) -> Bool {
        let fold = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\u{2019}", with: "'").lowercased() }
        return !fold(a).isEmpty && fold(a) == fold(b)
    }

    // This Mac's own row: a Mac named as this Mac is.
    static func isThisMac(name: String, kind: String, thisMac: String?) -> Bool {
        guard kind == "mac", let thisMac else { return false }
        return sameName(name, thisMac)
    }

    // A tab's position: its sort values (value, then the device that wrote it), or nil if it doesn't read.
    struct Position: Equatable, Sendable {
        var values: [(Double, String)]
        static func == (a: Position, b: Position) -> Bool { a.values.elementsEqual(b.values) { $0 == $1 } }
    }

    static func position(_ blob: Data?) -> Position? {
        guard let blob, blob.count > 2, blob.count < 1 << 16 else { return nil }
        // zlib: a two-byte header (78 01/5E/9C/DA), then deflate, which NSData's .zlib takes.
        let start = blob.startIndex
        guard blob[start] & 0x0f == 8, (Int(blob[start]) << 8 | Int(blob[start + 1])) % 31 == 0 else { return nil }
        // The deflate stream, with or without zlib's four-byte check after it.
        let deflate = Data(blob.dropFirst(2))
        let inflated = (try? (deflate as NSData).decompressed(using: .zlib) as Data) ?? (try? (Data(deflate.dropLast(4)) as NSData).decompressed(using: .zlib) as Data)
        guard let raw = inflated, raw.count < 1 << 16,
              let json = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any],
              let list = json["sortValues"] as? [[String: Any]], !list.isEmpty, list.count <= 64 else { return nil }
        var values: [(Double, String)] = []
        for entry in list {
            guard let n = entry["sortValue"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
            values.append((n.doubleValue, entry["deviceIdentifier"] as? String ?? ""))
        }
        return Position(values: values)
    }

    // Safari's order: value by value; a list that begins another comes first.
    static func before(_ a: Position, _ b: Position) -> Bool {
        for (x, y) in zip(a.values, b.values) {
            if x.0 != y.0 { return x.0 < y.0 }
            if x.1 != y.1 { return x.1 < y.1 }
        }
        return a.values.count < b.values.count
    }

    // The tabs on the person's other devices, as Safari has them now.
    // `thisMac`: this Mac's name (its own rows are left out); tests pass their own.
    static func read(_ folder: URL = SafariProfiles.safariFolder, thisMac: String? = thisMacName(), busyTimeoutMs: Int32 = 200) -> Outcome {
        switch SafariFiles.access(folder, file: file) {
        case .denied: return .noAccess
        case .noSafari: return .noData
        case .granted: break
        }
        let db = folder.appendingPathComponent(file)
        guard FileManager.default.fileExists(atPath: db.path) else { return .noData }
        let handle: OpaquePointer
        switch SafariFiles.openReadOnly(db, busyTimeoutMs: busyTimeoutMs) {
        case .ok(let h): handle = h
        case .busy: return .busy
        case .noAccess: return .noAccess
        case .failed(let code): return .failed("the database didn't open (\(code))")
        }
        defer { sqlite3_close_v2(handle) }
        // Both tables as Safari 27.2 has them, or nothing.
        let (deviceCols, c1) = SafariFiles.columns(handle, "cloud_tab_devices")
        let (tabCols, c2) = SafariFiles.columns(handle, "cloud_tabs")
        for code in [c1, c2] where code != SQLITE_OK { return outcome(code, "the tables didn't read") }
        if deviceCols.isEmpty && tabCols.isEmpty { return .noData } // a file with nothing in it yet
        guard ["device_uuid", "device_name", "device_type_identifier", "last_modified"].allSatisfy(deviceCols.contains),
              ["tab_uuid", "device_uuid", "title", "url"].allSatisfy(tabCols.contains) else { return .failed("no iCloud Tabs tables as Safari 27.2 has them") }
        let col = { (cols: Set<String>, name: String, otherwise: String) in cols.contains(name) ? name : otherwise }

        var devices: [String: CloudDevice] = [:]
        var order: [String] = []
        let deviceSQL = "SELECT device_uuid, device_name, device_type_identifier, last_modified, \(col(deviceCols, "has_duplicate_device_name", "0")), \(col(deviceCols, "is_ephemeral_device", "0")) FROM cloud_tab_devices"
        let d = rows(handle, deviceSQL) { stmt in
            let id = text(stmt, 0)
            guard !id.isEmpty, devices[id] == nil else { return }
            let model = String(text(stmt, 2).prefix(128))
            devices[id] = CloudDevice(id: id, name: String(text(stmt, 1).prefix(128)), kind: kind(model), model: model,
                                      modifiedAt: unixTime(sqlite3_column_double(stmt, 3)),
                                      ephemeral: sqlite3_column_int(stmt, 5) != 0, duplicateName: sqlite3_column_int(stmt, 4) != 0, tabs: [])
            order.append(id)
        }
        if d != SQLITE_OK { return outcome(d, "the devices didn't read") }

        var tabs: [String: [(tab: CloudTab, position: Position?)]] = [:]
        var dropped = 0
        let tabSQL = "SELECT tab_uuid, device_uuid, title, url, \(col(tabCols, "is_pinned", "0")), \(col(tabCols, "last_viewed_time", "0")), \(col(tabCols, "position", "NULL")) FROM cloud_tabs"
        let t = rows(handle, tabSQL) { stmt in
            let device = text(stmt, 1)
            guard devices[device] != nil else { return }
            let url = text(stmt, 3)
            guard url.count <= maxURL, let scheme = URL(string: url)?.scheme?.lowercased(), scheme == "https" || scheme == "http" else { dropped += 1; return }
            let viewed = sqlite3_column_double(stmt, 5)
            let tab = CloudTab(id: text(stmt, 0), title: String(text(stmt, 2).prefix(maxTitle)), url: url,
                               pinned: sqlite3_column_int(stmt, 4) != 0, viewedAt: viewed > 0 ? unixTime(viewed) : 0)
            guard !tab.id.isEmpty else { dropped += 1; return }
            tabs[device, default: []].append((tab, position(blob(stmt, 6))))
        }
        if t != SQLITE_OK { return outcome(t, "the tabs didn't read") }

        var report = Report(devices: [])
        for id in order {
            guard var device = devices[id] else { continue }
            if isThisMac(name: device.name, kind: device.kind, thisMac: thisMac) { report.own += 1; continue }
            let list = (tabs[id] ?? []).sorted { a, b in
                switch (a.position, b.position) {
                case let (x?, y?): return before(x, y) || (!before(y, x) && a.tab.id < b.tab.id)
                case (.some, nil): return true
                case (nil, .some): return false
                case (nil, nil): return a.tab.viewedAt != b.tab.viewedAt ? a.tab.viewedAt > b.tab.viewedAt : a.tab.id < b.tab.id
                }
            }
            guard !list.isEmpty else { report.empty += 1; continue }
            if list.count > maxTabs { report.dropped += list.count - maxTabs }
            device.tabs = list.prefix(maxTabs).map(\.tab)
            report.devices.append(device)
        }
        report.dropped += dropped
        // The device used most recently first (its newest tab viewed, or its record's day).
        report.devices.sort { a, b in
            let x = lastUsed(a), y = lastUsed(b)
            return x != y ? x > y : (a.name, a.id) < (b.name, b.id)
        }
        if report.devices.count > maxDevices { report.devices = Array(report.devices.prefix(maxDevices)) }
        return .read(report)
    }

    static func lastUsed(_ d: CloudDevice) -> Double { max(d.modifiedAt, d.tabs.map(\.viewedAt).max() ?? 0) }

    private static func unixTime(_ reference: Double) -> Double { reference.isFinite ? reference + referenceDate : 0 }

    private static func outcome(_ code: Int32, _ what: String) -> Outcome {
        switch code {
        case SQLITE_BUSY, SQLITE_LOCKED: return .busy
        case SQLITE_PERM, SQLITE_AUTH, SQLITE_CANTOPEN: return .noAccess
        default: return .failed("\(what) (\(code))")
        }
    }

    private static func text(_ stmt: OpaquePointer, _ i: Int32) -> String {
        sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? ""
    }

    private static func blob(_ stmt: OpaquePointer, _ i: Int32) -> Data? {
        let n = Int(sqlite3_column_bytes(stmt, i))
        guard n > 0, n < 1 << 16, let bytes = sqlite3_column_blob(stmt, i) else { return nil }
        return Data(bytes: bytes, count: n)
    }

    // Each row of `sql` to `each`: SQLITE_OK, or SQLite's code.
    private static func rows(_ db: OpaquePointer, _ sql: String, _ each: (OpaquePointer) -> Void) -> Int32 {
        var stmt: OpaquePointer?
        var code = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard code == SQLITE_OK, let stmt else { return code }
        defer { sqlite3_finalize(stmt) }
        while true {
            code = sqlite3_step(stmt)
            guard code == SQLITE_ROW else { break }
            each(stmt)
        }
        return code == SQLITE_DONE ? SQLITE_OK : code
    }

    // What the log says of a read: counts, never a title, an address or a name.
    static func describe(_ outcome: Outcome) -> String {
        switch outcome {
        case .read(let r):
            let tabs = r.devices.reduce(0) { $0 + $1.tabs.count }
            let kinds = Dictionary(grouping: r.devices, by: \.kind).map { "\($0.value.count) \($0.key)" }.sorted().joined(separator: ", ")
            return "\(r.devices.count) other device\(r.devices.count == 1 ? "" : "s")\(kinds.isEmpty ? "" : " (\(kinds))"), \(tabs) tab\(tabs == 1 ? "" : "s")"
                + "; left out: \(r.own) of this Mac's, \(r.empty) with no tabs, \(r.dropped) tab\(r.dropped == 1 ? "" : "s") not a web page"
        case .noAccess: return "no Full Disk Access: none shown"
        case .noData: return "no iCloud Tabs file (iCloud Tabs off, or not synced yet)"
        case .busy: return "the database was busy: trying again"
        case .failed(let why): return "not read: \(why)"
        }
    }

    // What the overlays get (extension/shared/cloud-tabs.ts cloudOf): times in milliseconds since 1970.
    static func json(_ outcome: Outcome) -> JSONObject? {
        switch outcome {
        case .read(let r):
            return ["status": "ready", "devices": r.devices.map { d -> JSONObject in
                ["id": d.id, "name": d.name, "kind": d.kind, "model": d.model, "modifiedAt": (d.modifiedAt * 1000).rounded(),
                 "ephemeral": d.ephemeral, "duplicateName": d.duplicateName,
                 "tabs": d.tabs.map { t -> JSONObject in ["id": t.id, "title": t.title, "url": t.url, "pinned": t.pinned, "viewedAt": (t.viewedAt * 1000).rounded()] }]
            }]
        case .noAccess: return ["status": "noAccess", "devices": [Any]()]
        case .noData: return ["status": "noData", "devices": [Any]()]
        case .failed: return ["status": "failed", "devices": [Any]()]
        case .busy: return nil
        }
    }
}

// iCloud Tabs' reads kept going (SafariFiles.swift): CloudTabs.db and its
// log with kqueue, the folder with FSEvents (the file made, or replaced), a
// read at most once a second while they change and none when the files are
// as at the last good read; the outcome handed on only when it changed.
final class CloudTabsWatcher: SafariFileWatcher<CloudTabs.Outcome> {
    struct Options {
        var debounce: TimeInterval = 1
        var latency: TimeInterval = 0.3
        var retry: TimeInterval = 10
        var busyRetry: TimeInterval = 2
        // This Mac's name (its own rows are left out); nil: the computer's name, at each read.
        var thisMac: String?
    }

    init(folder: URL = SafariProfiles.safariFolder, options: Options = Options()) {
        let name = options.thisMac
        super.init(folder: folder, files: CloudTabs.watchedFiles,
                   timing: Timing(debounce: options.debounce, latency: options.latency, retry: options.retry, busyRetry: options.busyRetry),
                   label: "icloud tabs", stamped: true,
                   read: { CloudTabs.read($0, thisMac: name ?? CloudTabs.thisMacName()) },
                   next: { outcome in
                       switch outcome {
                       case .busy: return .busy
                       case .noAccess, .noData, .failed: return .retry
                       case .read: return .good
                       }
                   },
                   describe: CloudTabs.describe, matters: Self.matters)
    }

    nonisolated static func matters(_ path: String) -> Bool {
        CloudTabs.watchedFiles.contains((path as NSString).lastPathComponent)
    }
}
