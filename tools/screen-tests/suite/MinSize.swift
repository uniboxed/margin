// A hosted window's own minimum size and the sidebar's drag (docs/HOSTING-CORE.md "Live resize: tiles in Margin's
// Space", "A window's minimum size"): the real Mac, 2026-11-18 09:08, Weather's window left Margin's Space into a
// full-screen Space of its own three times as the sidebar's edge was dragged fast. Reads only: each tile's values as
// the window server has them (`SizeConstraints`: the minimum and maximum its app gave its full-screen tile;
// `TileRect`), the windows' model bounds and Spaces every millisecond, Margin's log, the copies' own logs. Numbers only.
import AppKit

let copyValues = fn("SLSSpaceCopyValues", (@convention(c) (Int32, UInt64) -> Unmanaged<CFDictionary>?).self)
func tileValues(_ tile: UInt64) -> [String: Any] { (copyValues(cid, tile)?.takeRetainedValue() as? [String: Any]) ?? [:] }
func sizeOf(_ d: Any?) -> CGSize? {
  guard let d = d as? [String: Any], let w = (d["Width"] as? NSNumber)?.doubleValue, let h = (d["Height"] as? NSNumber)?.doubleValue else { return nil }
  return CGSize(width: w, height: h)
}
func rectOf(_ d: Any?) -> CGRect? {
  guard let d = d as? [String: Any], let s = sizeOf(d), let x = (d["X"] as? NSNumber)?.doubleValue, let y = (d["Y"] as? NSNumber)?.doubleValue else { return nil }
  return CGRect(origin: CGPoint(x: x, y: y), size: s)
}
// A window's tile in a Space (its `TileWindowID`), and the minimum its app gave that tile (nil: none said).
func tileOf(window n: Int, in space: UInt64) -> UInt64? { tilesOf(space).first { (tileValues($0)["TileWindowID"] as? NSNumber)?.intValue == n } }
func tileMin(_ tile: UInt64) -> CGSize? { sizeOf((tileValues(tile)["SizeConstraints"] as? [String: Any])?["Min"]) }
func tileRectNow(_ tile: UInt64) -> CGRect? { rectOf(tileValues(tile)["TileRect"]) }
func sizeText(_ s: CGSize?) -> String { s.map { "\(Int($0.width))x\(Int($0.height))" } ?? "none" }

extension Runner {
  // The hosted window of a target (its largest), its tile in Margin's Space and the minimum the tile says.
  // (The window in a tile of Margin's Space first: an app can make another window of its tile's size beside it, seen
  // 2026-11-18 09:39, Chameleon's 1099×966 as its tile went narrower than its minimum; else its largest.)
  func tiled(_ t: Target) -> (n: Int, r: CGRect, tile: UInt64?, min: CGSize?)? {
    guard let a = app(t.id) else { return nil }
    let tiles = tilesOf(marginSpace).map { ($0, (tileValues($0)["TileWindowID"] as? NSNumber)?.intValue ?? 0) }
    let mine = windowsOf(a.processIdentifier).filter { w in w.layer == 0 && tiles.contains { $0.1 == w.n } }
    if let w = mine.first, let tile = tiles.first(where: { $0.1 == w.n })?.0 { return (w.n, w.r, tile, tileMin(tile)) }
    guard let w = placedWindow(a.processIdentifier, minWidth: 200, minHeight: 200) else { return nil }
    return (w.n, w.r, nil, nil)
  }

  // What the window server says of a hosted window's tile: its minimum and maximum (its app's), its rect; and what
  // Margin says it learned.
  func tileMinStep(_ t: Target, expect: CGSize?) {
    guard let w = tiled(t), let tile = w.tile else { return step("tile-min (\(t.text)): its tile in Margin's Space says its minimum", false, "no tile of its window in Margin's Space \(marginSpace) (tiles \(tilesOf(marginSpace)))") }
    let v = tileValues(tile)
    let c = v["SizeConstraints"] as? [String: Any]
    let line = LogMark(at: logStart).since("minimum").last { $0.contains("app:\(t.id)") }
    let ok = w.min != nil && expect.map { e in w.min.map { abs($0.width - e.width) <= 1 && abs($0.height - e.height) <= 60 } ?? false } ?? true
    step("tile-min (\(t.text)): its tile says the minimum its app gave it\(expect.map { " (about \(sizeText($0)))" } ?? "")", ok,
         "tile \(tile): SizeConstraints min \(sizeText(sizeOf(c?["Min"]))), max \(sizeText(sizeOf(c?["Max"]))), preferred \(sizeText(sizeOf(c?["Preferred"]))); TileRect \(rect(rectOf(v["TileRect"]))); its window \(rect(w.r)); Margin: \(line.map { String($0.suffix(160)) } ?? "nothing said of its minimum")")
  }

  // The sidebar's edge dragged (`dx` points over `steps` display frames, Margin's dev hook `drag`) with `shown` shown and
  // `parked` parked, every window's model bounds and Spaces read every millisecond, the shown one's tile rect every few.
  // Asserted: no window ever out of Margin's Space (the shown one) or in a user Space (a parked one); the shown one never
  // narrower than its minimum; nothing placed again or behind the loader; the page area at the drag's end `endsAt`
  // wide (nil: as dragged, its minimum the floor); each parked one at the page area, or (its minimum wider) at its
  // minimum width, its right edge the page area's. Also said: how it went (when a rect below its minimum was first sent,
  // when the window stopped following, when and where it left), for the record.
  func minDrag(_ t: Target, dx: Int, steps: Int, endsAt: Int?, parked: [Target]) {
    let name = "min-drag (\(t.text), \(dx > 0 ? "+" : "")\(dx) pt over \(steps) frames\(parked.isEmpty ? "" : ", \(parked.map(\.text).joined(separator: ", ")) parked"))"
    guard let w = tiled(t), let pageBefore = rectIn(front(), "page area") else { return skip(name, "no hosted window or no page area") }
    gate("the drag")
    let minimum = w.min
    let others = parked.compactMap { k in tiled(k).map { (k, $0) } }
    let mark = LogMark()
    let start = Date()
    hook(["drag": "\(dx),\(steps)"])
    struct Change { let t: Double; let what: String }
    var changes: [Change] = []
    var lastBounds: CGRect?, lastSpaces: [UInt64]?, lastRect: CGRect?
    var ejectedAt: Double?, ejectedInto: [UInt64] = [], narrowest = CGFloat.infinity, emptyReads = 0
    var firstBelow: (t: Double, w: CGFloat)?, heldAt: Double?
    var parkedOut: [String: [UInt64]] = [:]
    let dragLength = Double(steps) / 120
    var quietSince = Date()
    var i = 0
    while true {
      let now = Date().timeIntervalSince(start)
      if let b = bounds(w.n), b != lastBounds {
        lastBounds = b
        quietSince = Date()
        changes.append(Change(t: now, what: "bounds \(rect(b))"))
        narrowest = min(narrowest, b.width)
      }
      let sp = spacesOf(w.n)
      if sp.isEmpty { emptyReads += 1 } else if sp != lastSpaces {
        if lastSpaces != nil { changes.append(Change(t: now, what: "Spaces \(sp)")) }
        lastSpaces = sp
        quietSince = Date()
        if sp != [marginSpace], ejectedAt == nil { ejectedAt = now; ejectedInto = sp }
      }
      if i % 4 == 0, let tile = w.tile, let r = tileRectNow(tile), r != lastRect {
        lastRect = r
        changes.append(Change(t: now, what: "rect \(rect(r))"))
        if let m = minimum, r.width < m.width - 0.5, firstBelow == nil { firstBelow = (now, r.width) }
        // (The window held at its minimum while its rect goes narrower.)
        if let m = minimum, r.width < m.width - 0.5, let b = lastBounds, abs(b.width - m.width) <= 1, heldAt == nil { heldAt = now }
      }
      for (k, o) in others {
        let s = spacesOf(o.n)
        if !s.isEmpty, parkedOut[k.text] == nil { parkedOut[k.text] = s }
      }
      i += 1
      // (Until 0.6 s past the drag's own length with nothing changed for 0.6 s; out of Margin's Space, until it's back
      // there at rest (Margin's recovery), 12 s at most.)
      let quiet = Date().timeIntervalSince(quietSince)
      let back = ejectedAt == nil || (lastSpaces == [marginSpace] && quiet > 1.5)
      if now > dragLength + 0.6, quiet > 0.6, back { break }
      if now > dragLength + 12 { break }
      usleep(1000)
    }
    spin(1.2)
    let pageAfter = rectIn(front(), "page area")
    let all = mark.lines()
    let liveLine = all.last { $0.contains("host: live resize:") && $0.contains("page area changes") }
    let out = all.filter { $0.contains("found out of Margin's Space") || $0.contains("found where it mustn't be") }
    let refits = all.filter { $0.contains("placed again") || $0.contains(": page loading") }
    let sent = match(liveLine, #"(\d+) sent"#).flatMap { Int($0[0]) } ?? 0
    let late = match(liveLine, #"(\d+) not followed"#).flatMap { Int($0[0]) } ?? 0
    let final = bounds(w.n)
    let copyNotes: [String] = { guard case .copy(let n) = t else { return [] }
      return copyLog(n).split(separator: "\n").map(String.init).filter { l in
        guard let ts = Double(l.split(separator: " ").dropFirst().first ?? ""), ts >= start.timeIntervalSince1970 else { return false }
        return l.contains("FullScreen") || l.contains("space changed") || l.contains("didChangeScreen")
      } }()
    func ms(_ s: Double?) -> String { s.map { "\(Int($0 * 1000)) ms" } ?? "never" }
    let belowText = firstBelow.map { "\(ms($0.t)) (\(Int($0.w)) wide)" } ?? "never"
    var outText = "never"
    if let e = ejectedAt {
      outText = "at \(ms(e)) into \(ejectedInto)"
      if let f = firstBelow { outText += " (\(Int((e - f.t) * 1000)) ms after the first rect below its minimum)" }
    }
    let narrowText = narrowest.isFinite ? "\(Int(narrowest))" : "?"
    let story = "page area \(rect(pageBefore)) → \(rect(pageAfter)); its minimum \(sizeText(minimum)); first rect below it \(belowText); held at its minimum from \(ms(heldAt)); narrowest bounds \(narrowText); out of Margin's Space \(outText)" + (emptyReads > 0 ? "; \(emptyReads) reads in no Space" : "")
    log("  \(name): \(story)")
    log("  timeline: " + changes.prefix(60).map { "\(Int($0.t * 1000)) \($0.what)" }.joined(separator: "; ") + (changes.count > 60 ? "; … \(changes.count - 60) more" : ""))
    if !copyNotes.isEmpty { log("  its own log: " + copyNotes.prefix(12).map { String($0.suffix(90)) }.joined(separator: " | ")) }
    if !out.isEmpty || !refits.isEmpty { log("  Margin: " + (out + refits).prefix(6).map { String($0.suffix(170)) }.joined(separator: " | ")) }
    // (The page area the drag ends on: as asked, or as dragged with the shown one's minimum its floor when it was wider.)
    let want: CGFloat? = endsAt.map(CGFloat.init) ?? minimum.map { m in max(pageBefore.width - CGFloat(dx), min(pageBefore.width, m.width)) }
    let pageOK = pageAfter.map { p in want.map { abs(p.width - $0) <= 2 } ?? true } ?? false
    var fillsOK = false
    if let f = final, let p = pageAfter {
      if let m = minimum, m.width > p.width + 1 { fillsOK = abs(f.maxX - p.maxX) <= 2 && abs(f.width - m.width) <= 2 } else { fillsOK = near(f, p, 1) }
    }
    step("\(name): never out of Margin's Space, never narrower than its minimum, nothing placed again or behind the loader, the edge stopped where its minimum is\(want.map { " (the page area \(Int($0)) wide at the end)" } ?? ""), each change followed",
         ejectedAt == nil && out.isEmpty && refits.isEmpty && (minimum.map { narrowest >= $0.width - 1 } ?? true) && pageOK && fillsOK && liveLine != nil && late * 10 <= max(sent, 1),
         "\(story); its window at the end \(rect(final)); Margin: \(liveLine.map { String($0.suffix(200)) } ?? "no live-resize line")")
    guard !others.isEmpty, let p = pageAfter else { return }
    // (Each parked one: never in a user Space; at the page area or at its minimum width, its right edge the page area's.)
    var said: [String] = [], ok = true
    for (k, o) in others {
      let b = bounds(o.n)
      let m = o.min
      let wide = m.map { $0.width > p.width + 1 } ?? false
      let at = b.map { b in wide ? abs(b.maxX - p.maxX) <= 2 && abs(b.width - m!.width) <= 2 && abs(b.minY - p.minY) <= 2 : near(b, p, 1) } ?? false
      let inUser = parkedOut[k.text]
      if !at || inUser != nil { ok = false }
      said.append("\(k.text) #\(o.n) min \(sizeText(m)) at \(rect(b))\(wide ? " (its minimum wider than the page area: there, its right edge the page area's)" : "")\(inUser.map { ", IN A USER SPACE \($0)" } ?? ", never in a user Space")")
    }
    step("\(name): every parked window kept out of sight and sized: at the page area, or at its own minimum width with its right edge the page area's", ok, said.joined(separator: "; "))
  }

  // The one shown wider (its minimum) than the page area: in Margin's Space, on screen, at its minimum width with its
  // right edge the page area's (what overflows under Margin's sidebar, Margin's window in front), for `seconds`.
  func overflowHeld(_ t: Target, seconds: Double) {
    guard let w = tiled(t), let p = rectIn(front(), "page area") else { return skip("overflow (\(t.text))", "not hosted, or no page area") }
    let mark = LogMark()
    var bad: [String] = []
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      gate("holding")
      let b = bounds(w.n), sp = spacesOf(w.n)
      let at = b.map { b in w.min.map { m in m.width > p.width + 1 ? abs(b.maxX - p.maxX) <= 2 && abs(b.width - m.width) <= 2 : near(b, p, 1) } ?? near(b, p, 1) } ?? false
      if !at || (!sp.isEmpty && sp != [marginSpace]) { bad.append("\(rect(b)) \(sp)") }
      spin(0.25)
    }
    let out = mark.since("found out of Margin's Space")
    step("overflow (\(t.text)): wider than the page area by its own minimum: held in Margin's Space at its minimum width, its right edge the page area's, \(Int(seconds)) s",
         bad.isEmpty && out.isEmpty, "page area \(rect(p)); its minimum \(sizeText(w.min)); its window \(rect(bounds(w.n))) \(spacesOf(w.n)); \(bad.count) reads off\(bad.first.map { " (first: \($0))" } ?? ""); Margin: \(out.first.map { String($0.suffix(150)) } ?? "never found it out of its Space")")
  }
}
