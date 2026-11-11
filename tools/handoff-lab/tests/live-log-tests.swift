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
        let proof = """
        {"app_pid":7,"event":"validation_begin","index":0}
        {"app_pid":7,"event":"request","index":1,"phase":"warmup","mode":"freeze","old":"park"}
        {"app_pid":7,"event":"settled","index":1,"ok":false,"status":"fail","error":"unexpected failed/recovered transition: park+freeze; Safari’s window didn’t go full screen; dev hook: cover off"}
        """
        func accepts(_ text: String) -> Bool { validationFailedFirstWarmupPID(Data(text.utf8)) != nil }
        precondition(validationFailedFirstWarmupPID(Data(proof.utf8)) == 7)
        precondition(!accepts(proof + "\n{}"))
        precondition(!accepts(proof.replacingOccurrences(of: "\"mode\":\"freeze\"", with: "\"mode\":\"live\"")))
        precondition(!accepts(proof.replacingOccurrences(of: "\"ok\":false", with: "\"ok\":true")))
        precondition(!accepts(proof.replacingOccurrences(of: "\"index\":1", with: "\"index\":2")))
        precondition(!accepts(proof.replacingOccurrences(of: "\"old\":\"park\"", with: "\"old\":\"park\",\"fault\":\"fullscreen\"")))
        precondition(!accepts(proof.replacingOccurrences(of: "\"app_pid\":7,\"event\":\"settled\"", with: "\"app_pid\":8,\"event\":\"settled\"")))
        let livePlan = profileLiveReliabilityPlan()
        precondition(livePlan.count == 36 && livePlan.prefix(2).allSatisfy { $0.phase == "warmup" } && livePlan.filter { $0.phase == "repeated" }.count == 30)
        precondition(livePlan.allSatisfy { $0.mode == "live" } && Array(livePlan.suffix(4)) == Array(plan.suffix(4)))
        let watchRows: [[String: Any]] = [
            ["event": "validation_begin", "prior_failed_warmups": 1],
            ["event": "request", "index": 2, "phase": "warmup", "mode": "live", "old": "park"],
            ["event": "settled", "index": 2, "ok": true, "status": "pass", "summary": "live cover 1000 ms (no freeze)"],
            ["event": "request", "index": 3, "phase": "warmup", "mode": "live", "old": "park"],
            ["event": "settled", "index": 3, "ok": true, "status": "pass", "summary": "live cover 1000 ms (no freeze)"],
            ["event": "request", "index": 4, "phase": "warmup", "mode": "freeze", "old": "park"],
            ["event": "settled", "index": 4, "ok": false, "status": "fail", "error": "park+freeze; frozen 1700 ms (result 0); focus ok; late (watchdog, waiting for A not started); dev hook: cover off"],
        ].map { $0.merging(["app_pid": 7]) { _, new in new } }
        func watchPID(_ rows: [[String: Any]]) -> Int? {
            let lines = rows.map { String(data: try! JSONSerialization.data(withJSONObject: $0), encoding: .utf8)! }
            return validationFreezeWatchdogPID(Data(lines.joined(separator: "\n").utf8))
        }
        precondition(watchPID(watchRows) == 7)
        precondition(watchPID(watchRows + [["event": "request", "app_pid": 7]]) == nil)
        var bad = watchRows; bad[2]["ok"] = false
        precondition(watchPID(bad) == nil)
        bad = watchRows; bad[5]["index"] = 5
        precondition(watchPID(bad) == nil)
        bad = watchRows; bad[6]["error"] = (bad[6]["error"] as! String).replacingOccurrences(of: "result 0", with: "result 1")
        precondition(watchPID(bad) == nil)
        bad = watchRows; bad[6]["error"] = (bad[6]["error"] as! String) + "; recovered: failure"
        precondition(watchPID(bad) == nil)
        bad = watchRows; bad[1]["mode"] = "freeze"
        precondition(watchPID(bad) == nil)
        bad = watchRows; bad[0]["prior_failed_warmups"] = 2
        precondition(watchPID(bad) == nil)
        print("all 52 live-log/validation-plan checks passed (no windows or private calls)")
    }
}
