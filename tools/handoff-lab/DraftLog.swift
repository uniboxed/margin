// Metadata-only replies from the guarded shown-window drafts observation.
import Foundation

struct DraftObservation: Equatable {
    let nonce: UUID
    let window: Int
    let native: Int
    let browser: Int
    let caller: Int
    let tabs: [Int]
    let drafts: [Int]
    let unknown: [Int]

    var clear: Bool { drafts.isEmpty && unknown.isEmpty }
    func sameSource(as other: Self) -> Bool {
        window == other.window && native == other.native && browser == other.browser && caller == other.caller && tabs == other.tabs
    }
    static func parse(_ line: String) -> Self? {
        guard !line.contains("dev hook: dump:"),
              let regex = try? NSRegularExpression(pattern: #"dev hook: drafts observed: nonce ([A-Fa-f0-9-]{36}), window ([0-9]+), native ([0-9]+), pid ([0-9]+), caller ([0-9]+), elapsed [0-9]+ ms, tabs \[([0-9, ]*)\], drafts ([0-9]+) \[([0-9, ]*)\], unknown ([0-9]+) \[([0-9, ]*)\]$"#),
              let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { return nil }
        func text(_ n: Int) -> String? { Range(match.range(at: n), in: line).map { String(line[$0]) } }
        func positive(_ n: Int) -> Int? { text(n).flatMap(Int.init).flatMap { $0 > 0 ? $0 : nil } }
        func ids(_ n: Int) -> [Int]? {
            guard let raw = text(n) else { return nil }
            if raw.isEmpty { return [] }
            let parts = raw.components(separatedBy: ", ")
            let values = parts.compactMap(Int.init)
            guard values.count == parts.count, values.allSatisfy({ $0 > 0 }), values == Array(Set(values)).sorted() else { return nil }
            return values
        }
        guard let nonce = text(1).flatMap(UUID.init(uuidString:)), let window = positive(2), let native = positive(3),
              let browser = positive(4), let caller = positive(5), let tabs = ids(6), !tabs.isEmpty,
              let drafts = ids(8), let unknown = ids(10), text(7).flatMap(Int.init) == drafts.count,
              text(9).flatMap(Int.init) == unknown.count,
              Set(drafts + unknown).isSubset(of: Set(tabs)) else { return nil }
        return Self(nonce: nonce, window: window, native: native, browser: browser, caller: caller, tabs: tabs, drafts: drafts, unknown: unknown)
    }
}
