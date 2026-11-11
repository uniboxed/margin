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
        try FileManager.default.removeItem(at: second)
        try FileManager.default.createSymbolicLink(at: second, withDestinationURL: file)
        do { _ = try ValidationSystemEvent.read(folder, since: 0); check(false) } catch { check(true) }
        print("all \(count) system evidence checks passed; no app/window/OS action")
    }
}
