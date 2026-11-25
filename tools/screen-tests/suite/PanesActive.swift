// Every pane of a split draws active (Margin's PanesActive.swift; DECISIONS.md "Every pane of a split draws active"):
// a split of two Chameleon copies (as the pane-clicks part makes it), each copy's own word on its state asked by its
// notification (Chameleon's `state` line: NSApp.isActive, its key and main windows, its field edited): the focused
// copy the window server's front app and active, the other active too (kept by Margin's records) with its pane's window
// key; clicks back and forth (each a pane click: the keyboard follows it, the menu bar's app the clicked one), both
// active after each, the kept one's inactive gap timed from its own log (its resign to its activation again); a key
// typed after a click reaches only the clicked one (another app in front is a hand check: TESTING.md); the split
// hidden (Chameleon 3 shown alone through the dev hook): the kept one let go after the grace; Margin's quit: its
// "let go (Margin quits" line before the copies resign; then, from a launch of its own, Margin killed (SIGKILL) with
// the split up: the kept copy still says it's active (nobody to let it go), Margin opened again: its recovery
// deactivates it before it quits the copies ("a crashed Margin kept 1 app active: 1 let go").
// Clicks and keys only where pane-clicks posts them (the window list says Margin's panel then that copy are under the
// point); no ⌘-Tab, no other app touched.
import AppKit

struct CopyState: Equatable { var active: Bool; var key: Int; var main: Int; var editing: Bool }

// Copy n's own word (nil: no answer within 2 s, or it isn't running).
func copyState(_ n: Int) -> CopyState? {
  let ask = String(UUID().uuidString.prefix(8))
  DistributedNotificationCenter.default().postNotificationName(.init(ChameleonSwitches.stateNotification), object: copy(n).id,
                                                               userInfo: ["bundle": copy(n).id, "ask": ask], deliverImmediately: true)
  var line: String?
  spin(2) { line = copyLines(n, "ask \(ask)").last; return line != nil }
  guard let m = match(line, #"state active (true|false) key (-?\d+) main (-?\d+) editing (true|false)"#), let key = Int(m[1]), let main = Int(m[2]) else { return nil }
  return CopyState(active: m[0] == "true", key: key, main: main, editing: m[3] == "true")
}
func stateText(_ s: CopyState?) -> String { s.map { "active \($0.active), key \($0.key), main \($0.main)\($0.editing ? ", editing" : "")" } ?? "no answer" }

// The kept copy's inactive gaps in its own log since `from` (each resign to its next activation, ms).
func inactiveGaps(_ n: Int, since from: Double) -> [Double] {
  var out: [Double] = []
  var resigned: Double?
  for line in copyLog(n).split(separator: "\n").map(String.init) {
    guard let t = copyStamp(line), t >= from else { continue }
    if line.contains("appDidResignActive") { resigned = t }
    if line.contains("appDidBecomeActive"), let r = resigned { out.append((t - r) * 1000); resigned = nil }
  }
  return out
}

extension Runner {
  // Both copies of the split active, each its pane's window key; the focused one the window server's front app.
  @discardableResult func panesActive(_ a: Int, _ b: Int, name: String? = nil) -> Bool {
    let title = name ?? "panes active: both copies of the split active, each its pane's window key; the focused one the front app"
    guard let f = focusedCopy(), let o = [a, b].first(where: { $0 != f }), let fa = copyApp(f), let oa = copyApp(o) else { skip(title, "no focused copy, or a copy not running"); return false }
    spin(0.4) // (Margin's step: one main-queue turn after the change, the copy's own records after)
    let fs = copyState(f), os = copyState(o)
    let fw = placedWindow(fa.processIdentifier, minWidth: 300, minHeight: 300)?.n, ow = placedWindow(oa.processIdentifier, minWidth: 300, minHeight: 300)?.n
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let ok = frontPid == fa.processIdentifier && fs?.active == true && fs?.key == fw && os?.active == true && os?.key == ow
    step(title, ok, "front app \(frontPid == fa.processIdentifier ? "Chameleon \(f)" : "pid \(frontPid ?? 0)"); Chameleon \(f) (focused, window \(fw ?? 0)): \(stateText(fs)); Chameleon \(o) (kept, window \(ow ?? 0)): \(stateText(os))")
    return ok
  }

  // Clicks back and forth `times` times (each a pane click), both active after each; the kept one's inactive gaps.
  func panesActiveFlips(_ a: Int, _ b: Int, times: Int) {
    let from = Date().timeIntervalSince1970
    var n = focusedCopy() == a ? b : a, both = 0
    for i in 0..<times {
      paneClick(n, .grid, name: "panes active flips \(i + 1)/\(times): a click in Chameleon \(n)'s pane")
      if panesActive(a, b, name: "panes active flips \(i + 1)/\(times): both active after it, Chameleon \(n) the front app") { both += 1 }
      n = n == a ? b : a
    }
    let gaps = inactiveGaps(a, since: from) + inactiveGaps(b, since: from)
    step("panes active flips: both active after every click; the one that had the keys inactive for a moment only (its resign to its activation again)",
         both == times, String(format: "%d of %d; inactive gaps median %.0f ms, most %.0f ms (%d)", both, times, median(gaps), gaps.max() ?? 0, gaps.count))
  }

  // The split hidden (`alone` shown by itself through the dev hook): the kept copy let go after the grace.
  func panesActiveHidden(_ a: Int, _ b: Int, alone: Int) {
    let kept = focusedCopy().flatMap { f in [a, b].first { $0 != f } }
    let mark = LogMark()
    show(.copy(alone), maxMs: nil)
    spin(2.5) // (the grace: 1 s)
    let s = kept.flatMap(copyState)
    let line = mark.since("panes active:").last { $0.contains("let go") }
    step("panes active: the split hidden (Chameleon \(alone) shown alone): the kept copy let go after the grace, inactive (it isn't the front app)",
         kept != nil && s?.active == false && line != nil, "Chameleon \(kept ?? 0): \(stateText(s)); Margin: \(line.map { String($0.suffix(160)) } ?? "no let-go line")")
  }

  // Margin quits with the split up: its let-go said before the copies resign (in their own logs) and quit.
  func panesActiveQuit(_ a: Int, _ b: Int) {
    gate("quitting Margin with a split up")
    let kept = focusedCopy().flatMap { f in [a, b].first { $0 != f } }
    let from = Date().timeIntervalSince1970
    let mark = LogMark()
    m.terminate()
    let quit = spin(25) { self.m.isTerminated }
    spin(8) { [a, b].allSatisfy { copyApp($0) == nil } }
    let line = mark.since("(Margin quits").last
    let resigned = kept.map { k in copyLines(k, "appDidResignActive").contains { (copyStamp($0) ?? 0) >= from } } ?? false
    step("panes active: Margin quits: the kept copy let go (its own resign logged) before it's quit", quit && line != nil && resigned,
         "Margin quit \(quit); Chameleon \(kept ?? 0) resigned \(resigned); Margin: \(line.map { String($0.suffix(160)) } ?? "no let-go line")")
  }

  // Margin killed with the split up: the kept copy still says it's active; Margin opened again lets it go first.
  func panesActiveCrash(_ a: Int, _ b: Int) {
    gate("killing Margin with a split up")
    guard marginWindow.pid == m.processIdentifier, let f = focusedCopy(), let k = [a, b].first(where: { $0 != f }) else { return skip("panes active: crash", "not the Margin the suite opened, or no split") }
    kill(m.processIdentifier, SIGKILL)
    spin(10) { kill(self.m.processIdentifier, 0) != 0 }
    spin(1.5)
    let left = copyState(k)
    step("panes active: Margin killed: the kept copy still takes itself for active (nobody let it go: the marker's for the next launch)", left?.active == true, "Chameleon \(k): \(stateText(left))")
    let from = Date().timeIntervalSince1970
    let mark = LogMark()
    openMargin()
    spin(15) { !mark.since("a crashed Margin kept").isEmpty }
    spin(8) { [a, b].allSatisfy { copyApp($0) == nil } }
    let line = mark.since("a crashed Margin kept").last
    let resigned = copyLines(k, "appDidResignActive").contains { (copyStamp($0) ?? 0) >= from }
    step("panes active: Margin opened again: its recovery deactivates the kept copy (its resign logged) before it quits the copies",
         line?.contains("1 let go") == true && resigned, "Chameleon \(k) resigned \(resigned); Margin: \(line.map { String($0.suffix(160)) } ?? "no recovery line")")
  }
}
