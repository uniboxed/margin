// Safari's own profile names (Phase 2 step 9, Tirth 2026-11-05: "option A"),
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
// team, or unsigned ("(UNSIGNED)"), is another key with its own id. Tirth's
// named profiles have the unsigned build of 2026-10-24 (removed 10-30) next
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
    enum Access: Equatable, Sendable { case granted, denied, noSafari }

    static let defaultServerId = "DefaultProfile"
    static let defaultMargin = "s-default" // BrowserProfiles.defaultProfile: the default profile's copy
    static let marginExtension = "io.tirth.margin.Extension"
    static var safariFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library/Safari", isDirectory: true)
    }

    // Can Margin.app read Safari's data: a read attempt, nothing more (no private calls).
    static func access(_ folder: URL = safariFolder) -> Access {
        let db = folder.appendingPathComponent("SafariTabs.db").path
        let fd = open(db, O_RDONLY)
        if fd >= 0 { close(fd); return .granted }
        let err = errno
        if err == EPERM || err == EACCES { return .denied }
        // No database: Margin may still be shut out of the folder.
        if opendir(folder.path).map({ closedir($0); return true }) == true { return .granted }
        return errno == EPERM || errno == EACCES ? .denied : .noSafari
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
        // Safari open: its log is there and read through. Safari closed: the file alone, nothing made beside it.
        let live = FileManager.default.fileExists(atPath: db.path + "-wal")
        let uri = db.absoluteString + (live ? "?mode=ro" : "?mode=ro&immutable=1")
        var handle: OpaquePointer?
        let opened = sqlite3_open_v2(uri, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil)
        defer { sqlite3_close_v2(handle) }
        guard opened == SQLITE_OK, let handle else {
            if opened == SQLITE_BUSY || opened == SQLITE_LOCKED { return .busy }
            if opened == SQLITE_PERM || opened == SQLITE_AUTH { return .noAccess }
            return .failed("the database didn't open (\(opened))")
        }
        sqlite3_busy_timeout(handle, busyTimeoutMs)
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
        var info: OpaquePointer?
        var code = sqlite3_prepare_v2(db, "PRAGMA table_info(bookmarks)", -1, &info, nil)
        guard code == SQLITE_OK, let info else { return code }
        var cols = Set<String>()
        while true {
            code = sqlite3_step(info)
            guard code == SQLITE_ROW else { break }
            if let name = sqlite3_column_text(info, 1) { cols.insert(String(cString: name)) }
        }
        sqlite3_finalize(info)
        guard code == SQLITE_DONE else { return code }
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

// The reads kept going: a read at most once per `debounce` while Safari's
// files change, and the outcome handed on only when it changed. Watched:
// the tab database and its write-ahead log with kqueue (each write: Safari
// keeps them open, and FSEvents only says a file changed once it's closed),
// and Safari's folder with FSEvents (a profile's Extensions.plist, written
// whole; profiles' folders made or removed; the log made again). Without
// access (or with no Safari data) it tries again every `retry`, so Full Disk
// Access given while Margin.app runs is picked up; a busy database, after
// `busyRetry`.
final class SafariProfileWatcher {
    struct Options {
        var debounce: TimeInterval = 1
        var latency: TimeInterval = 0.3 // FSEvents' own coalescing
        var retry: TimeInterval = 10
        var busyRetry: TimeInterval = 2
        var extensionId = SafariProfiles.marginExtension
        var team = SafariProfiles.ownTeam // which of Margin's entries in a profile is this build's
    }

    static let watchedFiles = ["SafariTabs.db", "SafariTabs.db-wal"]

    let folder: URL
    let options: Options
    var onChange: ((SafariProfiles.Outcome) -> Void)?
    // After every read that isn't busy, changed or not (the shell's checks of the copies against it).
    var onRead: ((SafariProfiles.Outcome) -> Void)?
    // The copies Margin knows from their hellos, asked as each read starts (SafariProfiles.entries).
    var known: () -> Set<String> = { [] }
    private(set) var last: SafariProfiles.Outcome?
    private(set) var reads = 0
    private var stream: FSEventStreamRef?
    private var files: [String: DispatchSourceFileSystemObject] = [:]
    private var pending: Timer?
    private var reading = false
    private var again = false
    private var stopped = true
    private let queue = DispatchQueue(label: "io.tirth.margin.safari-profiles", qos: .utility)

    init(folder: URL = SafariProfiles.safariFolder, options: Options = Options()) {
        self.folder = folder
        self.options = options
    }

    func start() {
        guard stopped else { return }
        stopped = false
        watch()
        readNow()
    }

    func stop() {
        stopped = true
        pending?.invalidate()
        pending = nil
        if let stream { FSEventStreamStop(stream); FSEventStreamInvalidate(stream); FSEventStreamRelease(stream) }
        stream = nil
        for source in files.values { source.cancel() }
        files = [:]
    }

    // Something changed (or may have): one read, `after` from now, unless one is already coming.
    func soon(after: TimeInterval? = nil) {
        guard !stopped, pending == nil else { return }
        pending = Timer.scheduledTimer(withTimeInterval: after ?? options.debounce, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.pending = nil
                self?.readNow()
            }
        }
    }

    func readNow() {
        guard !stopped else { return }
        if reading { again = true; return }
        reading = true
        let folder = folder, id = options.extensionId, team = options.team, known = known()
        queue.async {
            let outcome = SafariProfiles.read(folder, extensionId: id, team: team, known: known)
            DispatchQueue.main.async { MainActor.assumeIsolated { self.done(outcome) } }
        }
    }

    private func done(_ outcome: SafariProfiles.Outcome) {
        reading = false
        reads += 1
        guard !stopped else { return }
        watch() // what wasn't there (or readable) before
        // A busy database says nothing new: what was read before stands.
        if outcome != .busy, outcome != last {
            last = outcome
            Diagnostics.note("safari profiles: " + SafariProfiles.describe(outcome))
            onChange?(outcome)
        }
        if outcome != .busy { onRead?(outcome) }
        if again { again = false; soon(); return }
        switch outcome {
        case .busy: soon(after: options.busyRetry)
        case .noAccess, .noSafari, .failed: soon(after: options.retry)
        case .read: break
        }
    }

    // What FSEvents reports that a read depends on: never the -shm (a reader
    // touches it) nor a profile's history.
    nonisolated static func matters(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        if name == "SafariTabs.db" || name == "SafariTabs.db-wal" || name == "Extensions.plist" { return true }
        let parent = ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
        return parent == "Profiles" || name == "Profiles" || name == "WebExtensions"
    }

    fileprivate func changed(_ paths: [String], rescan: Bool) {
        if rescan || paths.contains(where: Self.matters) { soon() }
    }

    private func watch() {
        startStream()
        for name in Self.watchedFiles where files[name] == nil { watchFile(name) }
    }

    // kqueue on one of the database's files: each write; deleted or replaced, watched again after the next read.
    private func watchFile(_ name: String) {
        let fd = open(folder.appendingPathComponent(name).path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend, .delete, .rename, .revoke, .attrib], queue: .main)
        source.setEventHandler { [weak self, weak source] in
            MainActor.assumeIsolated {
                guard let self, let source else { return }
                if !source.data.isDisjoint(with: [.delete, .rename, .revoke]) {
                    source.cancel()
                    if self.files[name] === source { self.files[name] = nil }
                }
                self.soon()
            }
        }
        source.setCancelHandler { close(fd) }
        files[name] = source
        source.resume()
    }

    private func startStream() {
        // FSEvents needs a folder that's there (and, for Safari's, readable).
        guard stream == nil, FileManager.default.fileExists(atPath: folder.path) else { return }
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer)
        guard let made = FSEventStreamCreate(nil, safariProfilesEvents, &context, [folder.path] as CFArray,
                                             FSEventStreamEventId(kFSEventStreamEventIdSinceNow), options.latency, flags) else { return }
        FSEventStreamSetDispatchQueue(made, .main)
        guard FSEventStreamStart(made) else { FSEventStreamInvalidate(made); FSEventStreamRelease(made); return }
        stream = made
    }
}

// FSEvents' callback (on the main queue, FSEventStreamSetDispatchQueue).
private nonisolated func safariProfilesEvents(_ stream: ConstFSEventStreamRef, _ info: UnsafeMutableRawPointer?, _ count: Int,
                                              _ paths: UnsafeMutableRawPointer, _ flags: UnsafePointer<FSEventStreamEventFlags>,
                                              _ ids: UnsafePointer<FSEventStreamEventId>) {
    guard let info else { return }
    let list = (Unmanaged<CFArray>.fromOpaque(paths).takeUnretainedValue() as NSArray) as? [String] ?? []
    let rescanFlags = FSEventStreamEventFlags(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagRootChanged)
    let rescan = (0..<count).contains { flags[$0] & rescanFlags != 0 }
    let pointer = UInt(bitPattern: info)
    MainActor.assumeIsolated {
        guard let raw = UnsafeMutableRawPointer(bitPattern: pointer) else { return }
        Unmanaged<SafariProfileWatcher>.fromOpaque(raw).takeUnretainedValue().changed(list, rescan: rescan)
    }
}

// A profile's SF Symbol as a small white picture for a theme's profile mark
// (an `m-icon`: a data: URL, ui/sanitize.js checkIconUrl), made once per symbol.
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
