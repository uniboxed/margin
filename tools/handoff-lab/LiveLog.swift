// Read-only parsing shared by the live gate and its off-screen regression.
import Foundation

func liveCompareTargets(returnToA: Bool, reverse: Bool) -> [String] {
    if returnToA { return ["Test A"] } // a remaining single request always stays single
    return reverse ? ["Test A", "Test B"] : ["Test B", "Test A"]
}

func liveSwitchSummary(_ line: String) -> Bool {
    // A real summary may end with `dev hook: cap`. Exclude only the dump's
    // replay of old summaries, never that legitimate suffix.
    line.contains("handoff:") && line.contains("→") && !line.contains("dev hook: dump:")
}

func liveShownNumber(_ text: String) -> Int? {
    guard let regex = try? NSRegularExpression(pattern: #"shown [^\n]+\(([0-9]+)\);"#),
          let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let range = Range(match.range(at: 1), in: text),
          let number = Int(text[range]), number > 0 else { return nil }
    return number
}

let matchedValidationProtocol = "matched-v2-degraded-freeze"

enum MatchedTransition: String { case onTime = "on_time", degradedFreeze = "degraded_freeze" }

func liveSummaryNumber(_ text: String, pattern: String) -> Int? {
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let range = Range(match.range(at: 1), in: text) else { return nil }
    return Int(text[range])
}

// This classifies only a candidate summary. Native destination, source, cleanup,
// topology and capability checks must still succeed before it counts as a control.
func matchedTransition(_ summary: String, mode: String) -> MatchedTransition? {
    guard liveSwitchSummary(summary), !summary.contains("\n"),
          !["aborted", "recovered", "refused", "A kept", "window left over"].contains(where: summary.contains),
          summary.contains("; focus ok;") || summary.hasSuffix("; focus ok"),
          liveSummaryNumber(summary, pattern: #"request to reveal ([0-9]+) ms"#) != nil,
          liveSummaryNumber(summary, pattern: #"settled ([0-9]+)(?:,|;)"#) != nil else { return nil }
    if mode == "live" {
        guard summary.contains("live cover "), summary.contains("(no freeze)"),
              !summary.contains("frozen "), !summary.contains("late ("),
              liveSummaryNumber(summary, pattern: #"\((?:park|close), (?:parked target|new window)\), live cover ([0-9]+) ms \(no freeze\), request to reveal [0-9]+ ms:"#) != nil else { return nil }
        return .onTime
    }
    guard mode == "freeze", summary.contains("(park+freeze, "), !summary.contains("live cover "),
          summary.contains("dev hook: cover off"),
          liveSummaryNumber(summary, pattern: #"\(park\+freeze, (?:parked target|new window)\), frozen ([0-9]+) ms \(result 0\), request to reveal [0-9]+ ms:"#) != nil else { return nil }
    if !summary.contains("late (") { return .onTime }
    guard summary.components(separatedBy: "; late (").count == 2,
          let regex = try? NSRegularExpression(pattern: #"; late \(watchdog at [0-9]+ ms, waiting for A not started\); dev hook: cover off$"#),
          regex.firstMatch(in: summary, range: NSRange(summary.startIndex..., in: summary)) != nil else { return nil }
    return .degradedFreeze
}
