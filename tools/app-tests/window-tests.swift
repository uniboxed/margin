// Binding the extension's windows to the window server's (WindowMatcher.swift
// WindowBinder), read after read, against a made-up browser: every
// multi-window case Tirth asked for, a replay of the swap in his log
// (2026-11-05), and randomized orderings of Space switches with copies' focus
// flags lagging and disagreeing, checked against the truth at every read.
import AppKit
import Foundation

// One browser as both sides see it, with a clock. Each `read` is one read of the window server.
final class World {
  var t: Double = 1_800_000_000
  var server: [ServerWindow] = []
  var ext: [String: [ExtWindow]] = [:] // per link (its copy's last report)
  var copies: [String: String] = [:]
  var held: Set<String> = []
  var inFront = true
  var pids: Set<pid_t> = [1]
  var lines: [String] = []
  var binder: WindowBinder!
  var truth: [WindowKey: Int] = [:]
  var wrong: [String] = []
  // Blips of the window server's list (Tirth's log, 2026-11-05): these numbers left out of a read;
  // `collapse`, every one of the browser's left out; `noList`, no list at all.
  var blipped: Set<Int> = []
  var collapse = false
  var noList = false
  // The pages (background/link.js visibility): with `pages` on, each extension window the truth names has
  // its page in front say it's shown while its window is on screen, hidden while not, `pageLag` after the
  // window server changed (per window and what it says); `silent` ones never say. `spaceAt`: the last
  // Space change Margin.app heard (NSWorkspace), passed as is.
  var pages = false
  var pageLag: (WindowKey, Bool) -> Double = { _, _ in 0 }
  var silent: Set<WindowKey> = []
  var spaceAt: Double = -.infinity
  // The parking registry's numbers (HANDOFF.md §2.2), passed as they are.
  var parked: Set<Int> = []
  private var pageTarget: [WindowKey: Bool] = [:]
  private var pageDue: [(at: Double, key: WindowKey, visible: Bool)] = []
  private var pageLast: [WindowKey: Double] = [:]
  // When each window server window was last in a read the binder was given, and every binding dropped
  // for a window missing from the reads less than `Timing.absent` (the copy still reporting its window).
  private var lastListed: [Int: Double] = [:]
  var earlyDrops: [String] = []

  init(timing: WindowBinder.Timing = .init()) {
    binder = WindowBinder(browser: "safari", timing: timing, log: { [unowned self] in self.lines.append($0) })
  }

  @discardableResult func read(_ dt: Double = 0.25) -> [WindowKey: Int] {
    let before = t
    t += dt
    if pages {
      // A page sees its window shown or hidden a moment after the window server's change (made since the last read).
      for (key, n) in truth.sorted(by: { $0.key < $1.key }) where get(key) != nil && !silent.contains(key) {
        let on = server.first { $0.number == n }?.onScreen ?? false
        if pageTarget[key] != on {
          pageTarget[key] = on
          // One page says things in order: a word never overtakes the one before it.
          let at = max(before + 0.001 + pageLag(key, on), (pageLast[key] ?? -.infinity) + 0.001)
          pageLast[key] = at
          pageDue.append((at, key, on))
        }
      }
      pageDue.sort { $0.at < $1.at }
      while let due = pageDue.first, due.at <= t {
        pageDue.removeFirst()
        say(due.key, visible: due.visible, at: due.at)
      }
    }
    let listed = noList ? [] : collapse ? server.filter { !pids.contains($0.pid) } : server.filter { !blipped.contains($0.number) }
    let said = lines.count
    let out = binder.update(now: t, ext: ext.keys.sorted().flatMap { ext[$0]! }, reporting: Set(ext.keys), copies: copies, held: held,
                            server: listed, pids: pids, browserInFront: inFront, listed: !noList, spaceChangedAt: spaceAt, parked: parked, exact: exact)
    // Measured, not read from the line's words: how long the window had been out of the reads.
    for line in lines[said...] where line.contains(" is gone from the window server") {
      guard let n = line.range(of: "is no longer window ").flatMap({ Int(line[$0.upperBound...].prefix { $0.isNumber }) }), !pids.isEmpty else { continue }
      let away = t - (lastListed[n] ?? -.infinity)
      if away < binder.timing.absent - 1e-9 { earlyDrops.append("window \(n) dropped \(String(format: "%.2f", away)) s after it was last listed: \(line)") }
    }
    for w in listed where pids.contains(w.pid) { lastListed[w.number] = t }
    for (k, n) in out where truth[k] != nil && truth[k] != n { wrong.append("\(k) bound to \(n), is \(truth[k]!) (t+\(String(format: "%.2f", t - 1_800_000_000)))") }
    return out
  }
  // Accessibility's word: window number → the link its title names (SafariAX).
  var exact: [Int: String] = [:]
  func run(_ seconds: Double, every: Double = 0.25) {
    var left = seconds
    while left > 1e-9 { read(min(every, left)); left -= every }
  }

  // The window server's windows.
  func add(_ n: Int, _ r: CGRect, on: Bool = false, pid: pid_t = 1, layer: Int = 0, alpha: Double = 1) {
    server.append(ServerWindow(number: n, pid: pid, layer: layer, bounds: r, onScreen: on, alpha: alpha, order: server.count + 10))
  }
  func remove(_ n: Int) { server.removeAll { $0.number == n } }
  func move(_ n: Int, _ r: CGRect) { server = server.map { $0.number == n ? ServerWindow(number: n, pid: $0.pid, layer: $0.layer, bounds: r, onScreen: $0.onScreen, alpha: $0.alpha, order: $0.order) : $0 } }
  // The Space showing `n` (and `also`): those on screen, `n` in front; the rest of the browser's off screen.
  func show(_ n: Int?, also: Set<Int> = []) {
    server = server.map { w in
      let on = w.number == n || also.contains(w.number)
      return ServerWindow(number: w.number, pid: w.pid, layer: w.layer, bounds: w.bounds, onScreen: on, alpha: w.alpha, order: w.number == n ? 0 : (on ? 1 : w.number))
    }
  }
  var front: Int? { WindowMatcher.candidates(server, pids: pids).filter(\.onScreen).min { $0.order < $1.order }?.number }

  // The extension's windows.
  func put(_ link: String, _ id: Int, _ r: CGRect?, state: String = "fullscreen", focused: Bool = false, focusedAt: Double? = nil, createdAt: Double? = nil,
           visible: Bool? = nil, visibleAt: Double? = nil, blurredAt: Double? = nil) {
    var list = ext[link] ?? []
    let w = ExtWindow(key: WindowKey(link: link, windowId: id), bounds: r, state: state, focused: focused, activeTabId: nil, focusedAt: focusedAt, createdAt: createdAt,
                      visible: visible, visibleAt: visibleAt, blurredAt: blurredAt)
    if let i = list.firstIndex(where: { $0.key.windowId == id }) { list[i] = w } else { list.append(w) }
    ext[link] = list
    if copies[link] == nil { copies[link] = "copy-\(link)" }
  }
  func close(_ link: String, _ id: Int) { ext[link]?.removeAll { $0.key.windowId == id } }
  func get(_ key: WindowKey) -> ExtWindow? { ext[key.link]?.first { $0.key == key } }
  func set(_ key: WindowKey, bounds: CGRect? = nil, state: String? = nil, focused: Bool? = nil, focusedAt: Double? = nil) {
    guard let w = get(key) else { return }
    put(key.link, key.windowId, bounds ?? w.bounds, state: state ?? w.state, focused: focused ?? w.focused, focusedAt: focusedAt ?? w.focusedAt, createdAt: w.createdAt,
        visible: w.visible, visibleAt: w.visibleAt, blurredAt: w.blurredAt)
  }
  // A window's page in front saying it's shown or hidden (nil: it said nothing, or its word was forgotten).
  func say(_ key: WindowKey, visible: Bool?, at: Double? = nil) {
    guard let w = get(key) else { return }
    put(key.link, key.windowId, w.bounds, state: w.state, focused: w.focused, focusedAt: w.focusedAt, createdAt: w.createdAt,
        visible: visible, visibleAt: visible == nil ? nil : at ?? t, blurredAt: w.blurredAt)
  }
  // Margin.app hearing the active Space changed (now, or `ago` seconds back).
  func spaceChanged(ago: Double = 0) { spaceAt = t - ago }
  // A window's word forgotten (another tab shown in it: background/link.js tabActivated), its new tab
  // saying it again `after` seconds later (if its page can).
  func forget(_ key: WindowKey, after: Double) {
    say(key, visible: nil)
    guard let n = truth[key], !silent.contains(key) else { return }
    let on = server.first { $0.number == n }?.onScreen ?? false
    let at = max(t + after, (pageLast[key] ?? -.infinity) + 0.001)
    pageLast[key] = at
    pageTarget[key] = on
    pageDue.append((at, key, on))
  }
  // A copy's flags: `key` focused, its other windows not (each copy says only of its own).
  func flags(_ link: String, focused key: WindowKey?) {
    for w in ext[link] ?? [] { set(w.key, focused: w.key == key) }
  }
  // The focus moving to `key`: heard by its copy at `at` (default now), its flag with it; the other copies' flags left as they were.
  func focus(_ key: WindowKey, at: Double? = nil) {
    let when = at ?? t
    for w in ext[key.link] ?? [] { set(w.key, focused: w.key == key) }
    set(key, focusedAt: when)
  }
  var said: String { lines.joined(separator: "\n") }
}

// A tiny seeded generator (SplitMix64): the same seed, the same run.
struct Seeded {
  var state: UInt64
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
  mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
  mutating func range(_ a: Double, _ b: Double) -> Double { a + (b - a) * unit() }
  mutating func pick<T>(_ list: [T]) -> T { list[Int(next() % UInt64(list.count))] }
  mutating func chance(_ p: Double) -> Bool { unit() < p }
}

extension Tests {
  static func windowBinding() {
    let A = "safari:A", B = "safari:B"
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let second = CGRect(x: 1512, y: -100, width: 1920, height: 1080) // another display's full screen
    let left = CGRect(x: 40, y: 60, width: 900, height: 700), right = CGRect(x: 600, y: 120, width: 820, height: 640)
    func k(_ link: String, _ id: Int) -> WindowKey { WindowKey(link: link, windowId: id) }

    // ---- parsing ----
    let parsed = ExtWindow.parse([["windowId": 7, "left": 0, "top": 0, "width": 1512, "height": 982, "state": "fullscreen", "focused": true, "activeTabId": 3, "focusedAt": 1_800_000_000_500, "createdAt": 1_800_000_000_000],
                                  ["id": 8, "state": "minimized"], ["nope": 1]], link: A)
    check("windows parsed (id or windowId; none without one), focusedAt and createdAt in seconds", parsed.count == 2 && parsed[0].bounds == screen && parsed[0].focused && parsed[0].activeTabId == 3
          && parsed[0].focusedAt == 1_800_000_000.5 && parsed[0].createdAt == 1_800_000_000 && parsed[1].bounds == nil && parsed[1].state == "minimized" && parsed[1].focusedAt == nil)

    // ---- one window: its bounds ----
    do {
      let w = World()
      w.add(100, screen, on: true)
      w.put(A, 7, screen, focused: true)
      w.truth = [k(A, 7): 100]
      check("one window: bound by its bounds at the first read", w.read() == [k(A, 7): 100])
      check("and the log says why, in one line", w.lines.count == 1 && w.said.contains("safari:A#7 is window 100: the only free window with its bounds (0,0 1512×982)"), w.said)
      let before = w.lines.count
      w.run(5)
      check("reads that change nothing log nothing", w.lines.count == before, w.said)
    }
    for (label, server, ext) in [
      ("a few points off: still it", ServerWindow(number: 100, pid: 1, bounds: screen.offsetBy(dx: 3, dy: -2)), screen),
    ] {
      let w = World(); w.server = [server]; w.put(A, 7, ext)
      check(label, w.read() == [k(A, 7): 100])
    }
    for (label, server, state) in [
      ("far off: not it", ServerWindow(number: 100, pid: 1, bounds: screen.insetBy(dx: 40, dy: 40)), "fullscreen"),
      ("another app's window with the same bounds: not it", ServerWindow(number: 100, pid: 2, bounds: screen), "fullscreen"),
      ("a browser window of another layer (a menu, the toolbar in full screen): not it", ServerWindow(number: 100, pid: 1, layer: 25, bounds: screen), "fullscreen"),
      ("an invisible one: not it", ServerWindow(number: 100, pid: 1, bounds: screen, alpha: 0), "fullscreen"),
      ("a minimized window: not bound", ServerWindow(number: 100, pid: 1, bounds: screen), "minimized"),
    ] {
      let w = World(); w.server = [server]; w.put(A, 7, screen, state: state)
      check(label, w.read().isEmpty)
    }
    check("a popover-sized window isn't a browser window", WindowMatcher.candidates([ServerWindow(number: 1, pid: 1, bounds: CGRect(x: 0, y: 0, width: 300, height: 80))], pids: [1]).isEmpty)

    // ---- two profiles' windows with the same id, side by side ----
    do {
      let w = World()
      w.add(300, right, on: true); w.add(301, left, on: true)
      w.put(A, 7, left, state: "normal"); w.put(B, 7, right, state: "normal")
      check("two profiles' windows with the same id: told apart by link and bounds", w.read() == [k(A, 7): 301, k(B, 7): 300])
    }

    // ---- full screen and not; other Spaces; two displays ----
    do {
      let w = World()
      w.add(100, screen, on: false); w.add(101, left, on: true); w.add(102, second, on: true)
      w.put(A, 1, screen); w.put(A, 2, left, state: "normal"); w.put(B, 3, second)
      w.truth = [k(A, 1): 100, k(A, 2): 101, k(B, 3): 102]
      check("one full screen (on another Space), one not, one full screen on another display: each by its bounds", w.read() == w.truth)
    }

    // ---- two full-screen windows, same bounds, from a relaunch ----
    // The copies' focused flags as Safari may give them: only the key window (`global`), or each profile's last focused (`each`).
    do {
      let w = World()
      w.add(12812, screen, on: true); w.add(12881, screen, on: false); w.show(12812)
      w.put(A, 74, screen, focused: true); w.put(B, 1169, screen, focused: false)
      w.truth = [k(A, 74): 12812, k(B, 1169): 12881]
      check("relaunched, two same-bounds full-screen windows: none bound at once", w.read().isEmpty)
      check("and the log says it can't tell yet, once per window", w.lines.filter { $0.contains("isn't bound") }.count == 2 && w.said.contains("2 windows have its bounds (12812, 12881)"), w.said)
      w.run(10)
      // (Safari 2026-11-05: each profile's copy calls its own window focused; a flag says nothing across profiles.)
      check("two profiles' windows, only one called focused, 10 s: settled focus doesn't bind across copies", w.binder.numbers.isEmpty && w.wrong.isEmpty, "\(w.binder.numbers)")
      check("and the log says why, once", w.lines.filter { $0.contains("settled focus can't bind window 12812") }.count == 1
            && w.said.contains("safari: settled focus can't bind window 12812: the windows with its bounds are 2 copies' (safari:A, safari:B): a copy's focus flags only order its own windows"), w.said)
      // The pages say which is shown (each copy of its own window): the front one bound, then the other by elimination.
      w.pages = true
      let seenAt = w.t + 0.25 // the read their word comes with
      w.run(1.5)
      check("their pages saying which is shown: the front one bound (visible), then the other by elimination", w.binder.numbers == w.truth, "\(w.binder.numbers)\n\(w.said)")
      check("within about half a second of the pages' word (reads 0.25 s apart)", (w.binder.bindings[k(A, 74)]?.at ?? .infinity) - seenAt <= 0.55, "\(w.binder.bindings)")
      check("the log has both whys", w.said.contains("safari:A#74 is window 12812: visible: its page alone says it's shown (since ") && w.said.contains("window 12812 the only one on screen with its bounds (2 window(s) with them, all reported)")
            && w.said.contains("safari:B#1169 is window 12881: the only free window with its bounds (0,0 1512×982); 1 other(s) with them already bound"), w.said)
      check("nothing wrong on the way", w.wrong.isEmpty, "\(w.wrong)")
    }
    do {
      // One profile's two full-screen windows: its copy's flag orders them (settled focus, within a copy).
      let w = World()
      w.add(12812, screen); w.add(12881, screen); w.show(12812)
      w.put(A, 74, screen, focused: true); w.put(A, 75, screen)
      w.truth = [k(A, 74): 12812, k(A, 75): 12881]
      w.run(4)
      check("one copy's two same-bounds windows: not before the front window has been the same for 5 s", w.binder.numbers.isEmpty)
      w.run(1.5)
      check("settled focus within one copy: the front one bound, then the other by elimination", w.binder.numbers == w.truth && w.said.contains("safari:A#74 is window 12812: settled focus: the only window its copy calls focused"), "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // The copy heard none of its windows focused after its flag's focus (another profile's window took it).
      let w = World()
      w.add(12812, screen); w.add(12881, screen); w.show(12812)
      w.put(A, 74, screen, focused: true, focusedAt: w.t - 20, blurredAt: w.t - 10); w.put(A, 75, screen)
      w.truth = [k(A, 74): 12812, k(A, 75): 12881]
      w.run(8)
      check("settled focus: a copy that heard a blur after its window's focus doesn't bind it", w.binder.numbers.isEmpty && w.said.contains("settled focus can't bind window 12812: its copy heard none of its windows focused"), w.said)
    }
    do {
      let w = World()
      w.add(12812, screen); w.add(12881, screen); w.show(12812)
      w.put(A, 74, screen, focused: true); w.put(B, 1169, screen, focused: true) // each copy calls its own window focused
      w.truth = [k(A, 74): 12812, k(B, 1169): 12881]
      w.run(3)
      check("relaunched, both copies calling their window focused: nothing bound, nothing guessed", w.binder.numbers.isEmpty && w.wrong.isEmpty)
      // A Space switch: B's window to the front, B's copy hears it focused.
      w.show(12881); w.read(0.03)
      w.focus(k(B, 1169), at: w.t - 0.01); w.read(0.03)
      w.run(2.2, every: 0.1)
      check("a focus change with the front window changing then: B's bound; then A's by elimination", w.binder.numbers == w.truth, "\(w.binder.numbers)\n\(w.said)")
      check("the log: focus moved, with both times", w.said.contains("safari:B#1169 is window 12881: focus moved to it at") && w.said.contains("came to the front by"), w.said)
    }
    do {
      let w = World()
      w.add(12812, screen); w.add(12881, screen); w.add(13000, screen) // a third profile's window, Margin not on there
      w.show(12812)
      w.put(A, 74, screen, focused: true); w.put(B, 1169, screen)
      w.truth = [k(A, 74): 12812, k(B, 1169): 12881]
      w.run(4)
      check("a window of a profile with no linked copy has the same bounds: settled focus doesn't bind (it could be that one)", w.binder.numbers.isEmpty && w.wrong.isEmpty, "\(w.binder.numbers)")
      w.show(12881); w.read(0.05); w.focus(k(B, 1169), at: w.t - 0.02); w.run(2.2, every: 0.1)
      check("a focus change binds the window focused; the other stays unbound (two free windows share its bounds)", w.binder.numbers == [k(B, 1169): 12881] && w.wrong.isEmpty, "\(w.binder.numbers)")
      w.show(12812); w.read(0.05); w.focus(k(A, 74), at: w.t - 0.02); w.run(2.2, every: 0.1)
      check("and the next binds the other", w.binder.numbers == w.truth && w.wrong.isEmpty)
    }

    // ---- the swap in Tirth's log, replayed ----
    // 14:32:20: two profiles, one full-screen window each, already bound. A Space switch from A's
    // (12812) to B's (12881): the front window changes at once; the copies' flags lag and disagree for
    // 650 ms (A still calls #74 focused, B not yet #1169), then catch up, then the switch back.
    do {
      let w = World()
      w.add(12812, screen); w.add(12881, screen); w.show(12812)
      w.put(A, 74, screen, focused: true); w.put(B, 1169, screen)
      w.truth = [k(A, 74): 12812, k(B, 1169): 12881]
      w.pages = true
      w.run(6)
      check("the replay starts bound right", w.binder.numbers == w.truth, "\(w.binder.numbers)")
      for round in 0..<6 {
        let (to, from) = round % 2 == 0 ? (12881, 12812) : (12812, 12881)
        let (gain, lose) = round % 2 == 0 ? (k(B, 1169), k(A, 74)) : (k(A, 74), k(B, 1169))
        w.show(to, also: [from]); w.read(0.033) // mid-swipe: both on screen, the new one in front
        let switched = w.t
        w.run(0.3, every: 0.033)
        w.show(to)
        w.run(0.35, every: 0.033) // 650 ms of flags saying the old window is focused
        w.set(gain, focused: true, focusedAt: switched + 0.02); w.read(0.033) // the copy heard it at the switch, said so late
        w.run(0.2, every: 0.033)
        w.set(lose, focused: false); w.read(0.033)
        if round == 4 { w.set(lose, focused: true); w.run(0.5) } // a copy that keeps calling its window focused
        w.run(1.5, every: 0.1)
      }
      check("the replay: no swap at any read", w.wrong.isEmpty && w.binder.numbers == w.truth, "\(w.wrong.prefix(3))")
      check("and nothing in the log about bindings changing", !w.said.contains("no longer") && !w.said.contains("(was "), w.said)
    }

    // ---- focus evidence against a binding ----
    do {
      let w = World()
      w.add(12812, screen); w.add(12881, screen); w.show(12812)
      w.put(A, 74, screen, focused: true); w.put(B, 1169, screen)
      w.truth = [k(A, 74): 12812, k(B, 1169): 12881]
      w.pages = true
      w.run(6)
      w.pages = false // (from here on, the pages say nothing)
      // Suppose the bindings were wrong (learned from something that misled): swap the truth.
      w.truth = [k(A, 74): 12881, k(B, 1169): 12812]
      w.wrong = []
      w.show(12881); w.read(0.05); w.focus(k(A, 74), at: w.t - 0.02); w.run(2.2, every: 0.1)
      check("one focus change against a binding: kept, and logged", w.binder.numbers == [k(A, 74): 12812, k(B, 1169): 12881] && w.said.contains("kept (a second focus change saying so would move it)"), w.said)
      w.show(12812); w.read(0.05); w.focus(k(B, 1169), at: w.t - 0.02); w.run(2.2, every: 0.1)
      w.show(12881); w.read(0.05); w.focus(k(A, 74), at: w.t - 0.02); w.run(2.2, every: 0.1)
      check("a second one saying the same: moved, the other window then by elimination", w.binder.numbers == w.truth, "\(w.binder.numbers)\n\(w.said)")
      check("the log: two focus changes said so, and what it was", w.said.contains("(was 12812): two focus changes said so"), w.said)
    }

    // ---- windows closed, created, the one-window profile switch ----
    do {
      let w = World()
      w.add(100, screen); w.add(200, screen); w.show(100)
      w.put(A, 1, screen, focused: true); w.put(A, 2, screen)
      w.truth = [k(A, 1): 100, k(A, 2): 200]
      w.run(6)
      check("two full-screen windows of one profile: bound (settled, then elimination)", w.binder.numbers == w.truth, "\(w.binder.numbers)")
      // Window 2 closed; its window server window lingers a moment; a new window 3 opens in full screen.
      w.close(A, 2); w.read()
      check("closed in the browser: its binding dropped, and why", w.binder.numbers == [k(A, 1): 100] && w.said.contains("safari:A#2 is no longer window 200: closed in the browser"))
      w.put(A, 3, screen, createdAt: w.t); w.truth[k(A, 3)] = 300
      w.run(0.5)
      check("a new window's id with only the closing window to match: not bound to it", w.binder.numbers[k(A, 3)] == nil && w.wrong.isEmpty, "\(w.binder.numbers)")
      w.add(300, screen); w.remove(200); w.run(0.5)
      check("its own window listed (the closed one gone): bound", w.binder.numbers[k(A, 3)] == 300 && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // Created together while another same-bounds window is free: told apart by the times.
      let w = World()
      w.add(100, screen); w.add(200, screen); w.add(300, screen); w.show(100)
      w.put(A, 1, screen, focused: true); w.put(A, 2, screen, focused: true); w.put(B, 9, screen) // two focused: no settling
      w.truth = [k(A, 1): 100, k(A, 2): 200, k(B, 9): 300, k(B, 5): 500]
      w.run(2)
      check("nothing told yet", w.binder.numbers.isEmpty)
      w.add(500, screen) // opened in full screen (its own Space)
      w.read(0.1)
      w.put(B, 5, CGRect(x: 0, y: 0, width: 1000, height: 700), state: "normal", createdAt: w.t - 0.05) // the copy's first report: before full screen
      w.read(0.1)
      w.run(0.8)
      w.set(k(B, 5), bounds: screen, state: "fullscreen")
      w.run(1.5)
      check("created together (its copy's onCreated, a new window server window, each alone then), across a full-screen opening", w.binder.numbers[k(B, 5)] == 500 && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      check("the log: created together, with the times", w.said.contains("safari:B#5 is window 500: created together: its copy heard it created at"), w.said)
    }
    do {
      // Two windows created at once with the same bounds: creation can't tell them apart.
      let w = World()
      w.add(100, screen, on: true); w.put(A, 1, screen, focused: true)
      w.run(1)
      let at = w.t
      w.add(200, screen); w.add(201, screen)
      w.put(A, 2, screen, createdAt: at + 0.05); w.put(B, 3, screen, createdAt: at + 0.08)
      w.truth = [k(A, 1): 100, k(A, 2): 200, k(B, 3): 201]
      w.run(6)
      check("two windows created at once with the same bounds: neither bound on a guess", w.binder.numbers == [k(A, 1): 100] && w.wrong.isEmpty, "\(w.binder.numbers)")
    }
    do {
      // Step 4's one-window profile switch: B's copy creates its full-screen window, then A's is closed.
      let w = World()
      w.add(100, screen); w.show(100); w.put(A, 1, screen, focused: true)
      w.truth = [k(A, 1): 100, k(B, 4): 400]
      w.run(1)
      w.add(400, CGRect(x: 0, y: 0, width: 1200, height: 800)); w.read(0.05)
      w.put(B, 4, CGRect(x: 0, y: 0, width: 1200, height: 800), state: "normal", createdAt: w.t - 0.02); w.read(0.05)
      w.move(400, screen); w.show(400, also: [100]); w.run(0.3, every: 0.05)
      w.set(k(B, 4), bounds: screen, state: "fullscreen"); w.focus(k(B, 4), at: w.t - 0.25); w.run(0.3, every: 0.05)
      w.show(400); w.close(A, 1); w.run(0.2, every: 0.05)
      w.remove(100); w.run(1.5, every: 0.1)
      check("one-window profile switch: the new window bound, the old one's binding gone, never crossed", w.binder.numbers == [k(B, 4): 400] && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
    }

    // ---- full screen left and entered again; Space swipes and Mission Control moving windows ----
    do {
      let w = World()
      w.add(100, screen); w.add(200, screen); w.show(100)
      w.put(A, 1, screen, focused: true); w.put(B, 2, screen)
      w.truth = [k(A, 1): 100, k(B, 2): 200]
      w.pages = true; w.run(6)
      // A's window leaves full screen: the window server's bounds first, the copy's a second later.
      let windowed = CGRect(x: 200, y: 100, width: 1000, height: 700)
      w.move(100, CGRect(x: 100, y: 50, width: 1300, height: 900)); w.run(0.3)
      w.move(100, windowed); w.run(0.8)
      w.set(k(A, 1), bounds: windowed, state: "normal"); w.run(1)
      w.move(100, screen); w.run(1.2) // and back into full screen, the copy late again
      w.set(k(A, 1), bounds: screen, state: "fullscreen"); w.run(1)
      check("leaving and entering full screen (bounds disagreeing on the way): bindings held", w.binder.numbers == w.truth && w.wrong.isEmpty && !w.said.contains("no longer"), w.said)
      // Mission Control or a swipe: both windows on screen, the window server's bounds moving (both still for a while).
      w.show(100, also: [200])
      w.move(100, CGRect(x: 50, y: 300, width: 600, height: 390)); w.move(200, CGRect(x: 800, y: 300, width: 600, height: 390)); w.run(4)
      w.move(100, screen); w.move(200, screen); w.show(200); w.read(); w.focus(k(B, 2), at: w.t - 0.1); w.run(2)
      check("Mission Control: bindings held while the windows were shown small, and after", w.binder.numbers == w.truth && w.wrong.isEmpty && !w.said.contains("no longer"), w.said)
    }
    do {
      // A binding whose window's bounds match another free window alone, steadily: moved (a wrong binding mended).
      let w = World()
      w.add(100, left, on: true); w.put(A, 1, left, state: "normal")
      w.run(1)
      w.add(101, right, on: true); w.move(100, CGRect(x: 1000, y: 500, width: 400, height: 300))
      w.set(k(A, 1), bounds: right)
      w.run(1)
      check("its bounds matching another free window for a moment: kept", w.binder.numbers == [k(A, 1): 100])
      w.run(2)
      check("for 2 s, both still: moved to it, and why", w.binder.numbers == [k(A, 1): 101] && w.said.contains("safari:A#1 is window 101 (was 100): its bounds"), w.said)
    }

    // ---- links: dropped a moment, a new copy, gone; the browser quitting ----
    do {
      let w = World()
      w.add(100, screen); w.add(200, screen); w.show(100)
      w.put(A, 1, screen, focused: true); w.put(B, 2, screen)
      w.truth = [k(A, 1): 100, k(B, 2): 200]
      w.pages = true; w.run(6)
      let a = w.ext.removeValue(forKey: A)
      w.held = [A]; w.run(2)
      check("a link dropped a moment (held): its bindings kept", w.binder.numbers == w.truth)
      w.held = []; w.ext[A] = a; w.run(1)
      check("back, the same copy: still kept", w.binder.numbers == w.truth && !w.said.contains("no longer"))
      w.copies[A] = "copy-A-2"; w.read()
      check("a new copy of Margin in that profile (ids may be new): its bindings dropped, and why", w.said.contains("safari:A#1 is no longer window 100: a new copy of Margin started"), w.said)
      w.run(0.5)
      check("then learned again (elimination: the other is bound)", w.binder.numbers == w.truth, "\(w.binder.numbers)")
      w.ext[B] = nil; w.read()
      check("a link gone for good: its bindings dropped", w.binder.numbers == [k(A, 1): 100] && w.said.contains("safari:B#2 is no longer window 200: its copy isn't linked"))
      w.server = []; w.pids = []; w.read()
      check("the browser quitting: every binding dropped, and why", w.binder.numbers.isEmpty && w.said.contains("safari:A#1 is no longer window 100: window 100 is gone from the window server"))
    }

    // ---- the app's profile switch (ProfileSwitch.swift), both ways: openSpaceWindow's window bound as Margin made it ----
    for lingering in [false, true] {
      let w = World()
      w.add(100, screen); w.show(100); w.put(A, 7, screen, focused: true)
      w.truth = [k(A, 7): 100, k(B, 90): 400, k(A, 91): 500]
      w.run(1)
      check("switch\(lingering ? ", the old window lingering" : ""): A's window bound first", w.binder.numbers == [k(A, 7): 100])
      var made: [String] = []
      for (fromKey, fromN, toKey, toN) in [(k(A, 7), 100, k(B, 90), 400), (k(B, 90), 400, k(A, 91), 500)] {
        let asked = w.t
        // The window server lists the new window as it opens (a normal window first), the copy answers with its id…
        w.add(toN, CGRect(x: 0, y: 0, width: 1100, height: 760)); w.read(0.05)
        w.binder.expect(toKey, since: asked, now: w.t, why: "made by Margin's openSpaceWindow")
        w.read(0.05) // …and its window list comes a moment later
        w.put(toKey.link, toKey.windowId, CGRect(x: 0, y: 0, width: 1100, height: 760), state: "normal", createdAt: asked + 0.02)
        w.read(0.05)
        // Full screen: the window server first, the copy late; macOS slides to the new Space (both on screen a moment).
        w.move(toN, screen); w.show(toN, also: [fromN]); w.read(0.05)
        let early = w.binder.numbers[toKey]
        w.run(0.3, every: 0.05)
        w.set(toKey, bounds: screen, state: "fullscreen")
        w.read(0.05)
        made.append(w.binder.numbers[toKey] == toN && early == toN ? "bound at once" : "not: \(w.binder.numbers)")
        // The old one's copy still calls it focused (lagging); the new one's copy hears its focus late.
        w.show(toN); w.run(0.2, every: 0.05)
        w.focus(toKey, at: w.t - 0.5)
        // The switch closes the old window: the copy's list first, the window server's after (or a while after).
        w.close(fromKey.link, fromKey.windowId); w.read(0.05)
        if lingering { w.run(1, every: 0.1) }
        w.remove(fromN); w.run(2.5, every: 0.1)
      }
      check("switch\(lingering ? ", the old window lingering" : ""): each new window bound as soon as its bounds agreed (made by Margin), both ways", made == ["bound at once", "bound at once"], "\(made)\n\(w.said)")
      check("switch\(lingering ? ", the old window lingering" : ""): the old windows' bindings dropped as they closed, nothing wrong on the way", w.binder.numbers == [k(A, 91): 500] && w.wrong.isEmpty
            && w.said.contains("safari:A#7 is no longer window 100: closed in the browser") && w.said.contains("safari:B#90 is no longer window 400: closed in the browser"), "\(w.binder.numbers) \(w.wrong)\n\(w.said)")
      check("switch: the log says it was Margin's own window", w.said.contains("safari:B#90 is window 400: made by Margin's openSpaceWindow at"), w.said)
    }

    // ---- the window server's list blips (Tirth's log, 2026-11-05 21:53:39) ----
    // Three profiles, one full-screen window each, all with the same bounds; the third's bound by a
    // focus change. Its window missing from one read and listed again 42 ms later, then every one of
    // the browser's windows missing from a read: the binding holds, with no number free for another.
    let C = "safari:C"
    func three() -> World {
      let w = World()
      w.add(18278, screen); w.add(18285, screen); w.add(18342, screen); w.show(18278)
      w.put(A, 155, screen, focused: true); w.put(B, 153, screen, focused: true); w.put(C, 795, screen, focused: true) // each copy calls its own focused
      w.truth = [k(A, 155): 18278, k(B, 153): 18285, k(C, 795): 18342]
      w.run(2)
      w.show(18342); w.read(0.05); w.focus(k(C, 795), at: w.t - 0.02); w.run(2.4, every: 0.1)
      return w
    }
    do {
      let w = three()
      check("blips: the third profile's window bound by its focus change (the others can't be told)", w.binder.numbers == [k(C, 795): 18342], "\(w.binder.numbers)\n\(w.said)")
      let before = w.lines.count
      w.blipped = [18342]; w.read(0.25)
      check("blips: its window missing from one read: the binding kept, counted as missing", w.binder.numbers == [k(C, 795): 18342] && w.binder.absentNumbers == [18342], "\(w.binder.numbers)")
      check("blips: and the log says so once, kept for 3 s", w.lines.suffix(from: before).filter { $0.contains("missing from one read") }.count == 1
            && w.said.contains("safari:C#795: window 18342 missing from one read (kept for 3 s)"), w.said)
      w.blipped = []; w.read(0.042)
      check("blips: listed again 42 ms later: the same binding, nothing missing", w.binder.numbers == [k(C, 795): 18342] && w.binder.absentNumbers.isEmpty)
      check("blips: and the log says it's back, after how long", w.lines.last == "safari:C#795: window 18342 back after 42 ms", "\(w.lines.suffix(3))")
      w.collapse = true; w.read(0.25)
      check("blips: a read without any of the browser's windows: the binding kept", w.binder.numbers == [k(C, 795): 18342] && w.binder.lastReadCollapsed && w.binder.absentNumbers == [18342])
      w.read(0.033); w.read(0.033)
      w.collapse = false; w.read(0.033)
      check("blips: back: not counted as missing, and the read told something again", w.binder.absentNumbers.isEmpty && !w.binder.lastReadCollapsed)
      let collapsedLines = w.lines.suffix(from: before).filter { $0.contains("without the browser's windows") }
      // (The first blip too: a read without every bound window tells nothing either.)
      check("blips: each read without them said once, with the counts and where the bound window was", collapsedLines.count == 2
            && collapsedLines[0].hasPrefix("safari: a read of the window server without the browser's windows (2 entries, 2 the browser's, 2 at layer 0; window 18342 not listed): bindings kept")
            && collapsedLines[1].hasPrefix("safari: a read of the window server without the browser's windows (0 entries, 0 the browser's, 0 at layer 0; window 18342 not listed): bindings kept"), "\(collapsedLines)")
      check("blips: each such line says what the last read that told something had, and what the source gave", collapsedLines.count == 2
            && collapsedLines[0].hasSuffix("; the last read that told something had 3 at layer 0; the source gave a list")
            && collapsedLines[1].hasSuffix("; the last read that told something had 3 at layer 0; the source gave an empty list"), "\(collapsedLines)")
      let wholeAgain = w.lines.suffix(from: before).filter { $0.contains("has the browser's windows again") }
      check("blips: each episode's end one line, with how long and how many reads told nothing", wholeAgain == [
        "safari: the window server's list has the browser's windows again after 42 ms (1 read told nothing)",
        "safari: the window server's list has the browser's windows again after 99 ms (3 reads told nothing)",
      ], "\(wholeAgain)")
      check("blips: back after the read without any: said once, after how long", w.lines.suffix(from: before).filter { $0.hasPrefix("safari:C#795: window 18342 back after") } == [
        "safari:C#795: window 18342 back after 42 ms", "safari:C#795: window 18342 back after 99 ms",
      ], w.lines.suffix(from: before).joined(separator: "\n"))
      w.run(20)
      check("blips: 20 s on, still bound; never 'no longer', nothing wrong", w.binder.numbers == [k(C, 795): 18342] && !w.said.contains("is no longer") && w.wrong.isEmpty, w.said)
      check("blips: no 'can't be told' lines churned by the blips", w.lines.suffix(from: before).filter { $0.contains("isn't bound") }.isEmpty, w.lines.suffix(from: before).joined(separator: "\n"))
    }
    do {
      // Each focus event weighed has its outcome in the log, the ones that change nothing too.
      let w = three()
      w.show(18278); w.run(2)
      w.show(18342); w.read(0.05); w.focus(k(C, 795), at: w.t - 0.02); w.run(2.4, every: 0.1)
      check("focus events: one that agrees with its window's binding says so", w.lines.contains { $0.hasPrefix("safari:C#795: focus heard at ") && $0.contains(" agrees with its binding (window 18342 came to the front by ") },
            w.said)
      w.show(18278); w.run(2)
      w.show(18342); w.read(0.05); w.focus(k(C, 795), at: w.t - 0.02); w.read(0.05)
      w.close(C, 795); w.run(2.4, every: 0.1)
      check("focus events: one for a window its copy no longer reports says so", w.lines.contains { $0.hasPrefix("safari:C#795: focus heard at ") && $0.hasSuffix(" not used: its copy no longer reports it") }, w.said)
      // The visible rule not weighed at all (the browser not in front): why, once per change of reason.
      let lines = w.lines.count
      w.inFront = false; w.run(1)
      w.inFront = true; w.run(1)
      w.inFront = false; w.run(1)
      let off = w.lines.suffix(from: lines).filter { $0.contains("the visible rule not weighed") }
      check("visible rule: not weighed while the browser isn't in front, said once each time", off == Array(repeating: "safari: the visible rule not weighed: the browser isn't in front", count: 2), "\(off)")
    }
    do {
      // Every same-bounds window missing for 0.4 s (reads in a burst), with no list at all for some.
      let w = World()
      w.add(100, screen); w.add(200, screen); w.add(300, screen); w.add(900, screen) // 900: a profile with no linked copy
      w.show(100)
      w.put(A, 1, screen, focused: true); w.put(B, 2, screen); w.put(C, 3, screen)
      w.truth = [k(A, 1): 100, k(B, 2): 200, k(C, 3): 300]
      w.run(2)
      w.show(200); w.read(0.05); w.focus(k(B, 2), at: w.t - 0.02); w.run(2.4, every: 0.1)
      w.show(100); w.read(0.05); w.focus(k(A, 1), at: w.t - 0.02); w.run(2.4, every: 0.1)
      check("collapse: two bound by focus changes, the third can't be told (two free windows with its bounds)", w.binder.numbers == [k(A, 1): 100, k(B, 2): 200], "\(w.binder.numbers)")
      let changes = w.binder.frontChanges.count, lines = w.lines.count
      w.collapse = true
      for i in 0..<12 { w.noList = i % 4 == 3; w.read(0.033) }
      w.noList = false
      check("collapse: 0.4 s without the browser's windows: every binding kept", w.binder.numbers == [k(A, 1): 100, k(B, 2): 200] && w.binder.absentNumbers == [100, 200])
      check("collapse: no front change noted", w.binder.frontChanges.count == changes, "\(w.binder.frontChanges)")
      w.collapse = false; w.run(3)
      check("collapse: back: nothing new bound, nothing dropped, nothing wrong", w.binder.numbers == [k(A, 1): 100, k(B, 2): 200] && w.wrong.isEmpty && !w.said.contains("no longer"), w.said)
      check("collapse: and the front change count still the same (no change through nil and back)", w.binder.frontChanges.count == changes)
      check("collapse: one line for the episode", w.lines.suffix(from: lines).filter { $0.contains("without the browser's windows") || $0.contains("gave no list") }.count == 1, w.lines.suffix(from: lines).joined(separator: "\n"))
      w.noList = true; w.read(0.25); w.noList = false; w.read(0.25)
      check("collapse: no list at all: said as such", w.said.contains("safari: the window server gave no list (0 entries"), w.said)
    }
    do {
      // The front window alone missing for a few reads, nothing else in front: no front change noted.
      let w = World()
      w.add(100, screen); w.add(200, screen); w.show(100)
      w.put(A, 1, screen, focused: true); w.put(B, 2, screen)
      w.truth = [k(A, 1): 100, k(B, 2): 200]
      w.pages = true; w.run(6)
      let changes = w.binder.frontChanges.count
      w.blipped = [100]; w.run(0.3, every: 0.1); w.blipped = []; w.read(0.1)
      check("the front window missing for 0.3 s: no front change noted, bindings held", w.binder.frontChanges.count == changes && w.binder.numbers == w.truth, "\(w.binder.frontChanges)")
    }
    do {
      // Missing past the grace: gone, dropped once, with why.
      let w = World()
      w.add(100, screen); w.add(200, screen); w.show(100)
      w.put(A, 1, screen, focused: true); w.put(B, 2, screen)
      w.truth = [k(A, 1): 100, k(B, 2): 200]
      w.pages = true; w.run(6)
      w.remove(200); w.run(2.9, every: 0.1)
      check("absent: 2.9 s missing: still bound", w.binder.numbers == w.truth)
      w.run(0.3, every: 0.1)
      check("absent: past 3 s: dropped, once, with why", w.binder.numbers == [k(A, 1): 100] && w.lines.filter { $0.contains("is no longer window 200") }.count == 1
            && w.said.contains("safari:B#2 is no longer window 200: window 200 is gone from the window server (not listed for 3 s)"), w.said)
      w.run(5)
      check("absent: and nothing else bound to it after", w.binder.numbers == [k(A, 1): 100] && w.wrong.isEmpty)
    }
    do {
      // Closed in the browser while missing: dropped at once, its number retired (listed again, never bound).
      let w = World()
      w.add(100, screen); w.add(200, screen); w.show(100)
      w.put(A, 1, screen, focused: true); w.put(A, 2, screen)
      w.truth = [k(A, 1): 100, k(A, 2): 200]
      w.run(6)
      w.blipped = [200]; w.read(0.05)
      w.close(A, 2); w.read(0.05)
      check("absent, then closed in the browser: dropped at once, with why", w.binder.numbers == [k(A, 1): 100] && w.said.contains("safari:A#2 is no longer window 200: closed in the browser"), w.said)
      w.blipped = []
      w.put(A, 3, screen); w.truth[k(A, 3)] = 300
      w.run(2)
      check("absent, then closed: its number listed again isn't bound to another window", w.binder.numbers[k(A, 3)] == nil && w.wrong.isEmpty, "\(w.binder.numbers)")
      w.remove(200); w.add(300, screen); w.run(1)
      check("absent, then closed: the new window's own bound once it's listed", w.binder.numbers[k(A, 3)] == 300 && w.wrong.isEmpty, "\(w.binder.numbers)")
    }
    do {
      // A closed window's number that blips stays closed.
      let w = World()
      w.add(100, screen); w.add(200, screen); w.show(100)
      w.put(A, 1, screen, focused: true); w.put(A, 2, screen)
      w.truth = [k(A, 1): 100, k(A, 2): 200]
      w.run(6)
      w.close(A, 2); w.read() // its window lingers a moment
      w.blipped = [200]; w.read(0.033); w.blipped = []; w.read(0.033)
      w.put(A, 3, screen); w.truth[k(A, 3)] = 300
      w.run(1.5)
      check("a retired number that blips stays retired: a new window isn't bound to it", w.binder.numbers[k(A, 3)] == nil && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      w.remove(200); w.add(300, screen); w.run(0.5)
      check("and its own window is bound once listed", w.binder.numbers[k(A, 3)] == 300 && w.wrong.isEmpty, "\(w.binder.numbers)")
    }
    do {
      // A blip as a new window is created: the window back from the blip isn't the new one.
      let w = World()
      w.add(100, screen); w.add(200, screen); w.add(900, screen); w.add(901, screen); w.show(100) // 900, 901: profiles with no linked copy
      w.put(A, 1, screen, focused: true); w.put(B, 2, screen)
      w.truth = [k(A, 1): 100, k(B, 2): 200, k(B, 3): 300]
      w.run(2)
      w.show(200); w.read(0.05); w.focus(k(B, 2), at: w.t - 0.02); w.run(2.4, every: 0.1)
      w.show(100); w.read(0.05); w.focus(k(A, 1), at: w.t - 0.02); w.run(2.4, every: 0.1)
      check("created in a blip: set up (two bound, 900 and 901 not theirs)", w.binder.numbers == [k(A, 1): 100, k(B, 2): 200], "\(w.binder.numbers)")
      w.blipped = [900]; w.read(0.1)
      w.put(B, 3, screen, createdAt: w.t); w.read(0.1)
      w.blipped = []; w.read(0.05)
      w.run(2.4, every: 0.1) // its own window slow to come (a full-screen opening)
      w.add(300, screen); w.run(3)
      check("created in a blip: never bound to the window back from the blip", w.wrong.isEmpty, "\(w.wrong)\n\(w.said)")
    }
    do {
      // A blip during the profile switch's openSpaceWindow: the window back from it isn't Margin's new one.
      let w = World()
      w.add(100, screen); w.add(900, screen); w.show(100); w.put(A, 7, screen, focused: true)
      w.truth = [k(A, 7): 100, k(B, 90): 400]
      w.run(2)
      let asked = w.t
      w.blipped = [900]; w.read(0.05)
      w.binder.expect(k(B, 90), since: asked, now: w.t, why: "made by Margin's openSpaceWindow")
      w.blipped = []; w.read(0.05)
      w.put(B, 90, screen, createdAt: asked + 0.02); w.run(0.5, every: 0.05) // its copy already says full screen
      check("switch in a blip: not bound to the window back from the blip", w.binder.numbers[k(B, 90)] == nil && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      w.add(400, CGRect(x: 0, y: 0, width: 1100, height: 760)); w.read(0.05)
      w.move(400, screen); w.run(0.5, every: 0.05)
      check("switch in a blip: bound to its own new window", w.binder.numbers[k(B, 90)] == 400 && w.wrong.isEmpty && w.said.contains("safari:B#90 is window 400: made by Margin's openSpaceWindow"), "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // Real goings, as in the logs (19:30:51, 19:33:58, 19:37:19): the window gone, the link down a moment
      // later, then a new copy with a new window number: re-bound as soon as it's listed.
      let w = World()
      w.add(14375, screen, on: true); w.put(A, 1, screen, focused: true)
      w.truth = [k(A, 1): 14375]
      w.run(1)
      w.remove(14375); w.read(0.25)
      check("real going: the window gone, kept a moment", w.binder.numbers == [k(A, 1): 14375])
      w.ext[A] = nil; w.read(0.003)
      check("real going: the link down: dropped at once (its copy isn't linked)", w.binder.numbers.isEmpty && w.said.contains("safari:A#1 is no longer window 14375: its copy isn't linked"), w.said)
      w.run(0.5)
      w.copies[A] = "copy-A-2"; w.put(A, 1, screen, focused: true); w.truth = [k(A, 1): 15910]
      w.add(15910, screen, on: true); w.read(0.1)
      check("real going: the new copy's window bound at the first read that lists it", w.binder.numbers == [k(A, 1): 15910] && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // A window replaced in one read (gone, a new number, the copy's id the same): bound to the new one at once.
      let w = World()
      w.add(15875, screen, on: true); w.put(A, 1, screen, focused: true)
      w.truth = [k(A, 1): 15875]
      w.run(1)
      w.remove(15875); w.add(15910, screen, on: true); w.close(A, 1); w.put(A, 2, screen, focused: true); w.truth = [k(A, 2): 15910]
      w.read(0.25)
      check("a window replaced in one read: the old dropped, the new bound at once", w.binder.numbers == [k(A, 2): 15910] && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // The browser quitting with its links held (reconnecting): its bindings go after the grace.
      let w = World()
      w.add(100, screen, on: true); w.put(A, 1, screen, focused: true)
      w.run(1)
      let a = w.ext.removeValue(forKey: A); _ = a
      w.held = [A]; w.server = []; w.run(2.5)
      check("held, its window gone: kept for the grace", w.binder.numbers == [k(A, 1): 100])
      w.run(1)
      check("held, its window gone 3 s: dropped", w.binder.numbers.isEmpty && w.said.contains("safari:A#1 is no longer window 100: window 100 is gone from the window server (not listed for 3 s)"), w.said)
    }

    // ---- the pages say which window is shown (Tirth's log, 2026-11-05 21:52-21:56) ----
    // Three profiles, one full-screen window each, all with the same bounds, each in its own Space; each
    // copy calls its own window focused. Their pages say whether they're shown, a moment after the window
    // server shows or hides their window.
    func threeShown(lag: @escaping (WindowKey, Bool) -> Double = { _, _ in 0 }) -> World {
      let w = World()
      w.add(18278, screen); w.add(18285, screen); w.add(18342, screen); w.show(18285)
      w.put(A, 155, screen, focused: true); w.put(B, 153, screen, focused: true); w.put(C, 795, screen, focused: true)
      w.truth = [k(A, 155): 18278, k(B, 153): 18285, k(C, 795): 18342]
      w.pageLag = lag
      return w
    }
    // A Space switch to window `n`: both on screen as macOS slides, then `n` alone; macOS says the Space changed once the slide is over.
    func swipe(_ w: World, to n: Int, from: Int?, slide: Double = 0.3) {
      w.show(n, also: from.map { [$0] } ?? []); w.read(0.033)
      w.run(slide, every: 0.033)
      w.show(n); w.read(0.033)
      w.spaceChanged()
    }
    do {
      // The relaunch at 21:52:20 (Margin.app started with Safari's windows open): the pages say at once.
      let w = threeShown()
      w.pages = true
      w.run(0.75)
      check("visible, relaunch: nothing bound in Margin.app's first second (a switch just before it may not have been said yet)", w.binder.numbers.isEmpty, "\(w.binder.numbers)")
      w.run(1.0)
      check("visible, relaunch: three copies each calling their own window focused: the shown one bound by its page", w.binder.numbers == [k(B, 153): 18285] && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      check("visible, relaunch: the log says why", w.said.contains("safari:B#153 is window 18285: visible: its page alone says it's shown (since ")
            && w.said.contains("window 18285 the only one on screen with its bounds (3 window(s) with them, all reported)"), w.said)
      for (n, from) in [(18342, 18285), (18278, 18342)] { swipe(w, to: n, from: from); w.run(1.6, every: 0.1) }
      check("visible: each of the others bound as its Space is shown", w.binder.numbers == w.truth && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      check("visible: no focus change needed (none heard)", !w.said.contains("focus moved"), w.said)
    }
    do {
      // Tirth's log, 2026-11-06 23:30:19-29: from the bound window to one not bound yet, slowly: both windows
      // offset as they slide, the new page saying it's shown as it starts to slide in, macOS saying the Space
      // changed only once the slide is over. Bound as it slides in, not left unbound after it.
      let w = threeShown { _, visible in visible ? 0.05 : 0.15 }
      w.pages = true
      w.run(3) // (their bounds settled: a window offset in the slide is weighed by them)
      let start = w.binder.numbers
      w.show(18342, also: [18285])
      for step in 1...12 {
        let dx = CGFloat(step) * 120
        w.move(18342, screen.offsetBy(dx: screen.width - dx, dy: 0)); w.move(18285, screen.offsetBy(dx: -dx, dy: 0))
        w.read(0.1)
      }
      let sliding = w.binder.numbers[k(C, 795)]
      w.move(18342, screen); w.move(18285, screen); w.show(18342); w.read(0.033); w.spaceChanged()
      w.run(1, every: 0.1)
      check("visible at once: a window not bound yet bound as it slides in (offset, before macOS says the Space changed), by its page's word since it came on screen",
            start == [k(B, 153): 18285] && sliding == 18342 && w.wrong.isEmpty && w.said.contains("safari:C#795 is window 18342: visible at once: its page alone says it's shown"), "\(start) \(String(describing: sliding)) \(w.wrong.prefix(2))\n\(w.said)")
      check("visible at once: and the last one by elimination", w.binder.numbers == w.truth && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      // The same with the bound window's page slow to say it's hidden (3 s): its window is on screen as the slide
      // starts, so its word explains itself; the new one is still bound as it slides in.
      let v = threeShown { key, visible in visible ? 0.05 : (key == k(B, 153) ? 3 : 0.15) }
      v.pages = true
      v.run(3)
      v.show(18342, also: [18285]); v.run(0.3, every: 0.033)
      let early = v.binder.numbers[k(C, 795)]
      v.show(18342); v.read(0.033); v.spaceChanged(); v.run(4, every: 0.1)
      check("visible at once: the bound window's page slow to say it's hidden: still bound as it slides in, never wrong", early == 18342 && v.binder.numbers == v.truth && v.wrong.isEmpty,
            "\(String(describing: early)) \(v.binder.numbers) \(v.wrong.prefix(2))\n\(v.said)")
    }
    do {
      // The pages lagging the window server by up to 0.6 s, Spaces switched back and forth quickly, then calmly.
      for seed in 1...40 {
        var r = Seeded(state: UInt64(seed * 7919))
        let w = threeShown { _, _ in r.range(0, 0.6) }
        w.pages = true
        w.run(2)
        var current = 18285
        for _ in 0..<10 {
          let next = [18278, 18285, 18342].filter { $0 != current }[Int(r.next() % 2)]
          swipe(w, to: next, from: current, slide: r.range(0, 0.4))
          w.run(r.range(0.05, 0.5), every: 0.033)
          current = next
        }
        for n in [18278, 18285, 18342].filter({ $0 != current }) + [current] { swipe(w, to: n, from: current); current = n; w.run(2, every: 0.1) }
        if !w.wrong.isEmpty || w.binder.numbers != w.truth {
          check("visible, fast switches (seed \(seed)): never wrong, all bound once each was shown calmly", false, "\(w.wrong.prefix(3)) \(w.binder.numbers)\n\(w.lines.suffix(30).joined(separator: "\n"))")
          break
        }
        if seed == 40 { check("visible, fast switches with the pages lagging up to 0.6 s (40 runs): never wrong, all bound once each was shown calmly", true) }
      }
    }
    do {
      // Nothing said (pages Margin can't run in, or Safari never saying): nothing bound, nothing guessed.
      let w = threeShown()
      w.run(10)
      check("visible: with no page saying, nothing bound", w.binder.numbers.isEmpty && w.wrong.isEmpty, "\(w.binder.numbers)")
      // The page of the window on screen silent: the others' word that they're hidden binds nothing (unknown is never hidden).
      w.silent = [k(B, 153)]
      w.pages = true
      w.run(3)
      check("visible: the shown window's page saying nothing: nothing bound by the others' word that they're hidden", w.binder.numbers.isEmpty && w.wrong.isEmpty, "\(w.binder.numbers)")
      check("visible: and the log says why", w.said.contains("safari: window 18285 (on screen, 0,0 1512×982) not bound from its page: no page with its bounds says it's shown since Margin.app started"), w.said)
      // A page off screen silent: the shown one's word binds its window once the pages have settled (a page shown
      // before may have newly said so and not yet said it's hidden), not before; the silent one isn't bound by it.
      let s = threeShown()
      s.silent = [k(A, 155)]
      s.pages = true
      s.run(2.4)
      check("visible: one page off screen saying nothing: not bound while the pages may still be settling", s.binder.numbers.isEmpty, "\(s.binder.numbers)")
      check("visible: and the log says which", s.said.contains("not bound from its page: safari:A#155 said nothing yet (the pages settling after the last change)"), s.said)
      s.run(1.2)
      check("visible: then the shown one bound by its page, the silent one not", s.binder.numbers == [k(B, 153): 18285] && s.wrong.isEmpty, "\(s.binder.numbers)\n\(s.said)")
      check("visible: and the log says the silent page didn't stop it", s.said.contains("safari:B#153 is window 18285: visible: its page alone says it's shown (since ") && s.said.contains("; safari:A#155 said nothing, the others hidden"), s.said)
    }
    do {
      // Tirth's log, 2026-11-06 21:24:30-21:25:05: Safari reopened with five profiles, one full-screen window each,
      // all with the same bounds, each on its own Space. The copies link one by one over 10 s; three pages said
      // they're hidden before their copies linked, one never says (its tab not loaded), and the one whose window
      // a Space slide brought on screen (Safari not in front) said it's shown as the slide began, its word heard
      // 3 s late; Safari came to the front 2.5 s after the slide. Nothing was bound and nothing drawn.
      let fs = CGRect(x: 0, y: 33, width: 1512, height: 949)
      let D = "safari:s-default", P2 = "safari:s-4282", P3 = "safari:s-defee", P4 = "safari:s-27f6", P5 = "safari:s-8d45"
      func startup() -> World {
        let w = World()
        for n in [50775, 50782, 50790, 50798, 50802] { w.add(n, fs) }
        w.show(50802)
        w.truth = [k(D, 85): 50775, k(P2, 117): 50782, k(P3, 167): 50790, k(P4, 199): 50798, k(P5, 140): 50802]
        let t0 = w.t
        w.spaceChanged(ago: 1.4)
        w.run(1)
        // The first two copies link (held for a read, then their state), each calling its own window focused.
        w.held = [P2]; w.read(0.05); w.held = []
        w.put(P2, 117, fs, focused: true, visible: false, visibleAt: t0 - 1.4)
        w.held = [D]; w.read(0.1); w.held = []
        w.put(D, 85, fs, focused: true, focusedAt: t0 - 0.9)
        w.run(1.9)
        // A Space slide to s-default's window, Safari not in front: its page shown as the slide begins.
        w.inFront = false
        w.show(50775, also: [50802]); w.read(0.03)
        let shownAt = w.t
        w.run(0.1, every: 0.03)
        w.show(50775); w.read(0.03)
        w.spaceChanged()
        w.run(2.4)
        w.say(k(D, 85), visible: true, at: shownAt) // heard 3 s late
        w.inFront = true // Safari to the front, over the Space already showing
        w.run(2)
        w.held = [P3]; w.read(0.05); w.held = []
        w.put(P3, 167, fs, focused: false, focusedAt: t0 - 1.5, visible: false, visibleAt: t0 - 1.5, blurredAt: t0 - 1.5)
        w.run(2.7)
        // The last two: one hidden, one that never says.
        w.held = [P4, P5]; w.read(0.05); w.held = []
        w.put(P4, 199, fs, focusedAt: t0 - 1.6, blurredAt: t0 + 5)
        w.put(P5, 140, fs, focused: true, visible: false, visibleAt: t0 - 1.4)
        return w
      }
      let w = startup()
      let reported = w.t
      w.run(0.6, every: 0.05)
      check("startup, five profiles: the window on screen bound within 0.6 s of the last copy reporting, Safari in front", w.binder.numbers == [k(D, 85): 50775] && w.wrong.isEmpty,
            "\(w.binder.numbers) after \(String(format: "%.2f", w.t - reported)) s\n\(w.said)")
      check("startup: by its page (the silent one didn't stop it)", w.said.contains("safari:s-default#85 is window 50775: visible: its page alone says it's shown (since ")
            && w.said.contains("; safari:s-27f6#199 said nothing, the others hidden"), w.said)
      // Then each Space in turn (Safari in front, each page saying 0.1-0.25 s after its window's change, no focus
      // change heard): each window whose page speaks is bound once its page has said and the others' have
      // settled (1.5 s; 2.5 s after the silent page's window, whose page can't say it's hidden); the silent one
      // waits, and is bound by elimination once it's the only free one.
      w.pages = true
      w.silent = [k(P4, 199)]
      w.pageLag = { _, visible in visible ? 0.1 : 0.25 }
      var from = 50775
      for (key, n, within) in [(k(P3, 167), 50790, 1.5), (k(P4, 199), 50798, 3), (k(P2, 117), 50782, 2.5), (k(P5, 140), 50802, 1.5)] {
        swipe(w, to: n, from: from)
        from = n
        let start = w.t
        while w.binder.numbers[key] == nil && w.t - start < 3 { w.read(0.05) }
        if key == k(P4, 199) {
          check("startup: the silent page's window shown: not bound by the others' word", w.binder.numbers[key] == nil && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
        } else {
          check("startup: \(key)'s Space shown: bound by its page within \(within) s of the slide's end", w.binder.numbers[key] == n && w.t - start <= within && w.wrong.isEmpty,
                "\(w.binder.numbers) after \(String(format: "%.2f", w.t - start)) s\n\(w.lines.suffix(12).joined(separator: "\n"))")
        }
        w.run(0.5, every: 0.05)
      }
      // The same, with the last copies' pages said at various lags (0-3 s) and Safari coming to the front at various
      // times: never wrong at any read, and bound once all have reported with Safari in front.
      for seed in 1...30 {
        var r = Seeded(state: UInt64(seed * 15485863))
        let v = startup()
        if r.chance(0.5) { v.inFront = false; v.run(r.range(0, 2)); v.inFront = true }
        v.run(1.5, every: 0.05)
        if !v.wrong.isEmpty || v.binder.numbers != [k(D, 85): 50775] {
          check("startup (seed \(seed)): bound, never wrong", false, "\(v.wrong.prefix(3)) \(v.binder.numbers)\n\(v.said)")
          break
        }
        if seed == 30 { check("startup, Safari to the front at various times (30 runs): bound once it is, never wrong", true) }
      }
      // The window on screen is the silent page's (its tab not loaded): nothing bound to it by the others' word.
      let q = startup()
      q.truth = [k(D, 85): 50798, k(P2, 117): 50782, k(P3, 167): 50790, k(P4, 199): 50775, k(P5, 140): 50802]
      q.say(k(D, 85), visible: false, at: q.t - 2)
      q.run(4)
      check("startup: the on-screen window's page silent, every other hidden: nothing bound, nothing wrong", q.binder.numbers.isEmpty && q.wrong.isEmpty, "\(q.binder.numbers)\n\(q.said)")
      // A page that newly said it's shown as its window slid away (a tab loading in it), its window not bound yet,
      // its hidden word late by up to 1.5 s, the window coming on screen silent: never bound to it.
      for lateBy in [0.3, 0.9, 1.5] {
        let o = threeShown()
        o.show(18278) // A's window on screen as Margin.app starts
        o.silent = [k(C, 795)]
        o.pages = true
        o.pageLag = { _, _ in 0.1 }
        o.run(1.25) // A's page has said it's shown; its window not bound yet (the pages may be settling)
        o.pages = false
        let free = o.binder.numbers.isEmpty
        o.show(18342, also: [18278]); o.read(0.03)
        o.say(k(A, 155), visible: true, at: o.t) // newly said as its window slides away
        o.run(0.2, every: 0.03)
        o.show(18342); o.read(0.03); o.spaceChanged()
        let end = o.t
        o.run(lateBy, every: 0.05)
        o.say(k(A, 155), visible: false, at: end + 0.05)
        o.run(3, every: 0.05)
        check("slid away: a page newly shown as its free window slid away, hidden \(lateBy) s late, the new window's page silent: never bound wrong",
              free && o.wrong.isEmpty && o.binder.numbers[k(A, 155)] != 18342, "free: \(free) \(o.wrong.prefix(2)) \(o.binder.numbers)\n\(o.lines.suffix(10).joined(separator: "\n"))")
      }
    }
    do {
      // Tirth's log, 2026-11-06 21:25:20: no page can say (Margin updated: the pages' scripts are the old copy's),
      // the focus change says which, but the window was offset by a swipe begun when it was weighed: still bound.
      let fs = CGRect(x: 0, y: 33, width: 1512, height: 949)
      let D = "safari:s-default", P2 = "safari:s-4282", P3 = "safari:s-defee"
      let w = World()
      for n in [50775, 50782, 50802] { w.add(n, fs) }
      w.inFront = false; w.show(50782)
      w.put(D, 828, fs, focused: true); w.put(P2, 825, fs, focused: true); w.put(P3, 842, fs, focused: true)
      w.truth = [k(D, 828): 50775, k(P2, 825): 50782, k(P3, 842): 50802]
      w.run(3)
      w.show(50775); w.inFront = true; w.read(0.05); w.spaceChanged()
      w.focus(k(D, 828), at: w.t + 0.02)
      w.run(1.6, every: 0.1)
      // A swipe toward 50802 begins: 50775 offset, 50802 in front.
      w.move(50775, fs.offsetBy(dx: 3115, dy: 0)); w.show(50802, also: [50775])
      w.run(0.8, every: 0.1)
      check("focus moved: its window offset by a swipe when the change is weighed: bound by its settled bounds", w.binder.numbers[k(D, 828)] == 50775 && w.wrong.isEmpty,
            "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // A window no linked copy reports (a Private window, a profile without Margin) with the same bounds, shown
      // while the page that was shown before still says so (its word late by up to 3 s): never bound to.
      for seed in 1...40 {
        var r = Seeded(state: UInt64(seed * 104729))
        let w = threeShown()
        w.add(900, screen) // the Private window
        var slowHide = false
        w.pageLag = { _, visible in visible ? r.range(0, 0.6) : (slowHide ? r.range(0, 3) : r.range(0, 0.6)) }
        w.pages = true
        w.run(2)
        var current = 18285
        for _ in 0..<8 {
          let next = r.chance(0.5) ? 900 : [18278, 18285, 18342].filter { $0 != current }[Int(r.next() % 2)]
          slowHide = next == 900
          swipe(w, to: next, from: current, slide: r.range(0, 0.4))
          w.run(r.range(0.2, 3.5), every: 0.05)
          current = next
        }
        // Then each reported window shown calmly with its focus change: all three bound.
        slowHide = false
        w.run(1.5, every: 0.1)
        // (The window in front last: one already in front doesn't come forward.)
        let inFrontNow = w.front
        for (key, n) in w.truth.sorted(by: { ($0.value == inFrontNow ? 1 : 0, $0.key) < ($1.value == inFrontNow ? 1 : 0, $1.key) }) {
          w.show(n); w.read(0.05); w.spaceChanged(); w.focus(key, at: w.t - 0.03); w.run(2.5, every: 0.1)
        }
        if !w.wrong.isEmpty || w.binder.numbers.values.contains(900) || w.binder.numbers != w.truth {
          check("visible, a Private window (seed \(seed)): never bound to it, never wrong, the three bound once each is shown with its focus change", false, "\(w.wrong.prefix(3)) \(w.binder.numbers)\n\(w.lines.suffix(30).joined(separator: "\n"))")
          break
        }
        if seed == 40 { check("visible: a same-bounds window no copy reports, shown while another page still says it's shown for up to 3 s (40 runs): never bound to, never wrong, and the three reported windows bound once each is shown with its focus change", true) }
      }
      let w = threeShown()
      w.add(900, screen)
      w.pages = true
      w.run(2)
      swipe(w, to: 900, from: 18285)
      w.run(4)
      check("visible: the Private window shown: nothing bound to it, and the log says why", !w.binder.numbers.values.contains(900)
            && w.said.contains("safari: window 900 (on screen, 0,0 1512×982) not bound from its page: 4 window(s) have its bounds, 3 reported (a Private window, or a profile without Margin?)"), w.said)
    }
    do {
      // The front window and the Space change seen in one read (Tirth's log, 2026-11-05 21:53:03: the front
      // window changed 166 ms before macOS said the Space changed, and the Shell reads at once on the notice).
      // One transition, from the read before: the page's word at the slide's end counts.
      let w = threeShown()
      w.pages = true
      w.run(2)
      check("visible, one read: set up (B bound by its page)", w.binder.numbers == [k(B, 153): 18285], "\(w.binder.numbers)\n\(w.said)")
      w.pageLag = { key, visible in key == k(C, 795) && visible ? 0.1 : 0.05 }
      w.show(18342)
      w.spaceChanged(ago: -0.2) // heard before the read that first sees the new front window
      w.read(0.25)
      w.run(1.5, every: 0.1)
      check("visible: a new front window and the Space change seen in the same read are one transition (the page's word at the slide's end counts)",
            w.binder.numbers[k(C, 795)] == 18342 && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      // A front change seen in a read after the one that heard the Space change, but which may have come
      // before it (the reads between told nothing): the same transition too.
      let v = threeShown()
      v.pages = true
      v.run(2)
      v.pageLag = { key, visible in key == k(C, 795) && visible ? 0.1 : 0.05 }
      v.show(18342)
      v.collapse = true; v.read(0.1) // a read without the browser's windows
      v.spaceChanged(); v.read(0.05)
      v.collapse = false; v.read(0.1)
      v.run(1.5, every: 0.1)
      check("visible: a new front window first seen after reads that told nothing, the Space change heard among them: one transition",
            v.binder.numbers[k(C, 795)] == 18342 && v.wrong.isEmpty, "\(v.binder.numbers)\n\(v.said)")
    }
    do {
      // One page silent (Safari's own page in front, a PDF): the windows whose pages speak are still bound,
      // each as it's shown with its focus change (focus moved), never wrong; the silent one waits.
      let w = threeShown()
      w.silent = [k(A, 155)]
      w.pages = true
      w.run(2)
      for (key, n) in [(k(C, 795), 18342), (k(B, 153), 18285)] {
        w.show(n); w.read(0.05); w.spaceChanged(); w.focus(key, at: w.t - 0.03); w.run(2.5, every: 0.1)
      }
      check("visible: one page silent: the two that speak are bound once each is shown with its focus change", w.binder.numbers[k(C, 795)] == 18342 && w.binder.numbers[k(B, 153)] == 18285 && w.wrong.isEmpty,
            "\(w.binder.numbers)\n\(w.said)")
      // And with a Private window of the same bounds: the same.
      let p = threeShown()
      p.add(900, screen)
      p.pages = true
      p.run(2)
      for (key, n) in [(k(C, 795), 18342), (k(B, 153), 18285), (k(A, 155), 18278)] {
        p.show(n); p.read(0.05); p.spaceChanged(); p.focus(key, at: p.t - 0.03); p.run(2.5, every: 0.1)
      }
      check("visible: a Private window of the same bounds: the three reported windows bound as each is shown with its focus change, none to it",
            p.binder.numbers == p.truth && p.wrong.isEmpty, "\(p.binder.numbers)\n\(p.said)")
    }
    do {
      // A copy that linked and has gone for good (its socket guard turned it off, its last window closed):
      // after a moment it no longer holds up full-screen windows of other profiles bound alone by their bounds.
      let w = World()
      w.add(100, screen, on: true); w.add(300, second)
      w.put(A, 1, screen); w.put(C, 3, second)
      w.truth = [k(A, 1): 100, k(C, 3): 300]
      w.inFront = false // no page or focus rule: elimination alone
      w.run(1)
      check("away: set up (each bound as the only free window with its bounds)", w.binder.numbers == w.truth, "\(w.binder.numbers)\n\(w.said)")
      _ = w.ext.removeValue(forKey: C); w.remove(300) // C's copy gone, its window closed
      w.close(A, 1); w.remove(100)
      w.run(1)
      w.add(101, screen, on: true); w.put(A, 2, screen); w.truth = [k(A, 2): 101]
      w.run(1)
      check("away: a copy just gone: a new full-screen window waits (a window of its may be the one listed)", w.binder.numbers.isEmpty, "\(w.binder.numbers)")
      w.run(WindowBinder.Timing().away)
      check("away: a copy gone for good: the new full-screen window bound as the only free window with its bounds", w.binder.numbers == w.truth && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      // Safari quit with Margin.app still running and opened with one profile: nothing held over.
      let q = World()
      q.add(100, screen, on: true); q.add(200, second)
      q.put(A, 1, screen); q.put(B, 2, second)
      q.run(1)
      q.ext = [:]; q.server = []; q.pids = []; q.run(1)
      q.pids = [2]; q.add(101, screen, on: true, pid: 2); q.put(A, 5, screen); q.truth = [k(A, 5): 101]
      q.run(0.5)
      check("away: Safari quit and opened again with one profile: its full-screen window bound at once", q.binder.numbers == q.truth && q.wrong.isEmpty, "\(q.binder.numbers)\n\(q.said)")
    }
    do {
      // A binding its pages contradict (made wrong some other way): dropped after 2 s, then each bound right.
      let w = World()
      w.add(100, screen); w.add(200, screen); w.show(100)
      w.put(A, 1, screen, focused: true); w.put(B, 2, screen)
      w.truth = [k(A, 1): 100, k(B, 2): 200]
      w.pages = true
      w.run(3)
      check("hidden: set up (bound by the pages)", w.binder.numbers == w.truth, "\(w.binder.numbers)")
      w.truth = [k(A, 1): 200, k(B, 2): 100] // the bindings were wrong all along: A's page now says hidden, B's shown
      w.wrong = []
      w.run(1.9)
      check("hidden: its page hidden while its window is on screen, the other's shown: kept under 2 s", w.binder.numbers[k(A, 1)] == 100)
      w.run(0.5)
      check("hidden: dropped after 2 s, and why; the window whose page says it's shown, bound to one off screen, dropped too",
            w.said.contains("safari:A#1 is no longer window 100: its page has said it's hidden since") && w.said.contains("and safari:B#2's page says it's shown (since")
            && w.said.contains("safari:B#2 is no longer window 200: its page says it's shown (since"), w.said)
      w.wrong = [] // (wrong until then, as set up)
      w.run(1)
      check("hidden: then both bound right (the shown one by its page, the other by elimination)", w.binder.numbers == w.truth && w.wrong.isEmpty, "\(w.binder.numbers) \(w.wrong)\n\(w.said)")
      let after = w.lines.drop { !$0.contains("safari:A#1 is no longer window 100") }
      check("hidden: and nothing bound wrong again after the drops", !after.contains { $0.hasPrefix("safari:A#1 is window 100") || $0.hasPrefix("safari:B#2 is window 200") }
            && after.contains { $0.hasPrefix("safari:B#2 is window 100: visible") } && after.contains { $0.hasPrefix("safari:A#1 is window 200: the only free window") }, after.joined(separator: "\n"))
      // Pages that say nothing never drop a binding.
      let quiet = World()
      quiet.add(100, screen); quiet.add(200, screen); quiet.show(100)
      quiet.put(A, 1, screen, focused: true); quiet.put(B, 2, screen)
      quiet.truth = [k(A, 1): 100, k(B, 2): 200]
      quiet.pages = true; quiet.run(3); quiet.pages = false
      quiet.say(k(A, 1), visible: nil); quiet.say(k(B, 2), visible: nil)
      quiet.run(5)
      check("hidden: pages that say nothing never drop a binding", quiet.binder.numbers == quiet.truth && !quiet.said.contains("no longer"))
    }

    // ---- the moved rule and elimination, with a window no copy reports ----
    for offsetFor in [2.5, 5.0] {
      // A bound window offset (a held swipe, both on screen) next to a same-bounds window no copy reports.
      let w = World()
      w.add(101, screen); w.add(102, screen); w.show(101)
      w.put(A, 1, screen)
      w.truth = [k(A, 1): 101]
      w.show(102); w.run(2)
      w.show(101); w.read(0.05); w.focus(k(A, 1), at: w.t - 0.02); w.run(2.4, every: 0.1)
      check("moved, offset \(offsetFor) s: set up (bound by its focus change)", w.binder.numbers == w.truth, "\(w.binder.numbers)\n\(w.said)")
      w.move(101, screen.offsetBy(dx: 300, dy: 0)); w.show(101, also: [102])
      w.run(offsetFor)
      w.move(101, screen); w.show(101); w.run(3)
      check("moved: its window offset \(offsetFor) s next to an unreported same-bounds window: the binding unchanged", w.binder.numbers == w.truth && w.wrong.isEmpty && !w.said.contains("(was "), w.said)
    }
    do {
      // Elimination with a copy held (reconnecting) and a read missing a window: never wrong.
      let w = World()
      w.add(100, screen); w.add(200, screen); w.show(200)
      w.put(A, 1, screen); w.put(B, 2, screen)
      w.truth = [k(A, 1): 100, k(B, 2): 200]
      w.blipped = [100]
      w.read()
      _ = w.ext.removeValue(forKey: B); w.held = [B] // B's link dropped a moment
      w.run(4)
      check("elimination: B's link held, A's window missing from the reads: A not bound to B's window", w.wrong.isEmpty && w.binder.numbers.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      w.held = []; w.run(2)
      check("elimination: B's copy seen this session and not reporting: still not", w.wrong.isEmpty && w.binder.numbers.isEmpty, "\(w.binder.numbers)")
      w.blipped = []; w.put(B, 2, screen); w.run(1)
      check("elimination: back, every window listed and reported: nothing wrong", w.wrong.isEmpty, "\(w.binder.numbers)")
      // A window whose bounds no other has: at once, as ever; a full-screen one once no link is held.
      let one = World()
      one.add(100, left, on: true); one.put(A, 1, left, state: "normal"); one.add(200, screen); one.put(B, 2, screen); one.held = [C]
      check("elimination: a normal window with bounds of its own is bound at the first read, a link held or not", one.read() == [k(A, 1): 100], "\(one.binder.numbers)")
      one.held = []
      check("elimination: the full-screen one at the first read with none held", one.read() == [k(A, 1): 100, k(B, 2): 200], "\(one.binder.numbers)")
    }

    // ---- what the log says (Safari's evidence for next time) ----
    do {
      let w = threeShown()
      w.run(2)
      check("log: settled focus says why it can't, once", w.lines.filter { $0.contains("settled focus can't bind") }.count == 1
            && w.said.contains("safari: settled focus can't bind window 18285: the windows with its bounds are 3 copies' (safari:A, safari:B, safari:C)"), w.said)
      let before = w.lines.count
      w.show(18342); w.read(0.05); w.show(18278); w.read(0.05); w.show(18342); w.read(0.05)
      w.focus(k(C, 795), at: w.t - 0.02); w.run(2.4, every: 0.1)
      let new = Array(w.lines.suffix(from: before))
      check("log: the front window's changes, a line at most a second, as numbers", new.filter { $0.hasPrefix("safari: the front window: ") }.count == 2
            && new.contains { $0.hasPrefix("safari: the front window: 18342 at ") }
            && new.contains { $0.contains("18278 at ") && $0.contains(", 18342 at ") }, new.joined(separator: "\n"))
      check("log: a focus change not used, with the rule that said no", new.contains { $0.hasPrefix("safari:C#795: focus heard at ") && $0.contains("not used: near count 3 (front changes within 1 s: 18342, 18278, 18342)") }, new.joined(separator: "\n"))
      w.inFront = false; w.read(0.05); w.inFront = true; w.read(0.05)
      check("log: no front window said as none", w.said.contains(": none at "), w.said)
    }
    do {
      // A focus change whose front change has a blip after it (Safari not in front for 0.2 s): still bound.
      let w = threeShown()
      w.run(2)
      w.show(18342); w.read(0.05); w.focus(k(C, 795), at: w.t - 0.02)
      w.read(0.1); w.inFront = false; w.read(0.1); w.read(0.1); w.inFront = true; w.read(0.1)
      w.run(2.2, every: 0.1)
      check("focus moved: a blip of no front window (0.2 s) after the change doesn't count against it", w.binder.numbers == [k(C, 795): 18342] && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      // A longer one does.
      let l = threeShown()
      l.run(2)
      l.show(18342); l.read(0.05); l.focus(k(C, 795), at: l.t - 0.02)
      l.read(0.1); l.inFront = false; l.run(0.6, every: 0.1); l.inFront = true; l.read(0.1)
      l.run(2.2, every: 0.1)
      check("focus moved: no front window for 0.6 s after it: not used (it may have been another switch)", l.binder.numbers.isEmpty, "\(l.binder.numbers)")
    }

    // ---- randomized: the pages' word, lagging, missing, a Private window, Space changes heard late ----
    // Three profiles (A with two full-screen windows), a Private window with the same bounds in some runs, a
    // windowed one; 20 Space switches with the window server's list blipping, the pages saying they're shown
    // or hidden 0-0.6 s after (the one that was shown up to 3 s late when the Private window is), some pages
    // never saying, words forgotten (another tab shown) and said again, the browser leaving the front, and
    // macOS's Space change heard from 0.1 s before to 0.8 s after the switch. Never bound wrong at any read.
    do {
      let only = ProcessInfo.processInfo.environment["WINDOW_SEED"].flatMap { Int($0) }
      let runs = ProcessInfo.processInfo.environment["VISIBLE_RUNS"].flatMap { Int($0) } ?? 1000
      var wrongRuns = 0, firstWrong = "", bound = 0, total = 0, unboundAtEnd = 0, firstUnbound = ""
      var boundByPages = 0, totalByPages = 0, boundByFocus = 0, totalByFocus = 0
      for seed in only.map({ $0...$0 }) ?? 1...runs {
        var r = Seeded(state: UInt64(seed) &* 0x9E37_79B9 &+ 17)
        let w = World()
        let fs: [(WindowKey, Int)] = [(k(A, 1), 101), (k(A, 2), 102), (k(B, 1), 201), (k(C, 1), 301)]
        for (_, n) in fs { w.add(n, screen) }
        let privateWindow = r.chance(0.4)
        if privateWindow { w.add(900, screen) }
        w.add(207, left)
        for (key, _) in fs { w.put(key.link, key.windowId, screen, focused: true) } // each copy calls its windows focused
        w.put(B, 7, left, state: "normal")
        w.truth = Dictionary(uniqueKeysWithValues: fs + [(k(B, 7), 207)])
        for (key, _) in fs where r.chance(0.15) { w.silent.insert(key) }
        var slowHide = false
        w.pageLag = { _, visible in !visible && slowHide ? r.range(0, 3) : r.range(0, 0.6) }
        let targets = fs.map(\.1) + (privateWindow ? [900, 900] : [])
        var current = r.pick(targets)
        w.show(current)
        w.pages = true
        var due: [(Double, Int, () -> Void)] = []
        func later(_ at: Double, _ f: @escaping () -> Void) { due.append((at, due.count, f)) }
        var blipReads: [Int: (after: Int, reads: Int)] = [:]
        var collapse: (from: Double, until: Double)?
        if r.chance(0.5) { w.run(r.range(0, 3)) }
        for _ in 0..<20 {
          let next = r.pick(targets.filter { $0 != current })
          let swipe = r.range(0, 0.5)
          let start = w.t
          if r.chance(0.4) { blipReads[r.pick(targets + [207])] = (Int(r.next() % 6), 1 + Int(r.next() % 15)) }
          if r.chance(0.4) { let from = start + r.range(-0.1, 0.4); collapse = (from, from + r.range(0.2, 1.1)) }
          w.show(next, also: swipe > 0.05 ? [current] : [])
          slowHide = next == 900 && r.chance(0.6)
          if swipe > 0.05 { later(start + swipe) { [n = next] in w.show(n) } }
          later(start + r.range(-0.1, 0.8)) { w.spaceChanged() }
          if r.chance(0.15) { later(start + r.range(0, 1)) { w.inFront = false }; later(start + r.range(1, 1.5)) { w.inFront = true } }
          if r.chance(0.2) { let key = r.pick(fs).0; later(start + r.range(0, 2)) { w.forget(key, after: r.range(0.05, 0.6)) } }
          var left = r.range(0.1, 3.0)
          while left > 0 {
            let dt = r.pick([0.033, 0.033, 0.1, 0.25])
            left -= dt
            let at = w.t + dt
            due.sort { ($0.0, $0.1) < ($1.0, $1.1) }
            while let first = due.first, first.0 <= at { due.removeFirst(); first.2() }
            w.blipped = Set(blipReads.filter { $0.value.after == 0 && $0.value.reads > 0 }.keys)
            w.collapse = collapse.map { at >= $0.from && at < $0.until } ?? false
            w.noList = w.collapse && r.chance(0.25)
            w.read(dt)
            blipReads = blipReads.mapValues { $0.after > 0 ? ($0.after - 1, $0.reads) : (0, $0.reads - 1) }.filter { $0.value.reads > 0 }
          }
          current = next
        }
        for (_, _, f) in due.sorted(by: { ($0.0, $0.1) < ($1.0, $1.1) }) { f() }
        w.inFront = true; w.blipped = []; w.collapse = false; w.noList = false; slowHide = false
        // Then each window shown in turn, calmly, its Space change heard: the pages bind what they can. With
        // a page that never says or a Private window, the pages can't (never guessed): each is shown with its
        // focus change too, as Safari gives one when a window comes forward.
        let pagesAlone = !privateWindow && w.silent.isEmpty
        w.run(1.5, every: 0.1)
        // (The window in front last: one already in front doesn't come forward.)
        let inFrontNow = w.front
        for (key, n) in fs.filter({ $0.1 != inFrontNow }) + fs.filter({ $0.1 == inFrontNow }) {
          w.show(n); w.read(0.05); w.spaceChanged(); if !pagesAlone { w.focus(key, at: w.t - 0.03) }; w.run(2.5, every: 0.1)
        }
        total += fs.count
        let boundHere = fs.filter { w.binder.numbers[$0.0] == $0.1 }.count
        bound += boundHere
        if pagesAlone { boundByPages += boundHere; totalByPages += fs.count } else { boundByFocus += boundHere; totalByFocus += fs.count }
        if fs.contains(where: { w.binder.numbers[$0.0] != $0.1 }) {
          unboundAtEnd += 1
          if firstUnbound.isEmpty { firstUnbound = "seed \(seed) (\(pagesAlone ? "every page saying" : "a page silent or a Private window, focus changes")): \(w.binder.numbers)\n" + w.lines.suffix(only != nil ? 300 : 25).joined(separator: "\n") }
        }
        if !w.wrong.isEmpty { wrongRuns += 1; if firstWrong.isEmpty { firstWrong = "seed \(seed): \(w.wrong[0])\n" + w.lines.suffix(only != nil ? 300 : 25).joined(separator: "\n") } }
      }
      check("randomized pages (\(runs) runs of 20 Space switches, the pages' word lagging up to 0.6 s, the one shown before up to 3 s when a Private window is shown, some never saying, words forgotten, blips, Space changes heard late): never bound wrong", wrongRuns == 0, "\(wrongRuns) runs; \(firstWrong)")
      check("randomized pages: every full-screen window bound once each was shown calmly (by the pages with every page saying and no Private window; else with its focus change)",
            unboundAtEnd == 0 && (only != nil || (totalByPages > 0 && totalByFocus > 0)), "\(unboundAtEnd) runs; \(firstUnbound)")
      print("  (randomized pages: \(bound) of \(total) full-screen windows bound at the end: \(boundByPages) of \(totalByPages) by the pages alone, \(boundByFocus) of \(totalByFocus) with focus changes)")
    }

    // ---- randomized: Space switches among several windows, flags lagging and disagreeing ----
    let only = ProcessInfo.processInfo.environment["WINDOW_SEED"].flatMap { Int($0) }
    let lag = ProcessInfo.processInfo.environment["WINDOW_LAG"].flatMap { Double($0) } ?? 1.2
    let runs = ProcessInfo.processInfo.environment["WINDOW_RUNS"].flatMap { Int($0) } ?? 300
    for blips in [false, true] {
    var wrongRuns = 0, unboundRuns = 0, firstWrong = "", blipDrops = 0, firstDrop = ""
    for seed in only.map({ $0...$0 }) ?? 1...runs {
      var r = Seeded(state: UInt64(seed))
      let w = World()
      // A: two full-screen windows; B: one full-screen, one windowed on the desktop. All full screen on one display.
      let fs: [(WindowKey, Int)] = [(k(A, 1), 101), (k(A, 2), 102), (k(B, 1), 201)]
      let desk = (k(B, 7), 207)
      for (_, n) in fs { w.add(n, screen) }
      w.add(desk.1, left)
      for (key, _) in fs { w.put(key.link, key.windowId, screen) }
      w.put(B, 7, left, state: "normal")
      w.truth = Dictionary(uniqueKeysWithValues: fs + [desk])
      let perProfile = r.chance(0.5) // Safari's flags: each profile's last focused, or only the key window
      var current = r.pick(fs)
      w.show(current.1); w.focus(current.0, at: w.t - 5)
      if !perProfile { for (key, _) in fs where key.link != current.0.link { w.set(key, focused: false) } }
      if r.chance(0.5) { w.run(6) } // bound before the switches start, or from nothing (a relaunch) during them
      // Pending reports: (when, what).
      var due: [(Double, Int, () -> Void)] = []
      var lastReport: [String: Double] = [:] // one copy's reports come in the order it sent them
      func later(_ at: Double, _ f: @escaping () -> Void) { due.append((at, due.count + 1000 * seed, f)) }
      func report(_ link: String, _ at: Double, _ f: @escaping () -> Void) {
        let when = max(at, lastReport[link] ?? 0)
        lastReport[link] = when
        later(when, f)
      }
      // The window server's blips (Tirth's log, 2026-11-05): a window missing from 1-15 reads, and every
      // one of the browser's missing (sometimes no list at all) for 0.2-1.1 s about a switch.
      var blipReads: [Int: (after: Int, reads: Int)] = [:]
      var collapse: (from: Double, until: Double)?
      for _ in 0..<12 {
        let next = r.pick(fs.filter { $0.0 != current.0 })
        let swipe = r.range(0, 0.5)
        let start = w.t
        if blips, r.chance(0.5) { blipReads[r.pick(fs.map(\.1) + [desk.1])] = (Int(r.next() % 6), 1 + Int(r.next() % 15)) }
        if blips, r.chance(0.5) { let from = start + r.range(-0.1, 0.4); collapse = (from, from + r.range(0.2, 1.1)) }
        w.show(next.1, also: swipe > 0.05 ? [current.1] : [])
        let heard = start + r.range(0, 0.35)
        let lagTarget = r.range(0, lag), lagOthers = r.range(0, lag)
        let target = next.0
        report(target.link, heard + lagTarget) { w.focus(target, at: heard) }
        for link in [A, B] where link != target.link && !perProfile {
          report(link, start + lagOthers) { w.flags(link, focused: nil) }
        }
        if swipe > 0.05 { later(start + swipe) { [n = next.1] in w.show(n) } }
        if r.chance(0.15) { later(start + r.range(0, 1)) { w.inFront = false }; later(start + r.range(1, 1.5)) { w.inFront = true } }
        let gap = r.range(0.2, 3.0)
        var left = gap
        while left > 0 {
          let dt = r.pick([0.033, 0.033, 0.1, 0.25])
          left -= dt
          let at = w.t + dt
          due.sort { ($0.0, $0.1) < ($1.0, $1.1) }
          while let first = due.first, first.0 <= at { due.removeFirst(); first.2() }
          w.blipped = Set(blipReads.filter { $0.value.after == 0 && $0.value.reads > 0 }.keys)
          w.collapse = collapse.map { at >= $0.from && at < $0.until } ?? false
          w.noList = w.collapse && r.chance(0.25)
          w.read(dt)
          blipReads = blipReads.mapValues { $0.after > 0 ? ($0.after - 1, $0.reads) : (0, $0.reads - 1) }.filter { $0.value.reads > 0 }
          if only != nil {
            let flags = (w.ext[A]! + w.ext[B]!).map { "\($0.key)\($0.focused ? "*" : "")@\($0.focusedAt.map { String(format: "%.3f", $0 - 1_800_000_000) } ?? "-")" }
            print(String(format: "t+%.3f", w.t - 1_800_000_000), "front", w.front ?? -1, "inFront", w.inFront, flags.joined(separator: " "))
          }
        }
        current = next
      }
      for (_, _, f) in due.sorted(by: { ($0.0, $0.1) < ($1.0, $1.1) }) { f() }
      w.inFront = true
      w.blipped = []; w.collapse = false; w.noList = false
      // Then each full-screen window shown in turn, cleanly: every one should end up bound.
      for (key, n) in fs {
        w.show(n); w.read(0.05); w.focus(key, at: w.t - 0.03)
        if !perProfile { for link in [A, B] where link != key.link { w.flags(link, focused: nil) } }
        w.run(2.4, every: 0.1)
      }
      if !w.wrong.isEmpty { wrongRuns += 1; if firstWrong.isEmpty { firstWrong = "seed \(seed): \(w.wrong[0])\n" + w.lines.suffix(only != nil ? 200 : 12).joined(separator: "\n") } }
      if w.binder.numbers != w.truth { unboundRuns += 1 }
      // A binding goes for the window server only after 3 s without its window (every window here stays open),
      // measured from the reads (World.earlyDrops), not from what the line says.
      if !w.earlyDrops.isEmpty { blipDrops += 1; if firstDrop.isEmpty { firstDrop = "seed \(seed): \(w.earlyDrops[0])" } }
    }
    let with = blips ? ", the window server's list blipping" : ""
    check("randomized (\(runs) runs of 12 Space switches, flags lagging up to \(lag) s and disagreeing\(with)): never bound wrong", wrongRuns == 0, "\(wrongRuns) runs; \(firstWrong)")
    check("and every window bound once each was shown cleanly\(with)", unboundRuns == 0, "\(unboundRuns) runs")
    check("and no binding dropped for a window missing less than 3 s\(with)", blipDrops == 0, "\(blipDrops) runs; \(firstDrop)")
    }
  }
}

// Parked windows (HANDOFF.md §2.2): the parking registry's numbers given to every read, kept bound
// while missing or off screen, dropped only for the copy's word, the browser gone and a new copy,
// left out of every rule, and bound again by expectParked; and the made-by-Margin rule with the
// bounds openSpaceWindow's answer gives (§1.6).
extension Tests {
  static func parkedWindowBinding() {
    let A = "safari:A", B = "safari:B", C = "safari:C"
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let left = CGRect(x: 40, y: 60, width: 900, height: 700), right = CGRect(x: 600, y: 120, width: 820, height: 640)
    func k(_ link: String, _ id: Int) -> WindowKey { WindowKey(link: link, windowId: id) }
    func count(_ w: World, _ text: String) -> Int { w.lines.filter { $0.contains(text) }.count }

    // A's window shown in full screen (100), B's normal window (200) bound, then parked: out of the reads.
    func parkedWorld() -> World {
      let w = World()
      w.add(100, screen, on: true); w.add(200, left)
      w.put(A, 1, screen, focused: true); w.put(B, 2, left, state: "normal")
      w.truth = [k(A, 1): 100, k(B, 2): 200]
      w.run(1)
      w.parked = [200]
      w.remove(200)
      return w
    }

    // ---- kept while missing or off screen ----
    do {
      let w = parkedWorld()
      check("parked: both bound before the park", w.binder.numbers == w.truth, "\(w.binder.numbers)\n\(w.said)")
      w.run(10)
      check("parked: missing from the reads for 10 s, its binding kept", w.binder.numbers == w.truth && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      check("parked: not counted as a blip kept for 3 s (absentNumbers)", w.binder.absentNumbers.isEmpty, "\(w.binder.absentNumbers)")
      check("parked: the log says it's kept and why, once", count(w, "kept while parked") == 1 && w.said.contains("safari:B#2: window 200 kept while parked: not listed by the window server")
            && !w.said.contains("missing from one read"), w.said)
      w.add(200, left); w.run(5)
      check("parked: listed again off screen, kept, and the log says so once", w.binder.numbers == w.truth && count(w, "window 200 kept while parked: off screen") == 1, w.said)
      let b = w.ext.removeValue(forKey: B); w.run(3)
      check("parked: its copy not linked for 3 s (not held), kept", w.binder.numbers == w.truth && w.said.contains("safari:B#2: window 200 kept while parked: its copy isn't linked"), w.said)
      w.ext[B] = b; w.run(1)
      check("parked: back, the same copy: still bound, nothing dropped", w.binder.numbers == w.truth && !w.said.contains("no longer"), w.said)
    }
    do {
      // The same window not parked, for contrast: dropped after 3 s missing.
      let w = parkedWorld()
      w.parked = []
      w.run(4)
      check("not parked: missing for 3 s, dropped as before", w.binder.numbers == [k(A, 1): 100] && w.said.contains("safari:B#2 is no longer window 200: window 200 is gone from the window server (not listed for 3 s)"), w.said)
    }

    // ---- dropped: closed in the browser, the browser gone, a new copy ----
    do {
      let w = parkedWorld(); w.run(1)
      w.close(B, 2); w.read()
      check("parked: closed in the browser (its copy stopped listing it): dropped at once, and why", w.binder.numbers == [k(A, 1): 100]
            && w.said.contains("safari:B#2 is no longer window 200: closed in the browser (window 200 was parked)"), w.said)
    }
    do {
      let w = parkedWorld(); w.run(1)
      w.server = []; w.pids = []; w.read()
      check("parked: the browser quitting: dropped, and why", w.binder.numbers.isEmpty && w.said.contains("safari:B#2 is no longer window 200: window 200, parked, is gone (the browser isn't running)"), w.said)
    }
    do {
      let w = parkedWorld(); w.run(1)
      w.copies[B] = "copy-B-2"; w.close(B, 2); w.put(B, 5, left, state: "normal"); w.truth[k(B, 5)] = 200; w.truth[k(B, 2)] = nil
      w.read()
      check("parked: a new copy in its profile: dropped, and why", w.binder.numbers == [k(A, 1): 100] && w.said.contains("safari:B#2 is no longer window 200: a new copy of Margin started"), w.said)
      w.add(200, left, on: true); w.show(200, also: [100]); w.pages = true
      w.set(k(B, 5), focused: true, focusedAt: w.t)
      w.run(8)
      check("parked: the new copy's id bound by no rule while the registry hasn't said (elimination, visible, focus, settled focus)", w.binder.numbers == [k(A, 1): 100] && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      check("parked: its window never taken as the front window", !w.binder.frontChanges.contains(200), "\(w.binder.frontChanges)")
      w.binder.expectParked([k(B, 5): 200], why: "the parking registry rebound it after a new copy")
      let at = w.t
      w.read()
      check("expectParked: bound at the next read, and why", w.binder.numbers == [k(A, 1): 100, k(B, 5): 200] && w.wrong.isEmpty
            && w.said.contains("safari:B#5 is window 200: parked: the parking registry rebound it after a new copy"), w.said)
      check("expectParked: at that read", w.binder.bindings[k(B, 5)]?.at == w.t && w.t > at)
      w.remove(200); w.run(5)
      check("expectParked: then kept as any parked binding", w.binder.numbers[k(B, 5)] == 200, "\(w.binder.numbers)")
    }
    do {
      // expectParked's refusals: the copy doesn't list the key; a closed window's number; a number another key keeps.
      let w = parkedWorld(); w.run(1)
      w.binder.expectParked(k(B, 9), number: 200, why: "test"); w.read()
      check("expectParked: a key its copy doesn't list: not bound, and why", w.binder.numbers[k(B, 9)] == nil && w.said.contains("safari:B#9: parked window 200 (test) not bound: its copy doesn't list it"), w.said)
      w.put(B, 6, right, state: "normal")
      w.binder.expectParked(k(B, 6), number: 200, why: "test"); w.run(6)
      check("expectParked: a number another key keeps: not bound, and why after 5 s", w.binder.numbers[k(B, 6)] == nil && w.binder.numbers[k(B, 2)] == 200
            && w.said.contains("safari:B#6: parked window 200 (test) not bound in 5 s: window 200 is safari:B#2's"), w.said)
      w.close(B, 2); w.read()
      w.binder.expectParked(k(B, 6), number: 200, why: "test"); w.read()
      check("expectParked: a closed window's number: not bound", w.binder.numbers[k(B, 6)] == nil && w.said.contains("safari:B#6: parked window 200 (test) not bound: it's a closed window's"), w.said)
    }

    // ---- left out of the read that tells nothing ----
    do {
      let w = parkedWorld(); w.add(200, left); w.run(1)
      // A read with only the parked window of the browser's: it tells nothing (100 missing is a blip, not a change).
      w.blipped = [100]; w.read()
      check("parked: a read listing only the parked window tells nothing", w.binder.lastReadCollapsed && w.said.contains("a read of the window server without the browser's windows"), w.said)
      w.blipped = []; w.read()
      check("and the next whole read is taken", !w.binder.lastReadCollapsed && w.binder.numbers == w.truth)
      // The parked window leaving the reads: no window lost (elimination goes on in that read).
      w.add(300, right); w.run(1)
      w.remove(200); w.put(A, 3, right, state: "normal"); w.truth[k(A, 3)] = 300; w.read()
      check("parked: its window leaving the reads isn't a lost window: a window bound by elimination in that read", w.binder.numbers[k(A, 3)] == 300 && !w.binder.lastReadCollapsed, "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // Every one of the browser's windows parked and none listed: not a read that tells nothing.
      let w = World()
      w.add(200, left); w.put(B, 2, left, state: "normal"); w.truth = [k(B, 2): 200]
      w.run(1)
      w.parked = [200]; w.remove(200); w.read()
      check("parked: the only window, unlisted: the read is taken as it is, the binding kept", !w.binder.lastReadCollapsed && w.binder.numbers == w.truth && !w.said.contains("without the browser's windows"), w.said)
    }

    // ---- left out of the rules ----
    do {
      // Elimination: a parked window not bound yet (parked again from the crash marker, its copy not linked
      // yet) has the bounds of A's other window, the only free one with them.
      let w = World()
      w.add(100, screen, on: true); w.add(200, left); w.add(300, left, on: true)
      w.put(A, 1, screen, focused: true); w.put(A, 3, left, state: "normal")
      w.parked = [200]
      w.truth = [k(A, 1): 100, k(A, 3): 300]
      w.read()
      check("parked: never an elimination rival (another window with its bounds bound at once)", w.binder.numbers == w.truth && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // Moved: the parked window's copy moves it (bounds onto another display, §6.7) to a free window's bounds.
      let w = parkedWorld(); w.add(200, left); w.add(300, right); w.run(1)
      w.set(k(B, 2), bounds: right); w.run(6)
      check("parked: never moved to a free window with its new bounds", w.binder.numbers[k(B, 2)] == 200 && !w.said.contains("(was 200)"), "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // Focus moved: a parked window focused (⌘`) while another window comes to the front.
      let w = parkedWorld(); w.add(200, left); w.add(300, screen); w.put(A, 4, screen); w.truth[k(A, 4)] = 300
      w.run(1)
      for _ in 0..<2 {
        w.show(300); w.read(0.05); w.focus(k(B, 2), at: w.t - 0.02); w.run(2.4, every: 0.1)
        w.show(100); w.read(0.05); w.run(2.4, every: 0.1)
      }
      check("parked: its focus moves nothing, twice", w.binder.numbers[k(B, 2)] == 200 && w.wrong.isEmpty && w.said.contains("safari:B#2: focus heard at") && w.said.contains("not used: its window is parked"), "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      // Visible and the front window: a parked window back on screen and in front (a system return), its page shown.
      let w = parkedWorld(); w.add(200, left, on: true); w.show(200, also: [100]); w.pages = true
      w.run(4)
      check("parked: on screen in front, never the front window, never a rule's", !w.binder.frontChanges.contains(200) && w.binder.numbers == w.truth && w.wrong.isEmpty, "\(w.binder.frontChanges)\n\(w.said)")
    }

    // ---- made by Margin: openSpaceWindow's answered bounds ----
    let made = CGRect(x: 0, y: 0, width: 1100, height: 760)
    func creating() -> (World, Double) {
      let w = World()
      w.add(100, screen, on: true); w.put(A, 7, screen, focused: true)
      w.ext[B] = []; w.copies[B] = "copy-B" // B's copy linked, no window yet
      w.truth = [k(A, 7): 100, k(B, 90): 400]
      w.run(1)
      let asked = w.t
      w.add(400, made); w.read(0.05)
      return (w, asked)
    }
    do {
      let (w, asked) = creating()
      w.binder.expect(k(B, 90), since: asked, now: w.t, why: "made by Margin's openSpaceWindow", bounds: made)
      w.read(0.05)
      check("made by Margin with the answer's bounds: bound at the next read, before its copy lists it", w.binder.numbers[k(B, 90)] == 400
            && w.said.contains("safari:B#90 is window 400: made by Margin's openSpaceWindow at") && w.said.contains("(by the bounds its answer gave, 0,0 1100×760, before its copy listed it)"), w.said)
      w.run(1.5, every: 0.05)
      check("and kept while its copy's list lags (not closed in the browser)", w.binder.numbers[k(B, 90)] == 400 && !w.said.contains("no longer"), w.said)
      w.put(B, 90, made, state: "normal", createdAt: asked + 0.02); w.read(0.05)
      w.move(400, screen); w.set(k(B, 90), bounds: screen, state: "fullscreen"); w.run(3)
      check("and once listed, an ordinary binding through full screen", w.binder.numbers == w.truth && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
    }
    do {
      let (w, asked) = creating()
      w.binder.expect(k(B, 90), since: asked, now: w.t, why: "made by Margin's openSpaceWindow", bounds: made)
      w.read(0.05)
      w.run(2.5, every: 0.05)
      check("made by Margin, its copy never listing it in 2 s: closed in the browser after all", w.binder.numbers[k(B, 90)] == nil && w.said.contains("safari:B#90 is no longer window 400: closed in the browser"), w.said)
    }
    do {
      // An older copy: no bounds in the answer. Not bound until its list has the window (as before).
      let (w, asked) = creating()
      w.binder.expect(k(B, 90), since: asked, now: w.t, why: "made by Margin's openSpaceWindow")
      w.run(0.5, every: 0.05)
      check("made by Margin, no bounds answered: waits for its copy's list", w.binder.numbers[k(B, 90)] == nil)
      w.put(B, 90, made, state: "normal", createdAt: asked + 0.02); w.read(0.05)
      check("then bound by its list's bounds", w.binder.numbers[k(B, 90)] == 400 && !w.said.contains("by the bounds its answer gave"), w.said)
    }
    do {
      // The answer's bounds don't fit the new window, and its list's do: bound by the list.
      let (w, asked) = creating()
      w.binder.expect(k(B, 90), since: asked, now: w.t, why: "made by Margin's openSpaceWindow", bounds: right)
      w.run(0.5, every: 0.05)
      check("made by Margin, the answer's bounds not the new window's: not bound by them", w.binder.numbers[k(B, 90)] == nil, w.said)
      w.put(B, 90, made, state: "normal", createdAt: asked + 0.02); w.read(0.05)
      check("then bound by its list's", w.binder.numbers[k(B, 90)] == 400 && w.wrong.isEmpty, w.said)
    }
    do {
      // A parked window shown during the create (listed again, never listed since Margin.app started: parked
      // again from the crash marker, its copy not linked yet) is never taken for the new one.
      let w = World()
      w.add(100, screen, on: true); w.put(A, 7, screen, focused: true)
      w.ext[C] = []; w.copies[C] = "copy-C"
      w.parked = [200]
      w.truth = [k(A, 7): 100, k(C, 90): 400]
      w.run(1)
      let asked = w.t
      w.add(200, left); w.read(0.05) // the parked window listed again
      w.binder.expect(k(C, 90), since: asked, now: w.t, why: "made by Margin's openSpaceWindow", bounds: left)
      w.run(0.5, every: 0.05)
      check("made by Margin: a parked window listed again isn't the new window", w.binder.numbers[k(C, 90)] == nil && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
      w.add(400, left); w.read(0.05)
      check("and the real new one is", w.binder.numbers[k(C, 90)] == 400 && w.wrong.isEmpty, "\(w.binder.numbers)\n\(w.said)")
    }
  }
}


extension Tests {
  // Accessibility names each window's profile (SafariAX.swift, WindowBinder.update `exact`).
  static func axBinding() {
    let A = "safari:s-default", B = "safari:s-b", C = "safari:s-c"
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    func k(_ link: String, _ id: Int) -> WindowKey { WindowKey(link: link, windowId: id) }
    let names = ["s-default": "Work", "s-b": "Personal", "s-c": "Test A"]
    check("a title names its profile: a named one by its prefix, the default's by none",
          SafariAX.profile(ofTitle: "Personal — Inbox", names: names, defaultId: "s-default") == "s-b"
          && SafariAX.profile(ofTitle: "Test A — x", names: names, defaultId: "s-default") == "s-c"
          && SafariAX.profile(ofTitle: "Test A", names: names, defaultId: "s-default") == "s-c"
          && SafariAX.profile(ofTitle: "Inbox — Personal stuff", names: names, defaultId: "s-default") == "s-default"
          && SafariAX.profile(ofTitle: "Start Page", names: names, defaultId: "s-default") == "s-default")

    // Three profiles, three same-bounds full-screen windows, one on screen, nothing said by any page:
    // bound at the first read, every one, the off-screen ones too.
    do {
      let w = World()
      w.add(100, screen, on: true); w.add(101, screen); w.add(102, screen)
      w.put(A, 1, screen); w.put(B, 2, screen); w.put(C, 3, screen)
      w.truth = [k(A, 1): 101, k(B, 2): 100, k(C, 3): 102]
      w.exact = [100: B, 101: A, 102: C]
      let out = w.read()
      check("Accessibility: every same-bounds window bound at the first read, on screen or not", out == w.truth, "\(out)")
      check("and never wrong", w.wrong.isEmpty, w.wrong.joined(separator: "; "))
    }
    // A binding the other rules made to another profile's window goes, and the right one is made.
    do {
      let w = World()
      w.add(100, screen, on: true)
      w.put(A, 1, screen)
      _ = w.read() // bound by its bounds alone (one window)
      w.add(101, screen); w.put(B, 2, screen)
      w.exact = [100: B, 101: A]
      let out = w.read()
      check("Accessibility overrides: A's window is 101 and B's 100", out[k(A, 1)] == 101 && out[k(B, 2)] == 100, "\(out)")
    }
    // Two windows of one profile: only the one with its bounds is bound; same bounds, neither (the other rules decide).
    do {
      let w = World()
      let left = CGRect(x: 40, y: 60, width: 900, height: 700)
      w.add(100, screen, on: true); w.add(101, left, on: true)
      w.put(A, 1, screen); w.put(A, 2, left, state: "normal")
      w.exact = [100: A, 101: A]
      let out = w.read()
      check("one profile's two windows: each by its own bounds", out[k(A, 1)] == 100 && out[k(A, 2)] == 101, "\(out)")
    }
    // A window not yet named (its title empty) waits; a parked window is never named.
    do {
      let w = World()
      w.add(100, screen, on: true); w.add(101, screen)
      w.put(A, 1, screen); w.put(B, 2, screen)
      w.parked = [101]
      w.exact = [100: A, 101: B]
      let out = w.read()
      check("a parked window is left to the parking registry", out[k(B, 2)] == nil && out[k(A, 1)] == 100, "\(out)")
    }
  }
}
