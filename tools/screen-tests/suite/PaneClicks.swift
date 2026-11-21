// The first click in another pane (Margin's PaneClickTap.swift; DECISIONS.md "The first click in another pane goes
// through"): a split of two Chameleon copies made through Margin's dev hook (each hosted, then `ui split.add`, as the
// row's menu does), then clicks posted only on the copies' own windows (after the window list says Margin's panel then
// that copy are under the point), each in the pane WITHOUT the keys: Chameleon's grid (an NSView that refuses the first
// mouse, as WebKit and AppKit's text views do: before the tap a click there only made its window key, no "click at"),
// its button (it takes the first mouse anyway: unchanged), its field (the key typed after the click reaches it), a
// double-click (counts 1 and 2), a drag from it (its drags and its release follow, in order), then the times (Margin's
// "key in N ms", and from the press's post to the copy's own click), a click in the pane that has the keys (Margin says
// nothing: untouched), and Margin's idle cost with the split up and the tap on.
import AppKit

enum PaneClickKind: String, Equatable { case grid, button, field, double, drag }
nonisolated(unsafe) var paneItems: [Int: String] = [:] // each copy's item id in Margin's library (its dev hook's `say: layout`)

func layoutLine() -> String? { ask(["say": "layout"], answer: "dev hook: layout:") }
func layoutFocused(_ line: String?) -> String? { match(line, #"focused ([A-Za-z0-9_:.\-]+)"#)?.first }
func shownItem(_ line: String?) -> String? { match(line, #"shown item ([A-Za-z0-9_:.\-]+)"#)?.first }
// A press, release or drag at `p` with its click count (a double-click's second press says 2, as the window server's own).
func mouse(_ type: CGEventType, _ p: CGPoint, count: Int64 = 1) {
  post {
    let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
    e?.setIntegerValueField(.mouseEventClickState, value: count)
    return e
  }
}
// A copy's log line's own time (`CHAMELEON <epoch> pid …`).
func copyStamp(_ line: String?) -> Double? { line.flatMap { match($0, #"CHAMELEON ([0-9.]+) "#) }.flatMap { Double($0[0]) } }
func median(_ v: [Double]) -> Double { v.isEmpty ? 0 : v.sorted()[v.count / 2] }

extension Runner {
  // Copy `adding` added to a split beside copy `main`, both hosted: each shown once (its item id read), `main` last, then
  // `split.add` with `adding`'s item in Margin's page.
  func splitWith(_ main: Int, adding: Int) {
    gate("the split")
    for n in [adding, main] {
      show(.copy(n), maxMs: nil)
      if let id = shownItem(layoutLine()) { paneItems[n] = id }
    }
    guard let add = paneItems[adding], paneItems[main] != nil, paneItems[main] != add else {
      return step("split: each copy's item known (Margin's dev hook `say: layout`)", false, "\(paneItems)")
    }
    let mark = LogMark()
    let said = ask(["ui": "split.add", "arg": add], answer: "dev hook: ui split.add:")
    var line: String?
    let made = spin(15) { line = layoutLine(); return line?.contains(", split ") == true && line?.contains("pane ") == true }
    spin(1.5)
    let a = copyApp(main).flatMap { placedWindow($0.processIdentifier, minWidth: 300, minHeight: 300) }
    let b = copyApp(adding).flatMap { placedWindow($0.processIdentifier, minWidth: 300, minHeight: 300) }
    let apart = a.flatMap { a in b.map { b in a.on && b.on && a.spaces == [marginSpace] && b.spaces == [marginSpace] && a.r.intersection(b.r).isNull } } ?? false
    let tap = mark.since("pane clicks: on")
    step("split: Chameleon \(main) and \(adding) side by side in Margin's Space (dev hook `ui split.add`), the pane click tap on", made && apart && !tap.isEmpty,
         "\(said.map { String($0.suffix(80)) } ?? "no answer"); layout \(line.map { String($0.suffix(220)) } ?? "none"); windows \(a.map { "#\($0.n) \(rect($0.r))" } ?? "none"), \(b.map { "#\($0.n) \(rect($0.r))" } ?? "none"); Margin: \(tap.last.map { String($0.suffix(120)) } ?? "no `pane clicks: on`")")
  }

  // Which copy's pane has the keys, as Margin's layout says.
  func focusedCopy() -> Int? {
    let f = layoutFocused(layoutLine())
    return paneItems.first { $0.value == f }?.key
  }

  // Where in copy `n`'s window (its grid's subviews: the field at 30,150 320×28, the button at 30,200 140×32, from its
  // top left; the grid's middle right of both).
  func panePoint(_ n: Int, _ kind: PaneClickKind) -> CGPoint? {
    guard let pane = copyApp(n), let w = placedWindow(pane.processIdentifier, minWidth: 300, minHeight: 300) else { return nil }
    switch kind {
    case .grid, .double, .drag: return CGPoint(x: w.r.midX + 60, y: w.r.midY + 40)
    case .button: return CGPoint(x: w.r.minX + 100, y: w.r.minY + 216)
    case .field: return CGPoint(x: w.r.minX + 190, y: w.r.minY + 164)
    }
  }

  // A first click of `kind` in copy `n`'s pane while the other has the keys (the other's grid clicked first if `n` has
  // them: a pane click too). `name`: the step's name. Margin's word on it, and the post-to-click time (nil: none).
  @discardableResult func paneClick(_ n: Int, _ kind: PaneClickKind, name: String? = nil) -> (marginMs: Double?, clickMs: Double?) {
    let title = name ?? "pane click (\(kind.rawValue)): a first click in Chameleon \(n)'s pane without the keys reaches it"
    guard canPost else { skip(title, "this suite can't post events (give the terminal Accessibility to run them)"); return (nil, nil) }
    gate("a pane click (\(kind.rawValue)) in Chameleon \(n)")
    if focusedCopy() == n, let other = paneItems.keys.first(where: { $0 != n }) {
      paneClick(other, .grid, name: "pane click (grid, to move the keys): a first click in Chameleon \(other)'s pane without the keys reaches it")
      gate("a pane click (\(kind.rawValue)) in Chameleon \(n)")
    }
    guard focusedCopy() != n else { step(title, false, "Chameleon \(n)'s pane still has the keys (Margin's layout: \(layoutLine().map { String($0.suffix(160)) } ?? "none"))"); return (nil, nil) }
    guard let pane = copyApp(n), let p = panePoint(n, kind) else { skip(title, "Chameleon \(n)'s window isn't placed"); return (nil, nil) }
    let stack = under(p)
    guard marginThenApp(stack, m.processIdentifier, pane.processIdentifier) else {
      skip(title, "the windows under the point aren't Margin's then the copy's (\(stack.map { "\($0.pid == m.processIdentifier ? "Margin" : $0.pid == pane.processIdentifier ? "pane" : "another app") layer \($0.layer)" }))")
      return (nil, nil)
    }
    let mark = LogMark()
    let clicks = copySaid(n, "click at"), drags = copySaid(n, "drag at"), releases = copySaid(n, "release at"), buttons = copySaid(n, " button\n"), typed = copySaid(n, "typed count")
    let keyed = copySaid(n, "becameKey"), keys = copySaid(n, "EVENT keyDown code 0 ")
    post { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) }
    spin(0.25) // (Margin decides who has the pointer as it moves: PassThrough)
    let downAt = Date().timeIntervalSince1970
    switch kind {
    case .grid, .button, .field:
      mouse(.leftMouseDown, p); spin(0.06); mouse(.leftMouseUp, p)
    case .double:
      mouse(.leftMouseDown, p); spin(0.04); mouse(.leftMouseUp, p); spin(0.06)
      mouse(.leftMouseDown, p, count: 2); spin(0.04); mouse(.leftMouseUp, p, count: 2)
    case .drag:
      mouse(.leftMouseDown, p)
      for i in 1...10 { spin(0.016); mouse(.leftMouseDragged, CGPoint(x: p.x + CGFloat(8 * i), y: p.y + CGFloat(4 * i))) }
      spin(0.03); mouse(.leftMouseUp, CGPoint(x: p.x + 80, y: p.y + 40))
    }
    spin(0.6)
    var got = false, detail = ""
    switch kind {
    case .grid:
      got = copySaid(n, "click at") == clicks + 1 && copySaid(n, "release at") == releases + 1
      detail = "its grid's clicks \(clicks) → \(copySaid(n, "click at")), releases \(releases) → \(copySaid(n, "release at"))"
    case .button:
      got = copySaid(n, " button\n") == buttons + 1
      detail = "its button \(buttons) → \(copySaid(n, " button\n")) (it takes the first mouse anyway)"
    case .field:
      // (The key only to the copy, its window key and no field of Margin's focused: checked first.)
      let frontIsCopy = NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier
      let marginField = fieldLength(field())
      if frontIsCopy, marginField == nil {
        plainKey(0) // (a: its field's length goes up by one)
        got = gotKey(n, 0, after: keys) && spin(1) { copySaid(n, "typed count") == typed + 1 }
      }
      detail = "front app the copy \(frontIsCopy), Margin's field \(marginField.map { "focused (\($0))" } ?? "none"); the key reached it \(copySaid(n, "EVENT keyDown code 0 ") > keys); its field's changes \(typed) → \(copySaid(n, "typed count")) (\(copyLines(n, "typed count").last.map { String($0.suffix(16)) } ?? "-"))"
    case .double:
      let lines = copyLines(n, "click at").suffix(2)
      got = copySaid(n, "click at") == clicks + 2 && lines.first?.hasSuffix("count 1") == true && lines.last?.hasSuffix("count 2") == true
      detail = "its grid's clicks \(clicks) → \(copySaid(n, "click at")), counts \(lines.map { String($0.suffix(7)) })"
    case .drag:
      // (This drag's own lines, in the copy's order: its press, its drags, its release.)
      let mine = copyLog(n).split(separator: "\n").map(String.init).filter { $0.contains("click at") || $0.contains("drag at") || $0.contains("release at") }.dropFirst(clicks + drags + releases)
      let order = mine.map { $0.contains("click at") ? "c" : $0.contains("drag at") ? "d" : "r" }.joined()
      got = copySaid(n, "click at") == clicks + 1 && copySaid(n, "drag at") >= drags + 8 && copySaid(n, "release at") == releases + 1 && order.hasPrefix("cd") && order.hasSuffix("dr")
      detail = "its grid's clicks \(clicks) → \(copySaid(n, "click at")), drags \(drags) → \(copySaid(n, "drag at")) (10 posted), releases \(releases) → \(copySaid(n, "release at")), in order \(order)"
    }
    let lines = mark.since("app:\(copy(n).id): a click in its pane")
    let delivered = lines.first { $0.contains("the click delivered") }
    let ms = delivered.flatMap { match($0, #"key in ([0-9.]+) ms"#) }.flatMap { Double($0[0]) } ?? (delivered?.contains("key already") == true ? 0 : nil)
    let first = copyLines(n, kind == .button ? " button" : "click at").last
    let clickMs = copyStamp(first).map { ($0 - downAt) * 1000 }
    let focused = focusedCopy() == n
    step(title, got && delivered != nil && focused && copySaid(n, "becameKey") > keyed,
         "\(detail); its window key \(copySaid(n, "becameKey") > keyed), Margin's focus on it \(focused); Margin: \(lines.map { String($0.suffix(150)) })\(clickMs.map { String(format: "; from the press's post to the copy's click %.0f ms", $0) } ?? "")")
    return (ms, clickMs)
  }

  // Grid clicks back and forth `times` times (each in the pane without the keys): Margin's key time and the post-to-click
  // time, median and most; then a click in the pane that has the keys (Margin says nothing of it: untouched).
  func paneClickTimes(_ a: Int, _ b: Int, times: Int) {
    var margin: [Double] = [], clicked: [Double] = []
    var n = focusedCopy() == a ? b : a
    for i in 0..<times {
      let r = paneClick(n, .grid, name: "pane click times \(i + 1)/\(times): Chameleon \(n)'s grid")
      if let m = r.marginMs { margin.append(m) }
      if let c = r.clickMs { clicked.append(c) }
      n = n == a ? b : a
    }
    step("pane click times: every click delivered, each window key within the cap (120 ms)", margin.count == times && (margin.max() ?? 999) < 120,
         String(format: "Margin's key time median %.1f ms, most %.1f ms; the press's post to the copy's click median %.0f ms, most %.0f ms (%d of %d said)",
                median(margin), margin.max() ?? 0, median(clicked), clicked.max() ?? 0, margin.count, times))
    // (The pane with the keys: the click goes straight through, as before; nothing held, nothing said.)
    guard canPost, let k = focusedCopy(), let pane = copyApp(k), let p = panePoint(k, .grid) else { return skip("pane click: the pane with the keys untouched", "no pane with the keys, or no posting") }
    gate("a click in the pane with the keys")
    guard marginThenApp(under(p), m.processIdentifier, pane.processIdentifier) else { return skip("pane click: the pane with the keys untouched", "the windows under the point aren't Margin's then the copy's") }
    let mark = LogMark(), clicks = copySaid(k, "click at")
    click(p)
    step("pane click: a click in the pane with the keys goes straight through (Margin holds nothing, says nothing)",
         copySaid(k, "click at") == clicks + 1 && mark.since("a click in its pane").isEmpty, "its grid's clicks \(clicks) → \(copySaid(k, "click at")); Margin: \(mark.since("a click in its pane").map { String($0.suffix(120)) })")
  }
}
