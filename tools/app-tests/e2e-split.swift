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
  guard let library = shell.library, let session = shell.hosted, let engine = shell.host else { return check("the library, the session and the engine", false) }
  let space = library.spaces().first?.id ?? ""
  func app(_ bundle: String, _ name: String) -> String {
    (library.perform("addItem", ["spaceId": space, "target": ItemTarget.app(bundleId: bundle, name: name).json, "title": name]).result as? JSONObject)?["tabId"] as? String ?? ""
  }
  let notesItem = app("com.apple.Notes", "Notes"), editItem = app("com.apple.TextEdit", "TextEdit")
  let c = made.open()
  defer { made.closeAll() }
  world.marginWindow = c.window.windowNumber
  c.hostedBounds = { world.bounds(window: $0) }
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
}
