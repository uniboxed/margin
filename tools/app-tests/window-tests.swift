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

  init(timing: WindowBinder.Timing = .init()) {
    binder = WindowBinder(browser: "safari", timing: timing, log: { [unowned self] in self.lines.append($0) })
  }

  @discardableResult func read(_ dt: Double = 0.25) -> [WindowKey: Int] {
    t += dt
    let listed = noList ? [] : collapse ? server.filter { !pids.contains($0.pid) } : server.filter { !blipped.contains($0.number) }
    let out = binder.update(now: t, ext: ext.keys.sorted().flatMap { ext[$0]! }, reporting: Set(ext.keys), copies: copies, held: held,
                            server: listed, pids: pids, browserInFront: inFront, listed: !noList)
    for (k, n) in out where truth[k] != nil && truth[k] != n { wrong.append("\(k) bound to \(n), is \(truth[k]!) (t+\(String(format: "%.2f", t - 1_800_000_000)))") }
    return out
  }
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
  func put(_ link: String, _ id: Int, _ r: CGRect?, state: String = "fullscreen", focused: Bool = false, focusedAt: Double? = nil, createdAt: Double? = nil) {
    var list = ext[link] ?? []
    let w = ExtWindow(key: WindowKey(link: link, windowId: id), bounds: r, state: state, focused: focused, activeTabId: nil, focusedAt: focusedAt, createdAt: createdAt)
    if let i = list.firstIndex(where: { $0.key.windowId == id }) { list[i] = w } else { list.append(w) }
    ext[link] = list
    if copies[link] == nil { copies[link] = "copy-\(link)" }
  }
  func close(_ link: String, _ id: Int) { ext[link]?.removeAll { $0.key.windowId == id } }
  func get(_ key: WindowKey) -> ExtWindow? { ext[key.link]?.first { $0.key == key } }
  func set(_ key: WindowKey, bounds: CGRect? = nil, state: String? = nil, focused: Bool? = nil, focusedAt: Double? = nil) {
    guard let w = get(key) else { return }
    put(key.link, key.windowId, bounds ?? w.bounds, state: state ?? w.state, focused: focused ?? w.focused, focusedAt: focusedAt ?? w.focusedAt, createdAt: w.createdAt)
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
      w.run(4)
      check("not bound before the front window has been the same for 5 s (a switch may have just happened, flags lagging)", w.binder.numbers.isEmpty)
      w.run(1)
      check("settled focus (the only focused window, the same front window, 5 s): the front one bound, then the other by elimination", w.binder.numbers == w.truth, "\(w.binder.numbers)\n\(w.said)")
      check("the log has both whys", w.said.contains("safari:A#74 is window 12812: settled focus") && w.said.contains("safari:B#1169 is window 12881: the only free window with its bounds (0,0 1512×982); 1 other(s) with them already bound"), w.said)
      check("nothing wrong on the way", w.wrong.isEmpty, "\(w.wrong)")
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
      w.run(6)
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
      w.run(6)
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
      w.run(6)
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
      w.run(20)
      check("blips: 20 s on, still bound; never 'no longer', nothing wrong", w.binder.numbers == [k(C, 795): 18342] && !w.said.contains("is no longer") && w.wrong.isEmpty, w.said)
      check("blips: no 'can't be told' lines churned by the blips", w.lines.suffix(from: before).filter { $0.contains("isn't bound") }.isEmpty, w.lines.suffix(from: before).joined(separator: "\n"))
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
      w.run(6)
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
      w.run(6)
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

    // ---- randomized: Space switches among several windows, flags lagging and disagreeing ----
    let only = ProcessInfo.processInfo.environment["WINDOW_SEED"].flatMap { Int($0) }
    let lag = ProcessInfo.processInfo.environment["WINDOW_LAG"].flatMap { Double($0) } ?? 1.2
    let runs = ProcessInfo.processInfo.environment["WINDOW_RUNS"].flatMap { Int($0) } ?? 300
    for blips in [false, true] {
    var wrongRuns = 0, unboundRuns = 0, firstWrong = "", blipDrops = 0
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
      // A binding goes for the window server only after 3 s without its window (every window here stays open).
      if w.lines.contains(where: { $0.contains("is gone from the window server") && !$0.contains("(not listed for 3 s)") }) { blipDrops += 1 }
    }
    let with = blips ? ", the window server's list blipping" : ""
    check("randomized (\(runs) runs of 12 Space switches, flags lagging up to \(lag) s and disagreeing\(with)): never bound wrong", wrongRuns == 0, "\(wrongRuns) runs; \(firstWrong)")
    check("and every window bound once each was shown cleanly\(with)", unboundRuns == 0, "\(unboundRuns) runs")
    check("and no binding dropped for a window missing less than 3 s\(with)", blipDrops == 0, "\(blipDrops) runs")
    }
  }
}
