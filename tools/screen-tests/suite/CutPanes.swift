// A cut pane (docs/PEEK-SPLIT.md §4b; Margin's HostEngine `cutOf`, `slide`): a split of two Chameleon copies, the one
// at the page area's end with a minimum wider than its pane. Its window at that minimum from its pane's start, the rest
// past the display's edge (macOS keeps a full-screen tile there), held (never taken out of its tile); its arrow pressed
// on Margin's own window (after the window list says the point is Margin's, then the copy's): slid to show its other
// side, now under the pane beside it (behind that copy's window); a first click into it delivered without a raise
// (pane-clicks' step); slid back past the display's edge; Margin's idle cost with a cut pane up.
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

  // Copy `n`'s arrow on `side` pressed on Margin's own window (the pointer into its pane first: the arrows show while
  // it's over it): slid to show that side (Margin says it, its window at the other alignment), its other side's arrow
  // now; after a slide to its right (its window into copy `other`'s pane), behind copy `other`'s window; back to its
  // left, past the display's edge again.
  func cutPaneSlide(_ n: Int, other: Int, side: String) {
    let title = "cut pane: Chameleon \(n)'s \(side) arrow pressed (on Margin's own window): slid to show its \(side) side\(side == "right" ? ", now behind Chameleon \(other)'s window" : ", past the display's edge again")"
    guard canPost else { return skip(title, "this suite can't post events (give the terminal Accessibility to run them)") }
    gate("a cut pane's arrow")
    guard let pid = copyApp(n)?.processIdentifier, let pane = paneRect(n), let before = placedWindow(pid, minWidth: 300, minHeight: 300) else { return step(title, false, "Chameleon \(n)'s pane or window isn't known") }
    guard cutSides(n)?.contains(side) == true else { return step(title, false, "Margin didn't offer its \(side) arrow (its arrows \(cutSides(n).map { $0.sorted().joined(separator: ",") } ?? "not said"))") }
    // (The pointer into its pane, away from the arrow: Margin says the pane hovered, the page shows its arrows.)
    let into = CGPoint(x: pane.midX, y: pane.midY + 120)
    post { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: into, mouseButton: .left) }
    spin(0.6)
    let at = CGPoint(x: side == "right" ? pane.maxX - 24 : pane.minX + 24, y: pane.midY)
    guard marginThenApp(under(at), m.processIdentifier, pid) else {
      return skip(title, "the windows under the arrow aren't Margin's then the copy's (\(under(at).map { "pid \($0.pid) layer \($0.layer)" }))")
    }
    let mark = LogMark()
    let clicks = copySaid(n, "click at")
    click(at)
    var slid: String?
    spin(3) { slid = mark.since("app:\(copy(n).id): slid to show its \(side) side").last; return slid != nil }
    spin(0.5)
    guard let w = placedWindow(pid, minWidth: 300, minHeight: 300) else { return step(title, false, "its window gone (\(allOf(pid)))") }
    let screen = mainDisplay()
    let placed = side == "right" ? abs(w.r.maxX - pane.maxX) <= 1 : abs(w.r.minX - pane.minX) <= 1 && w.r.maxX > screen.maxX + 1
    let order = side == "right" ? behind(n, other) : true
    let sides = cutSides(n, since: mark)
    let want: Set<String> = side == "right" ? ["left"] : ["right"]
    let ms = slid.flatMap { match($0, #"in ([0-9.]+) ms \((\d+) rects\)"#) }
    step(title, slid != nil && placed && order == true && sides == want && w.spaces == [marginSpace] && copySaid(n, "click at") == clicks && abs(w.r.width - before.r.width) <= 0.5,
         "its pane \(rect(pane)), its window \(rect(before.r)) → \(rect(w.r)), Spaces \(w.spaces); \(ms.map { "in \($0[0]) ms, \($0[1]) rects" } ?? "Margin said no slide"); behind Chameleon \(other)'s window \(order.map(String.init) ?? "unread"); its arrows now \(sides.map { $0.sorted().joined(separator: ",") } ?? "not said"); the press reached the copy \(copySaid(n, "click at") > clicks) (never: it's Margin's arrow)")
  }

  // After a click delivered into a cut pane lying under copy `other`'s (pane-clicks' step): still behind it (no raise).
  func cutPaneStillBehind(_ n: Int, other: Int) {
    gate("the cut pane's order")
    let b = behind(n, other)
    step("cut pane: after a click into it, Chameleon \(n)'s window still behind Chameleon \(other)'s (delivered without a raise)", b == true, "behind \(b.map(String.init) ?? "unread")")
  }
}
