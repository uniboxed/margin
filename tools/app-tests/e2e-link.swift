// The link's requests end on evidence only (docs/LINK-RESILIENCE.md §1; part of e2e.swift's run): the real link
// (ExtensionLink.swift over margin-core's) against fake-extension.mts's `stall` and `lose` modes. A copy that runs late
// but is alive (its window reports keep coming) is waited for past any fixed time and answers once it catches up; one
// silent past the dead rule ends the link and its requests `down`; a request the copy read past without taking is sent
// again with its id, then `lost`.
import AppKit

final class LinkWatch: ExtensionLinkDelegate {
  var up: [String: LinkConnection] = [:]
  var downs: [String] = []
  func linkUp(_ link: LinkConnection) { up[link.key] = link }
  func linkReceived(_ link: LinkConnection, _ message: LinkMessage) {}
  func linkDown(_ link: LinkConnection, _ why: String) { downs.append("\(link.key): \(why)"); if up[link.key] === link { up[link.key] = nil } }
}

@MainActor
func linkScenario() async {
  func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { e2eCheck("link: \(label)", ok, detail()) }
  let started = Date()
  let fake = Fake()
  do { try fake.start() } catch { return check("the fake extension starts", false, "\(error)") }
  defer { fake.stop() }
  guard await until(5, { fake.first("ready") != nil }) else { return check("the fake extension starts", false) }
  let link = SocketLink(dispatch: FakeDispatch(), safariSince: { nil }, wake: Notification.Name("com.unibox.margin.test.link.\(ProcessInfo.processInfo.processIdentifier)"),
                        timing: .init(tick: 0.5, dead: 3, keep: 30, hello: 2, safariSettled: 2))
  let watch = LinkWatch()
  link.delegate = watch
  link.start()
  defer { link.stop(why: "the test is over") {} }
  guard await until(3, { link.port != nil }) else { return check("listening", false) }
  fake.tell(["do": "wantLink"])
  guard await until(3, { fake.first("wantLink") != nil }), let nonce = fake.first("wantLink")?["nonce"] as? String else { return check("wantLink", false) }
  link.wantLink(nonce: nonce)
  guard await until(3, { fake.first("link") != nil }) else { return check("the link", false) }
  func connect(_ id: String) async -> LinkConnection? {
    fake.tell(["do": "connect", "id": id, "profile": "s-\(id.lowercased())", "theme": NSNull()])
    _ = await until(3, { watch.up["safari:s-\(id.lowercased())"] != nil })
    return watch.up["safari:s-\(id.lowercased())"]
  }
  // A request's outcome, with how long it took.
  final class Outcome { var reply: JSONObject?; var error: Error?; var at: Date?; var done: Bool { at != nil } }
  func ask(_ c: LinkConnection, _ type: String, _ payload: JSONObject = [:]) -> Outcome {
    let o = Outcome()
    Task { @MainActor in
      do { o.reply = try await c.request(type: type, payload: payload, windowId: nil) } catch { o.error = error }
      o.at = Date()
    }
    return o
  }
  // The copy's window reports while it's stalled: alive (any bytes), never reading.
  func reporting(_ id: String, while going: @escaping () -> Bool) {
    Task { @MainActor in
      while going() {
        fake.tell(["do": "windows", "id": id, "list": []])
        try? await Task.sleep(nanoseconds: 400_000_000)
      }
    }
  }

  // ---- a copy alive but slow: waited for past any fixed time, answered once it catches up ----
  guard let a = await connect("A") else { return check("the copy linked", false) }
  var mark = fake.events.count
  fake.tell(["do": "stall", "id": "A", "ms": 7000])
  _ = await until(2, { fake.first("stalled", since: mark) != nil })
  let asked = Date()
  let slowShow = ask(a, "hostShow", ["windowId": 90, "itemId": "w1", "url": "https://example.com/"])
  reporting("A", while: { !slowShow.done && a.isUp })
  _ = await until(12, { slowShow.done })
  let waited = slowShow.at.map { $0.timeIntervalSince(asked) } ?? -1
  check("a request to a copy stalled 7 s (alive: its window reports came) waits past the old 5 s and is answered once the copy catches up",
        slowShow.reply?["ok"] as? Bool == true && waited >= 6.5 && slowShow.error == nil, "after \(String(format: "%.1f", waited)) s: \(String(describing: slowShow.reply)) \(String(describing: slowShow.error))")
  check("the link stayed up through it (alive, not reading: slow, not gone)", a.isUp && watch.downs.isEmpty, "\(watch.downs)")
  mark = fake.events.count
  fake.tell(["do": "stall", "id": "A", "ms": 0])
  reporting("A", while: { fake.first("drained", since: mark) == nil && a.isUp })
  guard await until(10, { fake.first("drained", since: mark) != nil }) else { return check("the copy caught up", false) }

  // ---- read past without being taken: sent again with its id, answered; twice: lost ----
  mark = fake.events.count
  fake.tell(["do": "lose", "id": "A", "n": 1])
  let once = ask(a, "hostShow", ["windowId": 90, "itemId": "w2", "url": "https://two.example/"])
  _ = await until(5, { once.done })
  let lostId = fake.first("lost", since: mark).flatMap { int($0["reqId"]) }
  let ranId = fake.first("req", since: mark).flatMap { int(($0["msg"] as? JSONObject)?["id"]) }
  check("a request the copy read past (a numbered tock after it, no ack): sent again with the same id, then answered",
        once.reply?["ok"] as? Bool == true && lostId != nil && lostId == ranId, "lost \(String(describing: lostId)) ran \(String(describing: ranId)) \(String(describing: once.error))")
  mark = fake.events.count
  fake.tell(["do": "lose", "id": "A", "n": 2])
  let twice = ask(a, "hostShow", ["windowId": 90, "itemId": "w3", "url": "https://three.example/"])
  _ = await until(5, { twice.done })
  check("read past twice: the request ends `lost`, never run", twice.error.map { "\($0)" } == "lost" && fake.all("lost", since: mark).count == 2 && fake.first("req", since: mark) == nil,
        "\(String(describing: twice.error)) \(fake.all("lost", since: mark).count)")

  // ---- new API: slow and cancel ----
  mark = fake.events.count
  fake.tell(["do": "stall", "id": "A", "ms": 3000])
  _ = await until(2, { fake.first("stalled", since: mark) != nil })
  reporting("A", while: { fake.first("drained", since: mark) == nil && a.isUp })
  var askedId: Int?
  let overtaken = Outcome()
  Task { @MainActor in
    do { overtaken.reply = try await a.request(type: "hostShow", payload: ["windowId": 90, "itemId": "w5", "url": "https://five.example/"], windowId: nil, asked: { askedId = $0 }) } catch { overtaken.error = error }
    overtaken.at = Date()
  }
  try? await Task.sleep(nanoseconds: 600_000_000)
  let slowFor = a.slow ?? 0
  check("a stalled copy is slow: its oldest request not acked, for how long", slowFor >= 0.5 && slowFor < 3, "\(slowFor)")
  let cancelled = askedId.map { a.cancel($0) } ?? false
  _ = await until(1, { overtaken.done })
  let told = await until(2, { fake.first("cancel", since: mark) != nil })
  check("cancelled: the call ends at once, `cancelled`, and the copy is told before it ran it", cancelled && overtaken.error.map { "\($0)" } == "cancelled"
        && told && fake.first("cancel", since: mark)?["started"] as? Bool == false,
        "\(String(describing: overtaken.error)) \(String(describing: fake.first("cancel", since: mark)))")
  fake.tell(["do": "stall", "id": "A", "ms": 0])
  _ = await until(6, { fake.first("drained", since: mark) != nil })
  check("… and it never ran there (no req, no ack); nothing waits unread then", fake.first("req", since: mark) == nil && a.slow == nil, "\(String(describing: a.slow))")
  // ---- end new API ----

  // ---- total silence: the dead rule ends the link, its request `down` ----
  guard let b = await connect("B") else { return check("a second copy linked", false) }
  fake.tell(["do": "stall", "id": "B", "ms": 10_000])
  let silent = ask(b, "hostShow", ["windowId": 91, "itemId": "w4", "url": "https://four.example/"])
  let silentAt = Date()
  _ = await until(8, { silent.done })
  let ended = silent.at.map { $0.timeIntervalSince(silentAt) } ?? -1
  check("a copy silent past the dead rule (3 s here): its link closed and its request ended `down`",
        silent.error.map { "\($0)" } == "down" && ended >= 2.5 && !b.isUp && watch.downs.contains { $0.hasPrefix("safari:s-b") }, "\(String(describing: silent.error)) after \(String(format: "%.1f", ended)) s \(watch.downs)")
  print(String(format: "  timings: the link scenario %.1f s", Date().timeIntervalSince(started)))
}
