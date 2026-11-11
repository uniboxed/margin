import Foundation

struct ProfileValidationStep: Equatable {
    let phase: String
    let mode: String
    var old = "park"
    var fault: String? = nil
    var recovers = false
}

func validationExpectedFullscreenRecovery(_ step: ProfileValidationStep) -> Bool {
    step.phase == "fault" && step.mode == "live" && step.fault == "fullscreen" && step.recovers
}

func validationForegroundAllowed(_ front: Int32?, browser: Int32?, app: Int32) -> Bool {
    guard let front, let browser else { return false }
    return front == browser || front == app
}

func profileValidationPlan() -> [ProfileValidationStep] {
    let balanced = ["freeze", "live", "live", "freeze"]
    var steps = balanced.map { ProfileValidationStep(phase: "warmup", mode: $0) }
    for _ in 0..<6 { steps += balanced.map { ProfileValidationStep(phase: "matched", mode: $0) } }
    steps += (0..<18).map { _ in ProfileValidationStep(phase: "repeated", mode: "live") }
    steps += [ProfileValidationStep(phase: "fault", mode: "live", fault: "fullscreen", recovers: true),
              ProfileValidationStep(phase: "close", mode: "live", old: "close"),
              ProfileValidationStep(phase: "close", mode: "live", old: "close"),
              ProfileValidationStep(phase: "fault", mode: "live", fault: "park")]
    return steps
}

// Only the diagnosed first freeze warmup can be consumed from a prior run.
// A later/live failure can never use this to reset a genuine session demotion.
func validationFailedFirstWarmupPID(_ data: Data) -> Int? {
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    let rows = text.split(separator: "\n").compactMap {
        (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
    }
    guard text.split(separator: "\n").count == 3, rows.count == 3,
          rows[0]["event"] as? String == "validation_begin",
          rows[1]["event"] as? String == "request", rows[1]["index"] as? Int == 1,
          rows[1]["phase"] as? String == "warmup", rows[1]["mode"] as? String == "freeze",
          rows[1]["old"] as? String == "park", rows[1]["fault"] == nil,
          rows[2]["event"] as? String == "settled", rows[2]["index"] as? Int == 1,
          rows[2]["ok"] as? Bool == false, rows[2]["status"] as? String == "fail",
          let error = rows[2]["error"] as? String,
          error.contains("park+freeze"), error.contains("Safari’s window didn’t go full screen"),
          error.contains("dev hook: cover off"), !error.contains("live cover"),
          let pid = rows[0]["app_pid"] as? Int, pid > 0,
          rows[1]["app_pid"] as? Int == pid, rows[2]["app_pid"] as? Int == pid else { return nil }
    return pid
}

func profileLiveReliabilityPlan() -> [ProfileValidationStep] {
    (0..<2).map { _ in ProfileValidationStep(phase: "warmup", mode: "live") }
        + (0..<30).map { _ in ProfileValidationStep(phase: "repeated", mode: "live") }
        + profileValidationPlan().suffix(4)
}

// The failed matched run stays failed. This permits a separate live-only
// observation within its unconsumed request allowance, never a matched grade.
func validationFreezeWatchdogPID(_ data: Data) -> Int? {
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    let raw = text.split(separator: "\n")
    let rows = raw.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
    guard raw.count == 7, rows.count == 7, rows[0]["event"] as? String == "validation_begin",
          rows[0]["prior_failed_warmups"] as? Int == 1,
          let pid = rows[0]["app_pid"] as? Int, pid > 0,
          rows.allSatisfy({ $0["app_pid"] as? Int == pid }) else { return nil }
    for (position, index) in [(1, 2), (3, 3), (5, 4)] {
        let request = rows[position], settled = rows[position + 1]
        guard request["event"] as? String == "request", request["index"] as? Int == index,
              request["phase"] as? String == "warmup", request["old"] as? String == "park", request["fault"] == nil,
              request["mode"] as? String == (index == 4 ? "freeze" : "live"),
              settled["event"] as? String == "settled", settled["index"] as? Int == index else { return nil }
        if index < 4 {
            guard settled["ok"] as? Bool == true, settled["status"] as? String == "pass",
                  let summary = settled["summary"] as? String,
                  summary.contains("live cover "), summary.contains("no freeze"), !summary.contains("recovered:") else { return nil }
        } else {
            guard settled["ok"] as? Bool == false, settled["status"] as? String == "fail",
                  let error = settled["error"] as? String,
                  error.contains("park+freeze"), error.contains("(result 0)"), error.contains("focus ok"),
                  error.contains("late (watchdog"), error.contains("waiting for A not started"),
                  error.contains("dev hook: cover off"), !error.contains("; recovered:"), !error.contains("aborted") else { return nil }
        }
    }
    return pid
}

func validationTestProfile(_ dump: String) -> String? {
    for name in ["Test A", "Test B"] where dump.contains("dev hook: dump: test profile: \(name)\n") { return name }
    return nil
}

func validationAuditIsClean(_ dump: String) -> Bool {
    guard let row = dump.split(separator: "\n").first(where: { $0.contains("live cover audit:") }) else { return false }
    let audit = String(row)
    guard audit.contains("live cover audit: state idle, windows 0, views 0, spaces 0, presentation 0, timers 0, cleanup failures 0;"),
          let made = validationNumber(audit, after: "created "), let disposed = validationNumber(audit, after: "disposed ") else { return false }
    return made == disposed
}

func validationNumber(_ text: String, after label: String) -> Int? {
    guard let start = text.range(of: label)?.upperBound else { return nil }
    let digits = text[start...].prefix(while: { $0.isNumber })
    return Int(digits)
}
