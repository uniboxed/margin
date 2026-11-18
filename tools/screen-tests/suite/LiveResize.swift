// Live resize (docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space"): a drag of the sidebar's edge followed live
// by the hosted window shown (Margin's dev hook `drag`: the page's own handle, pointer events as WebKit hands a
// person's drag, one move a display frame; no event is posted to the system), the parked ones sized after it, a switch
// after it, Mission Control, a hosted app killed, Margin's quit and Margin killed. Reads only (the window server's model
// bounds, Spaces, tiles; `ps` for CPU time and memory), numbers only.
import AppKit

let modelBounds = fn("SLSGetWindowBounds", (@convention(c) (Int32, UInt32, UnsafeMutablePointer<CGRect>) -> Int32).self)
let copyTiles = fn("SLSSpaceCopyTileSpaces", (@convention(c) (Int32, UInt64) -> Unmanaged<CFArray>?).self)
func bounds(_ n: Int) -> CGRect? { var r = CGRect.zero; return modelBounds(cid, UInt32(n), &r) == 0 ? r : nil }
func tilesOf(_ space: UInt64) -> [UInt64] { (copyTiles(cid, space)?.takeRetainedValue() as? [NSNumber])?.map(\.uint64Value) ?? [] }
nonisolated(unsafe) var startFullScreen: Set<UInt64> = []
func fullScreenSpaces() -> Set<UInt64> { Set(mc().filter { $0.contains("/t4/") }.compactMap { UInt64($0.split(separator: "/")[0]) }) }
func pidOf(_ name: String) -> pid_t? { sh("/usr/bin/pgrep", ["-x", name], timeout: 5).split(separator: "\n").first.flatMap { pid_t($0) } }
// CPU time (ms) and resident memory (KB) of processes, by `ps` (WindowServer's too: no permission needed for these).
func usage(_ pids: [pid_t]) -> [pid_t: (cpu: Double, rss: Int)] {
  var out: [pid_t: (Double, Int)] = [:]
  for line in sh("/bin/ps", ["-o", "pid=,time=,rss=", "-p", pids.map(String.init).joined(separator: ",")], timeout: 10).split(separator: "\n") {
    let f = line.split(separator: " ", omittingEmptySubsequences: true)
    guard f.count == 3, let pid = pid_t(f[0]), let rss = Int(f[2]) else { continue }
    let parts = f[1].split(separator: ":").map { Double($0) ?? 0 }
    out[pid] = (parts.reversed().enumerated().reduce(0) { $0 + $1.element * pow(60, Double($1.offset)) } * 1000, rss)
  }
  return out
}

extension Runner {
  // The processes a measure reads: Margin, WindowServer, and the copies running.
  func measured() -> [(String, pid_t)] {
    var list: [(String, pid_t)] = []
    if let m { list.append(("Margin", m.processIdentifier)) }
    if let ws = pidOf("WindowServer") { list.append(("WindowServer", ws)) }
    for c in copies { if let a = app(c.id) { list.append(("Chameleon \(c.n)", a.processIdentifier)) } }
    return list
  }
  func memoryLine(_ label: String) {
    let list = measured()
    let u = usage(list.map(\.1))
    log("  MEMORY \(label): " + list.map { "\($0.0) \(u[$0.1].map { "\($0.rss / 1024) MB" } ?? "?")" }.joined(separator: ", "))
  }

  // Mission Control lists Margin's Space only, beside the Spaces there were before the run.
  func listedOnly(_ name: String) {
    let now = fullScreenSpaces()
    let extra = now.subtracting(startFullScreen).subtracting([marginSpace])
    let tiles = tilesOf(marginSpace)
    step("\(name): Mission Control lists Margin's Space only (no hosted app's own Space)", extra.isEmpty && now.contains(marginSpace),
         "full-screen Spaces now \(now.sorted()) (before the run \(startFullScreen.sorted()), Margin's \(marginSpace)); Margin's Space's tiles \(tiles)")
  }

  // Copy n shown; the sidebar's edge dragged by `dx` points over `steps` display frames (the dev hook); its window's
  // model bounds sampled every millisecond meanwhile. Then the parked copies sampled until each is at the new page area.
  func liveDrag(_ n: Int, dx: Int, steps: Int, parked: [Int]) { liveDrag(.copy(n), dx: dx, steps: steps, parked: parked.map { .copy($0) }) }
  func liveDrag(_ t: Target, dx: Int, steps: Int, parked: [Target]) {
    guard let pane = app(t.id), let w = placedWindow(pane.processIdentifier, minWidth: 200, minHeight: 200), let pageBefore = rectIn(front(), "page area") else {
      return skip("drag-live (\(t.text))", "no hosted window or no page area")
    }
    gate("the live drag")
    let mark = LogMark()
    let list = measured()
    let u0 = usage(list.map(\.1))
    let t0 = Date()
    _ = mark
    let windows = parked.compactMap { k in app(k.id).flatMap { placedWindow($0.processIdentifier, minWidth: 200, minHeight: 200) }.map { (k.text, $0.n) } }
    hook(["drag": "\(dx),\(steps)"])
    // (Read every millisecond, nothing else meanwhile (a read of Margin's log takes up to a second): the shown window's
    // model bounds until they've held still 400 ms past the drag's own length, the parked ones' with them; then until
    // each parked one has the shown one's last bounds, 3 s at most.)
    var samples: [(t: Double, r: CGRect)] = []
    var parkedSeen: [String: CGRect] = [:]
    var parkedAt: [String: Double] = [:]
    let dragLength = Double(steps) / 120
    var settledAt: Double?
    while true {
      let now = Date().timeIntervalSince(t0)
      if let r = bounds(w.n), samples.last?.r != r { samples.append((now, r)) }
      let last = samples.last
      if settledAt == nil, now > dragLength + 0.4, let last, now - last.t >= 0.4 { settledAt = last.t }
      if let target = last?.r {
        for (k, num) in windows where parkedAt[k] == nil {
          if let b = bounds(num) { parkedSeen[k] = b; if settledAt != nil || now > dragLength, near(b, target, 1), !near(b, samples.first?.r ?? .zero, 1) { parkedAt[k] = now } }
        }
      }
      if let s = settledAt, parkedAt.count == windows.count || now - s > 3 { break }
      if now > dragLength + 8 { break }
      usleep(1000)
    }
    let pageAfter = rectIn(front(), "page area")
    spin(0.6)
    let u1 = usage(list.map(\.1))
    let all = mark.lines()
    let liveLine = all.last { $0.contains("host: live resize:") && $0.contains("page area changes") }
    let refits = all.filter { $0.contains("placed again in") || $0.contains(": page loading") }.count
    let distinct = Set(samples.map { Int($0.r.minX) }).count
    let final = bounds(w.n)
    let followed = match(liveLine, #"followed (\d+) \(median ([0-9.-]+) ms, p95 ([0-9.-]+) ms\), (\d+) not followed"#)
    let sent = match(liveLine, #"(\d+) sent"#).flatMap { Int($0[0]) } ?? 0
    let p95 = followed.flatMap { Double($0[2]) } ?? 999
    // (Within 25 ms at the 95th percentile: three display frames at 120 Hz. Each write waits for its window to be there
    // (one in flight), so this is the app's own redraw at the new size: Chameleon at 1244×933 takes 10-15 ms a resize, its
    // own log's `didResize` lines, 2026-11-17 23:52; the kit's simpler panes 7-8 ms.)
    let cpu = list.map { name, pid in "\(name) \(Int((u1[pid]?.cpu ?? 0) - (u0[pid]?.cpu ?? 0))) ms" }.joined(separator: ", ")
    step("drag-live (\(t.text), \(dx > 0 ? "+" : "")\(dx) pt over \(steps) frames): the shown window follows each step (Margin's word: each change followed, 95% within 25 ms), never placed again or behind the loader, at the drag's last page area",
         liveLine != nil && sent >= steps / 3 && (followed.flatMap { Int($0[0]) } ?? 0) >= sent * 9 / 10 && p95 <= 25 && distinct >= steps / 3 && refits == 0
           && final != nil && pageAfter != nil && near(final!, pageAfter!, 1) && !near(pageAfter!, pageBefore, 1),
         "Margin: \(liveLine.map { String($0.suffix(220)) } ?? "no live-resize line"); the suite: \(samples.count) bounds seen, \(distinct) widths of its left edge, page area \(rect(pageBefore)) → \(rect(pageAfter)), the window \(rect(final)); placed again or loading \(refits)×; CPU over the drag and 3 s after: \(cpu)")
    if !windows.isEmpty {
      // (From the shown window's last change, the drag's end as the window server has it.)
      let release = settledAt ?? samples.last?.t ?? 0
      let after = parkedAt.mapValues { ($0 - release) * 1000 }
      let slowest = after.values.max() ?? 9999
      step("background-sized: every parked window (\(parked.map(\.text).joined(separator: ", "))) at the new page area within 1 s of the release, out of sight",
           parkedAt.count == windows.count && slowest <= 1000 && windows.allSatisfy { spacesOf($0.1).isEmpty },
           windows.map { k, num in "\(k) #\(num) \(after[k].map { "at it \(Int($0)) ms after the shown one's last change" } ?? "NOT at it (\(rect(parkedSeen[k])))"), Spaces \(spacesOf(num))" }.joined(separator: "; "))
    }
  }

  // A switch to copy n (parked, sized in the background): its first frame on screen at the page area, in 99 ms or less,
  // and every frame of it for 300 ms after at the page area, Margin's window its screen's whole width all along (a tile
  // change lays the first two tiles of Margin's Space out again as a split's thirds or halves: seen 2026-11-17 23:31:42,
  // Chameleon 1 at 489 wide for 120 ms after its switch).
  func switchSized(_ n: Int) {
    guard let pane = copyApp(n), let w = placedWindow(pane.processIdentifier, minWidth: 200, minHeight: 200), let page = rectIn(front(), "page area") else {
      return skip("switch-after-resize (Chameleon \(n))", "not hosted, or no page area")
    }
    gate("the switch")
    let mark = LogMark()
    let whole = marginWindow.r.width
    let t0 = Date()
    hook(["app": copy(n).id])
    var first: (t: Double, r: CGRect)?
    var wrong: [(Double, CGRect)] = []
    var narrow: [(Double, CGRect)] = []
    var backAt: [Double: Double] = [:] // (a wrong size's time → when it was at the page area again)
    while Date().timeIntervalSince(t0) < 3 {
      let now = Date().timeIntervalSince(t0) * 1000
      let on = ((CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(w.n)) as? [[String: Any]])?.first?[kCGWindowIsOnscreen as String] as? Bool) == true
      if on, let r = bounds(w.n) {
        if first == nil { first = (now, r) }
        if !near(r, page, 1), wrong.last.map({ !near($0.1, r, 0.5) }) ?? true { wrong.append((now, r)) }
        if near(r, page, 1), let w0 = wrong.last, backAt[w0.0] == nil { backAt[w0.0] = now }
      }
      if let b = bounds(marginWindow.n), b.width < whole - 2, narrow.last.map({ !near($0.1, b, 0.5) }) ?? true { narrow.append((now, b)) }
      if let f = first, now - f.t > 300 { break }
      usleep(500)
    }
    spin(1.0)
    let line = mark.since(" switched in").last { $0.contains("app:\(copy(n).id)") }
    let ms = match(line, #"switched in (\d+) ms"#).flatMap { Int($0[0]) }
    step("switch (Chameleon \(n)): its first frame on screen at the page area and every frame for 300 ms after, Margin's window whole all along, a switch in 99 ms or less, nothing placed again",
         first.map { near($0.r, page, 1) } == true && wrong.isEmpty && narrow.isEmpty && (ms ?? 9999) <= 99 && mark.since("placed again in").isEmpty,
         "first on screen \(first.map { "\(Int($0.t)) ms after the ask, at \(rect($0.r))" } ?? "never in 3 s"); the page area \(rect(page)); at another size \(wrong.map { "\(Int($0.0)) ms: \(rect($0.1))\(backAt[$0.0].map { " (back \(Int($0 - wrong.first!.0)) ms later)" } ?? "")" }); Margin's window narrower \(narrow.map { "\(Int($0.0)) ms: \(rect($0.1))" }); Margin: \(line.map { String($0.suffix(140)) } ?? "no switch line")")
  }

  // Copy n killed (SIGKILL) while hosted (parked): its placeholder tile gone from Margin's Space within 2 s, Margin's
  // window its display's whole width again, copy `shown` still at the page area, nothing listed but Margin's Space.
  func killCopy(_ n: Int, shown: Int) {
    guard let pane = copyApp(n), let shownPane = copyApp(shown), let page = rectIn(front(), "page area") else { return skip("hosted-app-crash (Chameleon \(n))", "not running") }
    gate("killing Chameleon \(n)")
    let mark = LogMark()
    let tilesBefore = tilesOf(marginSpace)
    kill(pane.processIdentifier, SIGKILL)
    var narrowSeen = false
    let t0 = Date()
    let whole = marginWindow.r.width
    let ok = spin(3) {
      if let b = bounds(self.marginWindow.n), b.width < whole - 2 { narrowSeen = true }
      return pane.isTerminated && tilesOf(self.marginSpace).count == tilesBefore.count - 1 && (bounds(self.marginWindow.n).map { $0.width >= whole - 1 } ?? false)
    }
    let took = Date().timeIntervalSince(t0) * 1000
    spin(1.0)
    let sw = placedWindow(shownPane.processIdentifier, minWidth: 200, minHeight: 200)
    step("hosted-app-crash (Chameleon \(n) killed): its tile out of Margin's Space (a placeholder destroyed), Margin's window whole again, Chameleon \(shown) still at the page area in Margin's Space",
         ok && sw.map { near($0.r, page, 1) && $0.spaces == [marginSpace] && $0.on } == true,
         "Margin's Space's tiles \(tilesBefore) → \(tilesOf(marginSpace)) in \(Int(took)) ms; Margin's window \(rect(bounds(marginWindow.n)))\(narrowSeen ? " (a split's half for a moment)" : ""); Chameleon \(shown) \(sw.map { "#\($0.n) \(rect($0.r)) onscreen \($0.on) spaces \($0.spaces)" } ?? "none"); Margin: \(mark.lines().filter { $0.contains("tile") }.suffix(3).map { String($0.suffix(130)) })")
  }

  // Margin quits with tiles in its Space: every copy it started quit, nothing of them on screen in a user Space, no
  // full-screen Space left but the ones before the run.
  func marginQuitTiles(_ ns: [Int]) {
    gate("quitting Margin with tiles in its Space")
    let pids = ns.compactMap { copyApp($0)?.processIdentifier }
    let mark = LogMark()
    m.terminate()
    let quit = spin(25) { self.m.isTerminated }
    spin(8) { ns.allSatisfy { copyApp($0) == nil } }
    spin(1.5)
    let left = fullScreenSpaces().subtracting(startFullScreen)
    let user = userSpaces()
    let onUser = pids.flatMap { p in windowsOf(p).filter { $0.on && !$0.spaces.filter(user.contains).isEmpty } }
    step("margin-quit with tiles: Margin quit, every copy it hosted given back and quit, no full-screen Space left but the run's first ones, nothing on screen of them",
         quit && ns.allSatisfy { copyApp($0) == nil } && left.isEmpty && onUser.isEmpty,
         "Margin quit \(quit); copies running \(ns.filter { copyApp($0) != nil }); full-screen Spaces left \(left.sorted()); Margin: \(mark.lines().last { $0.contains("host: quit:") }.map { String($0.suffix(160)) } ?? "no quit line")")
  }

  // Margin killed (SIGKILL) with tiles in its Space: what's seen meanwhile (its Space with no owner, the first two tiles
  // a split), then Margin opened again: its recovery gives everything back (the copies quit, their windows out of full
  // screen first), Margin's old Space destroyed, nothing listed but the run's first Spaces and Margin's new one.
  func killMargin(_ ns: [Int]) {
    gate("killing Margin")
    let old = marginSpace
    let oldPid = m.processIdentifier
    let pids = ns.compactMap { copyApp($0)?.processIdentifier }
    kill(oldPid, SIGKILL)
    spin(10) { kill(oldPid, 0) != 0 }
    spin(2.0)
    let split = pids.compactMap { p in placedWindow(p, minWidth: 200, minHeight: 200).map { "#\($0.n) \(rect($0.r)) onscreen \($0.on) spaces \($0.spaces)" } }
    log("  Margin killed: its old Space \(old) \(fullScreenSpaces().contains(old) ? "still listed" : "gone"), its tiles \(tilesOf(old)); the copies' windows: \(split)")
    let mark = LogMark()
    openMargin()
    spin(15) { !mark.since("a marker from a Margin that didn't quit cleanly").isEmpty }
    spin(8) { ns.allSatisfy { copyApp($0) == nil } }
    spin(2)
    let line = mark.since("a marker from a Margin that didn't quit cleanly").last
    let left = fullScreenSpaces().subtracting(startFullScreen).subtracting([marginSpace])
    step("margin-crash recovery (Margin killed, opened again): the copies given back and quit, Margin's old Space and the hosted tiles destroyed, nothing listed but Margin's new Space",
         line != nil && ns.allSatisfy { copyApp($0) == nil } && left.isEmpty && !fullScreenSpaces().contains(old),
         "Margin: \(line.map { String($0.suffix(260)) } ?? "no recovery line"); copies running \(ns.filter { copyApp($0) != nil }); full-screen Spaces left \(left.sorted()) (Margin's new one \(marginSpace), its old one \(old) \(fullScreenSpaces().contains(old) ? "STILL LISTED" : "gone"))")
  }
}
