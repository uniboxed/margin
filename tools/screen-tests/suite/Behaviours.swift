// The behaviour scenarios' verbs and the design's desired state (docs/HOSTING-CORE.md, principle 3) read from the
// window server: what `Step`s other than check10's do.
import AppKit

extension Runner {
  func run(_ s: Step) {
    log("— \(s.text)")
    switch s {
    case .openMargin: openMargin()
    case .firstHost(let n): firstHost(n)
    case .activateAbove(let n): activateAbove(n)
    case .clicks(let n): clicks(n)
    case .palette(let n): palette(n)
    case .secondHost(let n): secondHost(n)
    case .switchBack(let n): switchBack(n)
    case .sidebarDrags(let n, let o): sidebarDrags(n, o)
    case .frontMechanism: frontMechanism()
    case .spaceSwipes(let h, let o, let t): spaceSwipes(hosted: h, own: o, times: t)
    case .freshHost(let n): freshHost(n)
    case .busyWithExtras(let n): busyWithExtras(n)
    case .relaunch(let n): relaunch(n)
    case .setSwitches(let n, let sw):
      if copyApp(n) != nil { log("  Chameleon \(n) is running: quit first (switches are read at launch)"); quitCopy(n) }
      setSwitches(n, sw)
      try? FileManager.default.removeItem(atPath: copy(n).logPath) // (its log from here: what it says is this scenario's)
    case .prime(let n):
      gate("priming Chameleon \(n)")
      let what = prime(n)
      // (Back to Margin's Space: its windows opened on a Desktop and in Spaces of their own.)
      m.activate()
      if !spin(4, { active(cid) == marginSpace }), let disp = before.display { setCurrent(cid, disp as CFString, marginSpace); spin(1.5) }
      step("prime Chameleon \(n) (restore by AppKit): its windows saved for the next launch", what.contains("and quit") && what.contains("kept") && active(cid) == marginSpace,
           "\(what); its log: \(copyLines(n, "priming done").last.map { String($0.suffix(120)) } ?? "nothing"); the current Space \(active(cid)) (Margin's \(marginSpace))")
    case .host(let t): host(t)
    case .show(let t, let ms): show(t, maxMs: ms)
    case .trigger(let n): gate("Chameleon \(n)'s extra window"); triggerExtraWindow(n)
    case .wait(let secs, _):
      var left = secs
      while left > 0 { gate("waiting"); let chunk = min(5, left); spin(chunk); left -= chunk; log("  (waited, \(Int(left)) s left)") }
    case .expect(let e): expect(e)
    case .hold(let e, let secs):
      if case .desired(let d) = e { holdDesired(d, seconds: secs) } else { expect(e) }
    case .forget(let t):
      gate("forgetting \(t.text)")
      hook(["forget": "test", "apps": t.id])
      spin(3) { app(t.id) == nil }
      if case .copy(let n) = t, copyApp(n) != nil { log("  \(t.text) still running after its item was removed: quitting it"); quitCopy(n) }
      log("  \(t.text)'s item removed; running \(app(t.id) != nil)")
    case .quitMargin:
      gate("quitting Margin")
      if let m { m.terminate(); spin(25) { m.isTerminated }; log("  Margin quit: \(m.isTerminated)") }
    }
  }

  // The host ids Margin logs a target's lines under: `app:<bundle>`; a browser hosted as its own window, Safari's
  // `safari:<profile>` (real-apps, 2026-11-17: Safari's lines were `safari:p646`, never `app:com.apple.Safari`).
  func hostIds(_ t: Target) -> [String] { t.id == "com.apple.Safari" ? ["app:\(t.id)", "safari:"] : ["app:\(t.id)"] }
  func lines(_ mark: LogMark, _ ids: [String], _ what: String) -> [String] { ids.flatMap { id in mark.since("host: \(id)").filter { $0.contains(what) } } }
  // Hosts through the dev hook, waits for Margin's word that it's shown (full screen or window mode). A failure line
  // ends the wait only when no shown line follows within 3 s (a fallback says it's shown right after its failure line:
  // "full screen failed … backed out, shown in window mode", 2026-11-17).
  func host(_ t: Target) {
    gate("hosting \(t.text)")
    let mark = LogMark()
    let ids = hostIds(t)
    hook(["app": t.id])
    var shown: String?, failed: String?, failedAt: Date?
    spin(30) {
      shown = lines(mark, ids, " shown in").first
      if failed == nil, let f = lines(mark, ids, "").first(where: { $0.contains("failed") || $0.contains("couldn't") }) { failed = f; failedAt = Date() }
      return shown != nil || (failedAt.map { Date().timeIntervalSince($0) > 3 } ?? false)
    }
    spin(1.0)
    shown = shown ?? lines(mark, ids, " shown in").first
    step("host \(t.text): Margin says it's shown", shown != nil, shown.map { String($0.suffix(160)) } ?? "no shown line in 30 s; Margin said: \(lines(mark, ids, "").suffix(4).map { String($0.suffix(150)) })")
    if let failed { log("  Margin said: \(failed.suffix(200))") }
  }
  // A switch to an item already prepared: Margin's "switched in N ms" (a window-mode one's too).
  func show(_ t: Target, maxMs: Int?) {
    gate("showing \(t.text)")
    let mark = LogMark()
    let ids = hostIds(t)
    hook(["app": t.id])
    var line: String?
    spin(10) { line = lines(mark, ids, " switched in").first ?? lines(mark, ids, " shown in").first; return line != nil }
    spin(0.5)
    let ms = match(line, #"(?:switched|shown) in (\d+) ms"#).flatMap { Int($0[0]) }
    let switched = line?.contains("switched in") == true
    if let maxMs { step("show \(t.text) again: a switch in \(maxMs) ms or less", switched && (ms ?? 9999) <= maxMs, line.map { String($0.suffix(160)) } ?? "no switch line in 10 s") }
    else { log("  \(line.map { String($0.suffix(160)) } ?? "no switch line in 10 s")") }
  }

  func expect(_ e: Expect) {
    switch e {
    case .desired(let d):
      guard let (page, _) = pageNow() else { return step("desired: \(d.target.text)", false, "no page area from Margin") }
      let s = evaluate(d, page: page)
      step("desired: \(d.text)", s.ok, s.why)
      if !s.ok, let a = app(d.target.id) { log("   DIAG \(diag(a.processIdentifier, marginWindow?.n))") }
      if !s.ok, case .copy(let n) = d.target { copyTail(n) }
    case .running(let t, let on):
      let a = app(t.id)
      let alive = a.map { kill($0.processIdentifier, 0) == 0 } ?? false
      step("\(t.text) \(on ? "still running" : "not running")", (a != nil && alive) == on, a.map { "pid \($0.processIdentifier), policy \($0.activationPolicy.rawValue)" } ?? "NSWorkspace lists none")
    case .said(let n, let w):
      spin(3) { copySaid(n, w) > 0 }
      step("Chameleon \(n) says \"\(w)\"", copySaid(n, w) > 0, copyLines(n, w).last.map { String($0.suffix(200)) } ?? "never")
    case .givenBack(let ids):
      spin(20) { ids.allSatisfy { id in before.realApps.first { $0.bundle == id }?.wasRunning == true || app(id) == nil } }
      let user = userSpaces()
      for id in ids {
        guard let r = before.realApps.first(where: { $0.bundle == id }) else { continue }
        let a = app(id)
        if !r.wasRunning { step("given back: \(r.name) (Margin started it) quit with Margin", a == nil, a.map { "still running, pid \($0.processIdentifier), policy \($0.activationPolicy.rawValue)" } ?? "quit") }
        else {
          let normal = a.map { windowsOf($0.processIdentifier).filter { $0.layer == 0 && $0.r.width >= 200 && $0.r.height >= 150 && !$0.spaces.filter(user.contains).isEmpty } } ?? []
          step("given back: \(r.name) (the person's, running before) still running with a normal window and a Dock icon", a != nil && a!.activationPolicy == .regular && !normal.isEmpty,
               a.map { "pid \($0.processIdentifier)\(r.pid == $0.processIdentifier ? " (the same)" : " (ANOTHER)"), policy \($0.activationPolicy.rawValue), windows in a user Space: \(normal.map { "#\($0.n) \(rect($0.r)) \($0.spaces)" })" } ?? "NOT running")
        }
      }
    }
  }

  // Margin's page area and its front line now.
  func pageNow() -> (CGRect, String?)? { let f = front(); return rectIn(f, "page area").map { ($0, f) } }
  func isStrip(_ r: CGRect) -> Bool { r.height <= 120 && r.width >= 0.8 * marginWindow.r.width }
  // The desired state, once: (ok, what's wrong or what's there, a signature of the state for the hold's stability).
  func evaluate(_ d: Desired, page: CGRect) -> (ok: Bool, why: String, sig: String) {
    guard let a = app(d.target.id) else { return (false, "\(d.target.text) isn't running", "gone") }
    let pid = a.processIdentifier
    let list = onScreen()
    let all = windowsOf(pid)
    let user = userSpaces()
    let mainKind = all.filter { $0.layer == 0 && $0.r.width >= 200 && $0.r.height >= 200 && !isStrip($0.r) }
    let preexisting = Set(before.realApps.first { $0.bundle == d.target.id }?.windows.map(\.n) ?? [])
    var auxiliary: Set<Int> = []
    if d.auxiliary {
      // (A copy's auxiliary window, and an extra window it opened on demand: the person's, kept beside the main one.)
      if case .copy(let n) = d.target { auxiliary = Set(copyWindows(n, "auxiliary window") + copyLines(n, "extra window ").compactMap { match($0, #"extra window (\d+) opened"#).flatMap { Int($0[0]) } }) }
      else { auxiliary = Set(mainKind.filter { $0.r.width * $0.r.height < 0.3 * page.width * page.height }.map(\.n)) }
    }
    let mains = mainKind.filter { w in !auxiliary.contains(w.n) && w.on && w.spaces == [marginSpace] && (d.framed ? page.insetBy(dx: -2, dy: -2).contains(w.r) : near(w.r, page)) }
    var problems: [String] = []
    if mains.count != 1 { problems.append("\(mains.count) main windows \(d.framed ? "inside" : "at") the page area \(rect(page)) in Margin's Space") }
    let main = mains.first
    let panelIndex = (panelN.flatMap { p in list.firstIndex { $0.n == p } }) ?? (big(m.processIdentifier).flatMap { b in list.firstIndex { $0.n == b.n } })
    if let main, let pi = panelIndex, let wi = list.firstIndex(where: { $0.n == main.n }), wi < pi { problems.append("its window #\(main.n) in front of Margin's panel") }
    if panelIndex == nil { problems.append("Margin's panel not on screen") }
    let leftovers = mainKind.filter { w in w.n != main?.n && !preexisting.contains(w.n) && !auxiliary.contains(w.n) && !w.spaces.filter(user.contains).isEmpty }
    if !leftovers.isEmpty { problems.append("leftover(s) in user Spaces: \(leftovers.map { "#\($0.n) \(rect($0.r)) \($0.on ? "on screen " : "")in \($0.spaces)" })") }
    let strips = all.filter { $0.on && $0.alpha > 0 && $0.layer == 0 && isStrip($0.r) }
    if !strips.isEmpty { problems.append("strip(s) on screen: \(strips.map { "#\($0.n) \(rect($0.r))" })") }
    let sidebar = CGRect(x: marginWindow.r.minX, y: page.minY, width: max(0, page.minX - marginWindow.r.minX), height: page.height)
    if let pi = panelIndex {
      let covering = list.enumerated().filter { i, w in w.pid == pid && i < pi && w.alpha > 0 && w.r.intersection(sidebar).width > 8 && w.r.intersection(sidebar).height > 8 }.map(\.element)
      if !covering.isEmpty { problems.append("over the sidebar in front of Margin's panel: \(covering.map { "#\($0.n) \(rect($0.r)) layer \($0.layer)" })") }
    }
    let there = "main \(main.map { "#\($0.n) \(rect($0.r)) in \($0.spaces)" } ?? "none"); \(all.filter { $0.layer == 0 }.count) window(s) of layer 0, \(auxiliary.count) auxiliary"
    let sig = "\(main.map { rect($0.r) } ?? "none") \(main?.spaces ?? []) leftovers \(leftovers.count) strips \(strips.count)"
    return (problems.isEmpty, problems.isEmpty ? there : problems.joined(separator: "; ") + " (\(there))", sig)
  }
  // The desired state read every 0.5 s for `seconds`: every read in it, and the same state all along (no flicker, no
  // jump between Spaces, nothing vanishing).
  func holdDesired(_ d: Desired, seconds: Double) {
    guard var (page, f) = pageNow() else { return step("holds \(Int(seconds)) s: \(d.text)", false, "no page area from Margin") }
    let pageState = word(f, "page") ?? "?"
    var reads = 0, good = 0, changes = 0
    var firstMiss: String?, lastSig: String?
    let start = Date()
    var nextGate = Date()
    while Date().timeIntervalSince(start) < seconds {
      if Date() >= nextGate { gate("holding \(d.target.text)"); nextGate = Date().addingTimeInterval(10) }
      // (The moment right after the app's own change that the design leaves to it: a read within `settles` of the
      // copy's last such line isn't counted, its state neither.)
      if let (what, within) = d.settles, case .copy(let n) = d.target, let at = copyLines(n, what).last.flatMap({ match($0, #"CHAMELEON (\d+\.\d+)"#) }).flatMap({ Double($0[0]) }),
         Date().timeIntervalSince1970 - at < within { spin(0.5); continue }
      let s = evaluate(d, page: page)
      reads += 1
      if s.ok { good += 1 } else if firstMiss == nil { firstMiss = String(format: "at %.1f s: ", Date().timeIntervalSince(start)) + s.why }
      if let l = lastSig, l != s.sig { changes += 1 }
      lastSig = s.sig
      spin(0.5)
      if reads % 20 == 0 { log("  (\(good) of \(reads) reads in the desired state)") }
    }
    let end = pageNow()
    if let e = end { page = e.0; f = e.1 }
    let pageAfter = word(f, "page") ?? "?"
    step("holds \(Int(seconds)) s: \(d.text)", good == reads && changes == 0 && pageAfter == pageState,
         "\(good) of \(reads) reads in it, \(changes) change(s) of state; the page card \(pageState) → \(pageAfter)\(firstMiss.map { "; first miss \($0)" } ?? "")")
    if good != reads, let a = app(d.target.id) { log("   DIAG \(diag(a.processIdentifier, marginWindow?.n))") }
    if good != reads, case .copy(let n) = d.target { copyTail(n) }
  }
  // A copy's own log's last lines, after a miss: what it did (its windows' events), for the triage.
  func copyTail(_ n: Int) {
    for line in copyLog(n).split(separator: "\n").suffix(14) { log("   CHAMELEON \(n): \(line.suffix(200))") }
  }
}
