// The opt-in part with the person's own apps (`--real-apps`, Tirth's OK of 2026-11-17: "yes you can test any apps you
// want"). On top of every safety rule of the Chameleon parts:
// - only the apps listed here (skipped if not installed);
// - before: each one's state recorded (running or not, its pid, its windows' numbers, bounds and Spaces, its saved
//   window state: its defaults' keys with a window frame, full screen or restoration in their names), and Margin's
//   library items for it (the run adds items for these apps only through Margin's dev hook, and removes after only
//   those of apps that had none before: the hook can't tell one item of an app from another);
// - during: only Margin's dev hook (host, show, switch) and reads. NEVER a click or a key posted into a real app (no
//   message or mail sent, no call, no tab navigated, none of the person's windows or tabs closed): this part posts no
//   event at all;
// - after: every recorded key that changed put back (`defaults write` / `delete`), read back, and any difference that
//   couldn't be put back said; apps that weren't running quit politely (never forced); apps that were left running.
import AppKit

struct RealApp { let name: String; let bundle: String; let framedOnly: Bool } // framedOnly: can't fill the page (a fixed size)
// The list, in the order they're hosted (easy to change: one line each).
let realApps: [RealApp] = [
  RealApp(name: "Maps", bundle: "com.apple.Maps", framedOnly: false),
  RealApp(name: "Phone", bundle: "com.apple.mobilephone", framedOnly: true),
  RealApp(name: "Messages", bundle: "com.apple.MobileSMS", framedOnly: false),
  RealApp(name: "Mail", bundle: "com.apple.mail", framedOnly: false),
  RealApp(name: "WhatsApp", bundle: "net.whatsapp.WhatsApp", framedOnly: false),
  RealApp(name: "Safari", bundle: "com.apple.Safari", framedOnly: false),
  RealApp(name: "Notes", bundle: "com.apple.Notes", framedOnly: false),
  RealApp(name: "Calculator", bundle: "com.apple.calculator", framedOnly: true),
]
func isInstalled(_ bundle: String) -> Bool { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) != nil }
// Safari only while it already runs (the person's session, its own windows left as they are: Margin asks its own
// extension for a new window there). Not running, a launch of it restores the person's windows (and a full-screen one
// into a Space of its own: 2026-11-17 23:28, a web push launched it so): never by a test (Tirth, 2026-11-18).
func installedRealApps() -> [RealApp] { realApps.filter { isInstalled($0.bundle) && ($0.bundle != "com.apple.Safari" || app($0.bundle) != nil) } }

struct RealAppRecord: Codable {
  let name: String
  let bundle: String
  let wasRunning: Bool
  let pid: Int32?
  let policy: Int?
  let windows: [AnyWin]
  let prefs: Data? // the saved-state keys as a binary plist (nil: unreadable)
  let libraryItems: Int
}
// The saved window state among an app's defaults: keys with a window frame, full screen or restoration in their names.
func isStateKey(_ k: String) -> Bool {
  let l = k.lowercased()
  return k.contains("NSWindow Frame") || l.contains("fullscreen") || l.contains("full screen") || l.contains("restor") || k == "NSQuitAlwaysKeepsWindows" || k.contains("NSSplitView Subview Frames")
}
// Its defaults through `defaults export` (cfprefsd: an app's container too), cut off after 15 s.
func exportPrefs(_ bundle: String) -> [String: Any]? {
  let text = sh("/usr/bin/defaults", ["export", bundle, "-"], timeout: 15)
  guard let data = text.data(using: .utf8), let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return nil }
  return plist
}
func stateKeys(_ bundle: String) -> [String: Any]? { exportPrefs(bundle).map { $0.filter { isStateKey($0.key) } } }
// Margin's library items for an app: objects anywhere under Margin's data folder with `target.bundleId` the app's
// (read only; Margin's own folder, never another app's).
func libraryItems(_ bundle: String) -> Int {
  let root = home("Library/Application Support/Margin/data")
  var count = 0
  func walk(_ v: Any) {
    if let d = v as? [String: Any] {
      if (d["target"] as? [String: Any])?["bundleId"] as? String == bundle { count += 1 }
      d.values.forEach(walk)
    } else if let a = v as? [Any] { a.forEach(walk) }
  }
  for case let path as String in FileManager.default.enumerator(atPath: root)?.allObjects ?? [] where path.hasSuffix(".json") {
    if let d = FileManager.default.contents(atPath: root + "/" + path), let j = try? JSONSerialization.jsonObject(with: d) { walk(j) }
  }
  return count
}
func record(_ a: RealApp) -> RealAppRecord {
  let running = app(a.bundle)
  let prefs = stateKeys(a.bundle).flatMap { try? PropertyListSerialization.data(fromPropertyList: $0, format: .binary, options: 0) }
  return RealAppRecord(name: a.name, bundle: a.bundle, wasRunning: running != nil, pid: running?.processIdentifier, policy: running.map { $0.activationPolicy.rawValue },
                       windows: running.map { windowsOf($0.processIdentifier) } ?? [], prefs: prefs, libraryItems: libraryItems(a.bundle))
}
func describe(_ r: RealAppRecord) -> String {
  let keys = r.prefs.flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any] }
  return "\(r.name) (\(r.bundle)): \(r.wasRunning ? "running, pid \(r.pid ?? 0), \(r.windows.filter { $0.layer == 0 }.count) window(s) of layer 0" : "not running"); saved-state keys \(keys.map { "\($0.count)" } ?? "UNREADABLE"); Margin library items \(r.libraryItems)"
}

// A value written back with `defaults write`: its own type flag where there is one, else its XML form.
func defaultsWriteArgs(_ value: Any) -> [String]? {
  switch value {
  case let s as String: return ["-string", s]
  case let n as NSNumber where CFGetTypeID(n) == CFBooleanGetTypeID(): return ["-bool", n.boolValue ? "YES" : "NO"]
  case let n as NSNumber where CFNumberIsFloatType(n): return ["-float", n.stringValue]
  case let n as NSNumber: return ["-int", n.stringValue]
  case let d as Data: return ["-data", d.map { String(format: "%02x", $0) }.joined()]
  default:
    guard let xml = try? PropertyListSerialization.data(fromPropertyList: value, format: .xml, options: 0), let text = String(data: xml, encoding: .utf8),
          let body = match(text, #"(?s)<plist version="1.0">\s*(.*)\s*</plist>"#)?.first else { return nil }
    return [body]
  }
}
// Each recorded key that changed put back; the keys that still differ after (read again), said.
func putBackPrefs(_ r: RealAppRecord) -> [String] {
  guard let data = r.prefs, let before = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return ["\(r.name): its saved state wasn't readable before the run: nothing put back"] }
  guard let now = stateKeys(r.bundle) else { return ["\(r.name): its saved state isn't readable now: nothing put back"] }
  var touched: [String] = []
  for key in Set(before.keys).union(now.keys).sorted() {
    let b = before[key], n = now[key]
    if let b, let n, NSDictionary(dictionary: ["v": b]).isEqual(to: ["v": n]) { continue }
    if let b, let args = defaultsWriteArgs(b) { sh("/usr/bin/defaults", ["write", r.bundle, key] + args) } else if b == nil { sh("/usr/bin/defaults", ["delete", r.bundle, key]) }
    touched.append(key)
  }
  guard !touched.isEmpty else { return [] }
  let after = stateKeys(r.bundle) ?? [:]
  let left = touched.filter { key in
    let b = before[key], a = after[key]
    if b == nil { return a != nil }
    guard let b, let a else { return true }
    return !NSDictionary(dictionary: ["v": b]).isEqual(to: ["v": a])
  }
  log("  \(r.name): \(touched.count) saved-state key(s) put back\(left.isEmpty ? "" : ", \(left.count) still differ")")
  return left.map { "\(r.name): '\($0)' differs from before the run and couldn't be put back" }
}
