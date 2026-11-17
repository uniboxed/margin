// check10's steps (/tmp/margin-toolbar-test/hosted/check10.swift, 2026-11-17), ported: the two test panes are
// Chameleon copies (no switches unless the step sets them), their logs Chameleon's own. Same assertions, same names.
import AppKit

final class Runner {
  var built = ""
  var wantFront: String?
  var m: NSRunningApplication!
  var marginWindow: Win!
  var marginSpace: UInt64 = 0
  var startedInFullScreenOfAnother = false
  func copyApp(_ n: Int) -> NSRunningApplication? { app(copy(n).id) }
  func gotKey(_ n: Int, _ code: UInt16, after before: Int) -> Bool { spin(1.5) { copySaid(n, "EVENT keyDown code \(code) ") > before } }

  // The hosted window, by the window server, about a second after something put it there: on screen, in Margin's Space only.
  func member(_ name: String, _ pid: pid_t) {
    spin(1.0)
    let w = placedWindow(pid, minWidth: 200, minHeight: 200)
    let ok = w != nil && w!.on && w!.spaces == [marginSpace]
    step(name, ok, "window \(w.map { "#\($0.n) \(rect($0.r)) onscreen \($0.on) spaces \($0.spaces)" } ?? "none"); Margin's Space \(marginSpace), the current one \(active(cid))")
    if !ok { log("   DIAG \(diag(pid, marginWindow.n))") }
  }

  // ---- L, 0 ----
  func openMargin() {
    let startedOn = currentSpaceInfo()
    startedInFullScreenOfAnother = startedOn.type == 4 && startedOn.pid != nil
    log("started on Space \(startedOn.id): \(startedInFullScreenOfAnother ? "ANOTHER APP'S FULL-SCREEN SPACE (pid \(startedOn.pid ?? 0))" : startedOn.type == 4 ? "a full-screen Space with no app" : "a Desktop")")
    if let old = app(marginId) { old.terminate(); spin(15) { old.isTerminated } }
    sh("/usr/bin/defaults", ["write", marginId, "MarginDevHooks", "-bool", "YES"])
    sh("/usr/bin/defaults", ["write", marginId, "MarginPrepareBrowser", "-bool", "NO"]) // (no browser started or asked for a window)
    sh("/usr/bin/defaults", ["write", marginId, "MarginResumeLast", "-bool", "NO"]) // (the launcher: the person's last item is never opened)
    if let wantFront { sh("/usr/bin/defaults", ["write", marginId, "MarginFront", wantFront]) } else { sh("/usr/bin/defaults", ["delete", marginId, "MarginFront"]) }
    gate("opening Margin")
    sh("/usr/bin/open", [built])
    guard spin(10, { app(marginId) != nil }), let m = app(marginId) else { restore("Margin didn't start"); exit(5) }
    self.m = m
    let cameFront = bringMarginFront(m, built)
    log("Margin in front: \(cameFront); it said it brought itself forward \(said("brought forward").count) time(s)")
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == m.processIdentifier else { restore("Margin couldn't be brought to the front (the suite, not Margin)"); exit(8) }
    var f = front()
    let from = Date()
    spin(40) { f = front(); return word(f, "full screen") == "true" }
    step("L Margin's window in full screen, opened from \(startedInFullScreenOfAnother ? "another app's full-screen Space" : "a Desktop")", word(f, "full screen") == "true",
         "full screen \(word(f, "full screen") ?? "?") after \(String(format: "%.1f", Date().timeIntervalSince(from))) s; Margin waited \(said("full screen not asked yet").count) time(s) before asking, was refused \(said("macOS didn't take it to full screen").count) time(s), asked again \(said("asked again (").count) time(s); in front \(cameFront)")
    f = front()
    guard word(f, "full screen") == "true", let mw = win(baseN) ?? big(m.processIdentifier) else { restore("Margin's window didn't go full screen (\(f?.suffix(160) ?? "no answer from its dev hook"))"); exit(8) }
    marginWindow = mw
    marginSpace = spacesOf(mw.n).first ?? active(cid)
    log("Margin's window \(mw.n) \(rect(mw.r)) layer \(mw.layer), its panel \(panelN.map(String.init) ?? "?") \(win(panelN).map { "\(rect($0.r)) layer \($0.layer)" } ?? "not on screen"); page \(word(f, "page") ?? "?"), mechanism \(word(f, "mechanism") ?? "?"); its Space \(marginSpace)")
    let empty = picture()
    step("0 nothing hosted: the page card empty and painted (the launcher), nothing see-through", word(f, "page") == "empty" && painted(empty) == 81, "page \(word(f, "page") ?? "?"), page area painted \(painted(empty).map(String.init) ?? "?") of 81")
  }

  // ---- d1 d2 a1 m1 ----
  func firstHost(_ n: Int) {
    gate("opening Chameleon \(n)")
    hook(["say": "picture", "watch": "9"])
    spin(0.3)
    let shownBefore = said(": page shown").count
    hook(["app": copy(n).id])
    log("asked: Chameleon \(n)")
    spin(25) { said(": page shown").count > shownBefore && copyApp(n) != nil }
    spin(9.5) { !said("dev hook: picture: watched").isEmpty }
    guard let pane = copyApp(n) else { restore("Chameleon \(n) never started"); exit(9) }
    let watched = said("dev hook: picture: watched").last
    let loadingWatch = match(watched, #"loading (\d+) pictures, painted (\d+) to (\d+) of 81"#), shownWatch = match(watched, #"shown (\d+) pictures, painted (\d+) to (\d+) of 81"#)
    step("d1 the page card opaque while the pane opened (loading), see-through once it's shown",
         loadingWatch.map { Int($0[0])! > 0 && $0[1] == "81" } == true && shownWatch.map { Int($0[0])! > 0 && $0[1] == "0" } == true && word(watched, "last") == "shown",
         watched.map { String($0.suffix(170)) } ?? "no watch line")
    let f = front()
    guard let pageArea = rectIn(f, "page area"), let hole = rectIn(f, "hole") else { restore("no page area or hole from Margin (\(f?.suffix(160) ?? "?"))"); exit(9) }
    let paneWin = big(pane.processIdentifier)
    step("d2 shown: the hole is the hosted window's bounds, the page area", word(f, "page") == "shown" && paneWin != nil && abs(hole.minX - paneWin!.r.minX) <= 1 && abs(hole.width - paneWin!.r.width) <= 1 && abs(hole.height - paneWin!.r.height) <= 1,
         "hole \(rect(hole)), page area \(rect(pageArea)), the pane's window \(rect(paneWin?.r))")
    if let o = above(m.processIdentifier, pane.processIdentifier) { step("a1 Margin's window above the hosted window after the show", o.ok, o.text) } else { step("a1 Margin's window above the hosted window after the show", false, "one of the two isn't on screen") }
    member("m1 a second after the first show: the hosted window on screen, a member of Margin's Space only", pane.processIdentifier)
  }

  // ---- a2 ----
  func activateAbove(_ n: Int) {
    gate("activating Chameleon \(n)")
    guard let pane = copyApp(n) else { return skip("a2", "Chameleon \(n) isn't running") }
    pane.activate()
    spin(1.5) { NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier }
    if let o = above(m.processIdentifier, pane.processIdentifier) {
      step("a2 still above with the pane the active app", o.ok && NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier, o.text + "; front app \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?")")
    } else { step("a2 still above with the pane the active app", false, "one of the two isn't on screen") }
  }

  // ---- b1 a3 b2 k1 ----
  func clicks(_ n: Int) {
    guard canPost else { return skip("b1/a3/b2/k1 the clicks", "this suite can't post events (give the terminal Accessibility to run them)") }
    guard let pane = copyApp(n), let f = front(), let pageArea = rectIn(f, "page area"), let hole = rectIn(f, "hole") else { return skip("b1/a3/b2/k1 the clicks", "no hosted pane or no page area") }
    let inPane = CGPoint(x: hole.midX + 180, y: hole.midY + 120)
    let onFrame = CGPoint(x: min(pageArea.maxX + 4, marginWindow.r.maxX - 2), y: pageArea.midY)
    gate("the click in the pane")
    let stack = under(inPane)
    if marginThenApp(stack, m.processIdentifier, pane.processIdentifier) {
      let before = copySaid(n, "click at"), pressesBefore = Int(word(front(), "presses") ?? "") ?? -1
      click(inPane)
      let after = copySaid(n, "click at"), pressesAfter = Int(word(front(), "presses") ?? "") ?? -1
      step("b1 a click in the page area reached the test pane, not Margin", after == before + 1 && pressesAfter == pressesBefore, "the pane's clicks \(before) → \(after); Margin's window's presses \(pressesBefore) → \(pressesAfter)")
      if let o = above(m.processIdentifier, pane.processIdentifier) { step("a3 still above after a click in the hosted app", o.ok, o.text) } else { step("a3 still above after a click in the hosted app", false, "one of the two isn't on screen") }
    } else { skip("b1/a3 the click in the pane", "the windows under the point aren't Margin's then the pane's (\(stack.map { "\($0.pid == m.processIdentifier ? "Margin" : $0.pid == pane.processIdentifier ? "pane" : "another app") layer \($0.layer)" }))") }
    gate("the click on Margin's frame")
    if under(onFrame).first?.pid == m.processIdentifier {
      let before = copySaid(n, "click at"), pressesBefore = Int(word(front(), "presses") ?? "") ?? -1
      click(onFrame)
      let after = copySaid(n, "click at"), pressesAfter = Int(word(front(), "presses") ?? "") ?? -1
      step("b2 a click on Margin's frame beside the page area reached Margin, not the pane", pressesAfter == pressesBefore + 1 && after == before, "Margin's panel's presses \(pressesBefore) → \(pressesAfter); the pane's clicks \(before) → \(after); the front app after it \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?")")
    } else { skip("b2 the click on Margin's frame", "the top window there isn't Margin's") }
    gate("the click on Margin's sidebar")
    pane.activate()
    spin(1.5) { NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier }
    if let sp = spot(), let top = under(sp).first, top.pid == m.processIdentifier, NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier {
      let pressesBefore = Int(word(front(), "presses") ?? "") ?? -1, resignedBefore = copySaid(n, "resignedKey"), keysBefore = copySaid(n, "EVENT keyDown code 7 ")
      let activeBefore = said("Margin made the active app").count
      click(sp)
      let frontAfter = NSWorkspace.shared.frontmostApplication
      let fk = front()
      let pressesAfter = Int(word(fk, "presses") ?? "") ?? -1
      spin(0.3)
      plainKey(7) // x: to the pane (no field focused: a beep at most)
      let got = gotKey(n, 7, after: keysBefore)
      step("k1 a click on an empty spot of Margin's sidebar with the pane active: the pane STILL the frontmost app, Margin's panel got the press, the pane's window never resigned key, and a plain key after it reaches the pane",
           frontAfter?.processIdentifier == pane.processIdentifier && pressesAfter == pressesBefore + 1 && top.n == panelN && copySaid(n, "resignedKey") == resignedBefore && got
             && said("Margin made the active app").count == activeBefore && word(fk, "active") == "false",
           "at \(Int(sp.x)),\(Int(sp.y)) (the top window there \(top.n), Margin's panel \(panelN.map(String.init) ?? "?")); front app after \(frontAfter?.bundleIdentifier ?? "?"); Margin's panel's presses \(pressesBefore) → \(pressesAfter); the pane's window resigned key \(copySaid(n, "resignedKey") - resignedBefore) time(s); the plain key reached the pane \(got); Margin active \(word(fk, "active") ?? "?")")
    } else { skip("k1 the click on Margin's sidebar", "no empty spot from Margin's dev hook, the top window there isn't Margin's, or the pane isn't the front app (\(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"))") }
  }

  // ---- c1 c1b c2 ----
  func palette(_ n: Int) {
    gate("the palette")
    guard let pane = copyApp(n) else { return skip("c1/c1b/c2", "Chameleon \(n) isn't running") }
    pane.activate()
    spin(1.5) { NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier }
    let opened = said("palette opened").count
    hook(["key": "palette"])
    spin(5) { said("palette opened").count > opened }
    spin(0.6)
    var f = front()
    let withPalette = picture()
    let o3 = above(m.processIdentifier, pane.processIdentifier)
    let pw = panelWords(f)
    step("c1 the palette's key with the hosted app in front: the palette drawn over the page area, Margin's panel above the hosted window and KEY, the pane STILL the frontmost app (Margin never made active)",
         said("palette opened").count > opened && (painted(withPalette) ?? 0) > 0 && o3?.ok == true && word(f, "keys") == "true" && pw?.key == true && word(f, "active") == "false"
           && NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier,
         "the page says it's open: \(said("palette opened").count > opened); page area painted \(painted(withPalette).map(String.init) ?? "?") of 81; \(o3?.text ?? "not both on screen"); keys Margin's: \(word(f, "keys") ?? "?"); panel key \(pw.map { "\($0.key)" } ?? "?"); Margin active \(word(f, "active") ?? "?"); front app \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?")")
    if canPost, pw?.key == true, NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier {
      gate("typing in the palette")
      let typedBefore = copySaid(n, "typed count=")
      for code: UInt16 in [0, 11, 8] { plainKey(code) }
      spin(0.4)
      let fl = field()
      step("c1b three plain letters posted with the palette open: they reach the palette's field (its length 3), not the pane, the pane still the frontmost app",
           fieldLength(fl) == 3 && copySaid(n, "typed count=") == typedBefore && NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier,
           "the field: \(match(fl, #"field: (.*?) \(asked"#)?.first ?? "no answer"); the pane's field changed \(copySaid(n, "typed count=") - typedBefore) time(s); front app \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?")")
    } else { skip("c1b typing in the palette", canPost ? "the panel isn't key or the pane isn't the front app (see c1)" : "this suite can't post events") }
    gate("Escape")
    let keysBefore = copySaid(n, "EVENT keyDown code 7 ")
    if canPost, pw?.key == true {
      for down in [true, false] { post { let e = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: down); e?.flags = []; return e }; spin(0.06) }
    } else { hook(["key": "close"]) }
    spin(4) { NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier && panelWords(front())?.key == false }
    spin(0.5)
    f = front()
    let afterPalette = picture()
    let fieldAfter = field()
    var keyAfter = false
    if canPost { plainKey(7); keyAfter = gotKey(n, 7, after: keysBefore) }
    step("c2 Escape: the palette gone, the page area see-through again, the panel not key, the pane still the frontmost app, and a plain key after it reaches the pane (no click)",
         painted(afterPalette) == 0 && word(f, "keys") == "false" && panelWords(f)?.key == false && NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier
           && (fieldAfter?.contains("palette false") ?? false) && (!canPost || keyAfter),
         "page area painted \(painted(afterPalette).map(String.init) ?? "?") of 81; keys Margin's: \(word(f, "keys") ?? "?"); panel key \(panelWords(f).map { "\($0.key)" } ?? "?"); front app \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?") (\(canPost ? "a real Escape" : "the dev hook's close")); the plain key after it reached the pane \(canPost ? "\(keyAfter)" : "not posted")")
  }

  // ---- d3 a4 ----
  func secondHost(_ n: Int) {
    gate("the second pane")
    let shownBefore = said(": page shown").count, watchedBefore = said("dev hook: picture: watched").count
    hook(["say": "picture", "watch": "9"])
    spin(0.3)
    hook(["app": copy(n).id])
    log("asked: Chameleon \(n) (the second app)")
    spin(25) { said(": page shown").count > shownBefore && copyApp(n) != nil }
    spin(9.5) { said("dev hook: picture: watched").count > watchedBefore }
    let watched = said("dev hook: picture: watched").last
    let loading = match(watched, #"loading (\d+) pictures, painted (\d+) to (\d+) of 81"#), shown = match(watched, #"shown (\d+) pictures, painted (\d+) to (\d+) of 81"#)
    step("d3 a second app opening: the page card opaque for its whole opening (loading: every picture 81 of 81), then shown and see-through (0 of 81)",
         loading.map { Int($0[0])! > 0 && $0[1] == "81" && $0[2] == "81" } == true && shown != nil && word(watched, "last") == "shown" && painted(picture()) == 0,
         (watched.map { String($0.suffix(190)) } ?? "no watch line"))
    guard let pane2 = copyApp(n) else { restore("Chameleon \(n) never started"); exit(9) }
    if let o = above(m.processIdentifier, pane2.processIdentifier) { step("a4 Margin's window above the second hosted window", o.ok, o.text) } else { step("a4 Margin's window above the second hosted window", false, "one of the two isn't on screen") }
  }

  // ---- d4 m2 ----
  func switchBack(_ n: Int) {
    gate("the switch back")
    guard let pane = copyApp(n) else { return skip("d4/m2", "Chameleon \(n) isn't running") }
    let loadingBefore = said(": page loading").count, switchedBefore = said("switched in").count
    hook(["app": copy(n).id])
    spin(6) { said("switched in").count > switchedBefore && big(pane.processIdentifier) != nil }
    spin(0.6)
    let switched = said("switched in").last
    step("d4 a switch to an app already prepared: straight from shown to shown, no loader", said(": page loading").count == loadingBefore && big(pane.processIdentifier) != nil && word(front(), "page") == "shown",
         "page loading said \(said(": page loading").count - loadingBefore) times; \(match(switched, #"switched in (\d+) ms"#).map { "switched in \($0[0]) ms" } ?? "no switch line")")
    member("m2 a second after the switch to the prepared app: on screen, a member of Margin's Space only", pane.processIdentifier)
  }

  // ---- e1… ----
  func sidebarDrags(_ n: Int, _ offsets: [Int]) {
    guard let pane = copyApp(n), let pageArea = rectIn(front(), "page area") else { return skip("e the sidebar's drags", "no hosted pane or no page area") }
    let widthBefore = Int(pageArea.minX - marginWindow.r.minX)
    var lastArea = pageArea
    for (i, off) in offsets.enumerated() {
      let width = widthBefore + off
      gate("the sidebar's drag \(i + 1)")
      let placedBefore = said("placed again in ").count, failedBefore = said("event failed").count
      hook(["sidebar": "\(width)"])
      spin(15) { said("placed again in ").count > placedBefore && !said("page area changed").isEmpty && word(front(), "page") == "shown" }
      spin(1.0) // (2026-11-17: the window was in no Space about a second after "page shown")
      let f = front()
      let area = rectIn(f, "page area"), nowHole = rectIn(f, "hole"), w = big(pane.processIdentifier), placed = placedWindow(pane.processIdentifier)
      let o = above(m.processIdentifier, pane.processIdentifier)
      let inSpace = placed != nil && placed!.on && placed!.spaces == [marginSpace]
      let last = i == offsets.count - 1
      step("e\(i + 1) the sidebar's edge moved (\(last ? "back to its width" : "placing \(i + 1) of \(offsets.count - 1) in a row")): one placing, the hosted window at the new page area, a second later still on screen and in Margin's Space only, under Margin's window, Margin still full screen",
           said("placed again in ").count == placedBefore + 1 && area != nil && area != lastArea && w != nil && abs(w!.r.minX - area!.minX) <= 1 && abs(w!.r.width - area!.width) <= 1 && nowHole == area && inSpace
             && o?.ok == true && word(f, "full screen") == "true" && word(f, "page") == "shown" && !pane.isTerminated && said("event failed").count == failedBefore,
           "placings \(said("placed again in ").count - placedBefore); page area \(rect(lastArea)) → \(rect(area)); the pane's window \(placed.map { "#\($0.n) \(rect($0.r)) onscreen \($0.on) spaces \($0.spaces)" } ?? "none") (Margin's Space \(marginSpace)); hole \(rect(nowHole)); \(o?.text ?? "not both on screen"); full screen \(word(f, "full screen") ?? "?"); failures said \(said("event failed").count - failedBefore)")
      if !inSpace { log("   DIAG \(diag(pane.processIdentifier, marginWindow.n))") }
      if let area { lastArea = area }
    }
  }

  // ---- f ----
  func frontMechanism() {
    let f = front()
    let layerNow = win(baseN)?.layer, panelLayer = win(panelN)?.layer
    let mechanism = word(f, "mechanism") ?? "?"
    let levelLine = match(f, #"level (\d+) \(server ([0-9?]+)\)"#)
    step("f the way Margin's window is kept in front (its panel at the same layer)", (mechanism == "level" ? layerNow == 1 : mechanism == "order") && panelLayer == layerNow,
         mechanism == "level" ? "RAISED LEVEL HELD (Margin says level \(levelLine?[0] ?? "?"), the window server \(levelLine?[1] ?? "?"); the window list's layer \(layerNow.map(String.init) ?? "?"))"
         : "ORDER: \(wantFront == "order" ? "asked for by this run" : "the raised level was NOT held, Margin fell back to ordering itself above") (layer \(layerNow.map(String.init) ?? "?"))")
  }

  // ---- s0… ----
  func spaceSwipes(hosted h: Int, own o: Int, times: Int) {
    let key79 = spaceKey("79", 123), key81 = spaceKey("81", 124)
    guard case .arrow(let leftKey) = key79, case .arrow(let rightKey) = key81 else {
      return skip("s Space swipes", "Mission Control's move-a-Space keys aren't ⌃← / ⌃→ here (79: \(key79), 81: \(key81)): nothing posted")
    }
    guard canPost else { return skip("s Space swipes", "this suite can't post events or use Accessibility on its own test app") }
    guard modsHeld().isEmpty else { return skip("s Space swipes", "a modifier reads held before anything was posted (\(modsHeld().rawValue)): nothing posted") }
    guard let pane = copyApp(h) else { return skip("s Space swipes", "Chameleon \(h) isn't running") }
    gate("the Space swipes")
    var ownPid: pid_t?
    var putBack = false
    defer {
      if !putBack, let pid = ownPid, let a = NSRunningApplication(processIdentifier: pid), !a.isTerminated {
        if axFullScreen(pid) == true { _ = setAXFullScreen(pid, false); spin(4) { axFullScreen(pid) != true } }
        a.terminate(); spin(6) { a.isTerminated }; if !a.isTerminated { a.forceTerminate() }
        releaseModifiers()
        m.activate(); spin(3) { active(cid) == marginSpace }
        log("s: its own app put back after the step ended early: quit \(a.isTerminated), the current Space \(active(cid)) (Margin's \(marginSpace))")
      }
    }
    let mark = LogMark()
    quitCopy(o)
    spin(1.5)
    guard copyApp(o) == nil else { return step("s0 Chameleon \(o) quit as Margin's", false, "still running") }
    gate("Chameleon \(o) on its own")
    sh("/usr/bin/open", ["-g", copy(o).installed])
    guard spin(10, { copyApp(o) != nil }), let own = copyApp(o), spin(6, { placedWindow(own.processIdentifier) != nil }) else {
      return step("s0 Chameleon \(o) opened on its own", false, "it didn't start or show a window")
    }
    ownPid = own.processIdentifier
    let opened = placedWindow(own.processIdentifier)!
    var askedFull = spin(3) { setAXFullScreen(own.processIdentifier, true) }
    if !askedFull { own.activate(); spin(2); askedFull = spin(3) { setAXFullScreen(own.processIdentifier, true) } }
    var ownSpace: UInt64 = 0
    let inFull = askedFull && spin(8) {
      guard let w = placedWindow(own.processIdentifier), let sp = w.spaces.first, w.spaces.count == 1, sp != marginSpace,
            displaySpaces(containing: sp).first(where: { $0.id == sp })?.type == 4 else { return false }
      ownSpace = sp
      return true
    }
    spin(1.2)
    guard inFull else { return step("s0 Chameleon \(o) in full screen on its own", false, "asked \(askedFull); its window \(placedWindow(own.processIdentifier).map { "#\($0.n) \(rect($0.r)) spaces \($0.spaces)" } ?? "none"); spaces \(mc())") }
    let order = displaySpaces(containing: marginSpace)
    guard let mi = order.firstIndex(where: { $0.id == marginSpace }), let oi = order.firstIndex(where: { $0.id == ownSpace }) else {
      return step("s0 its Space on Margin's display", false, "Margin's Space \(marginSpace), its \(ownSpace), the display's \(order.map(\.id))")
    }
    let between = order[min(mi, oi) + 1 ..< max(mi, oi)]
    guard abs(oi - mi) <= 2, between.allSatisfy({ $0.type == 0 }) else {
      return skip("s Space swipes", "its own Space isn't next to Margin's (Margin's at \(mi), its at \(oi) of \(order.count), between: \(between.map { "type \($0.type)" })): not swiped through the person's Spaces")
    }
    let toPane = oi > mi ? rightKey : leftKey, toMargin = oi > mi ? leftKey : rightKey, presses = abs(oi - mi)
    let ownWindow = placedWindow(own.processIdentifier)?.n ?? opened.n
    step("s0 Chameleon \(o) in full screen ON ITS OWN, a Space of its own next to Margin's (not hosted)", true, "its window #\(ownWindow) in [\(ownSpace)], Margin's Space \(marginSpace); \(presses) press(es) from Margin's to it")
    var fn = false
    func swipe(_ arrow: UInt16, to target: UInt64) -> Bool {
      for _ in 0..<presses {
        let from = active(cid)
        guard pressSpaceKey(arrow, fn: fn) else { restore("a modifier still read held after a posted ⌃ arrow (\(modsHeld().rawValue))"); exit(11) }
        if !spin(2.5, { active(cid) != from }), !fn {
          fn = true
          log("s: ⌃ arrow without Fn didn't move a Space: with Fn")
          guard pressSpaceKey(arrow, fn: true) else { restore("a modifier still read held after a posted ⌃ Fn arrow (\(modsHeld().rawValue))"); exit(11) }
          spin(2.5) { active(cid) != from }
        }
        spin(1.0)
      }
      return spin(2) { active(cid) == target }
    }
    func backInMargin(_ name: String) {
      gate(name)
      spin(0.5)
      pane.activate()
      spin(1.5) { NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier }
      var clicked = "not clicked"
      if let hole = rectIn(front(), "hole") {
        let p = CGPoint(x: hole.midX + 180, y: hole.midY + 120), stack = under(p)
        if marginThenApp(stack, m.processIdentifier, pane.processIdentifier) { let b = copySaid(h, "click at"); click(p); clicked = "clicked: the pane's clicks \(b) → \(copySaid(h, "click at"))" }
        else { clicked = "not clicked (under the point: \(stack.prefix(3).map { $0.pid == m.processIdentifier ? "Margin" : $0.pid == pane.processIdentifier ? "pane" : $0.pid == own.processIdentifier ? "the copy on its own" : "another app" }))" }
      }
      spin(1.0)
      let f = front(), ab = above(m.processIdentifier, pane.processIdentifier)
      let lv = match(f, #"level (\d+) \(server ([0-9?]+)\)"#)
      let lets = mark.since("let in front of it"), named = lets.filter { $0.contains("(\(ownWindow))") }
      let fell = mark.since("isn't held by the window server")
      step(name, ab?.ok == true && lv?[0] == "1" && lv?[1] == "1" && panelWords(f)?.server == "1" && word(f, "mechanism") == "level" && named.isEmpty && fell.isEmpty && active(cid) == marginSpace,
           "\(ab?.text ?? "not both on screen"); level \(lv?[0] ?? "?") (server \(lv?[1] ?? "?")), mechanism \(word(f, "mechanism") ?? "?"); let in front: its own window \(named.count) time(s), any window \(lets.count); fell back \(fell.count); \(clicked); the current Space \(active(cid))")
      if ab?.ok != true { log("   DIAG \(diag(pane.processIdentifier, marginWindow.n))") }
    }
    gate("the first swipe back")
    guard swipe(toMargin, to: marginSpace) else { return step("s1 swiped back to Margin's Space", false, "the current Space \(active(cid)), Margin's \(marginSpace)") }
    backInMargin("s1 back in Margin's Space from a full-screen Space of its own: Margin above the hosted pane after its activation and a click, level 1 by the window server, still `level`, never let the other window in front")
    for i in 2...(times + 1) {
      gate("swipe \(i) there")
      guard swipe(toPane, to: ownSpace) else { return step("s\(i) swiped to its own Space", false, "the current Space \(active(cid)), its \(ownSpace)") }
      spin(0.8)
      gate("swipe \(i) back")
      guard swipe(toMargin, to: marginSpace) else { return step("s\(i) swiped back to Margin's Space", false, "the current Space \(active(cid)), Margin's \(marginSpace)") }
      backInMargin("s\(i) swipe \(i - 1) of \(times) there and back: Margin above the hosted pane after its activation and a click, level 1, still `level`, never let the other window in front")
    }
    gate("the palette after the swipes")
    pane.activate()
    spin(1.5) { NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier }
    let openedBefore = said("palette opened").count
    hook(["key": "palette"])
    spin(5) { said("palette opened").count > openedBefore }
    spin(0.6)
    let f = front(), pic = picture(), ab = above(m.processIdentifier, pane.processIdentifier)
    step("s\(times + 2) after the swipes, the palette's key with the hosted pane in front: drawn over the page area, Margin's panel above the pane and key, the pane still the frontmost app",
         said("palette opened").count > openedBefore && (painted(pic) ?? 0) > 0 && ab?.ok == true && word(f, "keys") == "true" && panelWords(f)?.key == true && NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier,
         "page area painted \(painted(pic).map(String.init) ?? "?") of 81; \(ab?.text ?? "not both on screen"); keys Margin's: \(word(f, "keys") ?? "?"); front app \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?")")
    gate("Escape after the swipes")
    if panelWords(f)?.key == true { for down in [true, false] { post { let e = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: down); e?.flags = []; return e }; spin(0.06) } } else { hook(["key": "close"]) }
    spin(3) { NSWorkspace.shared.frontmostApplication?.processIdentifier == pane.processIdentifier }
    gate("putting the swipes' copy back")
    putBack = true
    _ = swipe(toPane, to: ownSpace)
    spin(0.5)
    let out = spin(3) { setAXFullScreen(own.processIdentifier, false) } && spin(6) { placedWindow(own.processIdentifier).map { !$0.spaces.contains(ownSpace) } ?? true }
    spin(1.0)
    own.terminate(); spin(6) { own.isTerminated }; if !own.isTerminated { own.forceTerminate(); spin(2) }
    m.activate()
    if !spin(4, { active(cid) == marginSpace }) { _ = bringMarginFront(m, built); spin(3) { active(cid) == marginSpace } }
    if active(cid) != marginSpace, let disp = before.display { setCurrent(cid, disp as CFString, marginSpace); spin(1) }
    log("s: put back: out of full screen \(out), quit \(own.isTerminated); the current Space \(active(cid)) (Margin's \(marginSpace)); modifiers held \(modsHeld().rawValue)")
  }

  // ---- w ----
  func freshHost(_ n: Int) {
    let name = "w a fresh Chameleon opened with Margin's Space current, its first window in Margin's Space: full screen at the page area and in Margin's Space only within 2 s, never window mode"
    gate("the fresh copy in Margin's Space")
    quitCopy(n); spin(1.5)
    guard copyApp(n) == nil else { return skip(name, "Chameleon \(n) still runs: not a fresh launch") }
    if active(cid) != marginSpace { m.activate(); spin(3) { active(cid) == marginSpace } }
    guard active(cid) == marginSpace else { return skip(name, "Margin's Space isn't the current one") }
    gate("asking for the fresh copy")
    guard let area = rectIn(front(), "page area") else { return step(name, false, "no page area from Margin before the ask") }
    let mark = LogMark()
    let asked = Date()
    let hid = "app:\(copy(n).id)"
    hook(["app": copy(n).id])
    var pid: pid_t?
    var first: (spaces: [UInt64], at: Date, n: Int)?
    var placedAt: Date?
    var spacesSeen: [[UInt64]] = []
    let until = Date().addingTimeInterval(20)
    while Date() < until {
      if pid == nil { pid = copyApp(n)?.processIdentifier }
      if let p = pid, let w = placedWindow(p) {
        if first == nil { first = (w.spaces, Date(), w.n) }
        if spacesSeen.last != w.spaces { spacesSeen.append(w.spaces) }
        let there = w.on && w.spaces == [marginSpace] && near(w.r, area, 1)
        if there, placedAt == nil { placedAt = Date() } else if !there { placedAt = nil }
        if let at = placedAt, Date().timeIntervalSince(at) >= 1.0 { break }
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    guard let p = pid, let first else { return step(name, false, "the copy \(pid == nil ? "never started" : "showed no window") within 20 s; Margin said: \(mark.since("host: \(hid)").suffix(3).map { String($0.suffix(140)) })") }
    spin(0.5)
    let w = placedWindow(p)
    let shownLine = mark.since("host: \(hid) shown in").first
    let windowMode = mark.since("\(hid): full screen failed").count + mark.since("\(hid) shown in window mode").count + mark.since("backed out, shown in window mode").count
    let inMarginSaid = mark.since("\(hid): its window read in Margin's Space").count + mark.since("\(hid): Accessibility found its window in Margin's Space").count
    let landed = first.spaces == [marginSpace] || inMarginSaid > 0
    let within = placedAt.map { $0.timeIntervalSince(first.at) }
    let fullScreen = shownLine.map { $0.contains("(full screen") } == true
    let holds = w != nil && w!.on && w!.spaces == [marginSpace] && near(w!.r, area, 1)
    let ownSpaces = mc().filter { $0.hasSuffix("/pid\(p)") }
    let ok = fullScreen && windowMode == 0 && holds && ownSpaces.isEmpty && (within ?? 99) <= 2.0
    let detail = "its first window #\(first.n) in \(first.spaces) \(String(format: "%.2f", first.at.timeIntervalSince(asked))) s after the ask (Margin's Space \(marginSpace)), its Spaces then \(spacesSeen.prefix(6)); at the page area in Margin's Space only \(within.map { String(format: "%.2f s", $0) } ?? "never (for a second)") after its first window (\(fullScreen ? "full screen" : "NOT full screen")); window mode said \(windowMode) time(s); now \(w.map { "#\($0.n) \(rect($0.r)) onscreen \($0.on) spaces \($0.spaces)" } ?? "no window"), page area \(rect(area)); its own full-screen Spaces \(ownSpaces)"
    if landed || !ok { step(name, ok, detail) } else { skip(name, "its first window wasn't in Margin's Space (the case didn't happen): " + detail) }
    if !ok { log("   DIAG \(diag(p, marginWindow.n))") }
    gate("the first copy again")
    hook(["app": copy(1).id])
    spin(6) { copyApp(1).flatMap { big($0.processIdentifier) } != nil && word(front(), "page") == "shown" }
  }

  // ---- x1 x2 ----
  func busyWithExtras(_ n: Int) {
    let n1 = "x1 a fresh Chameleon whose Accessibility answers kAXErrorCannotComplete as it launches: full screen at the page area, never window mode"
    let n2 = "x2 its own full-width strip and its window over the sidebar: never let in front of Margin's window, Margin's panel above both"
    gate("the busy copy")
    quitCopy(n); spin(1.5)
    guard copyApp(n) == nil else { skip(n1, "Chameleon \(n) still runs: not a fresh launch"); return skip(n2, "as x1") }
    if active(cid) != marginSpace { m.activate(); spin(3) { active(cid) == marginSpace } }
    guard active(cid) == marginSpace else { skip(n1, "Margin's Space isn't the current one"); return skip(n2, "as x1") }
    setSwitches(n, ["axBusy": "2.5", "strip": "at:6,for:5", "auxiliary": "sidebar,at:6,for:5,borderless"])
    defer { setSwitches(n, [:]) }
    guard let area = rectIn(front(), "page area") else { step(n1, false, "no page area from Margin before the ask"); return skip(n2, "as x1") }
    let optionsBefore = copySaid(n, "options pid"), busyBefore = copySaid(n, "busy pid"), stripBefore = copySaid(n, "extra strip window")
    let mark = LogMark()
    let hid = "app:\(copy(n).id)"
    gate("asking for the busy copy")
    hook(["app": copy(n).id])
    guard spin(10, { copyApp(n) != nil }), let pane2 = copyApp(n) else { step(n1, false, "the copy never started"); return skip(n2, "as x1") }
    spin(3) { copySaid(n, "options pid") > optionsBefore }
    spin(20) { !mark.since("host: \(hid) shown in").isEmpty || !mark.since("host: \(hid): place failed").isEmpty }
    spin(1.0)
    let shown = mark.since("host: \(hid) shown in").first
    let fullScreen = shown.map { $0.contains("(full screen") } == true
    let windowMode = mark.since("\(hid): full screen failed").count + mark.since("\(hid) shown in window mode").count + mark.since("backed out, shown in window mode").count
    let w = placedWindow(pane2.processIdentifier)
    let x1 = fullScreen && windowMode == 0 && w != nil && w!.on && w!.spaces == [marginSpace] && near(w!.r, area, 1)
    step(n1, x1, "it said busy \(copySaid(n, "busy pid") - busyBefore) time(s); Margin: \(fullScreen ? "full screen" : "NOT full screen"), window mode said \(windowMode) time(s), refused at first \(mark.since("\(hid): Accessibility didn't take its full screen at first").count) time(s), frames refused \(mark.since("\(hid): Accessibility refused its frame").count) time(s); now \(w.map { "#\($0.n) \(rect($0.r)) onscreen \($0.on) spaces \($0.spaces)" } ?? "no window"), page area \(rect(area))")
    if !x1 { log("   DIAG \(diag(pane2.processIdentifier, marginWindow.n))") }
    gate("its extra windows")
    spin(12) { copySaid(n, "extra strip window") > stripBefore }
    let extra = (copyWindows(n, "extra strip window") + copyWindows(n, "auxiliary window")).suffix(2)
    guard extra.count == 2 else { return step(n2, false, "its extra windows weren't made (its log: \(extra))") }
    _ = front()
    // (Each read: every one of the two on screen below Margin's panel. One never on screen at all (parked by Margin, or
    // drawn nowhere) can't be in front of it: said, not a failure; the 2026-11-17 baseline counted that as one.)
    var reads = 0, anyOn = 0, below = 0, bothOn = 0
    let end = Date().addingTimeInterval(3.5)
    while Date() < end {
      let list = onScreen()
      if let pi = panelN.flatMap({ p in list.firstIndex { $0.n == p } }) {
        let idx = extra.compactMap { x in list.firstIndex { $0.n == x } }
        if !idx.isEmpty { anyOn += 1; if idx.allSatisfy({ pi < $0 }) { below += 1 } }
        if idx.count == 2 { bothOn += 1 }
      }
      reads += 1
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    spin(4) { copySaid(n, "strip window") > 0 && copySaid(n, "closed (after") > 0 }
    spin(1.0)
    let letIn = extra.map { x in mark.since("another window (\(x)) in its Space: let in front of it").count }
    let ok2 = below == anyOn && letIn.allSatisfy { $0 == 0 }
    step(n2, ok2, "the strip and the window over the sidebar \(Array(extra)): on screen at \(anyOn) of \(reads) reads (both at \(bothOn)\(anyOn == 0 ? ": never on screen, nothing to cover" : "")), Margin's panel \(panelN.map(String.init) ?? "?") above every one on screen at \(below) of them; Margin let them in front \(letIn) time(s)")
    if !ok2 { log("   DIAG \(diag(pane2.processIdentifier, marginWindow.n))") }
    gate("the first copy again")
    hook(["app": copy(1).id])
    spin(6) { copyApp(1).flatMap { big($0.processIdentifier) } != nil && word(front(), "page") == "shown" }
  }

  // ---- R ----
  func relaunch(_ n: Int) {
    gate("the relaunch")
    let f = front()
    let last = match(f, #", last (\S+)"#)?.first ?? "?"
    guard last == "app:\(copy(n).id)" else { return skip("R Margin opened again with its last item", "the item Margin would show by itself isn't Chameleon \(n) (its dev hook says: last \(last)): Margin not opened again, nothing of the person's shown") }
    let oldPid = m.processIdentifier
    m.terminate()
    guard spin(25, { m.isTerminated }) else { restore("Margin didn't quit for the relaunch"); exit(10) }
    guard spin(10, { kill(oldPid, 0) != 0 && app(marginId) == nil }) else { restore("the Margin that quit was still there 10 s later"); exit(10) }
    spin(2)
    spin(6) { copies.allSatisfy { app($0.id) == nil } } // (Margin's quit quits the apps it started)
    guard copyApp(n) == nil else { restore("Chameleon \(n) was still running after Margin's quit"); exit(10) }
    let lastBefore = said("the item it showed last (").count, emptyBefore = said(": page empty").count, launcherBefore = said("its launcher in the page area again").count
    let loadingBefore = said(": page loading").count, shownBefore = said(": page shown").count
    sh("/usr/bin/defaults", ["delete", marginId, "MarginResumeLast"]) // (on, as Margin ships; MarginPrepareBrowser stays NO)
    gate("opening Margin again")
    sh("/usr/bin/open", [built])
    guard spin(10, { app(marginId) != nil }), let m2 = app(marginId), m2.processIdentifier != oldPid else { restore("Margin didn't start again"); exit(5) }
    m = m2
    let cameFront = bringMarginFront(m2, built)
    spin(45) { said(": page shown").count > shownBefore && copyApp(n) != nil }
    var f2 = front()
    spin(20) { f2 = front(); return word(f2, "full screen") == "true" && word(f2, "page") == "shown" }
    spin(1.0)
    let pane = copyApp(n)
    let space2 = (win(baseN) ?? big(m2.processIdentifier)).flatMap { spacesOf($0.n).first } ?? 0
    let placed = pane.flatMap { placedWindow($0.processIdentifier) }
    let over = pane.flatMap { above(m2.processIdentifier, $0.processIdentifier) }
    step("R Margin opened again: the item it showed last (Chameleon \(n)) shown again by itself, the page card loading from the start and never the launcher, then shown; on screen in Margin's Space only, under Margin's window; Margin in full screen",
         said("the item it showed last (").count == lastBefore + 1 && said(": page empty").count == emptyBefore && said("its launcher in the page area again").count == launcherBefore
           && said(": page loading").count > loadingBefore && said(": page shown").count > shownBefore && word(f2, "page") == "shown" && word(f2, "full screen") == "true"
           && placed != nil && placed!.on && space2 != 0 && placed!.spaces == [space2] && over?.ok == true,
         "last item shown \(said("the item it showed last (").count - lastBefore) time(s); page loading \(said(": page loading").count - loadingBefore), shown \(said(": page shown").count - shownBefore), empty \(said(": page empty").count - emptyBefore); now page \(word(f2, "page") ?? "?"), full screen \(word(f2, "full screen") ?? "?"), in front \(cameFront); its window \(placed.map { "#\($0.n) \(rect($0.r)) onscreen \($0.on) spaces \($0.spaces)" } ?? "none") (Margin's Space \(space2)); \(over?.text ?? "not both on screen")")
    if let w = win(baseN) ?? big(m2.processIdentifier) { marginWindow = w; marginSpace = space2 }
  }
}
