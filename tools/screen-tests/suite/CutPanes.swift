// A cut pane (docs/PEEK-SPLIT.md §4b; Margin's HostEngine `cutOf`, `slide`): a split of two Chameleon copies, the one
// at the page area's end with a minimum wider than its pane. Its window at that minimum from its pane's start, the rest
// past the display's edge (macOS keeps a full-screen tile there), held (never taken out of its tile); the pointer
// resting on it opens it to fit its app, the other pane folded and blurred (docs/FLEX-SPLIT.md step 1); the sidebar puts
// the split back; the pointer resting on a folded card opens that one; Margin's idle cost with a cut pane up.
import AppKit

extension Runner {
  // The rect of copy `n`'s pane, as Margin's layout says it (`main <item> at x,y w×h` or `pane <item> at …`).
  func paneRect(_ n: Int) -> CGRect? {
    guard let item = paneItems[n], let line = layoutLine(),
          let m = match(line, "(?:main|pane) " + NSRegularExpression.escapedPattern(for: item) + #" at (-?\d+),(-?\d+) (\d+)×(\d+)"#),
          let x = Double(m[0]), let y = Double(m[1]), let w = Double(m[2]), let h = Double(m[3]) else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
  }

  // The sides Margin last told its page for copy `n`'s pane (`cut panes {…}`: each side its arrow slides); nil: none said.
  func cutSides(_ n: Int, since mark: LogMark? = nil) -> Set<String>? {
    guard let item = paneItems[n] else { return nil }
    let lines = mark.map { $0.since("cut panes ") } ?? said("cut panes ")
    guard let last = lines.last, let r = last.range(of: "cut panes ") else { return nil }
    let json = String(last[r.upperBound...])
    guard json != "none", let d = json.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: [String: Any]] else { return [] }
    guard let pane = o[item] else { return [] }
    return Set(["left", "right", "up", "down"].filter { pane[$0] as? String == "slide" })
  }

  // Whether copy `a`'s window is behind copy `b`'s on screen (the window server's order); nil: one isn't on screen.
  func behind(_ a: Int, _ b: Int) -> Bool? {
    guard let pa = copyApp(a)?.processIdentifier, let pb = copyApp(b)?.processIdentifier else { return nil }
    let list = onScreen()
    let big = { (pid: pid_t) in list.firstIndex { $0.pid == pid && $0.layer == 0 && $0.r.width > 300 && $0.r.height > 300 } }
    guard let ia = big(pa), let ib = big(pb) else { return nil }
    return ia > ib
  }

  // Copy `n`'s window at its minimum (`minWidth`) from its pane's start, the rest past the display's edge, in Margin's
  // Space only, on screen, its right its one arrow; held `seconds` (a read every 0.5 s): never moved, never out of
  // Margin's Space, nothing of it over copy `other`'s pane.
  func cutPaneEdge(_ n: Int, other: Int, minWidth: CGFloat, seconds: Double) {
    let title = "cut pane: Chameleon \(n)'s window at its minimum (\(Int(minWidth))) from its pane's start, the rest past the display's edge, held \(Int(seconds)) s (never out of its tile), its right its one arrow"
    gate("the cut pane at the display's edge")
    guard let pid = copyApp(n)?.processIdentifier, let pane = paneRect(n), let otherPane = paneRect(other) else { return step(title, false, "the panes aren't known (\(layoutLine().map { String($0.suffix(220)) } ?? "no layout"))") }
    let screen = mainDisplay()
    guard pane.maxX >= screen.maxX - 24 else { return skip(title, "Chameleon \(n)'s pane \(rect(pane)) isn't at the display's edge (\(rect(screen)))") }
    guard pane.width < minWidth - 1 else { return skip(title, "its pane \(rect(pane)) isn't narrower than its minimum \(Int(minWidth)) (a wide display: nothing to cut)") }
    let mark = LogMark()
    var first: (n: Int, r: CGRect, on: Bool, spaces: [UInt64])?
    var moved: [String] = []
    var reads = 0
    let until = Date().addingTimeInterval(seconds)
    repeat {
      let w = placedWindow(pid, minWidth: 300, minHeight: 300)
      reads += 1
      if first == nil { first = w }
      if let w, let f = first, (w.n != f.n || abs(w.r.minX - f.r.minX) > 1 || abs(w.r.width - f.r.width) > 1 || w.spaces != f.spaces || !w.on) {
        moved.append("\(String(format: "%.1f", until.timeIntervalSinceNow)) s left: #\(w.n) \(rect(w.r)) on \(w.on) spaces \(w.spaces)")
      }
      if w == nil { moved.append("its window gone from the list") }
      spin(0.5)
    } while Date() < until && moved.count < 5
    guard let w = first else { return step(title, false, "no window of Chameleon \(n) (\(allOf(pid)))") }
    let atStart = abs(w.r.minX - pane.minX) <= 1 && w.r.width >= minWidth - 0.5
    let pastEdge = w.r.maxX > screen.maxX + 1
    let inMargin = w.on && w.spaces == [marginSpace]
    let overOther = w.r.intersection(otherPane.insetBy(dx: 2, dy: 2)).isNull == false
    let sides = cutSides(n)
    let ejected = mark.since("app:\(copy(n).id)").filter { $0.contains("out of full screen") || $0.contains("strayed") || $0.contains("its own full-screen Space") }
    step(title, atStart && pastEdge && inMargin && !overOther && moved.isEmpty && sides == ["right"] && ejected.isEmpty,
         "its pane \(rect(pane)), its window #\(w.n) \(rect(w.r)) (past the display's \(Int(screen.maxX)) by \(Int(w.r.maxX - screen.maxX))), on screen \(w.on), Spaces \(w.spaces) (Margin's \(marginSpace)); over Chameleon \(other)'s pane \(overOther); \(reads) reads, changes \(moved.isEmpty ? "none" : moved.joined(separator: "; ")); its arrows \(sides.map { $0.sorted().joined(separator: ",") } ?? "not said"); Margin: \(ejected.map { String($0.suffix(140)) })")
  }

  // The pointer resting on copy `n`'s cut pane (its hole: the copy's): after the page's pause it opens to its app's
  // minimum (`minWidth`), its window at its pane (no longer cut); copy `other`'s pane folded, its window at its own
  // minimum, blurred behind its card (Margin's `folded panes blurred`); both in Margin's Space (docs/FLEX-SPLIT.md step 1).
  func paneOpens(_ n: Int, other: Int, minWidth: CGFloat) {
    let title = "split opens: the pointer resting on Chameleon \(n)'s cut pane opens it to its app's minimum (\(Int(minWidth))), Chameleon \(other)'s folded and blurred"
    guard canPost else { return skip(title, "this suite can't post events (give the terminal Accessibility to run them)") }
    gate("a pane opening to fit its app")
    guard let item = paneItems[n], let pid = copyApp(n)?.processIdentifier, let opid = copyApp(other)?.processIdentifier, let pane = paneRect(n) else { return step(title, false, "the panes aren't known (\(layoutLine().map { String($0.suffix(220)) } ?? "no layout"))") }
    let mark = LogMark()
    let into = CGPoint(x: pane.midX, y: pane.midY + 120)
    post { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: into, mouseButton: .left) }
    var opened: String?
    spin(4) { opened = mark.since("split: \(item) opened to fit its app").last; return opened != nil }
    var now = paneRect(n)
    spin(3) { now = paneRect(n); return now.map { $0.width >= minWidth - 2 } ?? false }
    spin(0.6)
    now = paneRect(n)
    let folded = paneRect(other)
    let w = placedWindow(pid, minWidth: 300, minHeight: 300), ow = placedWindow(opid, minWidth: 300, minHeight: 300)
    let blurred = mark.since("folded panes blurred").last
    // (A picture of the page area as it is, to see the folded card over the blurred window: in the logs.)
    let shot = "\(buildDir)/logs/split-open-\(n)-\(Int(Date().timeIntervalSince1970)).png"
    if let f = folded, let p = now { let r = f.union(p); sh("/usr/sbin/screencapture", ["-x", "-R", "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))", shot]) }
    let fits = now.map { abs($0.width - minWidth) <= 2 } ?? false
    let atPane = now.flatMap { p in w.map { abs($0.r.minX - p.minX) <= 1 && abs($0.r.width - p.width) <= 1 } } ?? false
    let foldedOK = folded.map { $0.width < 700 - 1 && $0.width >= 63 } ?? false
    let otherMin = ow.map { $0.r.width >= 699 } ?? false
    let spaces = (w?.spaces ?? []) == [marginSpace] && (ow?.spaces ?? []) == [marginSpace]
    step(title, opened != nil && fits && atPane && foldedOK && otherMin && blurred != nil && spaces,
         "Margin's page: \(opened.map { String($0.suffix(120)) } ?? "no opening said"); its pane \(rect(pane)) → \(now.map(rect) ?? "?"), its window \(w.map { rect($0.r) } ?? "?") (at its pane \(atPane)); Chameleon \(other)'s pane \(folded.map(rect) ?? "?"), its window \(ow.map { rect($0.r) } ?? "?"); \(blurred.map { String($0.suffix(120)) } ?? "no blur said"); Spaces \(w?.spaces ?? []) / \(ow?.spaces ?? []) (Margin's \(marginSpace)); picture \(shot)")
  }

  // The pointer moved onto Margin's sidebar (left of the page area): after the page's pause the split goes back to its
  // own sizes, no pane folded.
  func paneBack(_ n: Int, other: Int) {
    let title = "split back: the pointer on Margin's sidebar puts the split back at its sizes (Chameleon \(n)'s and \(other)'s panes even), no pane folded"
    guard canPost else { return skip(title, "this suite can't post events (give the terminal Accessibility to run them)") }
    gate("the split back at its sizes")
    guard let a = paneRect(n), let b = paneRect(other) else { return step(title, false, "the panes aren't known") }
    let mark = LogMark()
    let on = CGPoint(x: min(a.minX, b.minX) - 110, y: (a.midY + b.midY) / 2)
    post { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: on, mouseButton: .left) }
    spin(0.1)
    post { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: on.x + 4, y: on.y + 4), mouseButton: .left) }
    var back: String?
    spin(4) { back = mark.since("split: back at its sizes").last; return back != nil }
    var pa = paneRect(n), pb = paneRect(other)
    spin(3) { pa = paneRect(n); pb = paneRect(other); return pa.flatMap { x in pb.map { abs(x.width - $0.width) <= 4 } } ?? false }
    let even = pa.flatMap { x in pb.map { abs(x.width - $0.width) <= 4 } } ?? false
    let unfolded = mark.since("no pane folded").last
    step(title, back != nil && even && unfolded != nil,
         "Margin's page: \(back.map { String($0.suffix(120)) } ?? "nothing said"); the panes \(pa.map(rect) ?? "?") and \(pb.map(rect) ?? "?"); \(unfolded.map { String($0.suffix(80)) } ?? "no unfold said")")
  }

  // The pointer resting on copy `n`'s folded card (Margin's own: no hole there): that pane opens to its app's minimum,
  // copy `other`'s folds and is blurred.
  func foldedCardOpens(_ n: Int, other: Int, minWidth: CGFloat) {
    let title = "split opens: the pointer resting on Chameleon \(n)'s folded card opens that pane to its app's minimum (\(Int(minWidth))), Chameleon \(other)'s folded and blurred"
    guard canPost else { return skip(title, "this suite can't post events (give the terminal Accessibility to run them)") }
    gate("a folded card")
    guard let item = paneItems[n], let card = paneRect(n) else { return step(title, false, "the panes aren't known") }
    guard card.width < minWidth - 1 else { return step(title, false, "Chameleon \(n)'s pane \(rect(card)) isn't folded") }
    let at = CGPoint(x: card.midX, y: card.midY)
    let mark = LogMark()
    post { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left) }
    spin(0.1)
    post { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: at.x + 2, y: at.y + 6), mouseButton: .left) }
    var opened: String?
    spin(4) { opened = mark.since("split: \(item) opened to fit its app").last; return opened != nil }
    var now = paneRect(n)
    spin(3) { now = paneRect(n); return now.map { $0.width >= minWidth - 2 } ?? false }
    spin(0.6)
    now = paneRect(n)
    let folded = paneRect(other)
    let blurred = mark.since("folded panes blurred").last
    step(title, opened != nil && (now.map { abs($0.width - minWidth) <= 2 } ?? false) && (folded.map { $0.width < 800 - 1 } ?? false) && blurred != nil,
         "Margin's page: \(opened.map { String($0.suffix(120)) } ?? "no opening said"); its pane \(rect(card)) → \(now.map(rect) ?? "?"); Chameleon \(other)'s \(folded.map(rect) ?? "?"); \(blurred.map { String($0.suffix(120)) } ?? "no blur said")")
  }
}
