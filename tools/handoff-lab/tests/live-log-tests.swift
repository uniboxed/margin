import Foundation

@main enum LiveLogTests {
    static func main() {
        let actual = "Margin: handoff: safari:A#120 → safari:B#699 (park, new window): A parked 867; focus ok; dev hook: cap"
        let cases: [(String, Bool)] = [
            (actual, true),
            ("Margin: dev hook: dump:   " + actual, false),
            ("handoff: safari:A#1 → safari:B#2; focus ok", true),
            ("handoff: safari:A#1 → safari:B#2; recovered: no window", true),
            ("dev hook: switch to Test B", false),
            ("handoff: source preparing", false),
        ]
        for (line, wanted) in cases { precondition(liveSwitchSummary(line) == wanted) }
        precondition(liveShownNumber("switch: idle; shown safari:A#120 (10864); 0 handoffs") == 10864)
        for missing in ["shown -; 0 handoffs", "shown safari:A#1 (0);", "shown safari:A#1 (-1);"] {
            precondition(liveShownNumber(missing) == nil)
        }
        precondition(liveCompareTargets(returnToA: false, reverse: false) == ["Test B", "Test A"])
        precondition(liveCompareTargets(returnToA: false, reverse: true) == ["Test A", "Test B"])
        precondition(liveCompareTargets(returnToA: true, reverse: false) == ["Test A"])
        precondition(liveCompareTargets(returnToA: true, reverse: true) == ["Test A"])
        print("all 14 live-log/plan checks passed (no windows or private calls)")
    }
}
