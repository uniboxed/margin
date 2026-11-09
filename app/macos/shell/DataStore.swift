// Margin.app's files for the lasting data (docs/DATA.md "The app's files";
// PLAN.md §6 "Where data lives"): one data set per browser and profile, one
// file per collection, so a change to a space doesn't rewrite every site
// icon. Under the root (the app's: ~/Library/Application Support/Margin/data):
//
//   <browser>/<profile>/set.json               { format, browser, profile, acked, savedAt }
//   <browser>/<profile>/items/<collection>.json { format, collection, items }
//
// Each file is written whole to a temporary file beside it (flushed with
// fsync), the version it replaces is kept as `<file>.bak` (a hard link, so the
// file itself is never missing), and the new one is renamed over it. set.json
// is written last: a profile without one has no data set. Reading takes a
// file's backup when the file can't be read, and removes temporary files a
// crash left. The names on disk are the browser's and profile's with
// everything but a–z, 0–9, _ and - written as %XX (so no name can be `..`,
// and two that differ only in case don't meet on a case-insensitive disk);
// Margin's own collections keep their names, any other is written out the
// same way after `x-`. The real names are inside the files.
//
// The data sets are kept in memory once read; save() changes the memory at
// once and writes on a queue of its own, in order, then calls back on the
// main thread (the link acks only then).

import Foundation
import Security

struct DataProfile: Hashable, Comparable, CustomStringConvertible {
    let browser: String
    let profile: String
    var key: String { "\(browser):\(profile)" }
    var description: String { key }
    static func < (a: DataProfile, b: DataProfile) -> Bool { a.key < b.key }
}

final class DataStore {
    struct Stored {
        var set: DataSet
        // The newest updatedAt of the extension's changes the app has confirmed (data.ack) to this profile.
        var acked: Double
        // The set's revision: new at every save that changes it (its number,
        // then random letters, so a set restored from a backup or another
        // Mac's never has a rev a copy knows for something else). save() sets it.
        var rev = ""
    }

    static func nextRev(_ rev: String?) -> String {
        let n = rev.flatMap { $0.split(separator: "-").first }.flatMap { Int($0) } ?? 0
        var bytes = [UInt8](repeating: 0, count: 5)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return "\(n + 1)-" + bytes.map { String(format: "%02x", $0) }.joined()
    }

    let root: URL
    private let queue: DispatchQueue? // nil: written at once (the unit tests)
    var now: () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded() }
    // A test's crash: the number of files written before the store stops as
    // the app would if it died (the next file left as a temporary file, nothing
    // more written or called back as saved).
    var crashAfterWrites: Int?
    private(set) var crashed = false
    // Files read from their backup, and temporary files removed (tests, the log).
    private(set) var recovered: [String] = []
    private(set) var removedTemps = 0
    private(set) var writes = 0
    // While a save's callback runs: the rev that save wrote (a later save may
    // already have moved the set in memory on).
    private(set) var savedRev = ""

    private var cache: [DataProfile: Stored] = [:]
    private var unusable: Set<DataProfile> = [] // a later format's: read nothing, write nothing
    private var pending = 0
    private(set) var scheduled = 0 // files given to the queue (a test's crash counts from it)

    // ~/Library/Application Support/Margin/data
    static var appRoot: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Margin/data", isDirectory: true)
    }

    init(root: URL, background: Bool = true) {
        self.root = root
        queue = background ? DispatchQueue(label: "io.tirth.margin.data", qos: .utility) : nil
    }

    // ---- names ----

    static func fileName(_ name: String) -> String {
        var out = ""
        for byte in name.utf8 {
            switch byte {
            case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "_"), UInt8(ascii: "-"):
                out.append(Character(UnicodeScalar(byte)))
            default:
                out += String(format: "%%%02X", byte)
            }
        }
        // A long name (a collection of a later format's): its hash.
        if out.isEmpty || out.utf8.count > 200 { return "~" + Chunks.sha256(Data(name.utf8)) }
        return out
    }

    // Margin's own collections (docs/DATA.md), which differ in more than case, by
    // their names; any other (a later format's) written out after `x-`.
    static let knownCollections: Set<String> = ["spaces", "pins", "folders", "tabs", "archive", "settings", "themeSettings", "siteIcons", "userThemes"]

    static func collectionFileName(_ name: String) -> String {
        knownCollections.contains(name) ? name : "x-" + fileName(name)
    }

    func directory(_ p: DataProfile) -> URL {
        root.appendingPathComponent(Self.fileName(p.browser), isDirectory: true).appendingPathComponent(Self.fileName(p.profile), isDirectory: true)
    }

    // ---- reading ----

    // The profile's data set, or nil if it has none (never linked, or the
    // first set's write didn't finish) or it's a later format's.
    func load(_ p: DataProfile) -> Stored? {
        if let stored = cache[p] { return stored }
        if unusable.contains(p) { return nil }
        waitForWrites()
        let dir = directory(p)
        let items = dir.appendingPathComponent("items", isDirectory: true)
        removeTemps(in: dir)
        removeTemps(in: items)
        guard let manifest = readObject(dir.appendingPathComponent("set.json")) else { return nil }
        guard int(manifest["format"]) == DataFormat.version else {
            unusable.insert(p)
            Diagnostics.warn("\(p): its data is of format \(manifest["format"] ?? "?"): left alone")
            return nil
        }
        var collections: [String: Any] = [:]
        let names = (try? FileManager.default.contentsOfDirectory(atPath: items.path)) ?? []
        let files = Set(names.compactMap { name -> String? in
            if name.hasSuffix(".json") { return name }
            if name.hasSuffix(".json.bak") { return String(name.dropLast(4)) } // a backup whose file is gone
            return nil
        })
        for name in files.sorted() {
            guard let o = readObject(items.appendingPathComponent(name)) else { continue }
            guard int(o["format"]) == DataFormat.version else {
                unusable.insert(p)
                Diagnostics.warn("\(p): \(name) is of format \(o["format"] ?? "?"): the profile's data left alone")
                return nil
            }
            guard let collection = o["collection"] as? String, let list = o["items"] as? JSONObject else { continue }
            collections[collection] = list
        }
        // A set.json with no rev (none before step 3b's revisions) gets one no copy knows.
        let stored = Stored(set: DataSet(json: ["items": collections]), acked: num(manifest["acked"]) ?? 0, rev: manifest["rev"] as? String ?? Self.nextRev(nil))
        cache[p] = stored
        Diagnostics.note("\(p): data read (\(collections.count) collections)")
        return stored
    }

    // A file's object, else its backup's (noted in `recovered`).
    private func readObject(_ url: URL) -> JSONObject? {
        if let o = Self.object(at: url) { return o }
        let bak = URL(fileURLWithPath: url.path + ".bak")
        guard let o = Self.object(at: bak) else { return nil }
        recovered.append(url.lastPathComponent)
        Diagnostics.warn("\(url.lastPathComponent) couldn't be read: its backup taken")
        return o
    }

    private static func object(at url: URL) -> JSONObject? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? JSONObject
    }

    private func removeTemps(in dir: URL) {
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasSuffix(".tmp") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
            removedTemps += 1
        }
    }

    // Every profile with a data set, of one browser or all.
    func profiles(browser: String? = nil) -> [DataProfile] {
        var out = Set(cache.keys.filter { browser == nil || $0.browser == browser })
        let browsers = browser.map { [Self.fileName($0)] } ?? ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? [])
        for b in browsers {
            let dir = root.appendingPathComponent(b, isDirectory: true)
            for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] {
                let set = dir.appendingPathComponent(name, isDirectory: true).appendingPathComponent("set.json")
                guard let o = Self.object(at: set) ?? Self.object(at: URL(fileURLWithPath: set.path + ".bak")),
                      let br = o["browser"] as? String, let pr = o["profile"] as? String else { continue }
                out.insert(DataProfile(browser: br, profile: pr))
            }
        }
        return out.sorted()
    }

    // ---- writing ----

    // The profile's set and acked as they are now: in memory at once, then the
    // files of `changed` collections (nil: all) and set.json. Tombstones past
    // their time (60 days, 2,000 a collection) go first. A save that changes
    // anything gives the set a new `rev` (stored.rev is ignored), written to
    // set.json before the collections too (with the acked from before), so a
    // crash between them never leaves new items under the rev a copy has.
    // `then(true)` once it's all on disk; false if a write failed (the memory
    // is dropped: it's read again from the files).
    func save(_ p: DataProfile, _ stored: Stored, changed: Set<String>?, then: @escaping (Bool) -> Void = { _ in }) {
        guard !crashed else { return } // a dead app says nothing
        guard !unusable.contains(p) else { return then(false) }
        var stored = stored
        let before = cache[p] ?? load(p)
        let pruned = stored.set.pruneTombstones(before: now() - DataFormat.tombstoneMs)
        let collections = changed.map { $0.union(pruned) } ?? Set(stored.set.collections)
        let bumped = before == nil || !collections.isEmpty
        stored.rev = bumped ? Self.nextRev(before?.rev) : before!.rev
        cache[p] = stored
        let rev = stored.rev
        let dir = directory(p)
        let items = dir.appendingPathComponent("items", isDirectory: true)
        var files: [(URL, Data)] = []
        let manifest = { (acked: Double) -> Data in
            let body: JSONObject = ["format": DataFormat.version, "browser": p.browser, "profile": p.profile, "acked": acked, "rev": stored.rev, "savedAt": self.now()]
            return (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
        }
        // The new rev first (not for a first set: without set.json, a profile has none).
        if bumped, let before { files.append((dir.appendingPathComponent("set.json"), manifest(before.acked))) }
        for collection in collections.sorted() {
            let list = stored.set.items[collection] ?? [:]
            let body: JSONObject = ["format": DataFormat.version, "collection": collection, "items": list.mapValues(\.json)]
            guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else {
                Diagnostics.warn("\(p): \(collection) isn't JSON: not written")
                continue
            }
            files.append((items.appendingPathComponent(Self.collectionFileName(collection) + ".json"), data))
        }
        files.append((dir.appendingPathComponent("set.json"), manifest(stored.acked)))
        let allowed = crashAfterWrites.map { max(0, $0 - scheduled) }
        scheduled += files.count
        let job = { [files] () -> DataStore.Written in DataStore.write(files, dirs: [items, dir], allowed: allowed) }
        let done = { [weak self] (result: DataStore.Written) in
            guard let self else { return }
            self.pending -= 1
            self.writes += result.count
            if result.crashed {
                self.crashed = true
                Diagnostics.warn("\(p): the store stopped mid-write (a test's crash)")
                return // a crash says nothing more
            }
            if let error = result.error {
                Diagnostics.warn("\(p): data not saved: \(error)")
                self.cache[p] = nil
                return then(false)
            }
            self.savedRev = rev
            then(true)
        }
        pending += 1
        guard let queue else { return done(job()) }
        queue.async {
            let result = job()
            DispatchQueue.main.async { MainActor.assumeIsolated { done(result) } }
        }
    }

    // Waits for the writes under way (a read of the files after a failed one, the tests).
    func waitForWrites() {
        guard pending > 0, let queue else { return }
        queue.sync {}
    }

    // The memory dropped: the next load reads the files.
    func forget(_ p: DataProfile) {
        cache[p] = nil
    }

    // A profile's set put away, whole and as it was (a signing change carried
    // it to another id: ShellProfiles.swift carryOver): its folder renamed to
    // <browser>/.archived/<profile>-<ms>, where profiles() never looks, so
    // the profile has no set any more. Nothing is deleted. Where it went, or
    // nil if it had no folder or the rename failed.
    @discardableResult func archive(_ p: DataProfile) -> URL? {
        waitForWrites()
        let dir = directory(p)
        guard FileManager.default.fileExists(atPath: dir.path) else { return nil }
        let into = root.appendingPathComponent(Self.fileName(p.browser), isDirectory: true).appendingPathComponent(".archived", isDirectory: true)
        let to = into.appendingPathComponent("\(Self.fileName(p.profile))-\(Int(now()))", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: into, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: dir, to: to)
        } catch {
            Diagnostics.warn("\(p): its data set not put away: \(error)")
            return nil
        }
        cache[p] = nil
        return to
    }

    nonisolated struct Written: Sendable {
        var count = 0
        var crashed = false
        var error: String?
    }

    // The files in order, each whole or not at all.
    nonisolated private static func write(_ files: [(URL, Data)], dirs: [URL], allowed: Int?) -> Written {
        var out = Written()
        do {
            for dir in dirs { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
            for (url, data) in files {
                if let allowed, out.count >= allowed {
                    _ = try? writeFile(data, to: url, replace: false) // the crash: a temporary file left, the file as it was
                    out.crashed = true
                    return out
                }
                try writeFile(data, to: url, replace: true)
                out.count += 1
            }
            for dir in dirs { syncDirectory(dir) }
        } catch {
            out.error = "\(error)"
        }
        return out
    }

    // One small file written the same way (temporary file, fsync, .bak, rename), at once: browser.json.
    nonisolated static func writeAtomically(_ data: Data, to url: URL) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try writeFile(data, to: url, replace: true)
        syncDirectory(dir)
    }

    nonisolated struct WriteError: Error, CustomStringConvertible {
        let description: String
    }

    nonisolated private static func writeFile(_ data: Data, to url: URL, replace: Bool) throws {
        let path = url.path
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString.prefix(8)).tmp").path
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw WriteError(description: "\(url.lastPathComponent): open: \(String(cString: strerror(errno)))") }
        var failed: String?
        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < buffer.count {
                let n = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    failed = String(cString: strerror(errno))
                    return
                }
                offset += n
            }
        }
        if failed == nil, fsync(fd) != 0 { failed = String(cString: strerror(errno)) }
        close(fd)
        if let failed {
            unlink(tmp)
            throw WriteError(description: "\(url.lastPathComponent): \(failed)")
        }
        guard replace else { return }
        // The version it replaces, kept: a hard link (the file stays where it is throughout).
        if access(path, F_OK) == 0 {
            let bak = path + ".bak"
            let bakTmp = bak + ".tmp"
            unlink(bakTmp)
            if link(path, bakTmp) == 0 || (try? FileManager.default.copyItem(atPath: path, toPath: bakTmp)) != nil {
                rename(bakTmp, bak)
            }
        }
        guard rename(tmp, path) == 0 else {
            let why = String(cString: strerror(errno))
            unlink(tmp)
            throw WriteError(description: "\(url.lastPathComponent): rename: \(why)")
        }
    }

    // The renames made lasting.
    nonisolated private static func syncDirectory(_ dir: URL) {
        let fd = open(dir.path, O_RDONLY)
        guard fd >= 0 else { return }
        fsync(fd)
        close(fd)
    }
}
