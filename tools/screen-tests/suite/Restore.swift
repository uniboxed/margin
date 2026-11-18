// What the Mac was like before a part, written to a file first (so `--restore` can put it back from another process
// if this one was killed), and the restore that puts it all back: on every exit, signal, watchdog or gate stop.
import AppKit

struct Before: Codable {
  var part = ""
  var marginPath: String?        // Margin's bundle if it was running (opened again, in the background, after)
  var builtMargin = ""           // the Margin.app this run opens
  var marginDefaults: [String: String] = [:]
  var themeSettings: Data?       // MarginWindowThemeSettings as a binary plist (nil: none)
  var home: UInt64 = 0           // the Space the run started on
  var display: String?
  var pointer: [Double]?
  var mcCount = 0
  var safariPid: Int32?
  var copyDomains: [String: Data] = [:] // a copy's own defaults, if it had any (exported)
  var realApps: [RealAppRecord] = []
  var startedAt = Date().timeIntervalSince1970
}
nonisolated(unsafe) var before = Before()
nonisolated(unsafe) var statePath = ""
nonisolated(unsafe) var handoffPath = ""
func saveState() {
  guard let d = try? JSONEncoder().encode(before) else { return }
  FileManager.default.createFile(atPath: statePath, contents: d)
}
func loadState() -> Before? { FileManager.default.contents(atPath: statePath).flatMap { try? JSONDecoder().decode(Before.self, from: $0) } }

func recordBefore(part: String, built: String, realApps apps: [RealApp]) {
  var b = Before()
  b.part = part
  b.builtMargin = built
  b.marginPath = personsMargin()?.bundleURL?.path
  for k in marginKeys { b.marginDefaults[k] = defaultsRead(marginId, k) }
  if let v = CFPreferencesCopyAppValue(themeKey as CFString, marginId as CFString) { b.themeSettings = try? PropertyListSerialization.data(fromPropertyList: v, format: .binary, options: 0) }
  b.home = active(cid)
  b.display = dispIdent(cid)?.takeRetainedValue() as String?
  b.pointer = CGEvent(source: nil).map { [Double($0.location.x), Double($0.location.y)] }
  b.mcCount = mc().count
  b.safariPid = app("com.apple.Safari")?.processIdentifier
  for c in copies {
    let text = sh("/usr/bin/defaults", ["export", c.id, "-"])
    if let d = text.data(using: .utf8), let p = try? PropertyListSerialization.propertyList(from: d, format: nil) as? [String: Any], !p.isEmpty { b.copyDomains[c.id] = d }
  }
  b.realApps = apps.map(record)
  before = b
  saveState()
}

let restoreLock = NSLock()
nonisolated(unsafe) var restored = false
// The Space the run started on made current again, read back and asked again (three times at most).
func backHome(_ why: String) {
  guard let disp = before.display else { return }
  for _ in 0..<3 {
    if active(cid) == before.home { break }
    setCurrent(cid, disp as CFString, before.home)
    spin(1.2) { active(cid) == before.home }
  }
  log("  the Space the run started on (\(before.home)) \(active(cid) == before.home ? "is current again" : "could NOT be made current again (now \(active(cid)))") (\(why))")
}
// Items this run added for the person's apps: removed only for apps that had none before.
func forgettable() -> [String] { before.realApps.filter { $0.libraryItems == 0 }.map(\.bundle) }
func forgetTestItems() {
  // (One app per notification: the hook takes values of 64 characters at most.)
  for id in copies.map(\.id) + forgettable() { hook(["forget": "test", "apps": id]); spin(0.4) }
  spin(1.0)
}

func restore(_ why: String) {
  restoreLock.lock(); let first = !restored; restored = true; restoreLock.unlock()
  guard first else { return }
  log("RESTORE (\(why))")
  if app(marginId) != nil { forgetTestItems() }
  else if !forgettable().isEmpty, defaultsRead(marginId, "MarginDevHooks") == "1", FileManager.default.fileExists(atPath: before.builtMargin) {
    // (The real-apps part quits Margin as a step: opened again in the background only to remove the items it added.)
    sh("/usr/bin/open", ["-g", before.builtMargin, "--args", "--background"])
    if spin(10, { app(marginId) != nil }) { spin(4); forgetTestItems() }
  }
  if !allMargins().isEmpty { quitAllMargins(); log("  Margin quit: \(allMargins().isEmpty) (every instance)") }
  spin(3)
  for c in copies { if let p = app(c.id), axFullScreen(p.processIdentifier) == true { _ = setAXFullScreen(p.processIdentifier, false); spin(4) { axFullScreen(p.processIdentifier) != true } } }
  releaseModifiers()
  for c in copies { if let p = app(c.id) { log("  \(c.id) still running: quitting it"); p.terminate(); spin(5) { p.isTerminated }; if !p.isTerminated { p.forceTerminate() } } }
  removeCopies()
  for c in copies {
    sh("/usr/bin/defaults", ["delete", c.id])
    if let d = before.copyDomains[c.id] { sh("/usr/bin/defaults", ["import", c.id, "-"], input: d) }
  }
  // The person's apps: those this run started quit politely (never forced); the others left as they are.
  var notBack: [String] = []
  for r in before.realApps where !r.wasRunning {
    if let p = app(r.bundle) {
      p.terminate()
      if !spin(15, { p.isTerminated }) { notBack.append("\(r.name) wasn't running before and didn't quit when asked (left running)") }
    }
  }
  for r in before.realApps { notBack += putBackPrefs(r) }
  for k in marginKeys { defaultsPut(marginId, k, before.marginDefaults[k] ?? "") }
  let theme = before.themeSettings.flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) } as CFPropertyList?
  CFPreferencesSetAppValue(themeKey as CFString, theme, marginId as CFString)
  CFPreferencesAppSynchronize(marginId as CFString)
  if let was = before.marginPath { sh("/usr/bin/open", ["-g", was, "--args", "--background"]); spin(3) { app(marginId) != nil } }
  backHome("after Margin")
  if let p = before.pointer, p.count == 2 { CGWarpMouseCursorPosition(CGPoint(x: p[0], y: p[1])) }
  let held = modsHeld()
  let after = mc()
  log("  defaults now: " + marginKeys.map { "\($0) '\(defaultsRead(marginId, $0).prefix(20))'" }.joined(separator: " "))
  log("  test copies: removed \(copies.allSatisfy { !FileManager.default.fileExists(atPath: $0.installed) }), running \(copies.contains { app($0.id) != nil }); modifiers held \(held.isEmpty ? "none" : "0x\(String(held.rawValue, radix: 16)) (NOT let go)")")
  let safariNow = app("com.apple.Safari")?.processIdentifier
  if before.realApps.isEmpty { log("  Safari \(safariNow == before.safariPid ? "as it was" : "CHANGED (before \(before.safariPid.map(String.init) ?? "not running"), now \(safariNow.map(String.init) ?? "not running"))")") }
  log("  Margin \(app(marginId) == nil ? "not running" : "running")\(before.marginPath == nil ? " (it wasn't before)" : " (opened again in the background)"); Space \(active(cid)) (was \(before.home)); Mission Control \(after.count) Spaces (before \(before.mcCount)); ownerless full-screen Spaces: \(after.filter { $0.contains("/t4") && $0.hasSuffix("/pid-") })")
  for r in before.realApps { let now = app(r.bundle); log("  \(r.name): \(r.wasRunning ? "was running" : "wasn't running"), now \(now == nil ? "not running" : "running (pid \(now!.processIdentifier)\(r.pid == now!.processIdentifier ? ", the same" : ", ANOTHER"))")") }
  for line in notBack { log("  NOT PUT BACK: \(line)") }
  for r in before.realApps where r.libraryItems > 0 { if libraryItems(r.bundle) > r.libraryItems { log("  NOT PUT BACK: \(r.name) has \(libraryItems(r.bundle) - r.libraryItems) more item(s) in Margin's library than before (it had its own: remove the new one by hand)") } }
  // Margin's own lines of the run (numbers and ids only).
  for l in marginLog().filter({ $0.contains("host:") || $0.contains("Margin's window") || $0.contains("hosted:") || $0.contains("dev hook") }).suffix(150) {
    print("   margin: " + String(l.dropFirst(24)).replacingOccurrences(of: #"Df Margin\[[0-9]+:[0-9a-f]+\] \[com.unibox.margin:shell\] "#, with: "", options: .regularExpression).prefix(260))
  }
  summary()
  saveHandoff(handoffPath)
  try? FileManager.default.removeItem(atPath: statePath)
}

func summary() {
  let byScenario = Dictionary(grouping: results, by: \.scenario)
  log("SUMMARY of part \(before.part):")
  var order: [String] = []
  for r in results where !order.contains(r.scenario) { order.append(r.scenario) }
  for s in order {
    let rs = byScenario[s] ?? []
    log("  \(s): \(rs.filter { $0.ok == true }.count) passed, \(rs.filter { $0.ok == false }.count) failed, \(rs.filter { $0.ok == nil }.count) skipped")
    for r in rs { log("    \(r.ok == true ? "PASS" : r.ok == false ? "FAIL" : "SKIP") \(r.name)") }
  }
  let failed = results.filter { $0.ok == false }
  log("SUMMARY: \(results.filter { $0.ok == true }.count) passed, \(failed.count) failed, \(results.filter { $0.ok == nil }.count) skipped\(failed.isEmpty ? "" : ": FAILED " + failed.map { "\($0.scenario)/\($0.name.prefix(40))" }.joined(separator: "; "))")
}

// The run never hangs and is never left half done: no word from it for 5 minutes, or 10 minutes in all, and it puts
// everything back and exits (12); stopped from outside (SIGTERM, SIGINT, SIGHUP), the same (13).
let hardLimit = 600.0
nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []
func startWatchdog() {
  Thread {
    while true {
      sleep(5)
      progress.lock(); let quiet = Date().timeIntervalSince(lastSaid); progress.unlock()
      let total = Date().timeIntervalSince(t0)
      if quiet > 300 || total > hardLimit - 45 {
        print(String(format: "%6.2f ", total) + "WATCHDOG: \(quiet > 300 ? "no progress for \(Int(quiet)) s" : "\(Int(total)) s in all (the limit is \(Int(hardLimit)) s)"): putting everything back")
        restore("the watchdog")
        exit(12)
      }
    }
  }.start()
  for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
    src.setEventHandler { print("SIGNAL \(sig): putting everything back"); restore("stopped from outside (signal \(sig))"); exit(13) }
    src.resume()
    signalSources.append(src)
  }
}
