// The Chameleon copies (tools/screen-tests/apps/Chameleon, build.sh): copied into ~/Applications for a run (Margin
// finds apps through LaunchServices), their switches written in their own defaults, their own logs read, and removed
// after with their saved state. Never one of the person's apps.
import AppKit

struct Copy {
  let n: Int
  var id: String { "test.margin.chameleon.\(n)" }
  var name: String { "Margin Chameleon \(n)" }
  var installed: String { home("Applications/\(name).app") }
  var logPath: String { "\(logFolder)/\(id).log" }
  // (Where AppKit kept saved state before macOS 15; now it's in a daemon container under a name of its own, not
  // findable by the app's id: a priming run drops what's there instead, Chameleon's Restorer restoring nothing.)
  var savedState: String { home("Library/Saved Application State/\(id).savedState") }
}
let copyCount = 3
let copies = (1...copyCount).map(Copy.init)
func copy(_ n: Int) -> Copy { copies[n - 1] }
nonisolated(unsafe) var builtApps = ""  // the build folder with the copies (run.sh's)
let logFolder = "/tmp/margin-screen-tests"

func installCopies() {
  try? FileManager.default.createDirectory(atPath: logFolder, withIntermediateDirectories: true)
  for c in copies {
    sh("/usr/bin/ditto", ["\(builtApps)/\(c.name).app", c.installed])
    sh(lsregister, ["-f", c.installed])
    try? FileManager.default.removeItem(atPath: c.logPath)
    sh("/usr/bin/defaults", ["write", c.id, ChameleonSwitches.logKey, c.logPath])
  }
}
func removeCopies() {
  for c in copies where FileManager.default.fileExists(atPath: c.installed) { sh(lsregister, ["-u", c.installed]); try? FileManager.default.removeItem(atPath: c.installed) }
  for c in copies { try? FileManager.default.removeItem(atPath: c.savedState) }
}
// A copy's switches: every Chameleon key of its own defaults cleared, then these written (strings, as the app parses them).
func setSwitches(_ n: Int, _ switches: [String: String]) {
  let c = copy(n)
  for name in ChameleonSwitches.names { sh("/usr/bin/defaults", ["delete", c.id, ChameleonSwitches.key(name)]) }
  // (A priming run's keys gone too: with NSQuitAlwaysKeepsWindows left on, every later quit would save windows to restore.)
  for key in [ChameleonSwitches.primeKey, "NSQuitAlwaysKeepsWindows"] { sh("/usr/bin/defaults", ["delete", c.id, key]) }
  for (name, value) in switches.sorted(by: { $0.key < $1.key }) { sh("/usr/bin/defaults", ["write", c.id, ChameleonSwitches.key(name), "-string", value]) }
  try? FileManager.default.removeItem(atPath: c.savedState)
}
// What a copy said (its own log), and how many times.
func copyLog(_ n: Int) -> String { (try? String(contentsOfFile: copy(n).logPath, encoding: .utf8)) ?? "" }
func copySaid(_ n: Int, _ what: String) -> Int { copyLog(n).components(separatedBy: what).count - 1 }
func copyLines(_ n: Int, _ what: String) -> [String] { copyLog(n).split(separator: "\n").map(String.init).filter { $0.contains(what) } }
// The window numbers a copy says it made of a kind (`auxiliary window 123 pid … frame …`, `extra strip window 124 …`).
func copyWindows(_ n: Int, _ what: String) -> [Int] { copyLines(n, what).filter { $0.contains(" frame ") }.compactMap { match($0, what + #" (\d+)"#).flatMap { Int($0[0]) } } }
// Quit, and gone: its process too (kill(pid, 0)), not only NSWorkspace's word, so the next launch Margin makes is never
// handed the dying instance (behaviours-2, 2026-11-17: Margin hosted the last scenario's quitting copy and failed).
func quitCopy(_ n: Int) {
  guard let p = app(copy(n).id) else { return }
  let pid = p.processIdentifier
  p.terminate(); spin(6) { p.isTerminated && kill(pid, 0) != 0 }
  if kill(pid, 0) == 0 { p.forceTerminate(); spin(3) { kill(pid, 0) != 0 } }
}
// `restore` by the system: a priming run of the copy on its own (its windows as its switch says, those in full screen
// asked in, then a quit that keeps them: NSQuitAlwaysKeepsWindows in its own defaults), so AppKit restores them at the
// launch Margin makes. Its windows show on the real screen (the copy's only).
func prime(_ n: Int) -> String {
  let c = copy(n)
  quitCopy(n)
  sh("/usr/bin/defaults", ["write", c.id, ChameleonSwitches.primeKey, "-bool", "YES"])
  sh("/usr/bin/defaults", ["write", c.id, "NSQuitAlwaysKeepsWindows", "-bool", "YES"])
  let before = copySaid(n, "priming done")
  // (What an earlier scenario left saved is dropped: the priming run restores none of it and makes exactly its switch's
  // windows. Seen 2026-11-17: without that each restore scenario restored the last one's windows too, 2, 3, 6; with
  // -ApplePersistenceIgnoreState YES instead, AppKit saved only the windows that went full screen, never a normal one.)
  sh("/usr/bin/open", ["-g", c.installed])
  let done = spin(30) { copySaid(n, "priming done") > before && app(c.id) == nil }
  if let p = app(c.id) { p.terminate(); spin(6) { p.isTerminated } }
  sh("/usr/bin/defaults", ["delete", c.id, ChameleonSwitches.primeKey])
  // (Its saved state can't be looked for by path any more: the launch Margin makes says what it restored, `restored N`.)
  return "primed \(done ? "and quit, its windows kept" : "NOT done in 30 s")"
}
func triggerExtraWindow(_ n: Int) {
  DistributedNotificationCenter.default().postNotificationName(.init(ChameleonSwitches.extraWindowNotification), object: copy(n).id, userInfo: ["bundle": copy(n).id], deliverImmediately: true)
}
