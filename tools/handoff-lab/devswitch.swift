// DEV-HOOK: goes before production with app/shell/DevHooks.swift (app/HANDOFF.md §9).
//
// The dev hook's sender: posts one io.tirth.margin.dev.* notification to Margin.app, which honours it
// only while `defaults read io.tirth.margin MarginDevHooks` is YES, and only when the window it shows
// and the target are Safari's "Test A" and "Test B" (it checks; this checks too, and says so first).
// Nothing here touches Safari or reads anything of it. Margin.app's log says what it did:
//   /usr/bin/log stream --style compact --predicate 'subsystem == "io.tirth.margin"' | grep -E 'dev hook|handoff:'
//
//   swift tools/handoff-lab/devswitch.swift switch "Test B" [--space ID] [--wait S]
//   swift tools/handoff-lab/devswitch.swift dump
//   swift tools/handoff-lab/devswitch.swift mode [--freeze on|off] [--old park|close|keep]
//   swift tools/handoff-lab/devswitch.swift fail show|park|reveal|fullscreen
//   swift tools/handoff-lab/devswitch.swift probe tabMove   Test A's one-shot tab-move probe (app/WINDOWS.md)
//   swift tools/handoff-lab/devswitch.swift alternate N [--every S] [--wait S]   Test B, Test A, … N switches
//
// --wait S: post after S seconds (time to click into Safari, so the switch starts with Safari in front,
// as a key press would). --every S: the pause between switches (default 4 s: a handoff and its landing).

import Foundation

let names: Set<String> = ["Test A", "Test B"]
let prefix = "io.tirth.margin.dev."

func fail(_ why: String) -> Never {
    FileHandle.standardError.write(Data("devswitch: \(why)\n".utf8))
    exit(2)
}

func post(_ kind: String, _ fields: [String: String]) {
    var info = fields
    info["pid"] = String(ProcessInfo.processInfo.processIdentifier)
    DistributedNotificationCenter.default().postNotificationName(NSNotification.Name(prefix + kind), object: nil, userInfo: info, deliverImmediately: true)
    let shown = fields.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
    print("posted \(prefix)\(kind)\(shown.isEmpty ? "" : " (\(shown))")")
}

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name) else { return nil }
    guard i + 1 < args.count else { fail("\(name) needs a value") }
    let v = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return v
}
func seconds(_ name: String, _ otherwise: Double) -> Double {
    guard let v = option(name) else { return otherwise }
    guard let s = Double(v), s >= 0, s <= 600 else { fail("\(name) takes seconds") }
    return s
}
let wait = seconds("--wait", 0)
let every = seconds("--every", 4)
let space = option("--space")
let freeze = option("--freeze")
let old = option("--old")
guard let command = args.first else {
    fail("switch \"Test B\" [--space ID] | dump | mode [--freeze on|off] [--old park|close|keep] | fail STEP | alternate N [--every S] (see the file's head)")
}

let on = UserDefaults(suiteName: "io.tirth.margin")?.bool(forKey: "MarginDevHooks") ?? false
if !on { print("note: MarginDevHooks isn't YES: Margin.app will refuse (defaults write io.tirth.margin MarginDevHooks -bool YES)") }
if wait > 0 {
    print("posting in \(wait) s")
    Thread.sleep(forTimeInterval: wait)
}

switch command {
case "switch":
    guard args.count == 2, names.contains(args[1]) else { fail("switch takes \"Test A\" or \"Test B\", exactly") }
    var f = ["to": args[1]]
    if let space { f["space"] = space }
    post("switch", f)
case "dump":
    post("dump", [:])
case "mode":
    var f: [String: String] = [:]
    if let freeze { guard ["on", "off"].contains(freeze) else { fail("--freeze on|off") }; f["freeze"] = freeze }
    if let old { guard ["park", "close", "keep"].contains(old) else { fail("--old park|close|keep") }; f["old"] = old }
    guard !f.isEmpty else { fail("mode needs --freeze or --old") }
    post("mode", f)
case "fail":
    guard args.count == 2, ["show", "park", "reveal", "fullscreen"].contains(args[1]) else { fail("fail show|park|reveal|fullscreen") }
    post("fail", ["step": args[1]])
case "probe":
    guard args.count == 2, args[1] == "tabMove" else { fail("probe tabMove") }
    post("probe", ["what": "tabMove"])
case "alternate":
    guard args.count == 2, let n = Int(args[1]), n > 0, n <= 200 else { fail("alternate takes a count, 1-200") }
    for i in 1...n {
        post("switch", ["to": i % 2 == 1 ? "Test B" : "Test A"])
        if i < n { Thread.sleep(forTimeInterval: every) }
    }
default:
    fail("\(command) isn't a command")
}
// Let the post leave before the process ends.
RunLoop.current.run(until: Date().addingTimeInterval(0.2))
