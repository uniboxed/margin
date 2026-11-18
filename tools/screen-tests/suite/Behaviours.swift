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
  func lines(_ mark: LogMark, _ ids: [String], _ what: String) -> [String] { mine(mark.lines(), ids).filter { $0.contains(what) } }
  func mine(_ all: [String], _ ids: [String]) -> [String] { all.filter { l in ids.contains { l.contains("host: \($0)") } } }
  // How long Margin's word is waited for: a first open of Safari is a cold launch, its copies' links and a profile's
  // wake (4–35 s on 2026-11-17, the link slowed by another Margin build's extension handler): Margin's own verdict
  // (shown, or failed) is waited for, and this is only a bound for a Margin that says nothing.
  func within(_ t: Target) -> Double { t.id == "com.apple.Safari" ? 90 : 30 } // (90: the real-apps part stays under its 10-minute limit with both Safari steps at their bound)
  // Hosts through the dev hook, waits for Margin's word that it's shown (full screen or window mode). A failure line
  // ends the wait only when no shown line follows within 3 s (a fallback says it's shown right after its failure line:
  // "full screen failed … backed out, shown in window mode", 2026-11-17). Margin's log read once a look.
  func host(_ t: Target) {
    gate("hosting \(t.text)")
    let mark = LogMark()
    let ids = hostIds(t)
    let safari = t.id == "com.apple.Safari"
    if safari { environment() }
    hook(["app": t.id])
    var shown: String?, failed: String?, failedAt: Date?, seen: [String] = []
    let bound = within(t)
    spin(bound) {
      seen = mark.lines()
      let said = mine(seen, ids)
      shown = said.first { $0.contains(" shown in") }
      if failed == nil, let f = said.first(where: { $0.contains("failed") || $0.contains("couldn't") }) { failed = f; failedAt = Date() }
      return shown != nil || (failedAt.map { Date().timeIntervalSince($0) > 3 } ?? false)
    }
    spin(1.0)
    seen = mark.lines()
    shown = shown ?? mine(seen, ids).first { $0.contains(" shown in") }
    // (Margin's other words about it too: a Safari's are its link's and the session's, `hosted:`, not only `host:`.)
    let about = seen.filter { l in mine([l], ids).count == 1 || (safari && (l.contains("hosted: ") || l.contains("] hello: safari:") || l.contains("link down (safari:"))) }
    let story = safari ? safariStory(seen, from: mark.at) : nil
    step("host \(t.text): Margin says it's shown", shown != nil,
         (shown.map { String($0.suffix(160)) } ?? "no shown line in \(Int(bound)) s; Margin said: \(about.suffix(5).map { String($0.suffix(150)) })") + (story.map { "; \($0.text)" } ?? ""))
    if let failed { log("  Margin said: \(failed.suffix(200))") }
    if safari { refusals(since: mark.at) }
  }
  // A switch to an item already prepared: Margin's "switched in N ms" (a window-mode one's too). One whose first open
  // failed is a first open now (Safari's, 2026-11-17 20:47: 21 s), waited for as long as a host, and said so.
  func show(_ t: Target, maxMs: Int?) {
    gate("showing \(t.text)")
    let mark = LogMark()
    let ids = hostIds(t)
    let safari = t.id == "com.apple.Safari"
    hook(["app": t.id])
    var line: String?, opening = false
    let bound = safari ? within(t) : 10
    spin(bound) {
      let said = mine(mark.lines(), ids)
      line = said.first { $0.contains(" switched in") } ?? said.first { $0.contains(" shown in") }
      if !opening, said.contains(where: { $0.contains(" opened (pid") }) { opening = true }
      return line != nil || (said.contains { $0.contains("failed") } && line == nil && !opening)
    }
    spin(0.5)
    let ms = match(line, #"(?:switched|shown) in (\d+) ms"#).flatMap { Int($0[0]) }
    let switched = line?.contains("switched in") == true
    let what = line.map { String($0.suffix(160)) + (switched ? "" : opening ? " (a first open: its first one had failed)" : "") } ?? "no switch line in \(Int(bound)) s"
    if let maxMs { step("show \(t.text) again: a switch in \(maxMs) ms or less", switched && (ms ?? 9999) <= maxMs, what) }
    else { log("  \(what)") }
    if safari, !switched { refusals(since: mark.at) }
  }
  // The test environment, said before a Safari step: other Margin builds whose extension Safari also has (the person's
  // installed Margin beside the build under test). The definitive Safari check is a run against the installed build.
  func environment() {
    let others = otherBuilds(sh("/usr/bin/pluginkit", ["-mDAvvv", "-i", "com.unibox.margin.Extension"], timeout: 15), built: built)
    guard !others.isEmpty else { return log("  environment: only the build under test has Margin's extension registered") }
    log("  ENVIRONMENT: another Margin build's extension is registered with Safari too (\(others.joined(separator: ", "))): Safari runs one build's extension handler at a time and refuses the other's native messages meanwhile (\"Other version in use\"), so a profile's copy may link late; the definitive Safari check is against the installed build")
  }
  // Safari's own log: native messages it refused since `at` (another build's handler in use).
  func refusals(since at: Date) {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let out = sh("/usr/bin/log", ["show", "--start", f.string(from: at.addingTimeInterval(-1)), "--style", "compact", "--predicate", "process == \"Safari\" AND eventMessage CONTAINS[c] \"sendNativeMessage(). Other version in use\""], timeout: 30)
    let n = out.split(separator: "\n").filter { $0.contains("Other version in use") }.count
    if n > 0 { log("  Safari refused Margin's native messages \(n) time(s) in this step (\"Other version in use\": another Margin build's extension handler): the environment, not Margin") }
  }

  func expect(_ e: Expect) {
    switch e {
    case .desired(let d):
      guard var (page, f) = pageNow() else { return step("desired: \(d.target.text)", false, "no page area from Margin") }
      // (Margin still correcting, its page card loading: not a verdict yet; read again once it's done, 10 s at most.)
      var waited = 0.0
      while correcting(word(f, "page")), waited < 10 {
        spin(0.5); waited += 0.5
        guard let again = pageNow() else { break }
        (page, f) = again
      }
      let s = evaluate(d, page: page)
      step("desired: \(d.text)", s.ok, s.why + (waited > 0 ? " (read after Margin's correction under way, \(waited) s)" : ""))
      if !s.ok, let a = app(d.target.id) { log("   DIAG \(diag(a.processIdentifier, marginWindow?.n))") }
      if !s.ok, case .copy(let n) = d.target { copyTail(n) }
    case .running(let t, let on):
      let a = app(t.id)
      let alive = a.map { kill($0.processIdentifier, 0) == 0 } ?? false
      step("\(t.text) \(on ? "still running" : "not running")", (a != nil && alive) == on, a.map { "pid \($0.processIdentifier), policy \($0.activationPolicy.rawValue)" } ?? "NSWorkspace lists none")
    case .said(let n, let w):
      spin(3) { copySaid(n, w) > 0 }
      step("Chameleon \(n) says \"\(w)\"", copySaid(n, w) > 0, copyLines(n, w).last.map { String($0.suffix(200)) } ?? "never")
    case .itemClosed(let n):
      let id = copy(n).id
      let f = front()
      let page = word(f, "page") ?? "?"
      let closedLine = said("host: app:\(id): its window closed").last
      let pid = app(id)?.processIdentifier
      let user = userSpaces()
      let onUser = pid.map { p in windowsOf(p).filter { $0.layer == 0 && $0.on && $0.r.width >= 200 && $0.r.height >= 150 && !$0.spaces.filter(user.contains).isEmpty } } ?? []
      // (A reopen asked of it after it closed its window: Margin's, which it mustn't do any more.)
      func at(_ line: String?) -> Double? { line.flatMap { match($0, #"CHAMELEON (\d+\.\d+)"#) }.flatMap { Double($0[0]) } }
      let closedAt = at(copyLines(n, "closing its own window").last)
      let reopened = copyLines(n, "reopen asked").filter { l in closedAt.map { (at(l) ?? 0) > $0 } ?? false }
      step("Chameleon \(n)'s item closed", closedLine != nil && page == "empty" && onUser.isEmpty && reopened.isEmpty,
           "Margin said \(closedLine.map { "\"\(String($0.suffix(90)))\"" } ?? "nothing of its window closed"); the page card \(page); on screen in a user Space: \(onUser.map { "#\($0.n) \(rect($0.r))" }); reopens asked after its close: \(reopened.count); its app \(pid.map { "still running (pid \($0))" } ?? "not running")")
      if !(closedLine != nil && page == "empty" && onUser.isEmpty && reopened.isEmpty) { copyTail(n) }
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
    // (A window its app closed and the window server still lists, off screen: gone, as Margin's model takes it by
    // Accessibility's destroyed. A copy says which it closed.)
    let closed: Set<Int> = { if case .copy(let n) = d.target { return closedWindows(copyLog(n).split(separator: "\n").map(String.init)) }; return [] }()
    let mainKind = all.filter { $0.layer == 0 && $0.r.width >= 200 && $0.r.height >= 200 && !isStrip($0.r) && !($0.on == false && closed.contains($0.n)) }
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
    // (Which Space, said: Margin's Space has a new number every part, and "in [9202]" read as another Space, 2026-11-17.)
    func spacesText(_ sp: [UInt64]) -> String { "\(sp)\(sp == [marginSpace] ? " (Margin's)" : "")" }
    if !leftovers.isEmpty { problems.append("leftover(s) in user Spaces: \(leftovers.map { "#\($0.n) \(rect($0.r)) \($0.on ? "on screen " : "off screen ")in \(spacesText($0.spaces))" })") }
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
    // (The page card as it was, or settled: "loading" at the start is a correction of Margin's already under way as the
    // hold began, restore-code's placing again after its app re-laid its window out, 2026-11-17 19:03: every read in
    // the desired state, the card loading → shown. Shown → anything else is a change.)
    let pageOk = pageAfter == pageState || (pageState == "loading" && pageAfter == "shown")
    step("holds \(Int(seconds)) s: \(d.text)", good == reads && changes == 0 && pageOk,
         "\(good) of \(reads) reads in it, \(changes) change(s) of state; the page card \(pageState) → \(pageAfter)\(pageAfter != pageState && pageOk ? " (settled: a correction under way as the hold began)" : "")\(firstMiss.map { "; first miss \($0)" } ?? "")")
    if good != reads, let a = app(d.target.id) { log("   DIAG \(diag(a.processIdentifier, marginWindow?.n))") }
    if good != reads, case .copy(let n) = d.target { copyTail(n) }
  }
  // A copy's own log's last lines, after a miss: what it did (its windows' events), for the triage.
  func copyTail(_ n: Int) {
    for line in copyLog(n).split(separator: "\n").suffix(14) { log("   CHAMELEON \(n): \(line.suffix(200))") }
  }
}
