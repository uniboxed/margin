// Margin: its own log (numbers and ids only), its dev hook (DevHooks.swift: `com.unibox.margin.dev.host`, honoured only
// while MarginDevHooks is YES), its defaults, and bringing it to the front as checks 1-9 did.
import AppKit

let marginId = "com.unibox.margin"
// Every running Margin (the person's installed one, a build Safari's extension started for a link, the one under test:
// all one bundle id, 2026-11-18: `app(marginId)` took the wrong one, and a step meant for the one hosting went to another).
func allMargins() -> [NSRunningApplication] { NSRunningApplication.runningApplications(withBundleIdentifier: marginId).filter { !$0.isTerminated } }
func quitAllMargins() { for a in allMargins() { a.terminate() }; spin(20) { allMargins().isEmpty } }
// The person's own Margin among them (~/Applications), else the first.
func personsMargin() -> NSRunningApplication? { let all = allMargins(); return all.first { $0.bundleURL?.path == home("Applications/Margin.app") } ?? all.first }
nonisolated(unsafe) var logStart = Date()
func marginLog(from start: Date? = nil) -> [String] {
  let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"
  return sh("/usr/bin/log", ["show", "--start", f.string(from: (start ?? logStart).addingTimeInterval(-1)), "--style", "compact", "--predicate", "process == \"Margin\" AND subsystem == \"com.unibox.margin\""])
    .split(separator: "\n").filter { !$0.hasPrefix("Timestamp") }.map { String($0).replacingOccurrences(of: #"s-[0-9a-f]{8}-[0-9a-f-]{27}"#, with: "s-…", options: .regularExpression) }
}
func said(_ what: String) -> [String] { marginLog().filter { $0.contains(what) } }
// A line's own time (compact style: "2026-11-17 18:00:45.179 Df Margin[…]"); nil: not a log line.
let stampFormat: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"; return f }()
func stamp(_ line: String) -> Date? { line.count >= 23 ? stampFormat.date(from: String(line.prefix(23))) : nil }
// One mark in Margin's log: what it said since (a step's own lines), by the lines' own times. (Was by a count of the
// lines before it: 2026-11-17's Safari step read none of Margin's lines after its mark, "Margin said: []", though its
// failure line was there; a count is undone by any read that comes back short.)
struct LogMark {
  let at: Date
  init(at: Date = Date()) { self.at = at }
  func since(_ what: String) -> [String] { lines().filter { $0.contains(what) } }
  // Every line of Margin's since the mark (one read of its log: a step that looks for several things reads it once).
  func lines() -> [String] { marginLog(from: at).filter { line in stamp(line).map { $0 >= at.addingTimeInterval(-0.05) } ?? false } }
}

func hook(_ info: [String: String]) { var i = info; i["pid"] = "\(getpid())"; DistributedNotificationCenter.default().postNotificationName(.init("com.unibox.margin.dev.host"), object: nil, userInfo: i, deliverImmediately: true) }
// A hook that answers with one log line: that line (nil: none within 8 s).
func ask(_ info: [String: String], answer: String, within: Double = 8) -> String? {
  let mark = LogMark()
  hook(info)
  var line: String?
  spin(within) { line = mark.since(answer).last; return line != nil }
  return line
}
// Margin's two windows as its dev hook says them: `window`, the full-screen base that owns its Space; `panel`, its UI.
nonisolated(unsafe) var baseN: Int?
nonisolated(unsafe) var panelN: Int?
func front() -> String? {
  let line = ask(["say": "front"], answer: "dev hook: front:")
  if let w = match(line, #"window (\d+),"#).flatMap({ Int($0[0]) }) { baseN = w }
  if let p = match(line, #"panel (\d+) \("#).flatMap({ Int($0[0]) }) { panelN = p }
  return line
}
func panelWords(_ line: String?) -> (level: String, server: String, key: Bool, child: Bool)? {
  match(line, #"panel \d+ \(level (\d+), server ([0-9?]+), key (true|false), child (true|false)\)"#).map { ($0[0], $0[1], $0[2] == "true", $0[3] == "true") }
}
func field() -> String? { ask(["say": "field"], answer: "dev hook: field:") }
func fieldLength(_ line: String?) -> Int? { match(line, #"focused (true|false), length (-?\d+)"#).flatMap { $0[0] == "true" ? Int($0[1]) : nil } }
func spot() -> CGPoint? { match(ask(["say": "spot"], answer: "dev hook: spot:"), #"at (-?\d+),(-?\d+)"#).flatMap { m in Double(m[0]).flatMap { x in Double(m[1]).map { CGPoint(x: x, y: $0) } } } }
func picture() -> String? { ask(["say": "picture"], answer: "dev hook: picture:") }
func rectIn(_ line: String?, _ name: String) -> CGRect? {
  guard let m = match(line, name + #" (-?\d+),(-?\d+) (\d+)x(\d+)"#), let x = Double(m[0]), let y = Double(m[1]), let w = Double(m[2]), let h = Double(m[3]) else { return nil }
  return CGRect(x: x, y: y, width: w, height: h)
}
func word(_ line: String?, _ name: String) -> String? { match(line, name + #" ([A-Za-z0-9?]+)"#)?.first }
func painted(_ line: String?) -> Int? { match(line, #"page area painted (\d+) of 81"#).flatMap { Int($0[0]) } }
// Margin's panel above an app's largest window in the window server's order (nil: one of them isn't on screen).
func above(_ margin: pid_t, _ pid: pid_t) -> (ok: Bool, text: String)? {
  let list = onScreen()
  let ui = panelN.flatMap { n in list.first { $0.n == n && $0.pid == margin } } ?? big(margin)
  guard let m = ui, let p = big(pid), let mi = list.firstIndex(where: { $0.n == m.n }), let pi = list.firstIndex(where: { $0.n == p.n }) else { return nil }
  let bi = baseN.flatMap { n in list.firstIndex { $0.n == n } }
  return (mi < pi, "Margin's panel \(m.n) at \(mi) (layer \(m.layer)), its full-screen window \(baseN.map(String.init) ?? "?") at \(bi.map(String.init) ?? "not on screen")\(bi.map { " (layer \(list[$0].layer))" } ?? ""), the app's \(p.n) at \(pi) (layer \(p.layer)) of \(list.count) on screen")
}
func marginThenApp(_ stack: [Win], _ margin: pid_t, _ pid: pid_t) -> Bool {
  guard stack.first?.pid == margin else { return false }
  return stack.first { $0.pid != margin }?.pid == pid
}
// Margin brought to the front as checks 1-9 did, when it didn't come by itself. What it took, for the log.
func bringMarginFront(_ m: NSRunningApplication, _ built: String) -> String {
  func isFront() -> Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == m.processIdentifier }
  if spin(4, isFront) { return "by itself" }
  sh("/usr/bin/open", [built])
  if spin(3, isFront) { return "after `open` named it again" }
  sh("/usr/bin/osascript", ["-e", "tell application \"System Events\" to set frontmost of process \"Margin\" to true"])
  if spin(3, isFront) { return "after System Events set it frontmost" }
  return "NOT in front"
}

// ---- defaults (Margin's and the test apps' own) ----
func defaultsRead(_ domain: String, _ key: String) -> String { sh("/usr/bin/defaults", ["read", domain, key]).trimmingCharacters(in: .whitespacesAndNewlines) }
func defaultsPut(_ domain: String, _ key: String, _ was: String) {
  if was == "1" || was == "0" { sh("/usr/bin/defaults", ["write", domain, key, "-bool", was == "1" ? "YES" : "NO"]) }
  else if was.contains("does not exist") || was.isEmpty { sh("/usr/bin/defaults", ["delete", domain, key]) }
  else { sh("/usr/bin/defaults", ["write", domain, key, was]) }
}
// The Margin defaults a run writes (each recorded first and put back as it was).
let marginKeys = ["MarginDevHooks", "MarginPrepareBrowser", "MarginResumeLast", "MarginFront"]
// The theme's saved sidebar width (the sidebar drags change it).
let themeKey = "MarginWindowThemeSettings"
