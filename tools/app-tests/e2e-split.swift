// Split View (docs/PEEK-SPLIT.md §4) in Margin's own window with its real page (part of the e2e run, beside
// e2e-glue.swift): two app items made a split, the page lays out Margin's <m-pane>s and an <m-divider> in <m-page> for
// the item in front, the window takes each pane's box from the page's layout (`paneLayout`), the session places each
// app's window there (the engine on the stand-in world), the holes are the panes' and the divider takes the pointer
// (Margin's, never a pane's); the divider dragged in the page (pointer events as WebKit hands a person's): the drag
// reaches the session (`split.resizing`), the ratios are saved and each window placed at its pane's new box; a
// double-click: equal sizes.
import AppKit
import Foundation
import WebKit

func glueSplitScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("glue: split view: \(label)", ok, detail()) }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-split-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let world = GlueHostWorld()
  var options = Shell.Options()
  options.harness = true
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root
  options.bundleIds = ["safari": fakeBundle]
  options.hostSystem = world
  options.appCatalog.folders = []
  options.appCatalog.spotlight = false
  options.appCatalog.icons = AppIconCache(folder: root.appendingPathComponent("icons"))
  var host = HostEngine.Options()
  host.every = 0.01
  host.privateRetire = 0
  options.hostOptions = host
  var hosted = HostedSession.Options()
  hosted.resumesLast = false
  hosted.preparesBrowser = false
  options.hostedOptions = hosted
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.split.\(ProcessInfo.processInfo.processIdentifier)"))
  let shell = Shell(link: link, apps: ScriptedApps(), hotKeys: FakeKeys(), options: options)
  shell.start()
  defer { shell.stop {} }
  let made = shell.makeMarginWindows()
  // (The pane click tap: a stand-in for each one made, the tap's word on a press handed back through `reports`.)
  var taps: [FakePaneTap] = []
  var reports: [@Sendable (PaneClickResult) -> Void] = []
  made.makePaneTap = { report, _ in
    let t = FakePaneTap()
    taps.append(t)
    reports.append(report)
    return t
  }
  made.paneTapTrusted = { true }
  made.paneTapGrace = 0
  let library = shell.library
  guard let session = shell.hosted, let engine = shell.host else { return check("the library, the session and the engine", false) }
  // (All panes active: on in the stand-in world, a pane gone let go after its grace, as in the app.)
  world.panesActive = true
  let space = library.spaces().first?.id ?? ""
  func app(_ bundle: String, _ name: String) -> String {
    (library.perform("addItem", ["spaceId": space, "target": ItemTarget.app(bundleId: bundle, name: name).json, "title": name]).result as? JSONObject)?["tabId"] as? String ?? ""
  }
  let notesItem = app("com.apple.Notes", "Notes"), editItem = app("com.apple.TextEdit", "TextEdit")
  let c = made.open()
  defer { made.closeAll() }
  world.marginWindow = c.window.windowNumber
  c.hostedBounds = { world.bounds(window: $0) }
  c.hostedPid = { world.wins[$0]?.pid ?? ($0 == 99950 ? 4242 : nil) } // (99950: the preview card's stand-in window below)
  world.display = c.contentFrame
  guard await until(15, { c.isReady }) else { return check("Margin's window's page drawn", false) }
  _ = library.perform("createSplit", ["windowId": c.id, "panes": [notesItem, editItem]])
  let notes = HostTarget.app("com.apple.Notes").id, edit = HostTarget.app("com.apple.TextEdit").id
  guard await until(15, { engine.visible.count == 2 && session.layout[c.id]?.split != nil }) else {
    return check("the split shown (both apps visible)", false, "\(engine.visible) \(session.done.suffix(6))")
  }
  await session.idle()
  let sp = session.layout[c.id]?.split ?? ""
  let drawn = await js(c.webView, "const p = document.querySelector('m-page'); return [p.getAttribute('m-split'), p.getAttribute('m-split-id'), p.querySelectorAll(':scope > m-pane').length, p.querySelectorAll(':scope > m-divider').length, [...p.querySelectorAll(':scope > m-pane')].map(x => x.getAttribute('m-pane-id')).join(',')].join('|')") as? String ?? ""
  check("the page lays the split out in <m-page>: a pane per item, in order, a divider between them", drawn == "row|\(sp)|2|1|\(notesItem),\(editItem)", drawn)
  let panes = c.paneLayout?.panes ?? []
  let notesWindow = world.apps.values.first { $0.bundle == "com.apple.Notes" }?.windows.first ?? 0
  let editWindow = world.apps.values.first { $0.bundle == "com.apple.TextEdit" }?.windows.first ?? 0
  let page = c.window.pageRect ?? .zero
  check("Margin's window takes each pane's box from its page's layout, side by side inside the page area with a gap",
        c.paneLayout?.split == sp && panes.map(\.item) == [notesItem, editItem] && panes.count == 2 && panes[0].rect.maxX < panes[1].rect.minX
        && abs(panes[0].rect.minX - page.minX) <= 1 && abs(panes[1].rect.maxX - page.maxX) <= 1, "\(panes) page \(page)")
  check("each app's window at its pane's box, both in Margin's Space; the pane added focused",
        panes.count == 2 && world.bounds(window: notesWindow) == panes[0].rect && world.bounds(window: editWindow) == panes[1].rect && Set(world.inMargin) == [notesWindow, editWindow]
        && engine.shown == edit && session.shown[c.id] == editItem && engine.visible[notes] != nil,
        "\(String(describing: world.bounds(window: notesWindow))) \(String(describing: world.bounds(window: editWindow))) \(world.inMargin)")
  _ = await until(3) { c.holes.count == 2 }
  check("the holes are the panes' boxes (each window's frame inside its pane)", c.holes == panes.map(\.rect), "\(c.holes)")
  let gap = CGPoint(x: (panes.first?.rect.maxX ?? 0) + 2, y: page.midY)
  _ = await until(3) { c.slot?.hits.contains { $0.contains(gap) } == true }
  check("the divider takes the pointer (Margin's, in the gap: never a pane's)", c.slot?.hits.contains { $0.contains(gap) } == true && !PassThrough.pageGets(gap, c.slot),
        "\(String(describing: c.slot?.hits))")

  // The pane click tap (PaneClickTap.swift): made once the split's two windows are visible, told each pane's hole, window
  // and app, the one with the keys and Margin's own windows; a press it claimed left by the monitor's path (nothing fronted
  // again), its word focusing that pane without fronting anything; a press it didn't claim focused the usual way.
  _ = await until(3) { (taps.last?.scenes.last ?? nil)?.panes.count == 2 }
  // (The first run's space editor has the keys: a field of Margin's, every press as before then. Let go, as a press outside it.)
  let fieldFirst = (taps.last?.scenes.last ?? nil)?.fieldHasKeys == c.pageWantsKeyboard
  c.push(#"{"type":"pressOutside"}"#)
  _ = await until(3) { !c.pageWantsKeyboard && (taps.last?.scenes.last ?? nil)?.fieldHasKeys == false }
  await session.idle()
  try? await Task.sleep(nanoseconds: 100_000_000)
  await session.idle()
  let scene = taps.last?.scenes.last ?? nil
  check("the pane click tap: a field of Margin's with the keys told as it takes and lets go of them", fieldFirst && scene?.fieldHasKeys == false)
  check("the pane click tap: made with the split's two windows visible and started, told each pane's hole, window and app, the focused one, Margin's own windows, the slot",
        taps.count == 1 && taps.last?.started == 1 && taps.last?.stopped == 0 && made.paneTapsMade == 1 && scene?.panes.map(\.window) == [notesWindow, editWindow]
        && scene?.panes.map(\.rect) == c.holes && scene?.panes.map { Optional($0.pid) } == [world.wins[notesWindow]?.pid, world.wins[editWindow]?.pid]
        && scene?.focused == editWindow && scene?.marginWindows.contains(c.window.windowNumber) == true && scene?.marginWindows.contains(c.panel.windowNumber) == true
        && scene?.slot == c.slot && scene?.fieldHasKeys == false, "\(taps.count) \(String(describing: scene))")
  // All panes active (PanesActive.swift): the split as Margin's window publishes it reaches the engine, which keeps
  // Notes (not the focused app) active; the tap's scene says Notes is kept.
  let notesPid = world.wins[notesWindow]?.pid ?? 0
  _ = await until(3) { made.keptActive == [notesPid] && (taps.last?.scenes.last ?? nil)?.kept == [notesPid] }
  check("all panes active: the split shown: Notes' window kept active (TextEdit focused), the tap's scene carries it",
        world.activeCalls.first == "keep \(notesPid) \(notesWindow)" && made.keptActive == [notesPid] && (taps.last?.scenes.last ?? nil)?.kept == [notesPid],
        "\(world.activeCalls) \(made.keptActive) \(String(describing: (taps.last?.scenes.last ?? nil)?.kept))")
  if let tap = taps.last, panes.count == 2 {
    tap.claims = [77]
    let notesMid = CGPoint(x: panes[0].rect.midX, y: panes[0].rect.midY), editMid = CGPoint(x: panes[1].rect.midX, y: panes[1].rect.midY)
    var mark = world.calls.count
    c.pressed(notesMid, number: 77)
    await session.idle()
    try? await Task.sleep(nanoseconds: 50_000_000)
    check("the pane click tap: a press it claimed (its pane's window made key by it): the monitor's path leaves it, nothing fronted",
          c.tapClaimedPresses == 1 && engine.shown == edit && !world.calls.dropFirst(mark).contains { $0.hasPrefix("activate") }, "\(world.calls.dropFirst(mark))")
    reports.last?(PaneClickResult(window: notesWindow, pid: world.wins[notesWindow]?.pid ?? 0, outcome: .delivered(already: false), ms: 6, number: 77))
    let focusedByTap = await until(3) { engine.shown == notes && session.shown[c.id] == notesItem }
    await session.idle()
    _ = await until(3) { (tap.scenes.last ?? nil)?.focused == notesWindow }
    check("the pane click tap: …its word: Notes focused (the keys, the sidebar's highlight), nothing fronted, the tap told Notes has the keys now",
          focusedByTap && !world.calls.dropFirst(mark).contains { $0.hasPrefix("activate") } && (tap.scenes.last ?? nil)?.focused == notesWindow,
          "\(String(describing: engine.shown)) \(world.calls.dropFirst(mark))")
    mark = world.calls.count
    c.pressed(editMid, number: 78)
    let usual = await until(3) { engine.shown == edit }
    await session.idle()
    check("the pane click tap: a press it didn't claim (passed, not key in time): focused the usual way, the visible ones fronted",
          usual && c.tapClaimedPresses == 1 && world.calls.dropFirst(mark).contains("activate com.apple.TextEdit"), "\(world.calls.dropFirst(mark))")
    // A press on Margin's own over the page area (the divider; a cut pane's arrow the same): never a pane's press.
    mark = world.calls.count
    let shownBefore = engine.shown
    c.pressed(gap, number: 79)
    await session.idle()
    try? await Task.sleep(nanoseconds: 50_000_000)
    await session.idle()
    check("a press on the divider (Margin's own over the page area): never taken for a press on a pane, nothing focused or fronted",
          engine.shown == shownBefore && !world.calls.dropFirst(mark).contains { $0.hasPrefix("activate") }, "\(String(describing: engine.shown)) \(world.calls.dropFirst(mark))")
    // Another Space current: every press passes at once, the tap gone after its grace unless the split's back by then.
    made.paneTapGrace = 0.3
    c.onCurrentSpace = { false }
    made.paneSceneChanged()
    let passing = tap.scenes.last.map { $0 == nil } == true && made.paneTap === tap
    c.onCurrentSpace = { true }
    made.paneSceneChanged()
    try? await Task.sleep(nanoseconds: 450_000_000)
    check("the pane click tap: another Space current for a moment: every press passes meanwhile, the same tap kept once it's back within its grace",
          passing && made.paneTap === tap && taps.count == 1 && tap.stopped == 0 && (tap.scenes.last ?? nil)?.panes.count == 2)
    c.onCurrentSpace = { false }
    made.paneSceneChanged()
    let gone = await until(2) { made.paneTap == nil }
    check("the pane click tap: another Space current: gone after its grace (stopped)", gone && tap.stopped == 1 && made.paneTapsEnded == 1)
    made.paneTapGrace = 0
    c.onCurrentSpace = { true }
    made.paneSceneChanged()
    check("the pane click tap: Margin's Space current again with the split: a new one", taps.count == 2 && taps.last?.started == 1 && made.paneTap === taps.last)
  }

  // A drag's frame told by the engine (its windows a frame behind at most): the holes are the new rects at once.
  let list = c.visibleHosts
  let moved = list.enumerated().map { i, v -> HostShownWindow in
    var m = v
    m.rect = i == 0 ? CGRect(x: v.rect.minX, y: v.rect.minY, width: v.rect.width - 80, height: v.rect.height) : CGRect(x: v.rect.minX - 80, y: v.rect.minY, width: v.rect.width + 80, height: v.rect.height)
    return m
  }
  c.followsPage(true)
  c.setVisibleHosts(moved)
  let liveHoles = c.holes
  c.followsPage(false)
  c.setVisibleHosts(list)
  check("a drag's frame: the holes follow the rects the engine says at once (the windows' bounds not read meanwhile), and go back with them",
        list.count == 2 && liveHoles == moved.map(\.rect) && c.holes == panes.map(\.rect), "\(liveHoles) \(c.holes)")

  // The preview card over the split (the real screen, 2026-11-21: the split's gap drawn as a stripe across the card's page):
  // the page draws the card, its window is told visible at its <m-preview-page>, and in the card's page nothing of
  // Margin's window paints (its ground cut there, its page's divider clipped out), while the gap beside the card is
  // still Margin's ground; the card's page is cut out of the ground even while its window's frame reads elsewhere.
  if panes.count == 2 {
    c.push(#"{"type":"peek","peek":{"url":"https://docs.example.org/guide","title":"The Guide","loading":false}}"#)
    _ = await until(3) { c.cardRect != nil }
    try? await Task.sleep(nanoseconds: 300_000_000) // (its open's animation over)
    let cardRect = c.cardRect ?? .zero
    let cardWindow = 99950
    let content = c.contentFrame
    func local(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x - content.minX, y: p.y - content.minY) }
    let gapX = (panes[0].rect.maxX + panes[1].rect.minX) / 2
    let under = CGPoint(x: gapX, y: cardRect.midY), aboveCard = CGPoint(x: gapX, y: (page.minY + cardRect.minY) / 2)
    var cardFrame: CGRect? = cardRect
    let was = c.hostedBounds
    c.hostedBounds = { n in n == cardWindow ? cardFrame : was(n) }
    let withCard = list + [HostShownWindow(window: cardWindow, rect: cardRect, role: .card, z: 2, focused: true)]
    c.setVisibleHosts(withCard)
    let cardScene = taps.last?.scenes.last ?? nil
    check("the pane click tap: the preview card over the split: only the card's page told (the dim around it Margin's)",
          cardScene?.panes.map(\.window) == [cardWindow] && cardScene?.panes.first?.card == true && cardScene?.panes.first?.rect == c.holes.last, "\(String(describing: cardScene)) \(c.holes)")
    check("The preview card over the split: drawn across the gap between the panes (set up)",
          cardRect.width > 0 && cardRect.minX < gapX && cardRect.maxX > gapX && cardRect.minY < page.midY && cardRect.maxY > page.midY && cardRect.minY > page.minY + 4, "\(cardRect) gap at \(gapX)")
    let onPage = await js(c.webView, "const p = document.querySelector('m-page'); const r = p.getBoundingClientRect(); return [p.hasAttribute('m-card-clip'), document.elementsFromPoint(\(Double(local(under).x)), \(Double(local(under).y))).map(e => e.localName).filter(n => n.startsWith('m-')).join(',')].join('|')") as? String ?? ""
    check("…the page's <m-page> clipped out of the card's page: nothing of it (the divider) there",
          onPage.hasPrefix("true|") && !onPage.contains("m-divider") && !onPage.contains("m-page"), onPage)
    let points = [local(under), local(aboveCard)]
    _ = await until(3) { windowAlpha(c.panel, at: points).map { $0[0] == 0 && $0[1] > 0 } == true }
    let alpha = windowAlpha(c.panel, at: points)
    check("…as the window server pictures Margin's window: see-through in the card's page where the gap crosses it (the card's window shows), the gap above the card painted",
          alpha.map { $0[0] == 0 && $0[1] > 0 } == true && c.holes.contains(cardRect) && !c.ground.fills(local(under)), "\(String(describing: alpha)) \(c.holes)")
    // (Its window's frame read elsewhere, not in place yet: the card's page still cut out of the ground.)
    cardFrame = CGRect(x: page.minX, y: page.minY, width: 200, height: 120)
    c.setVisibleHosts(list)
    c.setVisibleHosts(withCard)
    check("…the card's page cut out of Margin's ground whatever its window's frame reads (not in place yet) and whatever's under it, a split's gap",
          c.holes.contains(cardRect) && !c.ground.fills(local(under)) && c.ground.fills(local(aboveCard)), "\(c.holes) under \(c.ground.fills(local(under)))")
    cardFrame = cardRect
    c.hostedBounds = was
    c.setVisibleHosts(list)
    c.push(#"{"type":"peek","peek":null}"#)
    _ = await until(3) { c.cardRect == nil }
    let unclipped = await js(c.webView, "return document.querySelector('m-page').hasAttribute('m-card-clip') || getComputedStyle(document.querySelector('m-page')).clipPath !== 'none'") as? Bool
    check("…the card gone: <m-page> whole again, the holes the panes'", unclipped == false && c.holes == panes.map(\.rect), "\(String(describing: unclipped)) \(c.holes)")
  }

  // The divider dragged in the page: the drag reaches the session, the ratios are saved, each window placed at its new box.
  func divider(_ type: String, dx: Double = 0) async {
    _ = await js(c.webView, """
      const d = document.querySelector('m-page > m-divider'); const r = d.getBoundingClientRect();
      if ('\(type)' === 'pointerdown' || '\(type)' === 'dblclick') window.__splitAt = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const at = window.__splitAt;
      const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: \(type == "pointerup" || type == "dblclick" ? 0 : 1), clientX: at.x + \(dx), clientY: at.y };
      d.dispatchEvent('\(type)' === 'dblclick' ? new MouseEvent('dblclick', init) : new PointerEvent('\(type)', { ...init, pointerId: 9, isPrimary: true }));
      return true
    """)
  }
  await divider("pointerdown")
  await divider("pointermove", dx: -60)
  let reached = await until(5) { session.resizing == c.id }
  await divider("pointermove", dx: -120)
  try? await Task.sleep(nanoseconds: 120_000_000)
  await divider("pointerup", dx: -120)
  let over = await until(5) { session.resizing == nil }
  c.remeasure()
  _ = await until(5) { (c.paneLayout?.panes.first?.rect.width ?? 0) < (panes.first?.rect.width ?? 0) - 100 }
  await session.idle()
  let after = c.paneLayout?.panes ?? []
  let ratios = { ((library.values["splits"] as? JSONObject)?[sp] as? JSONObject)?["ratios"] as? [Double] ?? [] }
  _ = await until(3) { (ratios().first ?? 1) < 0.45 }
  check("the divider dragged: the drag reached the session, Notes' pane 120 pt narrower, the ratios saved",
        reached && over && after.count == 2 && abs((after.first?.rect.width ?? 0) - ((panes.first?.rect.width ?? 0) - 120)) <= 2 && ratios().count == 2 && (ratios().first ?? 1) < 0.45,
        "\(reached) \(over) \(after) \(ratios())")
  _ = await until(5) { world.bounds(window: notesWindow) == after.first?.rect }
  await session.idle()
  check("…each window placed at its pane's new box once it's let go, both still shown, the layout kept",
        after.count == 2 && world.bounds(window: notesWindow) == after[0].rect && world.bounds(window: editWindow) == after[1].rect && engine.visible.count == 2 && session.layout[c.id]?.split == sp,
        "\(String(describing: world.bounds(window: notesWindow))) \(String(describing: world.bounds(window: editWindow))) \(after)")
  await divider("dblclick")
  _ = await until(5) { ratios() == [0.5, 0.5] }
  check("a double-click on the divider: equal sizes saved", ratios() == [0.5, 0.5], "\(ratios())")

  // Remove from Split View on TextEdit's pane (an app's pane of a split of two), as its row's menu runs it: the action
  // with the row's number (the UI names an open item by its number; the library's item id is refused, as the on-screen
  // dev hook's dispatch with a pane's id was, 2026-11-21). The split ends, Notes shown alone at the page area, TextEdit's
  // window parked.
  await session.idle()
  let row = session.number(ofItem: editItem)
  let menu = await js(c.webView, "return JSON.stringify((window.marginApp.devState && JSON.parse(window.marginApp.devState()).split?.panes) || [])") as? String ?? ""
  let byId = await js(c.webView, "return String(window.marginApp.devDispatch('split.remove', '\(editItem)'))") as? String ?? ""
  let byRow = await js(c.webView, "return String(window.marginApp.devDispatch('split.remove', \(row)))") as? String ?? ""
  let ended = await until(10) { library.split(sp) == nil && engine.visible.count == 1 && session.layout[c.id] == nil && session.shown[c.id] == notesItem }
  await session.idle()
  _ = await until(5) { world.bounds(window: notesWindow) == c.window.pageRect }
  check("Remove from Split View on an app's pane of two, by its row's number (the pane menu's way): the split ends, the other shown alone at the page area, the removed one's window parked",
        byId == "false" && byRow == "true" && ended && world.bounds(window: notesWindow) == c.window.pageRect && !world.inMargin.contains(editWindow) && engine.shown == notes
        && library.items(space: space).contains { $0.id == editItem },
        "byId \(byId) byRow \(byRow) \(ended) \(String(describing: library.split(sp))) \(engine.visible) \(String(describing: world.bounds(window: notesWindow))) \(world.inMargin) \(menu) \(session.done.suffix(4))")
  check("…the page's state names each pane by its row's number too (what an on-screen check dispatches with)", menu.contains("\"tabId\":\(row)"), menu)
  // (One tap for both, docs/SIDEBAR-PRESS.md: it stays for Margin's panel while the window hosts; the split's part of it,
  // the first click in another pane, is over: its scene has no panes.)
  let toldAlone = taps.last?.scenes.last ?? nil
  check("the pane click tap: the split ended, one window shown: the tap stays (Margin's panel's presses), told no panes (the split's pane clicks over) and this window's panel",
        made.paneTap != nil && taps.last?.stopped == 0 && toldAlone?.panes.isEmpty == true && toldAlone?.panels.map(\.window) == [c.panel.windowNumber],
        "\(taps.map(\.stopped)) \(String(describing: toldAlone))")
  _ = await until(3) { made.keptActive.isEmpty }
  check("all panes active: the split ended: every app kept let go (deactivated), none kept", made.keptActive.isEmpty && engine.keptActive.isEmpty
        && world.activeCalls.contains { $0.hasPrefix("release ") }, "\(world.activeCalls) \(made.keptActive)")

  // A split again, then Margin quits: the tap goes at once.
  _ = library.perform("createSplit", ["windowId": c.id, "panes": [notesItem, editItem]])
  let again = await until(15) { engine.visible.count == 2 && made.paneTap != nil && (taps.last?.scenes.last ?? nil)?.panes.count == 2 }
  let last = taps.last
  _ = await until(3) { !engine.keptActive.isEmpty }
  let keptAgain = !engine.keptActive.isEmpty
  made.closeAll()
  check("the pane click tap: a split again: the tap told its panes again; Margin quits (its windows closed): stopped at once", again && last?.stopped == 1 && made.paneTap == nil,
        "\(again) \(String(describing: last?.stopped))")
  _ = await until(3) { engine.keptActive.isEmpty }
  check("all panes active: a split again: kept again; Margin's windows closed: let go", keptAgain && engine.keptActive.isEmpty, "\(world.activeCalls)")
  print("  (all panes active, the glue's split: \(world.activeCalls.count) records asked over its two splits, its presses and its ends: \(world.activeCalls.joined(separator: ", ")))")
}

// The pane click tap's stand-in: what it was told, the presses it claims.
nonisolated final class FakePaneTap: PaneClickTapping, @unchecked Sendable {
  var started = 0, stopped = 0
  var scenes: [PaneClickScene?] = []
  var claims: Set<Int> = []
  func start() { started += 1 }
  func stop() { stopped += 1 }
  func update(_ scene: PaneClickScene?) { scenes.append(scene) }
  func claimed(number: Int, at point: CGPoint) -> Bool { claims.remove(number) != nil }
  // (A press it delivered to a Margin window's panel: docs/SIDEBAR-PRESS.md.)
  var panelClaims: Set<Int> = []
  func claimedPanel(number: Int) -> Bool { panelClaims.remove(number) != nil }
}
