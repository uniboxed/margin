import Foundation

@main enum SystemEvidenceTests {
    static func main() throws {
        var count = 0
        func check(_ value: Bool) { count += 1; precondition(value, "system evidence check \(count)") }
        func parse(_ json: String) throws -> ValidationSystemEvent? { try ValidationSystemEvent.parse(Data(json.utf8)) }
        check(try parse(#"{"t":100,"ev":"screen locked"}"#)?.ev == "screen locked")
        check(try parse(#"{"t":100,"ev":"app activated"}"#) == nil)
        for bad in [#"{"t":true,"ev":"woke"}"#, #"{"t":-1,"ev":"woke"}"#, #"{"t":"100","ev":"woke"}"#, #"{"ev":"woke"}"#, "broken"] {
            do { _ = try parse(bad); check(false) } catch { check(true) }
        }
        let lock = ValidationSystemEvent(t: 11, ev: "screen locked"), unlock = ValidationSystemEvent(t: 13, ev: "screen unlocked")
        let sleep = ValidationSystemEvent(t: 11, ev: "will sleep"), wake = ValidationSystemEvent(t: 13, ev: "woke")
        let display = ValidationSystemEvent(t: 11, ev: "displays changed")
        check(ValidationSystemEvent.proves([lock, unlock], kind: "lock", shown: 10, ended: 12))
        check(!ValidationSystemEvent.proves([lock], kind: "lock", shown: 10, ended: 12))
        check(!ValidationSystemEvent.proves([lock, unlock], kind: "lock", shown: 12, ended: 14))
        check(!ValidationSystemEvent.proves([lock, unlock], kind: "lock", shown: 9, ended: 10))
        check(ValidationSystemEvent.proves([unlock, lock], kind: "lock", shown: 10, ended: 12)) // timestamps decide, not input order
        check(!ValidationSystemEvent.proves([.init(t: 9, ev: "screen unlocked"), lock], kind: "lock", shown: 10, ended: 12))
        check(ValidationSystemEvent.proves([sleep, wake], kind: "sleep", shown: 10, ended: 12))
        check(!ValidationSystemEvent.proves([.init(t: 11, ev: "screen sleep"), wake], kind: "sleep", shown: 10, ended: 12))
        check(!ValidationSystemEvent.proves([lock, unlock], kind: "sleep", shown: 10, ended: 12))
        check(ValidationSystemEvent.proves([display], kind: "display", shown: 10, ended: 12))
        check(!ValidationSystemEvent.proves([display], kind: "display", shown: .nan, ended: 12))
        check(!ValidationSystemEvent.proves([display, wake], kind: "unknown", shown: 10, ended: 12))
        check(ValidationSystemEvent.proves([.init(t: 12.002, ev: "screen locked"), unlock], kind: "lock", shown: 10, ended: 12))
        check(!ValidationSystemEvent.proves([.init(t: 12.02, ev: "screen locked"), unlock], kind: "lock", shown: 10, ended: 12))
        let started = ValidationSystemEvent(t: 10.1, ev: "switch started safari:b")
        check(try parse(#"{"t":10.1,"ev":"switch started safari:b"}"#) == started)
        check(abs((ValidationSystemEvent.coverEnd([started], target: "safari:b", revealMS: 1000, requested: 10, shown: 10.2, observed: 20) ?? 0) - 11.1) < 0.0001)
        check(ValidationSystemEvent.coverEnd([started, started], target: "safari:b", revealMS: 1000, requested: 10, shown: 10.2, observed: 20) == nil)
        check(ValidationSystemEvent.coverEnd([started], target: "safari:c", revealMS: 1000, requested: 10, shown: 10.2, observed: 20) == nil)
        check(ValidationSystemEvent.coverEnd([started], target: "safari:b", revealMS: 1000, requested: 10.15, shown: 10.2, observed: 20) == nil)
        check(ValidationSystemEvent.coverEnd([started], target: "safari:b", revealMS: -1, requested: 10, shown: 10.2, observed: 20) == nil)
        check(ValidationSystemEvent.coverEnd([started], target: "safari:b", revealMS: 50, requested: 10, shown: 10.2, observed: 20) == nil)
        check(ValidationSystemEvent.coverEnd([started], target: "safari:b", revealMS: 1000, requested: 10, shown: 10.2, observed: 10.8) == nil)
        let earlyLock = ValidationSystemEvent(t: 12.18, ev: "screen locked")
        let lateUnlock = ValidationSystemEvent(t: 14, ev: "screen unlocked")
        let abort = "recovered: the switch was interrupted (aborted)"
        check(ValidationSystemEvent.proofPath([lock, unlock], kind: "lock", shown: 10, ended: 12, authSeen: nil, reason: "interrupted (sleep)") == "direct lock callback")
        check(ValidationSystemEvent.proofPath([earlyLock, lateUnlock], kind: "lock", shown: 10, ended: 12, authSeen: 12.04, reason: abort) == "secure-login activation before public lock callback")
        check(ValidationSystemEvent.proofPath([earlyLock, lateUnlock], kind: "lock", shown: 10, ended: 12, authSeen: nil, reason: abort) == nil)
        check(ValidationSystemEvent.proofPath([earlyLock, lateUnlock], kind: "lock", shown: 10, ended: 12, authSeen: 11, reason: abort) == nil)
        check(ValidationSystemEvent.proofPath([earlyLock, lateUnlock], kind: "lock", shown: 10, ended: 12, authSeen: 12.9, reason: abort) == nil)
        check(ValidationSystemEvent.proofPath([.init(t: 12.9, ev: "screen locked"), lateUnlock], kind: "lock", shown: 10, ended: 12, authSeen: 12.04, reason: abort) == nil)
        check(ValidationSystemEvent.proofPath([earlyLock], kind: "lock", shown: 10, ended: 12, authSeen: 12.04, reason: abort) == nil)
        check(ValidationSystemEvent.proofPath([earlyLock, lateUnlock], kind: "lock", shown: 10, ended: 12, authSeen: 12.04, reason: "unrelated recovery") == nil)
        let screen = ValidationSystemEvent(t: 11.99, ev: "screen sleep")
        let realSleep = ValidationSystemEvent(t: 12.5, ev: "will sleep")
        let realWake = ValidationSystemEvent(t: 15, ev: "woke")
        check(ValidationSystemEvent.proofPath([screen, realSleep, realWake], kind: "sleep", shown: 10, ended: 12, authSeen: nil, reason: "interrupted (sleep)") == "screen-sleep callback before actual system sleep")
        check(ValidationSystemEvent.proofPath([screen, realWake], kind: "sleep", shown: 10, ended: 12, authSeen: nil, reason: "interrupted (sleep)") == nil)
        check(ValidationSystemEvent.proofPath([screen, .init(t: 15, ev: "will sleep"), realWake], kind: "sleep", shown: 10, ended: 12, authSeen: nil, reason: "interrupted (sleep)") == nil)
        check(ValidationSystemEvent.proofPath([screen, realSleep, realWake], kind: "sleep", shown: 10, ended: 12, authSeen: nil, reason: abort) == nil)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-system-evidence-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        do { _ = try ValidationSystemEvent.read(folder, since: 0); check(false) } catch { check(true) }
        let file = folder.appendingPathComponent("trace-1.jsonl")
        let data = #"{"t":10,"snap":[]}"# + "\n" + #"{"t":11,"ev":"screen locked"}"# + "\n" + #"{"t":13,"ev":"screen unlocked"}"#
        try Data(data.utf8).write(to: file)
        let partial = try ValidationSystemEvent.read(folder, since: 10)
        check(partial == [lock])
        try Data((data + "\n").utf8).write(to: file)
        check(try ValidationSystemEvent.read(folder, since: 12) == [unlock])
        let second = folder.appendingPathComponent("trace-2.jsonl")
        try Data((#"{"t":20,"ev":"displays changed"}"# + "\n").utf8).write(to: second)
        check(try ValidationSystemEvent.read(folder, since: 12).map(\.ev) == ["screen unlocked", "displays changed"])
        do { _ = try ValidationSystemEvent.read(folder, since: Date().timeIntervalSince1970); check(false) }
        catch ValidationSystemEvent.EvidenceError.invalid { check(true) }
        let epoch = folder.appendingPathComponent("trace-3.jsonl")
        try Data(("{\"t\":\(Date().timeIntervalSince1970),\"ev\":\"screen locked\"}\n").utf8).write(to: epoch)
        do { _ = try ValidationSystemEvent.read(folder, since: 0); check(false) }
        catch ValidationSystemEvent.EvidenceError.invalid { check(true) }
        try FileManager.default.removeItem(at: epoch)
        try FileManager.default.removeItem(at: second)
        try FileManager.default.createSymbolicLink(at: second, withDestinationURL: file)
        do { _ = try ValidationSystemEvent.read(folder, since: 0); check(false) } catch { check(true) }
        print("all \(count) system evidence checks passed; no app/window/OS action")
    }
}
