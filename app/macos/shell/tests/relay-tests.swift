// Chrome's and Edge's connector (docs/PROTOCOL.md "Transport (Chrome and Edge, on the Mac)"): the real connector
// (app/shared/connector/, built by run.sh: MARGIN_CONNECTOR_BIN) spoken to as a browser speaks to a native host (its
// framing on stdin and stdout), linked to the app's real relay listener (RelayLink.swift) and SocketLink, in a
// temporary folder. What a wantLink gets (the handler's reply with the browser and its process, then the link
// dispatched as Safari's would be), a ping, the app not there, a relay that waited being told appUp, another version
// of the app, and who may connect.
import Foundation

private final class RelayProcess {
  let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private var received = Data()
  private let lock = NSLock()

  init(_ binary: String, socket: String, browser: String = "edge", version: String = "7") {
    process.executableURL = URL(fileURLWithPath: binary)
    var env = ProcessInfo.processInfo.environment
    env["MARGIN_CONNECTOR_SOCKET"] = socket
    env["MARGIN_CONNECTOR_BROWSER"] = browser
    env["MARGIN_CONNECTOR_VERSION"] = version
    env["MARGIN_CONNECTOR_NO_LAUNCH"] = "1"
    process.environment = env
    process.standardInput = input
    process.standardOutput = output
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard let self, !data.isEmpty else { return }
      self.lock.lock(); self.received.append(data); self.lock.unlock()
    }
    try? process.run()
  }

  // One message as the browser sends it.
  func send(_ object: JSONObject) {
    let json = try! JSONSerialization.data(withJSONObject: object)
    var length = UInt32(json.count)
    input.fileHandleForWriting.write(Data(bytes: &length, count: 4) + json)
  }

  // The next message the relay sends the browser, within `timeout` (the main run loop turning meanwhile: the
  // app's listener is on it).
  func next(_ timeout: TimeInterval = 3) -> JSONObject? {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      lock.lock()
      if received.count >= 4 {
        let length = Int(received.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) })
        if received.count >= 4 + length {
          let body = received.subdata(in: 4..<(4 + length))
          received.removeSubrange(0..<(4 + length))
          lock.unlock()
          return object(body)
        }
      }
      lock.unlock()
      RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    return nil
  }

  func end() {
    try? input.fileHandleForWriting.close()
    if process.isRunning { process.terminate() }
  }
}

private struct NoSafari: ExtensionDispatch {
  func dispatch(_ name: String, _ info: JSONObject, done: @escaping @MainActor (String?) -> Void) { done("no Safari here") }
}

private func spin(_ seconds: TimeInterval, until test: () -> Bool = { false }) {
  let end = Date().addingTimeInterval(seconds)
  while Date() < end, !test() { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
}

func relayTests() {
  guard let binary = ProcessInfo.processInfo.environment["MARGIN_CONNECTOR_BIN"] else {
    return check("relay: MARGIN_CONNECTOR_BIN set by run.sh", false)
  }
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent("margin-relay-\(getpid())", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: dir) }
  let path = dir.appendingPathComponent("r.sock").path
  let me = getpid()

  // Who may connect: this user's processes; another user's never.
  check("relay peers: another user's process is refused", RelayHub.relaySignedByUs(RelayHub.Peer(pid: me, uid: getuid() + 1)) == "another user's process")
  check("relay peers: this (unsigned) test's own process is let in", RelayHub.relaySignedByUs(RelayHub.Peer(pid: me, uid: getuid())) == nil)

  // No app: the relay answers as Safari's handler does then, and keeps waiting.
  let early = RelayProcess(binary, socket: path)
  early.send(["type": "wantLink", "nonce": "n0"])
  let alone = early.next()
  check("no app: answered by the connector, not open, not launching (MARGIN_CONNECTOR_NO_LAUNCH)", alone?["appOpen"] as? Bool == false && alone?["launching"] as? Bool == false && alone?["browser"] as? String == "edge", "\(alone ?? [:])")

  let link = SocketLink(dispatch: NoSafari(), safariSince: { nil }, wake: Notification.Name("io.tirth.margin.test.relay.\(me)"))
  let hub = RelayHub(path: path, version: "7", allows: { $0.uid == getuid() ? nil : "not this user" })
  link.relay = hub
  link.start()
  spin(3) { link.port != nil }
  check("the link listens", link.port != nil)
  check("relay socket: this user's only", (try? FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int) == 0o600)

  // The relay that waited is in now: told appUp, as Safari's copies are when the app starts.
  let up = early.next()
  check("a relay that waited: appUp dispatched to it once in", up?["name"] as? String == "appUp" && object((up?["userInfo"] as? JSONObject)?["e"] as? String)?["v"] as? Int == 2, "\(up ?? [:])")
  early.end()

  // A wantLink: the handler's reply (the browser and its process), then the link dispatched into the browser's relays.
  let relay = RelayProcess(binary, socket: path)
  spin(2) { hub.connected >= 1 }
  relay.send(["type": "wantLink", "nonce": "n1"])
  let reply = relay.next()
  check("wantLink: replied open, with the browser and its process", reply?["ok"] as? Bool == true && reply?["appOpen"] as? Bool == true && reply?["launching"] as? Bool == false
          && reply?["browser"] as? String == "edge" && reply?["pid"] as? Int == Int(me), "\(reply ?? [:])")
  let dispatched = relay.next()
  let info = object((dispatched?["userInfo"] as? JSONObject)?["e"] as? String)
  check("wantLink: the link dispatched as Safari's arrives (name, userInfo.e)", dispatched?["name"] as? String == "link", "\(dispatched ?? [:])")
  check("the link: its nonce, the port, a token and a key", info?["nonce"] as? String == "n1" && info?["port"] as? Int == link.port.map(Int.init)
          && (info?["token"] as? String)?.count == 64 && (info?["key"] as? String)?.count == 64, "\(info ?? [:])")
  relay.send(["type": "ping", "at": 1])
  check("a ping: answered", relay.next()?["ok"] as? Bool == true)
  relay.send(["type": "log", "line": "kept link try 1 of 3"])
  check("a log line: answered (and in the app's log)", relay.next()?["ok"] as? Bool == true)
  relay.end()

  // Another version of Margin.app answering: the relay leaves (the browser starts the new one).
  let old = RelayProcess(binary, socket: path, version: "6")
  spin(3) { !old.process.isRunning }
  check("another version of the app: the relay exits", !old.process.isRunning)
  old.end()

  // Refused by the listener's check: closed at once, the relay answering alone again.
  let strict = RelayHub(path: dir.appendingPathComponent("s.sock").path, version: "7", allows: { _ in "not Margin's relay" })
  let strictLink = SocketLink(dispatch: NoSafari(), safariSince: { nil }, wake: Notification.Name("io.tirth.margin.test.relay.strict.\(me)"))
  strictLink.relay = strict
  strictLink.start()
  let refused = RelayProcess(binary, socket: strict.path)
  spin(0.5)
  check("a refused relay: never connected", strict.connected == 0)
  refused.end()

  // The host files (margin-connector --install): written for each Chromium browser whose folder is there, naming
  // the connector and only Margin's extension; the same again writes nothing.
  let support = dir.appendingPathComponent("support", isDirectory: true)
  for browser in ["Google/Chrome", "Microsoft Edge Beta"] {
    try? FileManager.default.createDirectory(at: support.appendingPathComponent(browser, isDirectory: true), withIntermediateDirectories: true)
  }
  func install() -> (Int32, [String]) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: binary)
    process.arguments = ["--install", "--support", support.path]
    let out = Pipe()
    process.standardOutput = out
    try? process.run()
    process.waitUntilExit()
    let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return (process.terminationStatus, text.split(separator: "\n").map(String.init))
  }
  let (status, written) = install()
  check("host files: Chrome's and Edge Beta's, no other browser's", status == 0 && written.count == 2 && written.allSatisfy { $0.hasSuffix("NativeMessagingHosts/io.tirth.margin.json") }, "\(status) \(written)")
  let host = object(try? Data(contentsOf: support.appendingPathComponent("Google/Chrome/NativeMessagingHosts/io.tirth.margin.json")))
  let real = URL(fileURLWithPath: binary).resolvingSymlinksInPath().path
  check("a host file: the connector, stdio, Margin's extension only", host?["name"] as? String == "io.tirth.margin" && (host?["path"] as? String).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path } == real
          && host?["type"] as? String == "stdio" && same(host?["allowed_origins"], ["chrome-extension://njeebbcmlenfopaecfbphgcfihbdmkec/"]), "\(host ?? [:])")
  check("host files: the same again writes nothing", install().1.isEmpty)

  var stopped = 0
  link.stop(why: "test done") { stopped += 1 }
  strictLink.stop(why: "test done") { stopped += 1 }
  spin(1) { stopped == 2 }
  check("stopped: the relay socket removed", !FileManager.default.fileExists(atPath: path))
}
