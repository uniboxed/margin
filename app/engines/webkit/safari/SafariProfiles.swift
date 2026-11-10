// Safari's own profile names (Phase 2 step 9, chosen 2026-11-05: "option A"),
// read from Safari's files with Full Disk Access, read only, and kept in step
// with Safari while Margin.app runs. Without the permission nothing here is
// read and Margin keeps the names typed in its Edit Profile (BrowserProfiles.swift).
//
// Where Safari keeps them (Safari 27.2, learned from a read-only probe in
// Margin.app and Safari's own code, DECISIONS.md "Margin 2, Phase 2 step 9"):
//
//   ~/Library/Containers/com.apple.Safari/Data/Library/Safari/
//     SafariTabs.db        SQLite in WAL mode; table `bookmarks`: a profile is a
//                          row with type 1, subtype 2, parent 0: `title` its name,
//                          `server_id` Safari's id for it (`DefaultProfile` for the
//                          default one), `extra_attributes` a property list with
//                          `SymbolImageName` (an SF Symbol).
//     Profiles/<server_id>/WebExtensions/Extensions.plist
//                          each extension's state in that profile, keyed
//                          "<bundle id> (<team id>)": Margin's has `ProfileIdentifier`,
//                          the UUID Safari hands Margin's handler as
//                          SFExtensionProfileKey (made at random for each extension
//                          in each profile, so nothing else names it).
//
// A profile can hold more than one entry of Margin's: Safari keeps a removed
// extension's state (with a `RemovedDate`), and a build signed by another
// team, or unsigned ("(UNSIGNED)"), is another key with its own id. A real
// Mac's named profiles have the unsigned build of 2026-10-24 (removed 10-30) next
// to the signed one: the first key in sorted order was the removed one, so
// each name went to a copy that never links ("Margin 2: Safari
// reliability"). The entry used (chosenEntry): never a removed one; the one
// keyed with Margin.app's own team (`ownTeam`, "UNSIGNED" when ad hoc); then
// one whose copy Margin knows from a hello; then an enabled one, then the
// newest. `Enabled` alone isn't trusted: Safari leaves it true on some
// removed entries.
//
// So a copy (`s-<that uuid>`, SafariWebExtensionHandler.swift) is linked to its
// Safari profile through Margin's own entry in that profile's Extensions.plist;
// the default profile's copy (`s-default`) is always `DefaultProfile`.
//
// The database is opened read only (`mode=ro`; `immutable=1` when Safari has no
// write-ahead log open, so nothing is ever made in its folder), with a short
// busy timeout, once per read and closed straight after: Safari is never kept
// waiting. Only profiles' names, symbols and ids are read; never a tab, an
// address or another extension's settings. The log says names and ids only.

import AppKit
import Foundation
import Security
import SQLite3

nonisolated struct SafariProfile: Equatable, Sendable {
    var serverId: String // Safari's id for the profile: the folder its data is in
    var uuid: String // its external_uuid
    var name: String
    var symbol: String // an SF Symbol's name, "" if none
    var margin: String? // the Margin profile id of the copy that runs in it, once Margin has run there
    var entries = 0 // Margin's entries in its Extensions.plist (live or removed)
    var entryKey: String? // the one used: its key's team ("UNSIGNED", "" for the bundle id alone)
}

nonisolated enum SafariProfiles {
    enum Outcome: Equatable, Sendable {
        case read([SafariProfile])
        case noAccess // Full Disk Access not given (or withdrawn)
        case noSafari // no Safari data where it should be
        case busy // the database was locked for longer than the busy timeout: try again soon
        case failed(String) // not what Safari 27.2 writes: nothing used
    }
    typealias Access = SafariFiles.Access

    static let defaultServerId = "DefaultProfile"
    static let defaultMargin = "s-default" // BrowserProfiles.defaultProfile: the default profile's copy
    static let marginExtension = "com.unibox.margin.Extension"
    static var safariFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library/Safari", isDirectory: true)
    }

    // Can Margin.app read Safari's data: a read attempt, nothing more (no private calls).
    static func access(_ folder: URL = safariFolder) -> Access {
        SafariFiles.access(folder, file: "SafariTabs.db")
    }

    // The profiles as Safari has them now.
    // `team`: Margin.app's own (ownTeam; nil when ad hoc); `known`: the copies Margin knows from their hellos.
    static func read(_ folder: URL = safariFolder, extensionId: String = marginExtension, team: String? = nil, known: Set<String> = [],
                     busyTimeoutMs: Int32 = 200) -> Outcome {
        switch access(folder) {
        case .denied: return .noAccess
        case .noSafari: return .noSafari
        case .granted: break
        }
        let db = folder.appendingPathComponent("SafariTabs.db")
        guard FileManager.default.fileExists(atPath: db.path) else { return .noSafari }
        let handle: OpaquePointer
        switch SafariFiles.openReadOnly(db, busyTimeoutMs: busyTimeoutMs) {
        case .ok(let h): handle = h
        case .busy: return .busy
        case .noAccess: return .noAccess
        case .failed(let code): return .failed("the database didn't open (\(code))")
        }
        defer { sqlite3_close_v2(handle) }
        var rows: [(title: String, uuid: String, server: String, extra: Data?)] = []
        switch profileRows(handle, into: &rows) {
        case SQLITE_OK: break
        case SQLITE_BUSY, SQLITE_LOCKED: return .busy
        case SQLITE_PERM, SQLITE_AUTH, SQLITE_CANTOPEN: return .noAccess
        case let code: return .failed(code == -1 ? "no profiles table as Safari 27.2 has it" : "the profiles didn't read (\(code))")
        }
        let profiles = rows.map { row -> SafariProfile in
            let server = row.server.isEmpty ? row.uuid : row.server
            var p = SafariProfile(serverId: server, uuid: row.uuid, name: String(row.title.prefix(64)), symbol: symbol(row.extra), margin: nil)
            if server == defaultServerId || row.uuid == defaultServerId {
                p.margin = defaultMargin
            } else {
                let found = marginEntries(folder, folders: [row.server, row.uuid], extensionId: extensionId, team: team, known: known)
                p.margin = found.chosen
                p.entries = found.count
                p.entryKey = found.chosen == nil ? nil : found.suffix
            }
            return p
        }
        return .read(profiles)
    }

    // The profile rows (their name, uuid, Safari id and settings): SQLITE_OK,
    // SQLite's code, or -1 when the table isn't as Safari 27.2 has it.
    private static func profileRows(_ db: OpaquePointer, into rows: inout [(title: String, uuid: String, server: String, extra: Data?)]) -> Int32 {
        let (cols, read) = SafariFiles.columns(db, "bookmarks")
        guard read == SQLITE_OK else { return read }
        var code: Int32
        guard ["type", "subtype", "parent", "title", "external_uuid", "server_id", "deleted"].allSatisfy(cols.contains) else { return -1 }
        let extra = cols.contains("extra_attributes") ? "extra_attributes" : "NULL"
        let order = cols.contains("order_index") ? "order_index, id" : "id"
        let sql = "SELECT title, external_uuid, server_id, \(extra) FROM bookmarks WHERE type = 1 AND subtype = 2 AND parent = 0 AND deleted = 0 ORDER BY \(order)"
        var stmt: OpaquePointer?
        code = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard code == SQLITE_OK, let stmt else { return code }
        defer { sqlite3_finalize(stmt) }
        while true {
            code = sqlite3_step(stmt)
            guard code == SQLITE_ROW else { break }
            let text = { (i: Int32) in sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? "" }
            var data: Data?
            let n = Int(sqlite3_column_bytes(stmt, 3))
            if n > 0, n < 1 << 20, let bytes = sqlite3_column_blob(stmt, 3) { data = Data(bytes: bytes, count: n) }
            rows.append((text(0), text(1), text(2), data))
        }
        return code == SQLITE_DONE ? SQLITE_OK : code
    }

    // The SF Symbol Safari shows for the profile (its settings' SymbolImageName).
    static func symbol(_ extra: Data?) -> String {
        guard let extra, let plist = (try? PropertyListSerialization.propertyList(from: extra, options: [], format: nil)) as? [String: Any],
              let name = plist["SymbolImageName"] as? String, name.count <= 64,
              name.range(of: "^[a-z0-9]+(\\.[a-z0-9]+)*$", options: .regularExpression) != nil else { return "" }
        return name
    }

    // Margin.app's own team, from its signature (public Security API); nil
    // when it's signed ad hoc (npm run safari -- --unsigned) or unsigned. The
    // extension inside it is signed by the same team, so its entries in
    // Safari's plists are keyed "<bundle id> (<this>)", or "(UNSIGNED)".
    static let ownTeam: String? = {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any], let team = dict[kSecCodeInfoTeamIdentifier as String] as? String,
              team.range(of: "^[A-Z0-9]{1,20}$", options: .regularExpression) != nil else { return nil }
        return team
    }()

    // One of Margin's entries in a profile's Extensions.plist.
    struct Entry: Equatable, Sendable {
        var key: String
        var suffix: String // the team in "<bundle id> (<team>)", "UNSIGNED", or "" for the bundle id alone
        var margin: String? // s-<its ProfileIdentifier>, if that's a UUID
        var enabled: Bool?
        var added: Date?
        var removed: Bool
    }
    struct Entries: Equatable, Sendable {
        var all: [Entry] = []
        var chosen: String? // the copy's id (s-<uuid>) of the entry used, if any
        var suffix: String?
        var count: Int { all.count }
    }

    // Removed: a RemovedDate later than when it was added (and than its last
    // Enabled change, if it has one). An entry added again with an old
    // RemovedDate left on it counts as there.
    static func isRemoved(_ state: [String: Any]) -> Bool {
        guard let removed = date(state["RemovedDate"]) else { return false }
        if let added = date(state["AddedDate"]), added >= removed { return false }
        if let changed = date(state["EnabledModificationDate"]), changed >= removed { return false }
        return true
    }

    private static func date(_ v: Any?) -> Date? {
        if let d = v as? Date { return d }
        if let n = v as? NSNumber { return Date(timeIntervalSinceReferenceDate: n.doubleValue) }
        return nil
    }

    // Margin's entries in one profile's plist (its states), and the one used:
    // never a removed one; the own team's key ("UNSIGNED" with no team); one
    // whose copy is `known`; then enabled, then the newest added, then by key.
    // None live: none (the profile keeps Margin's typed name). Nothing here
    // pairs a profile with a copy by elimination.
    static func entries(_ states: [String: Any], extensionId: String, team: String?, known: Set<String> = []) -> Entries {
        var out = Entries()
        for key in states.keys.sorted() {
            let suffix: String
            if key == extensionId { suffix = "" } else if key.hasPrefix(extensionId + " ("), key.hasSuffix(")") {
                suffix = String(key.dropFirst(extensionId.count + 2).dropLast())
            } else { continue }
            let state = states[key] as? [String: Any] ?? [:]
            let margin = (state["ProfileIdentifier"] as? String).flatMap { UUID(uuidString: $0) }.map { "s-\($0.uuidString.lowercased())" }
            out.all.append(Entry(key: key, suffix: suffix, margin: margin, enabled: state["Enabled"] as? Bool, added: date(state["AddedDate"]), removed: isRemoved(state)))
        }
        let live = out.all.filter { !$0.removed && $0.margin != nil }
        let own = team ?? "UNSIGNED"
        let pick = live.first { $0.suffix == own } ?? live.first { known.contains($0.margin!) }
            ?? live.sorted { a, b in
                let ea = a.enabled == true, eb = b.enabled == true
                if ea != eb { return ea }
                let da = a.added ?? .distantPast, db = b.added ?? .distantPast
                if da != db { return da > db }
                return a.key < b.key
            }.first
        out.chosen = pick?.margin
        out.suffix = pick?.suffix
        return out
    }

    // Margin's entries in that profile (its Extensions.plist under the first
    // of `folders` that has any), and the copy's id from the one used.
    static func marginEntries(_ folder: URL, folders: [String], extensionId: String, team: String?, known: Set<String> = []) -> Entries {
        var found = Entries()
        for name in folders where name.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil {
            let url = folder.appendingPathComponent("Profiles", isDirectory: true).appendingPathComponent(name, isDirectory: true)
                .appendingPathComponent("WebExtensions", isDirectory: true).appendingPathComponent("Extensions.plist")
            guard let data = try? Data(contentsOf: url),
                  let states = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any] else { continue }
            let here = entries(states, extensionId: extensionId, team: team, known: known)
            if here.chosen != nil { return here }
            if here.count > 0 { found = here }
        }
        return found
    }

    // Margin's profile id in that profile: Margin's own entry in the profile's
    // Extensions.plist (`ProfileIdentifier`, what Safari sends as SFExtensionProfileKey).
    static func marginProfile(_ folder: URL, folders: [String], extensionId: String, team: String? = nil, known: Set<String> = []) -> String? {
        marginEntries(folder, folders: folders, extensionId: extensionId, team: team, known: known).chosen
    }

    // What the log says of a read: names and ids, never anything else.
    static func describe(_ outcome: Outcome) -> String {
        switch outcome {
        case .read(let list):
            return "\(list.count) profile\(list.count == 1 ? "" : "s"): " + list.map { "“\($0.name)” (\($0.serverId)\($0.symbol.isEmpty ? "" : ", \($0.symbol)")) → \(copy($0))" }.joined(separator: "; ")
        case .noAccess: return "no Full Disk Access: the names typed in Margin are used"
        case .noSafari: return "no Safari data found"
        case .busy: return "the database was busy: trying again"
        case .failed(let why): return "not read: \(why)"
        }
    }

    // A profile's copy as the log says it: its id, and which of Margin's
    // entries it came from (the key's team, "UNSIGNED" or "bundle id") and how
    // many there are. Ids and team ids only.
    private static func copy(_ p: SafariProfile) -> String {
        let count = "\(p.entries) entr\(p.entries == 1 ? "y" : "ies")"
        guard let margin = p.margin else { return p.entries == 0 ? "no copy yet" : "no copy yet (\(count), none live)" }
        guard p.entries > 0 else { return margin } // the default profile's, always s-default
        let key = p.entryKey.map { $0.isEmpty ? "bundle id" : $0 } ?? "?"
        return "\(margin) (\(key), \(count))"
    }
}

// The reads kept going (SafariFiles.swift SafariFileWatcher): a read at most
// once per `debounce` while Safari's files change, and the outcome handed on
// only when it changed. Watched: the tab database and its write-ahead log
// with kqueue (each write: Safari keeps them open, and FSEvents only says a
// file changed once it's closed), and Safari's folder with FSEvents (a
// profile's Extensions.plist, written whole; profiles' folders made or
// removed; the log made again). Without access (or with no Safari data) it
// tries again every `retry`, so Full Disk Access given while Margin.app runs
// is picked up; a busy database, after `busyRetry`.
final class SafariProfileWatcher: SafariFileWatcher<SafariProfiles.Outcome> {
    struct Options {
        var debounce: TimeInterval = 1
        var latency: TimeInterval = 0.3 // FSEvents' own coalescing
        var retry: TimeInterval = 10
        var busyRetry: TimeInterval = 2
        var extensionId = SafariProfiles.marginExtension
        var team = SafariProfiles.ownTeam // which of Margin's entries in a profile is this build's
    }

    static let watchedFiles = ["SafariTabs.db", "SafariTabs.db-wal"]

    // The copies Margin knows from their hellos, asked as each read starts (SafariProfiles.entries).
    private final class Known { var get: () -> Set<String> = { [] } }
    private let knownBox: Known
    var known: () -> Set<String> {
        get { knownBox.get }
        set { knownBox.get = newValue }
    }

    let options: Options

    init(folder: URL = SafariProfiles.safariFolder, options: Options = Options()) {
        self.options = options
        let box = Known()
        knownBox = box
        let id = options.extensionId, team = options.team
        super.init(folder: folder, files: Self.watchedFiles,
                   timing: Timing(debounce: options.debounce, latency: options.latency, retry: options.retry, busyRetry: options.busyRetry),
                   label: "safari profiles",
                   read: { SafariProfiles.read($0, extensionId: id, team: team) },
                   readWith: {
                       let known = box.get()
                       return { SafariProfiles.read($0, extensionId: id, team: team, known: known) }
                   },
                   next: { outcome in
                       switch outcome {
                       case .busy: return .busy
                       case .noAccess, .noSafari, .failed: return .retry
                       case .read: return .good
                       }
                   },
                   describe: SafariProfiles.describe, matters: Self.matters)
    }

    // What FSEvents reports that a read depends on: never the -shm (a reader
    // touches it) nor a profile's history.
    nonisolated static func matters(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        if name == "SafariTabs.db" || name == "SafariTabs.db-wal" || name == "Extensions.plist" { return true }
        let parent = ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
        return parent == "Profiles" || name == "Profiles" || name == "WebExtensions"
    }
}

// A profile's SF Symbol as a small white picture for a theme's profile mark
// (an `m-icon`: a data: URL, ui/sanitize.ts checkIconUrl), made once per symbol.
enum ProfileSymbols {
    private static var made: [String: String] = [:]

    static func dataURL(_ name: String, points: CGFloat = 12, scale: CGFloat = 2) -> String? {
        guard !name.isEmpty else { return nil }
        if let known = made[name] { return known.isEmpty ? nil : known }
        let url = render(name, points: points, scale: scale) ?? ""
        made[name] = url
        return url.isEmpty ? nil : url
    }

    private static func render(_ name: String, points: CGFloat, scale: CGFloat) -> String? {
        let config = NSImage.SymbolConfiguration(pointSize: points * 0.8, weight: .semibold).applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
        guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config) else { return nil }
        let side = Int(points * scale)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = NSSize(width: points, height: points)
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.current = context
        let size = symbol.size
        let fit = min(points / max(size.width, 1), points / max(size.height, 1), 1)
        let w = size.width * fit, h = size.height * fit
        symbol.draw(in: NSRect(x: (points - w) / 2, y: (points - h) / 2, width: w, height: h))
        context.flushGraphics()
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}
