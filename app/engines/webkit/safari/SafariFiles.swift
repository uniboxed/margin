// What Margin.app reads of Safari's own files with Full Disk Access, and how:
// Safari's profile names (SafariProfiles.swift) and iCloud Tabs
// (CloudTabs.swift). Both are SQLite databases in Safari's container that
// Safari keeps open in WAL mode, so both are read the same way and watched
// the same way:
//
// - **Access:** a read attempt (`open()` on the file: EPERM/EACCES is no
//   permission), nothing more; no private calls.
// - **Reading:** SQLite opened read only (SQLITE_OPEN_READONLY, `mode=ro`;
//   `immutable=1` when Safari has no write-ahead log beside it, so nothing is
//   ever made in its folder), a short busy timeout, opened, read and closed
//   each time: Safari is never kept waiting. Margin never writes, vacuums or
//   checkpoints Safari's files.
// - **Watching** (SafariFileWatcher): FSEvents reports a file's change only
//   once the writer closes it, and Safari keeps its databases and their logs
//   open, so those are watched with kqueue (each write), and Safari's folder
//   with FSEvents for the rest. A read at most once per `debounce` while they
//   change; the outcome handed on (and logged) only when it changed. A
//   reader may also skip a read when its files' sizes and times are as they
//   were at its last good read (a kqueue event with nothing new).

import Foundation
import SQLite3

nonisolated enum SafariFiles {
    enum Access: Equatable, Sendable { case granted, denied, noSafari }

    // System Settings at Full Disk Access (its public URL): the set-up window's
    // step and the iCloud Tabs folder's row both open it.
    static let fullDiskAccessURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!

    // Can Margin.app read `file` in Safari's folder: a read attempt, nothing more.
    static func access(_ folder: URL, file: String) -> Access {
        let path = folder.appendingPathComponent(file).path
        let fd = open(path, O_RDONLY)
        if fd >= 0 { close(fd); return .granted }
        let err = errno
        if err == EPERM || err == EACCES { return .denied }
        // No such file: Margin may still be shut out of the folder.
        if opendir(folder.path).map({ closedir($0); return true }) == true { return .granted }
        return errno == EPERM || errno == EACCES ? .denied : .noSafari
    }

    enum Opened {
        case ok(OpaquePointer)
        case busy
        case noAccess
        case failed(Int32)
    }

    // One of Safari's databases, read only. Safari open: its log is there and
    // read through. Safari closed: the file alone, nothing made beside it.
    // The caller closes it (sqlite3_close_v2).
    static func openReadOnly(_ db: URL, busyTimeoutMs: Int32) -> Opened {
        let live = FileManager.default.fileExists(atPath: db.path + "-wal")
        let uri = db.absoluteString + (live ? "?mode=ro" : "?mode=ro&immutable=1")
        var handle: OpaquePointer?
        let opened = sqlite3_open_v2(uri, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil)
        guard opened == SQLITE_OK, let handle else {
            sqlite3_close_v2(handle)
            if opened == SQLITE_BUSY || opened == SQLITE_LOCKED { return .busy }
            if opened == SQLITE_PERM || opened == SQLITE_AUTH { return .noAccess }
            return .failed(opened)
        }
        sqlite3_busy_timeout(handle, busyTimeoutMs)
        return .ok(handle)
    }

    // A table's columns (PRAGMA table_info): the names, or SQLite's code.
    static func columns(_ db: OpaquePointer, _ table: String) -> (Set<String>, Int32) {
        var info: OpaquePointer?
        var code = sqlite3_prepare_v2(db, "PRAGMA table_info(\(table))", -1, &info, nil)
        guard code == SQLITE_OK, let info else { return ([], code) }
        defer { sqlite3_finalize(info) }
        var cols = Set<String>()
        while true {
            code = sqlite3_step(info)
            guard code == SQLITE_ROW else { break }
            if let name = sqlite3_column_text(info, 1) { cols.insert(String(cString: name)) }
        }
        return (cols, code == SQLITE_DONE ? SQLITE_OK : code)
    }

    // The files' sizes, times and inodes, as one string: the same string means nothing was written.
    static func stamp(_ folder: URL, _ files: [String]) -> String {
        files.map { name -> String in
            var st = stat()
            guard stat(folder.appendingPathComponent(name).path, &st) == 0 else { return "-" }
            return "\(st.st_ino):\(st.st_size):\(st.st_mtimespec.tv_sec).\(st.st_mtimespec.tv_nsec)"
        }.joined(separator: "|")
    }
}

// FSEvents' callback can't be generic: what it calls.
protocol FolderEvents: AnyObject {
    func folderChanged(_ paths: [String], rescan: Bool)
}

// Reads of one of Safari's files kept going (see the top of this file).
// Without access (or with no Safari data) it tries again every `retry`, so
// Full Disk Access given while Margin.app runs is picked up; a busy
// database, after `busyRetry`.
class SafariFileWatcher<Outcome: Equatable & Sendable>: FolderEvents {
    struct Timing {
        var debounce: TimeInterval = 1
        var latency: TimeInterval = 0.3 // FSEvents' own coalescing
        var retry: TimeInterval = 10
        var busyRetry: TimeInterval = 2
    }
    enum Next { case good, busy, retry }

    let folder: URL
    let files: [String] // watched with kqueue: the database and its log
    let timing: Timing
    var onChange: ((Outcome) -> Void)?
    // After every read that isn't busy, changed or not.
    var onRead: ((Outcome) -> Void)?
    private(set) var last: Outcome?
    private(set) var reads = 0
    private(set) var skipped = 0 // reads not made: the files were as at the last good read
    private let label: String
    private let reader: @Sendable (URL) -> Outcome
    private let readWith: (() -> @Sendable (URL) -> Outcome)?
    private let next: (Outcome) -> Next
    private let describe: (Outcome) -> String
    private let matters: (String) -> Bool
    private let stamped: Bool
    private var stamp: String?
    private var stream: FSEventStreamRef?
    private var sources: [String: DispatchSourceFileSystemObject] = [:]
    private var pending: Timer?
    private var reading = false
    private var again = false
    private var stopped = true
    private let queue: DispatchQueue

    // `stamped`: skip a read when the watched files haven't changed since the last good one.
    // `readWith`: asked on the main actor as each read starts, for a read that needs what's known then.
    init(folder: URL, files: [String], timing: Timing, label: String, stamped: Bool = false,
         read: @escaping @Sendable (URL) -> Outcome, readWith: (() -> @Sendable (URL) -> Outcome)? = nil, next: @escaping (Outcome) -> Next,
         describe: @escaping (Outcome) -> String, matters: @escaping (String) -> Bool) {
        self.folder = folder
        self.files = files
        self.timing = timing
        self.label = label
        self.stamped = stamped
        self.reader = read
        self.readWith = readWith
        self.next = next
        self.describe = describe
        self.matters = matters
        queue = DispatchQueue(label: "com.unibox.margin.\(label.replacingOccurrences(of: " ", with: "-"))", qos: .utility)
    }

    // Written out, and not optimized: Swift 6.3.3 (Xcode 26.6, GitHub's newest) crashes inlining
    // into the deinit it makes for this generic class when building for macOS 14 (EarlyPerfInliner,
    // 2026-11-10). It does nothing; the class's users stop it first.
    @_optimize(none) deinit {}

    var running: Bool { !stopped }

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
        for source in sources.values { source.cancel() }
        sources = [:]
        stamp = nil
    }

    // Something changed (or may have): one read, `after` from now, unless one is already coming.
    func soon(after: TimeInterval? = nil) {
        guard !stopped, pending == nil else { return }
        pending = Timer.scheduledTimer(withTimeInterval: after ?? timing.debounce, repeats: false) { [weak self] _ in
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
        let folder = folder, read = readWith?() ?? reader, files = files
        let known = stamped ? stamp : nil
        queue.async {
            let now = SafariFiles.stamp(folder, files)
            if let known, known == now {
                DispatchQueue.main.async { MainActor.assumeIsolated { self.unchanged() } }
                return
            }
            let outcome = read(folder)
            DispatchQueue.main.async { MainActor.assumeIsolated { self.done(outcome, stamp: now) } }
        }
    }

    private func unchanged() {
        reading = false
        skipped += 1
        guard !stopped else { return }
        if again { again = false; soon() }
    }

    private func done(_ outcome: Outcome, stamp now: String) {
        reading = false
        reads += 1
        guard !stopped else { return }
        watch() // what wasn't there (or readable) before
        let kind = next(outcome)
        stamp = kind == .good ? now : nil
        // A busy database says nothing new: what was read before stands.
        if kind != .busy, outcome != last {
            last = outcome
            Diagnostics.note("\(label): " + describe(outcome))
            onChange?(outcome)
        }
        if kind != .busy { onRead?(outcome) }
        if again { again = false; soon(); return }
        switch kind {
        case .busy: soon(after: timing.busyRetry)
        case .retry: soon(after: timing.retry)
        case .good: break
        }
    }

    func folderChanged(_ paths: [String], rescan: Bool) {
        if rescan || paths.contains(where: matters) { soon() }
    }

    private func watch() {
        startStream()
        for name in files where sources[name] == nil { watchFile(name) }
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
                    if self.sources[name] === source { self.sources[name] = nil }
                }
                self.soon()
            }
        }
        source.setCancelHandler { close(fd) }
        sources[name] = source
        source.resume()
    }

    private func startStream() {
        // FSEvents needs a folder that's there (and, for Safari's, readable).
        guard stream == nil, FileManager.default.fileExists(atPath: folder.path) else { return }
        let target: FolderEvents = self
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(target as AnyObject).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer)
        guard let made = FSEventStreamCreate(nil, safariFolderEvents, &context, [folder.path] as CFArray,
                                             FSEventStreamEventId(kFSEventStreamEventIdSinceNow), timing.latency, flags) else { return }
        FSEventStreamSetDispatchQueue(made, .main)
        guard FSEventStreamStart(made) else { FSEventStreamInvalidate(made); FSEventStreamRelease(made); return }
        stream = made
    }
}

// FSEvents' callback (on the main queue, FSEventStreamSetDispatchQueue).
private nonisolated func safariFolderEvents(_ stream: ConstFSEventStreamRef, _ info: UnsafeMutableRawPointer?, _ count: Int,
                                            _ paths: UnsafeMutableRawPointer, _ flags: UnsafePointer<FSEventStreamEventFlags>,
                                            _ ids: UnsafePointer<FSEventStreamEventId>) {
    guard let info else { return }
    let list = (Unmanaged<CFArray>.fromOpaque(paths).takeUnretainedValue() as NSArray) as? [String] ?? []
    let rescanFlags = FSEventStreamEventFlags(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagRootChanged)
    let rescan = (0..<count).contains { flags[$0] & rescanFlags != 0 }
    let pointer = UInt(bitPattern: info)
    MainActor.assumeIsolated {
        guard let raw = UnsafeMutableRawPointer(bitPattern: pointer) else { return }
        (Unmanaged<AnyObject>.fromOpaque(raw).takeUnretainedValue() as? FolderEvents)?.folderChanged(list, rescan: rescan)
    }
}
