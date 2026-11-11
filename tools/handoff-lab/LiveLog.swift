// Read-only parsing shared by the live gate and its off-screen regression.
import Foundation

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
