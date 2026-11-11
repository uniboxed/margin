// Bounded read-only proof from Margin's existing metadata-only OS-event trace.
import Foundation

struct ValidationSystemEvent: Decodable, Equatable {
    let t: Double
    let ev: String
    static let names: Set<String> = ["screen locked", "screen unlocked", "screen sleep", "will sleep", "woke", "displays changed"]

    static func parse(_ data: Data) throws -> Self? {
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.t.isFinite, value.t > 0 else { throw EvidenceError.invalid }
        return names.contains(value.ev) || value.ev.hasPrefix("switch started safari:") ? value : nil
    }
    enum EvidenceError: Error { case invalid, unavailable, oversized }

    static func read(_ folder: URL, since: Double) throws -> [Self] {
        // WindowTrace uses Diagnostics.now(): native boot uptime, NOT Unix time.
        let now = ProcessInfo.processInfo.systemUptime
        guard since.isFinite, since >= 0, since <= now + 1 else { throw EvidenceError.invalid }
        let files = try FileManager.default.contentsOfDirectory(at: folder,
            includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            .filter { $0.lastPathComponent.hasPrefix("trace-") && $0.pathExtension == "jsonl" }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }.prefix(5)
        guard !files.isEmpty else { throw EvidenceError.unavailable }
        var events: [Self] = []
        for file in files {
            let info = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard info.isRegularFile == true, info.isSymbolicLink != true else { throw EvidenceError.invalid }
            // Production rotates at 5 MiB before its next row, so allow a bounded final row.
            guard let size = info.fileSize, size <= 6 * 1024 * 1024 else { throw EvidenceError.oversized }
            let bytes = try Data(contentsOf: file, options: .mappedIfSafe)
            guard bytes.count <= 6 * 1024 * 1024 else { throw EvidenceError.oversized }
            // A concurrent last write may not have its newline yet; never treat it as evidence.
            let complete = bytes.last == 10 ? bytes : bytes.prefix(upTo: bytes.lastIndex(of: 10) ?? bytes.startIndex)
            for line in complete.split(separator: 10) where line.contains(34) {
                guard String(decoding: line, as: UTF8.self).contains("\"ev\"") else { continue }
                if let event = try parse(Data(line)) {
                    guard event.t <= now + 1 else { throw EvidenceError.invalid }
                    if event.t >= since { events.append(event) }
                }
            }
        }
        return events.sorted { $0.t < $1.t }
    }

    static func proves(_ events: [Self], kind: String, shown: Double, ended: Double) -> Bool {
        let entry = kind == "lock" ? "screen locked" : kind == "sleep" ? "will sleep" : "displays changed"
        guard ["lock", "sleep", "display"].contains(kind), shown.isFinite, ended.isFinite, ended >= shown,
              let first = events.first(where: { $0.ev == entry && $0.t >= shown && $0.t <= ended + 0.005 }) else { return false }
        if kind == "display" { return true }
        let exit = kind == "lock" ? "screen unlocked" : "woke"
        return events.contains { $0.ev == exit && $0.t >= first.t }
    }

    // A summary is emitted after recovery. Its receipt time is not cover-hide
    // time. Derive that bound from the unique matching native trace start and
    // the summary's request-to-reveal duration, all in the same boot clock.
    static func coverEnd(_ events: [Self], target: String, revealMS: Int, requested: Double, shown: Double, observed: Double) -> Double? {
        guard revealMS >= 0, target.hasPrefix("safari:"), requested.isFinite, shown.isFinite, observed.isFinite else { return nil }
        let starts = events.filter { $0.ev == "switch started \(target)" && $0.t >= requested && $0.t <= shown }
        guard starts.count == 1 else { return nil }
        let end = starts[0].t + Double(revealMS) / 1000
        return end >= shown && end <= observed + 0.005 ? end : nil
    }

    static func proofPath(_ events: [Self], kind: String, shown: Double, ended: Double, authSeen: Double?, reason: String) -> String? {
        if proves(events, kind: kind, shown: shown, ended: ended), reason.contains(kind == "display" ? "displays changed" : "sleep") {
            return "direct \(kind) callback"
        }
        // macOS may activate its secure login UI before posting screenIsLocked.
        // Accept this separately labelled early protection only with an
        // independent observation of that exact system app, tight time bounds,
        // a real subsequent lock/unlock and final unchanged browser/source proof.
        if kind == "lock", reason.contains("interrupted (aborted)"), let authSeen,
           authSeen >= max(shown, ended - 0.1), authSeen <= ended + 0.5,
           let locked = events.first(where: { $0.ev == "screen locked" && $0.t >= ended - 0.005 && $0.t <= ended + 0.5 }),
           authSeen <= locked.t + 0.1, events.contains(where: { $0.ev == "screen unlocked" && $0.t >= locked.t }) {
            return "secure-login activation before public lock callback"
        }
        // Screen sleep can end the cover before the later will-sleep callback.
        // It alone is insufficient: require actual will-sleep and wake too.
        if kind == "sleep", reason.contains("sleep"),
           let screen = events.first(where: { $0.ev == "screen sleep" && $0.t >= shown && $0.t <= ended + 0.005 }),
           let sleep = events.first(where: { $0.ev == "will sleep" && $0.t >= screen.t && $0.t <= ended + 2 }),
           events.contains(where: { $0.ev == "woke" && $0.t >= sleep.t }) {
            return "screen-sleep callback before actual system sleep"
        }
        return nil
    }
}
