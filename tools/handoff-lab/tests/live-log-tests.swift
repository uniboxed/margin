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
        let plan = profileValidationPlan()
        precondition(plan.count == 50 && plan.prefix(4).allSatisfy { $0.phase == "warmup" })
        let matched = plan.filter { $0.phase == "matched" }
        precondition(matched.count == 24 && matched.filter { $0.mode == "live" }.count == 12)
        precondition(plan.filter { $0.phase == "repeated" }.count == 18)
        precondition(plan.prefix(46).allSatisfy { $0.fault == nil && $0.old == "park" })
        for i in stride(from: 0, to: matched.count, by: 4) {
            precondition(matched[i..<(i + 4)].map(\.mode) == ["freeze", "live", "live", "freeze"])
        }
        precondition(plan.suffix(4).map(\.phase) == ["fault", "close", "close", "fault"])
        precondition(plan[46].fault == "fullscreen" && plan[46].recovers && plan[49].fault == "park")
        precondition(plan[47].old == "close" && plan[48].old == "close")
        precondition(validationTestProfile("dev hook: dump: test profile: Test B\n") == "Test B"
                     && validationTestProfile("dev hook: dump: test profile: Work\n") == nil)
        let clean = "live cover audit: state idle, windows 0, views 0, spaces 0, presentation 0, timers 0, cleanup failures 0; created 4, disposed 4, last window 120"
        precondition(validationAuditIsClean(clean) && !validationAuditIsClean(clean.replacingOccurrences(of: "presentation 0", with: "presentation 1")))
        precondition(!validationAuditIsClean(clean.replacingOccurrences(of: "cleanup failures 0", with: "cleanup failures 1")))
        precondition(!validationAuditIsClean(clean.replacingOccurrences(of: "disposed 4", with: "disposed 3")))
        precondition(validationAuditIsClean("handoff: older created 999 ms\n" + clean))
        precondition(validationNumber(clean, after: "last window ") == 120 && validationNumber("last window unknown", after: "last window ") == nil)
        precondition(validationForegroundAllowed(10, browser: 10, app: 20) && validationForegroundAllowed(20, browser: 10, app: 20))
        precondition(!validationForegroundAllowed(nil, browser: nil, app: 20) && !validationForegroundAllowed(30, browser: 10, app: 20))
        print("all 35 live-log/validation-plan checks passed (no windows or private calls)")
    }
}
