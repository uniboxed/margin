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
import SQLite3

nonisolated struct SafariProfile: Equatable, Sendable {
    var serverId: String // Safari's id for the profile: the folder its data is in
    var uuid: String // its external_uuid
    var name: String
    var symbol: String // an SF Symbol's name, "" if none
    var margin: String? // the Margin profile id of the copy that runs in it, once Margin has run there
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
    static func read(_ folder: URL = safariFolder, extensionId: String = marginExtension, busyTimeoutMs: Int32 = 200) -> Outcome {
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
                p.margin = marginProfile(folder, folders: [row.server, row.uuid], extensionId: extensionId)
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

    // Margin's profile id in that profile: Margin's own entry in the profile's
    // Extensions.plist (`ProfileIdentifier`, what Safari sends as SFExtensionProfileKey).
    static func marginProfile(_ folder: URL, folders: [String], extensionId: String) -> String? {
        for name in folders where name.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil {
            let url = folder.appendingPathComponent("Profiles", isDirectory: true).appendingPathComponent(name, isDirectory: true)
                .appendingPathComponent("WebExtensions", isDirectory: true).appendingPathComponent("Extensions.plist")
            guard let data = try? Data(contentsOf: url),
                  let states = (try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)) as? [String: Any] else { continue }
            // "<bundle id> (<team id>)", or "(UNSIGNED)"; the bundle id alone, in case.
            guard let key = states.keys.sorted().first(where: { $0 == extensionId || $0.hasPrefix(extensionId + " (") }),
                  let state = states[key] as? [String: Any], let id = state["ProfileIdentifier"] as? String,
                  let uuid = UUID(uuidString: id) else { continue }
            return "s-\(uuid.uuidString.lowercased())"
        }
        return nil
    }

    // What the log says of a read: names and ids, never anything else.
    static func describe(_ outcome: Outcome) -> String {
        switch outcome {
        case .read(let list):
            return "\(list.count) profile\(list.count == 1 ? "" : "s"): " + list.map { "“\($0.name)” (\($0.serverId)\($0.symbol.isEmpty ? "" : ", \($0.symbol)")) → \($0.margin ?? "no copy yet")" }.joined(separator: "; ")
        case .noAccess: return "no Full Disk Access: the names typed in Margin are used"
        case .noSafari: return "no Safari data found"
        case .busy: return "the database was busy: trying again"
        case .failed(let why): return "not read: \(why)"
        }
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
    }

    static let watchedFiles = ["SafariTabs.db", "SafariTabs.db-wal"]

    let folder: URL
    let options: Options
    var onChange: ((SafariProfiles.Outcome) -> Void)?
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
        let folder = folder, id = options.extensionId
        queue.async {
            let outcome = SafariProfiles.read(folder, extensionId: id)
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
