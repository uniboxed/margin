// Bounded read-only proof from Margin's existing metadata-only OS-event trace.
import Foundation

struct ValidationSystemEvent: Decodable, Equatable {
    let t: Double
    let ev: String
    static let names: Set<String> = ["screen locked", "screen unlocked", "will sleep", "woke", "displays changed"]

    static func parse(_ data: Data) throws -> Self? {
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.t.isFinite, value.t > 0 else { throw EvidenceError.invalid }
        return names.contains(value.ev) ? value : nil
    }
    enum EvidenceError: Error { case invalid, unavailable, oversized }

    static func read(_ folder: URL, since: Double) throws -> [Self] {
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
                    guard event.t <= Date().timeIntervalSince1970 + 1 else { throw EvidenceError.invalid }
                    if event.t >= since { events.append(event) }
                }
            }
        }
        return events.sorted { $0.t < $1.t }
    }

    static func proves(_ events: [Self], kind: String, shown: Double, ended: Double) -> Bool {
        let entry = kind == "lock" ? "screen locked" : kind == "sleep" ? "will sleep" : "displays changed"
        guard ["lock", "sleep", "display"].contains(kind), shown.isFinite, ended.isFinite, ended >= shown,
              let first = events.first(where: { $0.ev == entry && $0.t >= shown && $0.t <= ended }) else { return false }
        if kind == "display" { return true }
        let exit = kind == "lock" ? "screen unlocked" : "woke"
        return events.contains { $0.ev == exit && $0.t >= first.t }
    }
}
