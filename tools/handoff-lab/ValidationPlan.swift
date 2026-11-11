import Foundation

struct ProfileValidationStep: Equatable {
    let phase: String
    let mode: String
    var old = "park"
    var fault: String? = nil
    var recovers = false
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
