// A sidebar row dropped on the page (docs/FLEX-SPLIT.md step 2; Margin's ui/behaviors/split.ts dropAt, drag.ts): a real
// press on a copy's row in Margin's sidebar, dragged over the page area (the hosted windows' holes: the pointer stays
// Margin's while the button is held) and let go. On the page shown alone, its right edge: a new split, side by side; on a
// pane's middle: in its place, that copy out of the split; on the gap between two panes: between them.
import AppKit

extension Runner {
  // Copy `n`'s item, the one Margin's layout says is shown once that copy is.
  func itemOf(_ n: Int) -> String? {
    if let id = paneItems[n] { return id }
    show(.copy(n), maxMs: nil)
    let id = shownItem(layoutLine())
    if let id { paneItems[n] = id }
    return id
  }

  // The middle of copy `n`'s row in Margin's sidebar, on the screen (dev hook `say row`); nil: not drawn.
  func rowPoint(_ n: Int) -> CGPoint? {
    guard let item = paneItems[n], let line = ask(["say": "row", "arg": item], answer: "dev hook: row:"),
          let m = match(line, #"at (-?\d+),(-?\d+)"#), let x = Double(m[0]), let y = Double(m[1]) else { return nil }
    return CGPoint(x: x, y: y)
  }

  // A press on `from`, dragged to `to` the way a hand does (moved a little first, then on in steps of a frame), held
  // there a moment, let go.
  func dragRow(from: CGPoint, to: CGPoint, shot: String? = nil) {
    mouse(.leftMouseDown, from)
    spin(0.05)
    for i in 1...4 { spin(0.016); mouse(.leftMouseDragged, CGPoint(x: from.x + CGFloat(3 * i), y: from.y + CGFloat(i))) }
    let start = CGPoint(x: from.x + 12, y: from.y + 4)
    let steps = 30
    for i in 1...steps {
      spin(0.016)
      let k = CGFloat(i) / CGFloat(steps)
      mouse(.leftMouseDragged, CGPoint(x: start.x + (to.x - start.x) * k, y: start.y + (to.y - start.y) * k))
    }
    for _ in 0..<12 { spin(0.02); mouse(.leftMouseDragged, to) }
    // (A picture while it's held, the drag's copy and the mark where it'd drop: the logs folder.)
    if let shot { sh("/usr/sbin/screencapture", ["-x", shot]) }
    mouse(.leftMouseUp, to)
  }

  // The copies in the split, left to right, as Margin's layout says them (none: not a split).
  func splitOrder() -> [Int] {
    guard layoutLine()?.contains(", split ") == true else { return [] }
    return paneItems.keys.compactMap { n in paneRect(n).map { (n, $0.minX) } }.sorted { $0.1 < $1.1 }.map(\.0)
  }

  // Copy `n`'s row dropped on the page: `onto` the copy shown alone (its right edge), `over` a pane's middle, or
  // `between` two panes; the split then `expect` (left to right).
  func rowDrop(_ n: Int, kind: RowDrop, expect: [Int]) {
    let what: String
    switch kind {
    case .side(let o): what = "on the right edge of Chameleon \(o)'s page, shown alone: a new split, side by side"
    case .over(let o): what = "on Chameleon \(o)'s pane's middle: in its place, Chameleon \(o) out of the split"
    case .between(let a, let b): what = "on the gap between Chameleon \(a)'s and \(b)'s panes: between them"
    case .below(let o): what = "near Chameleon \(o)'s pane's bottom edge: below it, the two stacked in its place (docs/FLEX-SPLIT.md step 3)"
    }
    let title = "split drop: Chameleon \(n)'s row dragged from Margin's sidebar \(what) (the split \(expect.map(String.init).joined(separator: ", ")))"
    guard canPost else { return skip(title, "this suite can't post events (give the terminal Accessibility to run them)") }
    gate("a row dropped on the page")
    // (Every copy's item known first: learning one shows it.)
    let copies: [Int]
    switch kind { case .side(let o), .over(let o), .below(let o): copies = [n, o]; case .between(let a, let b): copies = [n, a, b] }
    for c in copies where itemOf(c) == nil { return step(title, false, "Chameleon \(c)'s item isn't known (\(paneItems))") }
    // (The target shown again: the page alone, or a pane, which shows its split.)
    show(.copy(copies[1]), maxMs: nil)
    spin(1.5)
    let to: CGPoint
    switch kind {
    case .side(let o):
      // (Its window is the page area.)
      guard let pid = copyApp(o)?.processIdentifier, let page = placedWindow(pid, minWidth: 300, minHeight: 300)?.r else { return step(title, false, "Chameleon \(o)'s page isn't known (\(layoutLine().map { String($0.suffix(220)) } ?? "no layout"))") }
      to = CGPoint(x: page.maxX - 40, y: page.midY)
    case .over(let o):
      guard let pane = paneRect(o) else { return step(title, false, "Chameleon \(o)'s pane isn't known") }
      to = CGPoint(x: pane.midX, y: pane.midY)
    case .between(let a, let b):
      guard let pa = paneRect(a), let pb = paneRect(b) else { return step(title, false, "the panes aren't known") }
      to = CGPoint(x: (pa.maxX + pb.minX) / 2, y: pa.midY)
    case .below(let o):
      guard let pane = paneRect(o) else { return step(title, false, "Chameleon \(o)'s pane isn't known") }
      to = CGPoint(x: pane.midX, y: pane.maxY - pane.height * 0.08)
    }
    // (Stacked: the dropped one's pane below the target's, as wide, where the target's was.)
    if case .below(let o) = kind {
      guard let from = rowPoint(n) else { return step(title, false, "Chameleon \(n)'s row isn't drawn in Margin's sidebar") }
      let before = paneRect(o)
      let mark = LogMark()
      dragRow(from: from, to: to, shot: "\(buildDir)/logs/split-drop-\(n)-below-\(Int(Date().timeIntervalSince1970)).png")
      var top: CGRect?, low: CGRect?
      let stacked = spin(15) {
        top = paneRect(o); low = paneRect(n)
        guard let t = top, let l = low else { return false }
        return l.minY >= t.maxY - 1 && abs(l.minX - t.minX) <= 2 && abs(l.width - t.width) <= 2
      }
      spin(1)
      // (Each pane's window: the one of its app in its pane's box, on screen in Margin's Space; an app may have others.)
      let windows = [(o, top), (n, low)].compactMap { c, r -> (n: Int, r: CGRect, on: Bool, spaces: [UInt64])? in
        guard let r, let pid = copyApp(c)?.processIdentifier else { return nil }
        return windowsOf(pid).first { $0.layer == 0 && abs($0.r.minX - r.minX) <= 2 && abs($0.r.minY - r.minY) <= 2 && abs($0.r.width - r.width) <= 2 && abs($0.r.height - r.height) <= 2 }.map { ($0.n, $0.r, $0.on, $0.spaces) }
      }
      let inSpace = windows.count == 2 && windows.allSatisfy { $0.on && $0.spaces == [marginSpace] }
      let inPlace = before.map { b in top.map { abs($0.minX - b.minX) <= 2 && abs($0.width - b.width) <= 2 } ?? false } ?? false
      return step(title, stacked && inSpace && inPlace,
                  "row \(Int(from.x)),\(Int(from.y)) → \(Int(to.x)),\(Int(to.y)); Chameleon \(o) \(before.map(rect) ?? "?") → \(top.map(rect) ?? "?"), Chameleon \(n) \(low.map(rect) ?? "?"); \(windows.map { "#\($0.n) \(rect($0.r))" }.joined(separator: ", ")); Margin's page: \(mark.since("split add: ").last.map { String($0.suffix(160)) } ?? "no room check said")")
    }
    guard let from = rowPoint(n) else { return step(title, false, "Chameleon \(n)'s row isn't drawn in Margin's sidebar") }
    let mark = LogMark()
    dragRow(from: from, to: to, shot: "\(buildDir)/logs/split-drop-\(n)-\(Int(Date().timeIntervalSince1970)).png")
    var order: [Int] = []
    spin(15) { order = splitOrder(); return order == expect }
    spin(1)
    order = splitOrder()
    let checked = mark.since("split add: ").last
    let windows = expect.compactMap { copyApp($0).flatMap { placedWindow($0.processIdentifier, minWidth: 200, minHeight: 200) } }
    let apart = windows.count == expect.count && windows.allSatisfy { $0.on && $0.spaces == [marginSpace] }
    step(title, order == expect && apart,
         "row \(Int(from.x)),\(Int(from.y)) → \(Int(to.x)),\(Int(to.y)); the split \(order); \(windows.map { "#\($0.n) \(rect($0.r))" }.joined(separator: ", ")); Margin's page: \(checked.map { String($0.suffix(160)) } ?? "no room check said")")
  }
}

// Where a row is dropped on the page.
enum RowDrop: Equatable {
  case side(Int)            // the right edge of that copy's page, shown alone
  case over(Int)            // that copy's pane's middle
  case between(Int, Int)    // the gap between two copies' panes
  case below(Int)           // near that copy's pane's bottom edge (a pane split across its node)
}
