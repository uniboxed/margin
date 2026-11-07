// The window trace: what the window map saw, what the copies said of their windows, where Margin's overlays were,
// and what Margin heard (a Space change, Safari's Accessibility events, links, switches), one JSON line each, so a
// session of Tirth's can be read back exactly (`WindowTrace.load`, `replay`) and become a test (window module step 1,
// 2026-11-07). DEV: on by default while Margin is in development (MarginWindowTrace NO turns it off); see the memory's
// before-production list.
//
// Only numbers and Margin's own keys: window numbers, pids, Space and display ids, rects, a window's state as its
// copy says it ("fullscreen", "normal"), profile ids. Never a title, an address or a page's content.
//
// Lines: `snap` (the whole map: at the start and every 30 s), `w`/`gone`/`d`/`front` (what changed), `ext` (the
// copies' windows, when they change), `ov` (the overlays, when they change), `ev` (an event, by name). Written on a
// queue of its own; a file is closed at 5 MB and a new one started, and only the newest 5 are kept.

import Foundation

nonisolated struct TraceOverlay: Codable, Equatable, Sendable {
    let k: String // its WindowKey
    let n: Int // its panel's window number
    let over: Int? // the window it's over
    let shown: Bool
    let own: Bool // in its window's own Space (not every Space)
    let f: CGRect
}

nonisolated struct TraceExt: Codable, Equatable, Sendable {
    let k: String
    let state: String
    let b: CGRect?
    let focused: Bool
}

nonisolated struct TraceLine: Codable, Equatable, Sendable {
    var t: Double
    var snap: [MapWindow]?
    var w: [MapWindow]?
    var gone: [Int]?
    var d: [MapDisplay]?
    var front: Int32? // -1: none in front
    var ext: [TraceExt]?
    var ov: [TraceOverlay]?
    var ev: String?
}


final class WindowTrace: @unchecked Sendable {
    static let maxBytes = 5 * 1024 * 1024
    static let keep = 5
    static let snapEvery: Double = 30

    let folder: URL
    private let queue = DispatchQueue(label: "margin.trace", qos: .utility)
    private var handle: FileHandle? // on the queue
    private var written = 0 // on the queue
    // On the main thread: what was written last, to write only what changed.
    private var lastSnapAt: Double = -.infinity
    private var lastExt: [TraceExt] = []
    private var lastOv: [TraceOverlay] = []

    init(folder: URL) { self.folder = folder }

    /// The app's: Application Support/Margin/traces, unless MarginWindowTrace is NO.
    static func forApp() -> WindowTrace? {
        guard UserDefaults.standard.object(forKey: "MarginWindowTrace") as? Bool ?? true else { return nil }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return WindowTrace(folder: support.appendingPathComponent("Margin/traces", isDirectory: true))
    }

    /// One map update: the whole map now and then, else what changed.
    func map(_ s: WindowSnapshot, _ changes: [MapChange]) {
        if s.at - lastSnapAt >= Self.snapEvery {
            lastSnapAt = s.at
            return write(TraceLine(t: s.at, snap: s.windows.values.sorted { $0.number < $1.number }, d: s.displays, front: s.frontPid ?? -1))
        }
        guard !changes.isEmpty else { return }
        var line = TraceLine(t: s.at)
        var changed = Set<Int>(), gone: [Int] = []
        for c in changes {
            switch c {
            case .appeared(let n), .onScreen(let n, _), .bounds(let n, _), .spaces(let n, _), .display(let n, _), .fullScreen(let n, _), .link(let n, _): changed.insert(n)
            case .gone(let n): gone.append(n)
            case .front(let pid): line.front = pid ?? -1
            case .displays(let d): line.d = d
            }
        }
        if !changed.isEmpty { line.w = changed.sorted().compactMap { s.windows[$0] } }
        if !gone.isEmpty { line.gone = gone.sorted() }
        write(line)
    }

    func ext(_ list: [TraceExt], at t: Double) {
        let sorted = list.sorted { $0.k < $1.k }
        guard sorted != lastExt else { return }
        lastExt = sorted
        write(TraceLine(t: t, ext: sorted))
    }

    func overlays(_ list: [TraceOverlay], at t: Double) {
        let sorted = list.sorted { $0.k < $1.k }
        guard sorted != lastOv else { return }
        lastOv = sorted
        write(TraceLine(t: t, ov: sorted))
    }

    func event(_ name: String, at t: Double) { write(TraceLine(t: t, ev: name)) }

    private func write(_ line: TraceLine) {
        guard let data = try? JSONEncoder().encode(line) else { return }
        queue.async { [self] in
            if handle == nil || written >= Self.maxBytes { start() }
            guard let handle else { return }
            handle.write(data)
            handle.write(Data([0x0a]))
            written += data.count + 1
        }
    }

    // On the queue: a new file, the oldest beyond `keep` removed.
    private func start() {
        try? handle?.close()
        handle = nil
        written = 0
        let fm = FileManager.default
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss-SSS"
        let url = folder.appendingPathComponent("trace-\(f.string(from: Date())).jsonl")
        guard fm.createFile(atPath: url.path, contents: nil), let h = try? FileHandle(forWritingTo: url) else { return }
        handle = h
        let old = ((try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("trace-") && $0.pathExtension == "jsonl" }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
        for u in old.dropFirst(Self.keep) { try? fm.removeItem(at: u) }
    }

    /// Everything written so far is on disk (tests; quitting).
    func flush() { queue.sync { try? handle?.synchronize() } }

    // ---- reading one back ----

    static func load(_ url: URL) -> [TraceLine] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        let decoder = JSONDecoder()
        return text.split(separator: "\n").compactMap { try? decoder.decode(TraceLine.self, from: Data($0.utf8)) }
    }

    /// The map as it was after each line that changed it, rebuilt from a trace (from its first `snap` on).
    static func replay(_ lines: [TraceLine]) -> [WindowSnapshot] {
        var out: [WindowSnapshot] = []
        var s: WindowSnapshot?
        for line in lines {
            if let snap = line.snap {
                s = WindowSnapshot(at: line.t, windows: Dictionary(snap.map { ($0.number, $0) }, uniquingKeysWith: { a, _ in a }),
                                   displays: line.d ?? [], frontPid: line.front.flatMap { $0 < 0 ? nil : $0 })
                out.append(s!)
                continue
            }
            guard var cur = s, line.w != nil || line.gone != nil || line.d != nil || line.front != nil else { continue }
            cur.at = line.t
            for w in line.w ?? [] { cur.windows[w.number] = w }
            for n in line.gone ?? [] { cur.windows[n] = nil }
            if let d = line.d { cur.displays = d }
            if let f = line.front { cur.frontPid = f < 0 ? nil : f }
            s = cur
            out.append(cur)
        }
        return out
    }
}
