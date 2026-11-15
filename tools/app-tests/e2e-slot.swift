// The slot through the real shell (part of e2e.swift's run; app/platforms/macos/shell/Slot.swift
// and ShellSlot.swift): the real link, shell and overlay against fake-extension.mts, one
// full-screen window as a stand-in off every display, and a stand-in for the Spaces' reserved
// edges that plays the window manager (a reservation resizes the stand-in window a moment
// later, unless it's told the window won't take it). No private macOS call is made.
//
// What it follows: the layout the overlay measures reserved in the window's Space and its
// copy sent a layout with no insets; the overlay kept over the whole display while its
// window is the slot; the copy's own (smaller) bounds still bound; the slot given back when
// the window leaves full screen and taken again when it's back; a window that won't take
// the slot given the page box (the real insets sent); everything given back at quit.
import AppKit
import WebKit

final class StandInSlotSpaces: SlotSpaces {
  var reservedNow: [UInt64: SlotEdges] = [:]
  private(set) var calls: [String] = []
  var onReserve: ((UInt64, SlotEdges) -> Void)?
  func reserve(_ edges: SlotEdges, space: UInt64) -> Bool {
    calls.append("reserve \(space) \(edges.text)")
    if reservedNow[space] != nil { reservedNow[space] = edges }
    onReserve?(space, edges)
    return true
  }
  func reserved(space: UInt64) -> SlotEdges? { reservedNow[space] }
}

@MainActor
func slotScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("slot: \(label)", ok, detail()) }
  let fake = Fake()
  do { try fake.start() } catch { check("fake extension starts", false); return }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { check("fake extension starts", false); return }
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("margin-e2e-slot-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.slot.\(ProcessInfo.processInfo.processIdentifier)"))
  let windows = ScriptedWindows(), apps = ScriptedApps()
  let stand = StandInSlotSpaces()
  stand.reservedNow = [10: .zero]
  var options = Shell.Options()
  options.harness = true
  options.overlay.harness = true
  options.fillsDisplay = { $0.width >= 1000 && $0.height >= 760 }
  options.slot = true
  options.slotSpaces = stand
  options.slotSpaceOf = { _ in 10 }
  options.root = URL(fileURLWithPath: env["MARGIN_APP_ROOT"]!)
  options.dataRoot = root
  options.bundleIds = ["safari": fakeBundle]
  let shell = Shell(link: link, windows: windows, apps: apps, hotKeys: FakeKeys(), options: options)
  windows.shell = shell
  check("a shell given a stand-in and the setting has a keeper", shell.slots != nil)
  let full = CGRect(x: -20000, y: -20000, width: 1200, height: 800)
  let a = standIn(full)
  defer { a.close() }
  let number = a.windowNumber
  var takes = true
  func place(_ bounds: CGRect) { windows.browser = [ServerWindow(number: number, pid: browserPid, bounds: bounds, onScreen: true)] }
  func real() -> CGRect? { windows.browser.first?.bounds }
  stand.onReserve = { _, edges in
    guard takes else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { MainActor.assumeIsolated { place(edges.inset(full)) } }
  }
  place(full)
  shell.start()
  var stopped = false
  defer { if !stopped { shell.stop {} } }
  guard await until(3, { link.port != nil }) else { check("link listens", false); return }
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { check("link requested", false); return }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { check("linked", false); return }
  func win(_ bounds: CGRect, state: String = "fullscreen") -> JSONObject {
    ["windowId": 1, "left": bounds.minX, "top": bounds.minY, "width": bounds.width, "height": bounds.height, "state": state, "focused": true]
  }
  fake.tell(["do": "connect", "id": "P", "profile": "P", "windows": [win(full)]])
  apps.bringToFront(browserPid)
  let key = WindowKey(link: "safari:P", windowId: 1)
  guard await until(10, { shell.overlays[key] != nil }), let overlay = shell.overlays[key] else { check("its overlay made", false); return }
  guard await until(15, { overlay.isReady && overlay.isShown }) else { check("its overlay drawn and shown", false); return }
  func insets(_ m: JSONObject?) -> [Double]? {
    guard let i = (m?["msg"] as? JSONObject)?["insets"] as? JSONObject, let l = num(i["left"]), let t = num(i["top"]), let r = num(i["right"]), let b = num(i["bottom"]) else { return nil }
    return [l, t, r, b]
  }
  func size(_ m: JSONObject?) -> [Double]? {
    guard let c = (m?["msg"] as? JSONObject)?["container"] as? JSONObject, let w = num(c["width"]), let h = num(c["height"]) else { return nil }
    return [w, h]
  }

  // ---- the layout reserved, the copy sent no insets ----
  guard await until(10, { shell.slots?.slot(of: number) != nil }), let slot = shell.slots?.slot(of: number) else {
    check("the overlay's layout reserved in its window's Space", false, "\(stand.calls) \(fake.all("setLayout").count)")
    return
  }
  let edges = slot.edges
  check("the overlay's layout reserved in its window's Space: a sidebar's width on the left, whole points", stand.calls.last == "reserve 10 \(edges.text)" && edges.left >= 100 && edges == edges.whole, "\(stand.calls)")
  check("kept with the window's full frame", slot.full == full && slot.space == 10)
  check("its window takes the slot, and the keeper says it landed", await until(3, { shell.slots?.slot(of: number)?.landedAt != nil }) && real() == edges.inset(full), "\(String(describing: real()))")
  check("its copy sent a layout with no insets, at the slot's size (the page is the whole window)",
        await until(5, { insets(fake.all("setLayout").last) == [0, 0, 0, 0] }) && size(fake.all("setLayout").last) == [Double(edges.inset(full).width), Double(edges.inset(full).height)],
        "\(fake.all("setLayout").map { insets($0) ?? [] }) \(String(describing: size(fake.all("setLayout").last)))")
  check("no layout with insets ever went (the page box was never asked for)", fake.all("setLayout").allSatisfy { insets($0) == [0, 0, 0, 0] }, "\(fake.all("setLayout").map { insets($0) ?? [] })")
  check("the overlay stays over the whole display, shown", overlay.frameTopLeft == full && overlay.isShown && overlay.windowFrame == full, "\(overlay.frameTopLeft)")
  check("the shell's reads give the window at its full frame, the window server's its real one",
        shell.windowSource.windows(of: [browserPid]).first { $0.number == number }?.bounds == full && shell.rawWindows.windows(of: [browserPid]).first { $0.number == number }?.bounds == edges.inset(full))

  // ---- the copy's own bounds are the slot's now: still bound, nothing moves ----
  var mark = fake.events.count
  fake.tell(["do": "windows", "id": "P", "list": [win(edges.inset(full))]])
  let stillBound = await until(2, { shell.matches[key] == number })
  let moved = await until(1, { shell.matches[key] != number || !overlay.isShown })
  check("the copy reporting the slot's bounds stays bound to its window", stillBound && !moved)
  check("and no new layout is sent", fake.first("setLayout", since: mark) == nil && overlay.frameTopLeft == full)

  // ---- out of full screen and back ----
  let calls = stand.calls.count
  place(CGRect(x: -20000, y: -20000, width: 900, height: 600))
  fake.tell(["do": "windows", "id": "P", "list": [win(CGRect(x: -20000, y: -20000, width: 900, height: 600), state: "normal")]])
  check("its window out of full screen: the slot given back", await until(3, { shell.slots?.serves(number) == false }) && stand.calls.dropFirst(calls).contains("reserve 10 0/0/0/0"), "\(stand.calls.dropFirst(calls))")
  place(full)
  mark = fake.events.count
  fake.tell(["do": "windows", "id": "P", "list": [win(full)]])
  check("back in full screen: reserved again, landed", await until(10, { shell.slots?.slot(of: number)?.landedAt != nil }) && real() == edges.inset(full), "\(stand.calls.suffix(3))")

  // ---- a window that won't take the slot: the page box ----
  takes = false
  shell.slots?.release(number, why: "the test's own")
  place(full)
  shell.slots?.options.landWithin = 0.3
  mark = fake.events.count
  check("a window that doesn't take its slot: the reservation given back after one more try",
        await until(8, { shell.slots?.boxed[number] != nil }) && stand.calls.last == "reserve 10 0/0/0/0", "\(stand.calls.suffix(4))")
  check("and its copy sent the layout's own insets: the page box", await until(5, { insets(fake.all("setLayout", since: mark).last) == [edges.left, edges.top, edges.right, edges.bottom] }),
        "\(fake.all("setLayout", since: mark).map { insets($0) ?? [] })")
  check("the overlay as it was", overlay.frameTopLeft == full && overlay.isShown)

  // ---- quit ----
  takes = true
  shell.slots?.gone(number) // (a new window, as far as the keeper knows)
  check("asked again: reserved again", await until(8, { shell.slots?.serves(number) == true }), "\(stand.calls.suffix(3))")
  let before = stand.calls.count
  var done = false
  shell.stop { done = true }
  stopped = true
  check("quit: every reservation given back", await until(3, { done }) && stand.calls.dropFirst(before).contains("reserve 10 0/0/0/0") && shell.slots?.slots.isEmpty == true, "\(stand.calls.dropFirst(before))")
  check("and no marker left", !FileManager.default.fileExists(atPath: shell.slotMarkerURL.path))
}
