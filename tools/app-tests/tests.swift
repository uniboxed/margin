// Checks of Margin.app's shell logic (app/shell/), with no browser, no window
// on screen and no link: the link's messages (LinkMessage.swift, version 2),
// its WebSocket by hand (LinkSocket.swift), chunks (Chunks.swift), the app's
// copy of a copy's state (StateMirror.swift), binding browser windows to the
// window server's (WindowMatcher.swift, in window-tests.swift), the stacking check, pass-through
// decisions (PassThrough.swift), layout reports into setLayout (Shell.swift
// LayoutOutbox), shortcuts and their gating (Shortcuts.swift, against a
// stand-in for Carbon), the coordinate flips, and the lasting data
// (data-tests.swift: the merge's vectors, the files, the data messages).
// tools/app-tests/run.sh
// builds and runs them (and the end-to-end check, e2e.swift).
import AppKit
import Foundation

var failures = 0
var passed = 0
func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
  if ok { passed += 1 } else { failures += 1; print("FAIL \(label)" + (detail().isEmpty ? "" : ": \(detail())")) }
}
func object(_ text: String?) -> JSONObject? {
  text.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject }
}
func object(_ data: Data?) -> JSONObject? { data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject } }
func same(_ a: Any?, _ b: Any?) -> Bool {
  guard let a, let b else { return a == nil && b == nil }
  return NSDictionary(dictionary: ["v": a]).isEqual(to: ["v": b])
}
// A frame as an extension's WebSocket sends it: masked.
func clientFrame(_ op: UInt8, _ payload: [UInt8], fin: Bool = true, mask: [UInt8] = [0x37, 0xfa, 0x21, 0x3d]) -> Data {
  var out = Data([(fin ? 0x80 : 0) | op])
  if payload.count < 126 { out.append(0x80 | UInt8(payload.count)) }
  else if payload.count < 65536 { out.append(0x80 | 126); out.append(contentsOf: [UInt8(payload.count >> 8), UInt8(payload.count & 0xff)]) }
  else { out.append(0x80 | 127); for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8((payload.count >> shift) & 0xff)) } }
  out.append(contentsOf: mask)
  out.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset & 3] })
  return out
}
let hello = LinkMessage.Hello(epoch: "e1", profile: "P1", browser: "safari", ext: "2.0", owner: true, instanceId: "i", origin: "o", since: 5, pid: nil)

final class FakeRegistrar: HotKeyRegistrar {
  var onHit: ((UInt32) -> Void)?
  var onRelease: ((UInt32) -> Void)?
  var held: [UInt32: Combo] = [:]
  var taken: Set<Combo> = [] // another app's
  var registrations = 0
  func register(_ combo: Combo, id: UInt32) -> Bool {
    registrations += 1
    guard !taken.contains(combo) else { return false }
    held[id] = combo
    return true
  }
  func unregister(id: UInt32) { held[id] = nil }
}

@main enum Tests {
  static func main() {
    let started = Date()
    linkMessages()
    appMessages()
    handshake()
    frames()
    chunks()
    mirror()
    layouts()
    windowBinding() // window-tests.swift
    stacking()
    passThrough()
    shortcuts()
    geometry()
    edgeAndPointer()
    safariParts()
    dataMerge()
    dataStore()
    dataSync()
    dataCarry() // data-tests.swift
    profilesTests()
    safariProfilesTests() // safari-profiles-tests.swift
    oneMargin()
    print(failures == 0 ? "all \(passed) checks passed" : "\(failures) of \(passed + failures) checks failed", String(format: "(%.2f s)", Date().timeIntervalSince(started)))
    exit(failures == 0 ? 0 : 1)
  }

  static func linkMessages() {
    if case .hello(let h)? = LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","profile":"P-1","browser":"safari","origin":"safari-web-extension://A","since":1761800000000,"ext":"2.0","owner":true,"instanceId":"i"}"#) {
      check("hello", h.epoch == "e1" && h.profile == "P-1" && h.browser == "safari" && h.key == "safari:P-1" && h.origin == "safari-web-extension://A" && h.since == 1761800000000 && h.ext == "2.0" && h.owner && h.instanceId == "i" && h.pid == nil)
    } else { check("hello decodes", false) }
    if case .hello(let h)? = LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","profile":"p","browser":"chrome","pid":4321}"#) { check("hello: not the owner unless it says so; a pid", !h.owner && h.pid == 4321) } else { check("bare hello decodes", false) }
    check("hello of version 1 (the native panel's): not one", LinkMessage.decode(#"{"k":"hello","v":1,"epoch":"e1","owner":true,"profile":"p","browser":"safari"}"#) == nil)
    check("hello with no profile: not one", LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","browser":"safari"}"#) == nil)
    check("hello with a profile that isn't a plain id: not one", LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","browser":"safari","profile":"a/b"}"#) == nil)
    check("hello from a browser not known: not one", LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","browser":"lynx","profile":"p"}"#) == nil)
    check("not JSON", LinkMessage.decode("{k:") == nil)
    check("no kind", LinkMessage.decode(#"{"epoch":"e"}"#) == nil)
    check("a snapshot needs its epoch", LinkMessage.decode(#"{"k":"snapshot","seq":1,"state":{}}"#) == nil)
    check("a seq that isn't a whole number: not one", LinkMessage.decode(#"{"k":"windows","epoch":"e","seq":1.5,"list":[]}"#) == nil)
    if case .snapshot(let epoch, let seq, let state, let windows)? = LinkMessage.decode(#"{"k":"snapshot","epoch":"e","seq":1,"state":{"spaces":[{"id":"a"}]},"windows":[{"windowId":3,"focused":true}]}"#) {
      check("snapshot", epoch == "e" && seq == 1 && same(state["spaces"], [["id": "a"]]) && windows.first?["windowId"] as? Int == 3)
    } else { check("snapshot decodes", false) }
    if case .delta(_, let seq, let changes, let favicons)? = LinkMessage.decode(#"{"k":"delta","epoch":"e","seq":2,"changes":{"pins":{"newValue":[]},"folders":{}},"favicons":{"set":{"https://a.example":{"icon":"data:x"}},"del":["https://b.example"]}}"#) {
      var pinsSet = false
      if case .set(let v)? = changes["pins"] { pinsSet = same(v, [Any]()) }
      var foldersGone = false
      if case .removed? = changes["folders"] { foldersGone = true }
      check("delta: a key's new value, a key removed (no newValue)", seq == 2 && pinsSet && foldersGone)
      check("delta: site icons as a diff", favicons?.del == ["https://b.example"] && same(favicons?.set["https://a.example"], ["icon": "data:x"]))
    } else { check("delta decodes", false) }
    if case .windows(_, let seq, let list)? = LinkMessage.decode(#"{"k":"windows","epoch":"e","seq":3,"list":[{"windowId":1},{"windowId":2}]}"#) {
      check("windows", seq == 3 && list.count == 2)
    } else { check("windows decodes", false) }
    if case .push(_, let windowId, let msg)? = LinkMessage.decode(#"{"k":"push","epoch":"e","windowId":4,"msg":{"type":"switching","tabId":5}}"#) {
      check("push for a window", windowId == 4 && msg["type"] as? String == "switching")
    } else { check("push decodes", false) }
    // Pushes an overlay made later still needs (Shell.swift HeldPushes): the last notice for a minute, the last loading set.
    do {
      var held = HeldPushes()
      let t0 = Date(timeIntervalSince1970: 1000)
      held.offer(windowId: 4, ["type": "switching", "tabId": 1], at: t0)
      held.offer(windowId: 4, ["type": "notice", "kind": "not-responding", "tabId": 7], at: t0)
      held.offer(windowId: 4, ["type": "loading", "tabIds": [7]], at: t0.addingTimeInterval(1))
      held.offer(windowId: 4, ["type": "loading", "tabIds": [7, 8]], at: t0.addingTimeInterval(2))
      held.offer(windowId: 5, ["type": "notice", "kind": "updated-while-open", "tabId": 9], at: t0)
      let now = held.messages(for: 4, at: t0.addingTimeInterval(5))
      check("held pushes: a window's last notice and loading set, oldest first; not a switch", now.count == 2 && now[0]["kind"] as? String == "not-responding" && same(now[1]["tabIds"], [7, 8]), "\(now)")
      check("held pushes: a notice goes after a minute, loading stays", held.messages(for: 4, at: t0.addingTimeInterval(90)).map { $0["type"] as? String } == ["loading"])
      check("held pushes: another window's are its own", held.messages(for: 5, at: t0).count == 1 && held.messages(for: 6, at: t0).isEmpty)
      held.offer(windowId: nil, ["type": "notice", "kind": "tab-gone"], at: t0.addingTimeInterval(3))
      check("held pushes: one for every window, given to each", held.messages(for: 6, at: t0.addingTimeInterval(4)).first?["kind"] as? String == "tab-gone")
      held.forget(windowId: 4)
      check("held pushes: a closed window's forgotten", held.messages(for: 4, at: t0.addingTimeInterval(4)).count == 1)
    }
    let sha = String(repeating: "a", count: 64)
    if case .theme(let epoch, let c)? = LinkMessage.decode(#"{"k":"theme","epoch":"e","id":"arcadia","transfer":"\#(sha)","part":1,"parts":3,"size":10,"data":"YWJj"}"#) {
      check("a theme chunk", epoch == "e" && c.id == "arcadia" && c.part == 1 && c.parts == 3 && c.size == 10 && c.data == "YWJj")
    } else { check("theme decodes", false) }
    check("a chunk past its parts: not one", LinkMessage.decode(#"{"k":"theme","epoch":"e","id":"a","transfer":"\#(sha)","part":3,"parts":3,"size":1,"data":""}"#) == nil)
    check("a chunk with no transfer hash: not one", LinkMessage.decode(#"{"k":"theme","epoch":"e","id":"a","transfer":"x","part":0,"parts":1,"size":1,"data":""}"#) == nil)
    if case .reply(let id, let body)? = LinkMessage.decode(#"{"k":"reply","id":7,"ok":false,"error":"x","stale":true}"#) {
      check("reply: its id, the answer without k and id", id == 7 && body["ok"] as? Bool == false && body["stale"] as? Bool == true && body["k"] == nil && body["id"] == nil)
    } else { check("reply decodes", false) }
    if case .tock? = LinkMessage.decode(#"{"k":"tock","at":1}"#) { check("tock", true) } else { check("tock decodes", false) }
    if case .bye(let why)? = LinkMessage.decode(#"{"k":"bye","why":"turned off"}"#) { check("bye", why == "turned off") } else { check("bye decodes", false) }
    if case .other(let k)? = LinkMessage.decode(#"{"k":"later"}"#) { check("a kind not known: other", k == "later") } else { check("unknown kind decodes", false) }
    if case .keys(let epoch, let bindings)? = LinkMessage.decode(#"{"k":"keys","epoch":"e","bindings":{"next-tab":["Alt+Meta+ArrowDown","Ctrl+Meta+ArrowDown",3],"palette":["Meta+KeyT"],"odd":"x"}}"#) {
      check("keys: each command's combinations (strings only)", epoch == "e" && bindings["next-tab"] == ["Alt+Meta+ArrowDown", "Ctrl+Meta+ArrowDown"] && bindings["palette"] == ["Meta+KeyT"] && bindings["odd"] == nil)
    } else { check("keys decodes", false) }
    check("keys need their epoch", LinkMessage.decode(#"{"k":"keys","bindings":{}}"#) == nil)
  }

  static func appMessages() {
    let welcome = object(AppMessage.welcome(key: "K").encode())
    check("welcome", welcome?["k"] as? String == "welcome" && welcome?["v"] as? Int == 2 && welcome?["key"] as? String == "K")
    let req = object(AppMessage.req(id: 3, epoch: "e", windowId: nil, type: "activateTab", payload: ["tabId": 9]).encode())
    check("req", req?["k"] as? String == "req" && req?["id"] as? Int == 3 && req?["epoch"] as? String == "e" && req?["windowId"] is NSNull
      && req?["type"] as? String == "activateTab" && (req?["payload"] as? JSONObject)?["tabId"] as? Int == 9 && (req?["at"] as? Double ?? 0) > 1.7e12)
    let layout = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 6.25, radii: [6.25, 6.25, 6.25, 6.25], width: 1280, height: 800, mode: "fullscreen")
    let set = object(AppMessage.setLayout(epoch: "e", windowId: 7, seq: 2, layout: layout).encode())
    check("setLayout: the window, its number, the insets, radius and size", set?["k"] as? String == "setLayout" && set?["windowId"] as? Int == 7 && set?["seq"] as? Int == 2
      && same(set?["insets"], ["left": 260, "top": 8, "right": 8, "bottom": 8]) && set?["radius"] as? Double == 6.25 && same(set?["container"], ["width": 1280, "height": 800]) && set?["mode"] as? String == "fullscreen")
    let drawn = object(AppMessage.drawn(epoch: "e", windowId: 7, on: false).encode())
    check("drawn: the window and whether it's drawn", drawn?["k"] as? String == "drawn" && drawn?["epoch"] as? String == "e" && drawn?["windowId"] as? Int == 7 && drawn?["on"] as? Bool == false)
    check("resync", object(AppMessage.resync(epoch: "e").encode())?["epoch"] as? String == "e")
    check("bye", object(AppMessage.bye(why: "quit").encode())?["why"] as? String == "quit")
    check("tick", object(AppMessage.tick.encode())?["k"] as? String == "tick")
    check("a payload that isn't JSON: nothing", AppMessage.req(id: 1, epoch: "e", windowId: 1, type: "x", payload: ["d": Date()]).encode() == nil)
    let big = String(repeating: "x", count: LinkProtocol.maxAppMessage)
    check("nothing over 1 MB goes from the app", AppMessage.req(id: 1, epoch: "e", windowId: 1, type: "x", payload: ["big": big]).encode() == nil)
    let almost = String(repeating: "x", count: LinkProtocol.maxAppMessage - 200)
    check("just under 1 MB goes", AppMessage.req(id: 1, epoch: "e", windowId: 1, type: "x", payload: ["big": almost]).encode() != nil)
    let chunk = Chunk(id: "t", transfer: String(repeating: "0", count: 64), part: 0, parts: 1, size: 3, data: "YWJj")
    let theme = object(AppMessage.theme(epoch: "e", chunk: chunk).encode())
    check("a theme chunk from the app", theme?["k"] as? String == "theme" && theme?["id"] as? String == "t" && theme?["parts"] as? Int == 1 && theme?["data"] as? String == "YWJj")
  }

  static func handshake() {
    let request = "GET /?t=ab%2Bc&x=1 HTTP/1.1\r\nHost: 127.0.0.1:5\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: safari-web-extension://ABC\r\n\r\n"
    if case .incomplete = Handshake.parse(Data(request.utf8.prefix(40))) { check("handshake in pieces: waits", true) } else { check("handshake incomplete", false) }
    if case .request(let r, let rest) = Handshake.parse(Data(request.utf8) + Data([0x81, 0x80])) {
      check("handshake: path, query (decoded), headers by lower-case name", r.path == "/" && r.query["t"] == "ab+c" && r.query["x"] == "1" && r.headers["origin"] == "safari-web-extension://ABC")
      check("handshake: what came after it kept", rest == Data([0x81, 0x80]))
      check("a WebSocket upgrade", Handshake.isUpgrade(r))
    } else { check("handshake parses", false) }
    if case .request(let r, _) = Handshake.parse(Data("GET / HTTP/1.1\r\nHost: x\r\n\r\n".utf8)) { check("plain GET: no upgrade", !Handshake.isUpgrade(r)) } else { check("plain GET parses", false) }
    if case .bad = Handshake.parse(Data("POST / HTTP/1.1\r\n\r\n".utf8)) { check("not GET: bad", true) } else { check("POST is bad", false) }
    if case .bad = Handshake.parse(Data(repeating: 0x41, count: Handshake.maxBytes + 1)) { check("too long a request: bad", true) } else { check("long request is bad", false) }
    check("accept key (RFC 6455's example)", Handshake.accept(key: "dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    check("same secrets", sameSecret("abc123", "abc123"))
    check("different secrets", !sameSecret("abc123", "abc124") && !sameSecret("abc", "abc1") && !sameSecret("", "a") && sameSecret("", ""))
    check("secrets: 64 hex characters, never twice the same", SocketLink.secret().count == 64 && SocketLink.secret() != SocketLink.secret())
  }

  static func frames() {
    var reader = FrameReader()
    let bytes = clientFrame(1, Array(#"{"k":"hello"}"#.utf8))
    var got: [FrameReader.Message] = []
    for byte in bytes {
      reader.append(Data([byte]))
      while let m = try! reader.nextMessage() { got.append(m) }
    }
    check("a text frame, a byte at a time", got == [.text(#"{"k":"hello"}"#)], "\(got)")
    reader.append(clientFrame(1, [UInt8](repeating: 0x61, count: 300)) + clientFrame(1, [UInt8](repeating: 0x62, count: 70_000)))
    check("a 16-bit length", try! reader.nextMessage() == .text(String(repeating: "a", count: 300)))
    check("a 64-bit length", try! reader.nextMessage() == .text(String(repeating: "b", count: 70_000)))
    check("then nothing", try! reader.nextMessage() == nil)
    reader.append(clientFrame(1, Array("hel".utf8), fin: false) + clientFrame(9, [1, 2]) + clientFrame(0, Array("lo".utf8)) + clientFrame(8, [3, 232]))
    check("a ping between a message's frames", try! reader.nextMessage() == .ping(Data([1, 2])))
    check("the message from its frames", try! reader.nextMessage() == .text("hello"))
    check("close: its code and no reason", try! reader.nextMessage() == .close(code: 1000, reason: ""))
    // The close frame's payload: the code and the reason in the log, 1005 for none (DECISIONS.md "Margin 2: Safari reliability").
    var closes = FrameReader()
    closes.append(clientFrame(8, [3, 233] + Array("x".utf8)) + clientFrame(8, []) + clientFrame(8, [3, 232] + Array("no word from the app for 12 s".utf8)))
    let goingAway = try? closes.nextMessage()
    check("a close frame of 1001 'x': both", goingAway == .close(code: 1001, reason: "x"), "\(String(describing: goingAway))")
    check("an empty close frame: 1005, no status code", try! closes.nextMessage() == .close(code: 1005, reason: ""))
    check("a copy's own reason", try! closes.nextMessage() == .close(code: 1000, reason: "no word from the app for 12 s"))
    check("how they read in the log", FrameReader.describeClose(1001, "x") == "1001 x" && FrameReader.describeClose(1001, "") == "1001 going away"
          && FrameReader.describeClose(1005, "") == "1005, no status code" && FrameReader.describeClose(1000, "no word from the app for 12 s") == "1000 no word from the app for 12 s")
    var oneByte = FrameReader()
    oneByte.append(clientFrame(8, [3]))
    check("a close frame of one byte: refused", (try? oneByte.nextMessage()) == nil)
    check("a reason that isn't UTF-8: said so, not shown", (try? FrameReader.close(Data([3, 232, 0xc3, 0x28]))) == .close(code: 1000, reason: "(a reason that isn't UTF-8)"))
    let long = Data([3, 232] + Array(String(repeating: "a", count: 122).utf8) + Array("é".utf8) + Array("bbb".utf8))
    check("a reason over 123 bytes: clipped, never half a character", (try? FrameReader.close(long)) == .close(code: 1000, reason: String(repeating: "a", count: 122)))
    check("control characters: spaces in the log", (try? FrameReader.close(Data([3, 232] + Array("a\nb".utf8)))) == .close(code: 1000, reason: "a b"))
    var unmasked = FrameReader()
    unmasked.append(Data([0x81, 0x02, 0x68, 0x69]))
    check("an unmasked frame (not a client's): refused", (try? unmasked.nextMessage()) == nil)
    var badText = FrameReader()
    badText.append(clientFrame(1, [0xc3, 0x28]))
    check("text that isn't UTF-8: refused", (try? badText.nextMessage()) == nil)
    check("the app's frames: short", Frame.encode(.text, Data("hi".utf8)) == Data([0x81, 2, 0x68, 0x69]))
    let big = Frame.encode(.text, Data(count: 70_000))
    check("the app's frames: 64-bit length", big.prefix(10) == Data([0x81, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]) && big.count == 70_010)
    check("close frame: its code", Frame.close(1001, "x") == Data([0x88, 3, 3, 233, 0x78]))
  }

  static func chunks() {
    let whole = Data((0..<1_300_000).map { UInt8($0 % 251) })
    guard let parts = Chunks.split(whole, id: "arcadia") else { return check("split", false) }
    check("split in pieces of 512 KB", parts.count == 3 && parts.allSatisfy { $0.parts == 3 && $0.size == whole.count && $0.transfer == Chunks.sha256(whole) })
    check("each piece's message under 1 MB", parts.allSatisfy { (AppMessage.theme(epoch: "e", chunk: $0).encode()?.utf8.count ?? .max) < LinkProtocol.maxAppMessage })
    var a = ChunkAssembler()
    check("waiting", a.add(parts[0]) == .waiting(have: 1, of: 3) && a.add(parts[1]) == .waiting(have: 2, of: 3))
    check("whole again", a.add(parts[2]) == .complete(id: "arcadia", data: whole))
    check("then nothing in progress", !a.inProgress)
    var b = ChunkAssembler()
    _ = b.add(parts[2]); _ = b.add(parts[0])
    check("pieces out of order", b.add(parts[1]) == .complete(id: "arcadia", data: whole))
    var c = ChunkAssembler()
    _ = c.add(parts[0])
    let other = Chunks.split(Data("{\"id\":\"x\"}".utf8), id: "x")!
    check("a piece of another send starts over", c.add(other[0]) == .complete(id: "x", data: Data("{\"id\":\"x\"}".utf8)))
    var d = ChunkAssembler()
    let bad = Chunk(id: "arcadia", transfer: parts[1].transfer, part: 1, parts: 3, size: whole.count, data: Data(repeating: 1, count: 10).base64EncodedString())
    _ = d.add(parts[0]); _ = d.add(bad)
    if case .refused = d.add(parts[2]) { check("pieces that don't add up: refused", true) } else { check("pieces that don't add up: refused", false) }
    var e = ChunkAssembler()
    if case .refused = e.add(Chunk(id: "a", transfer: parts[0].transfer, part: 0, parts: 1, size: 3, data: "not base64!")) { check("not base64: refused", true) } else { check("not base64", false) }
    var f = ChunkAssembler(limit: 100)
    if case .refused = f.add(parts[0]) { check("over the limit: refused", true) } else { check("over the limit", false) }
    check("too big to split: nothing", Chunks.split(Data(count: LinkProtocol.maxThemeBytes + 1), id: "a") == nil)
    check("empty: one piece", Chunks.split(Data(), id: "a")?.count == 1)
    var g = ChunkAssembler()
    check("an empty whole", g.add(Chunks.split(Data(), id: "a")![0]) == .complete(id: "a", data: Data()))
  }

  static func mirror() {
    let m = StateMirror()
    let snap = LinkMessage.snapshot(epoch: "e1", seq: 1, state: ["spaces": [["id": "a"]], "settings": ["sidebarPinnedOpen": true], "favicons": ["https://a.example": ["icon": "A"], "https://b.example": ["icon": "B"]]], windows: [["windowId": 1]])
    check("nothing before hello", m.apply(snap) == .ignored && !m.hasState && m.stateJSON() == nil)
    m.begin(hello)
    check("a delta before the snapshot: a gap", m.apply(.delta(epoch: "e1", seq: 1, changes: [:], favicons: nil)) == .gap(expected: 1, got: 1))
    check("snapshot", m.apply(snap) == .applied && m.hasState && m.seq == 1 && m.windows.count == 1 && m.origin == "o" && m.since == 5)
    check("the state as it came", same(object(m.stateJSON()), ["spaces": [["id": "a"]], "settings": ["sidebarPinnedOpen": true], "favicons": ["https://a.example": ["icon": "A"], "https://b.example": ["icon": "B"]]]))
    let delta = LinkMessage.delta(epoch: "e1", seq: 2, changes: ["pins": .set([["id": "p"]]), "settings": .removed], favicons: .init(set: ["https://c.example": ["icon": "C"], "https://a.example": ["icon": "A2"]], del: ["https://b.example"]))
    check("delta", m.apply(delta) == .applied && m.seq == 2)
    check("delta applied: set, removed, icons diffed", same(object(m.stateJSON()), ["spaces": [["id": "a"]], "pins": [["id": "p"]], "favicons": ["https://a.example": ["icon": "A2"], "https://c.example": ["icon": "C"]]]))
    check("windows count with the rest", m.apply(.windows(epoch: "e1", seq: 3, list: [["windowId": 1], ["windowId": 2]])) == .applied && m.windows.count == 2 && m.seq == 3)
    check("another epoch's: left", m.apply(.windows(epoch: "e0", seq: 4, list: [])) == .ignored && m.windows.count == 2 && m.seq == 3)
    check("a number missed: a gap", m.apply(.delta(epoch: "e1", seq: 5, changes: ["pins": .set([])], favicons: nil)) == .gap(expected: 4, got: 5))
    check("then left until the state comes again", m.apply(.delta(epoch: "e1", seq: 6, changes: ["pins": .set([])], favicons: nil)) == .ignored && m.isResyncing)
    check("the state again (a resync's snapshot, numbered on)", m.apply(.snapshot(epoch: "e1", seq: 7, state: ["pins": []], windows: [])) == .applied && m.keys == ["pins"] && m.seq == 7 && !m.isResyncing)
    check("and on from it", m.apply(.delta(epoch: "e1", seq: 8, changes: ["spaces": .set([])], favicons: nil)) == .applied && m.keys == ["pins", "spaces"])
    check("a stored null kept", m.apply(.delta(epoch: "e1", seq: 9, changes: ["archive": .set(NSNull())], favicons: nil)) == .applied && object(m.stateJSON())?["archive"] is NSNull)
    m.begin(LinkMessage.Hello(epoch: "e2", profile: "P1", browser: "safari", ext: nil, owner: true, instanceId: nil, origin: "o2", since: 6, pid: nil))
    check("a new connection: nothing kept", !m.hasState && m.keys.isEmpty && m.seq == 0 && m.windows.isEmpty && m.origin == "o2")
    check("the old epoch's snapshot: left", m.apply(.snapshot(epoch: "e1", seq: 1, state: ["a": 1], windows: [])) == .ignored)
    // A windows message that changes only the pages' words of being shown (a tab switch: hidden, then
    // shown): not pushed to the overlays, no burst of reads (Shell.forward).
    let w1: [JSONObject] = [["windowId": 1, "activeTabId": 3, "focused": true, "visible": true, "visibleAt": 100], ["windowId": 2, "activeTabId": 9]]
    var w2 = w1; w2[0]["visibleAt"] = 200
    var w3 = w1; w3[0]["visible"] = false
    var w4 = w1; w4[0]["activeTabId"] = 4
    var w5 = w1; w5[1]["visible"] = true; w5[1]["visibleAt"] = 300
    var w6 = w1; w6[0]["focused"] = false
    check("windows: only the pages' words changed", Shell.onlyVisibilityChanged(w1, w2) && Shell.onlyVisibilityChanged(w1, w3) && Shell.onlyVisibilityChanged(w1, w5))
    check("windows: another tab in front, a focus flag, a window more or less, the first list: more than that", !Shell.onlyVisibilityChanged(w1, w4) && !Shell.onlyVisibilityChanged(w1, w6)
          && !Shell.onlyVisibilityChanged(w1, Array(w1.prefix(1))) && !Shell.onlyVisibilityChanged([], w1))
  }

  static func layouts() {
    let g: JSONObject = ["insets": ["left": 260.3, "top": 8, "right": 8, "bottom": 8.26], "radius": 6.25, "radii": [6.25, 6.25, 6.25, 6.25], "container": ["width": 1280, "height": 800], "mode": "fullscreen", "outer": [:]]
    guard let l = PageLayout(geometry: g) else { return check("a layout report", false) }
    check("a layout report", l.left == 260.3 && l.bottom == 8.26 && l.width == 1280 && l.radius == 6.25 && l.mode == "fullscreen")
    check("rounded to half a point", l.rounded.left == 260.5 && l.rounded.bottom == 8.5 && l.rounded.top == 8)
    check("not a report: no insets", PageLayout(geometry: ["container": ["width": 1, "height": 1]]) == nil)
    check("not a report: no size", PageLayout(geometry: ["insets": ["left": 0, "top": 0, "right": 0, "bottom": 0], "container": ["width": 0, "height": 10]]) == nil)
    check("not a report: a number that's a boolean", PageLayout(geometry: ["insets": ["left": true, "top": 0, "right": 0, "bottom": 0], "container": ["width": 10, "height": 10]]) == nil)
    var outbox = LayoutOutbox()
    check("the first: number 1", outbox.offer(windowId: 7, l)?.seq == 1)
    check("the same again: nothing", outbox.offer(windowId: 7, l) == nil)
    var nudged = l
    nudged.left = 260.4 // still 260.5 rounded
    check("a change under half a point: nothing", outbox.offer(windowId: 7, nudged) == nil)
    nudged.left = 300
    check("a change: number 2", outbox.offer(windowId: 7, nudged)?.seq == 2)
    check("another window counts on its own", outbox.offer(windowId: 8, l)?.seq == 1)
    var resized = nudged
    resized.width = 1200
    check("a resize alone is a change", outbox.offer(windowId: 7, resized)?.seq == 3)
    outbox.forget(windowId: 7)
    check("forgotten: sent again, numbered on", outbox.offer(windowId: 7, resized)?.seq == 4)
    outbox.reset()
    check("a new link: from 1", outbox.offer(windowId: 7, resized)?.seq == 1)

    // Whether the app draws over each window, as the copy is told (DrawnOutbox).
    var d = DrawnOutbox()
    check("drawn: bound and in full screen, on at once", d.offer(windowId: 1, now: 0, bound: true, wanted: true).send == true)
    check("drawn: the same again: nothing", d.offer(windowId: 1, now: 0.1, bound: true, wanted: true).send == nil)
    let fresh = d.offer(windowId: 2, now: 0, bound: false, wanted: true)
    check("drawn: never bound: nothing yet, looked at again in 1.5 s", fresh.send == nil && fresh.due == 1.5, "\(fresh)")
    check("drawn: never bound: still nothing at 1.4 s", d.offer(windowId: 2, now: 1.4, bound: false, wanted: true).send == nil)
    check("drawn: never bound for 1.5 s: off", d.offer(windowId: 2, now: 1.5, bound: false, wanted: true).send == false)
    check("drawn: off again: nothing", d.offer(windowId: 2, now: 2, bound: false, wanted: true).send == nil)
    check("drawn: then bound: on", d.offer(windowId: 2, now: 3, bound: true, wanted: true).send == true)
    check("drawn: its binding gone 40 ms (a blip): nothing", d.offer(windowId: 2, now: 3.5, bound: false, wanted: true).send == nil && d.offer(windowId: 2, now: 3.54, bound: true, wanted: true).send == nil)
    check("drawn: unbound after being bound: nothing for 3 s", d.offer(windowId: 2, now: 4, bound: false, wanted: true).send == nil && d.offer(windowId: 2, now: 6.9, bound: false, wanted: true).send == nil)
    check("drawn: unbound for 3 s: off", d.offer(windowId: 2, now: 7, bound: false, wanted: true).send == false)
    check("drawn: a normal window: off after 1.5 s", d.offer(windowId: 3, now: 0, bound: true, wanted: false).send == nil && d.offer(windowId: 3, now: 1.5, bound: true, wanted: false).send == false)
    check("drawn: leaving full screen: nothing during the animation, off after 1.5 s", d.offer(windowId: 1, now: 10, bound: true, wanted: false).send == nil
          && d.offer(windowId: 1, now: 11, bound: true, wanted: false).send == nil && d.offer(windowId: 1, now: 11.5, bound: true, wanted: false).send == false)
    check("drawn: back in full screen: on", d.offer(windowId: 1, now: 12, bound: true, wanted: true).send == true)
    check("drawn: closed while on: off", d.closed(windowId: 1) == false && !d.windows.contains(1))
    check("drawn: closed while off: nothing", d.closed(windowId: 3) == nil)
  }

  static func stacking() {
    let browser = ServerWindow(number: 100, pid: 1, bounds: CGRect(x: 0, y: 0, width: 800, height: 600), order: 3)
    let overlay = ServerWindow(number: 900, pid: 9, bounds: browser.bounds, order: 2)
    check("just above", WindowMatcher.stackedAbove([overlay, browser], overlay: 900, browser: 100))
    check("behind it: not", !WindowMatcher.stackedAbove([ServerWindow(number: 900, pid: 9, bounds: browser.bounds, order: 4), browser], overlay: 900, browser: 100))
    let between = ServerWindow(number: 50, pid: 5, bounds: CGRect(x: 100, y: 100, width: 200, height: 200), order: 2)
    let above = ServerWindow(number: 900, pid: 9, bounds: browser.bounds, order: 1)
    check("another app's window between them: not", !WindowMatcher.stackedAbove([above, between, browser], overlay: 900, browser: 100))
    let elsewhere = ServerWindow(number: 51, pid: 5, bounds: CGRect(x: 2000, y: 0, width: 200, height: 200), order: 2)
    check("a window between them that doesn't cover the browser's: fine", WindowMatcher.stackedAbove([above, elsewhere, browser], overlay: 900, browser: 100))
    let popover = ServerWindow(number: 52, pid: 1, layer: 101, bounds: CGRect(x: 10, y: 10, width: 200, height: 200), order: 2)
    check("the browser's own popover between them: fine", WindowMatcher.stackedAbove([above, popover, browser], overlay: 900, browser: 100))
    check("the overlay not on screen: not", !WindowMatcher.stackedAbove([ServerWindow(number: 900, pid: 9, bounds: browser.bounds, onScreen: false, order: 2), browser], overlay: 900, browser: 100))
  }

  static func passThrough() {
    let frame = CGRect(x: 100, y: 50, width: 1280, height: 800)
    let layout = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 10, radii: [10, 10, 10, 10], width: 1280, height: 800, mode: "fullscreen")
    let slot = PassThrough.slot(in: frame, layout: layout)
    check("the slot from the insets, in screen points", slot.rect == CGRect(x: 360, y: 58, width: 1012, height: 784), "\(slot.rect)")
    check("over the page: the page's", PassThrough.pageGets(CGPoint(x: 800, y: 400), slot))
    check("over the sidebar: Margin's", !PassThrough.pageGets(CGPoint(x: 200, y: 400), slot))
    check("on the frame above the page: Margin's", !PassThrough.pageGets(CGPoint(x: 800, y: 54), slot))
    check("just inside the slot's corner: Margin's (rounded)", !PassThrough.pageGets(CGPoint(x: 361, y: 59), slot))
    check("inside the rounding: the page's", PassThrough.pageGets(CGPoint(x: 364, y: 62), slot))
    check("along an edge, past the corner: the page's", PassThrough.pageGets(CGPoint(x: 361, y: 400), slot))
    check("no slot reported: Margin's everywhere", !PassThrough.pageGets(CGPoint(x: 800, y: 400), nil))
    let palette = PassThrough.slot(in: frame, layout: layout, hits: [CGRect(x: 400, y: 100, width: 480, height: 300)])
    check("over the palette (drawn over the page): Margin's", !PassThrough.pageGets(CGPoint(x: 600, y: 200), palette))
    check("beside the palette: the page's", PassThrough.pageGets(CGPoint(x: 1200, y: 600), palette))
    var all = slot
    all.captureAll = true
    check("too much over the page to list: Margin's everywhere", !PassThrough.pageGets(CGPoint(x: 800, y: 400), all))
    check("a button held keeps what it was: a drag from the page stays the page's", PassThrough.decide(CGPoint(x: 200, y: 400), slot, buttonsDown: true, ignoring: true))
    check("a drag from Margin stays Margin's", !PassThrough.decide(CGPoint(x: 800, y: 400), slot, buttonsDown: true, ignoring: false))
    check("let go: decided again", PassThrough.decide(CGPoint(x: 800, y: 400), slot, buttonsDown: false, ignoring: false))
  }

  static func shortcuts() {
    check("⌃⌘↓", Combo.parse("Ctrl+Meta+ArrowDown") == Combo(keyCode: 125, modifiers: UInt32(0x1000 | 0x0100)))
    check("⌘T", Combo.parse("Meta+KeyT")?.keyCode == 17)
    check("no modifier: not one", Combo.parse("KeyT") == nil && Combo.parse("Shift+KeyT") == nil)
    check("a key not known: not one", Combo.parse("Meta+Banana") == nil)
    check("a modifier twice: not one", Combo.parse("Meta+Meta+KeyT") == nil)
    check("its name", Combo.parse("Ctrl+Meta+ArrowRight")?.description == "⌃⌘ArrowRight")
    check("six keys by default", ShortcutSet.bindings.count == 6 && Set(ShortcutSet.bindings.values) == Set(AppCommand.allCases))
    let fromCopy = ShortcutSet.bindings(from: ["next-tab": ["Alt+Meta+ArrowDown", "Ctrl+Meta+ArrowDown"], "toggle-sidebar": ["Alt+KeyK"], "palette": [], "prev-space": ["Banana"]])
    check("the copy's keys: both of a command's combinations", fromCopy[Combo.parse("Alt+Meta+ArrowDown")!] == .nextTab && fromCopy[Combo.parse("Ctrl+Meta+ArrowDown")!] == .nextTab)
    check("the copy's keys: the sidebar's own", fromCopy[Combo.parse("Alt+KeyK")!] == .toggleSidebar && fromCopy[Combo.parse("Alt+KeyS")!] == nil)
    check("the copy's keys: the palette is always ⌘T", fromCopy[Combo.parse("Meta+KeyT")!] == .palette)
    check("the copy's keys: a command not named keeps its default", fromCopy[Combo.parse("Ctrl+Meta+ArrowUp")!] == .prevTab)
    check("the copy's keys: a combination that isn't one: none for it", !fromCopy.values.contains(.prevSpace))
    check("the copy's keys: one combination, one command", ShortcutSet.bindings(from: ["next-tab": ["Meta+KeyT"]])[Combo.parse("Meta+KeyT")!] == .nextTab)
    check("keys Settings can record: punctuation and F keys", Combo.parse("Alt+Comma") != nil && Combo.parse("Ctrl+F5") != nil && Combo.parse("Meta+Backquote") != nil)
    check("gate: the linked browser in front with its overlay", ShortcutSet.active(frontPid: 10, linkedPids: [10], frontWindowHasOverlay: true))
    check("gate: another app in front", !ShortcutSet.active(frontPid: 11, linkedPids: [10], frontWindowHasOverlay: true))
    check("gate: the browser in front, its front window without an overlay", !ShortcutSet.active(frontPid: 10, linkedPids: [10], frontWindowHasOverlay: false))
    check("gate: nothing in front", !ShortcutSet.active(frontPid: nil, linkedPids: [10], frontWindowHasOverlay: true))
    let fake = FakeRegistrar()
    let keys = AppShortcuts(registrar: fake)
    var ran: [AppCommand] = []
    keys.onCommand = { command, _ in ran.append(command) }
    check("not held at first", fake.held.isEmpty && !keys.isActive)
    keys.set(active: true)
    check("held while active", fake.held.count == 6 && keys.isActive)
    keys.set(active: true)
    check("not registered twice", fake.registrations == 6)
    let nextTab = fake.held.first { $0.value == Combo.parse("Ctrl+Meta+ArrowDown") }!.key
    fake.onHit?(nextTab)
    check("a key: its command", ran == [.nextTab])
    keys.set(active: false)
    check("let go", fake.held.isEmpty && !keys.isActive)
    fake.onHit?(nextTab)
    check("a stray hit after letting go: nothing", ran == [.nextTab])
    fake.taken = [Combo.parse("Meta+KeyT")!]
    keys.set(active: true)
    check("one another app holds: the rest still Margin's", fake.held.count == 5 && keys.unavailable == [Combo.parse("Meta+KeyT")!])
    fake.taken = []
    keys.rebind(fromCopy)
    check("new keys while held: the new ones held at once", keys.isActive && Set(fake.held.values) == Set(fromCopy.keys) && fake.held.count == fromCopy.count)
    let toggle = fake.held.first { $0.value == Combo.parse("Alt+KeyK") }!.key
    ran = []
    fake.onHit?(toggle)
    check("a new key: its command", ran == [.toggleSidebar])
    let before = fake.registrations
    keys.rebind(fromCopy)
    check("the same keys again: nothing registered again", fake.registrations == before)
    keys.set(active: false)
    check("let go after a rebind: none held", fake.held.isEmpty)

    // A held key repeats at the Mac's repeat (a test clock), until let go.
    var waits: [(TimeInterval, () -> Void)] = []
    var mods = true
    var rep = KeyRepeat()
    rep.delay = { 0.4 }
    rep.interval = { 0.05 }
    rep.after = { seconds, run in
      var live = true
      waits.append((seconds, { if live { run() } }))
      return { live = false }
    }
    rep.modifiersDown = { _ in mods }
    let fake2 = FakeRegistrar()
    let held = AppShortcuts(registrar: fake2, keyRepeat: rep)
    var ran2: [AppCommand] = []
    var repeats2: [Bool] = []
    held.onCommand = { command, isRepeat in ran2.append(command); repeats2.append(isRepeat) }
    held.set(active: true)
    let down = fake2.held.first { $0.value == Combo.parse("Ctrl+Meta+ArrowDown") }!.key
    func runNext() { if !waits.isEmpty { waits.removeFirst().1() } }
    fake2.onHit?(down)
    check("held: once at the press", ran2 == [.nextTab] && waits.first?.0 == 0.4)
    runNext(); runNext(); runNext()
    check("held: again after the delay, then at the rate", ran2.count == 4 && waits.first?.0 == 0.05)
    check("held: the press is a press, the rest repeats", repeats2 == [false, true, true, true])
    fake2.onRelease?(down)
    runNext()
    check("let go: no more", ran2.count == 4)
    fake2.onHit?(down)
    mods = false
    runNext()
    check("the release missed, the modifiers up: it stops", ran2.count == 5 && waits.isEmpty)
    mods = true
    let palette = fake2.held.first { $0.value == Combo.parse("Meta+KeyT") }!.key
    ran2 = []
    fake2.onHit?(palette)
    check("the palette key doesn't repeat", ran2 == [.palette] && waits.isEmpty)
    fake2.onHit?(down)
    held.set(active: false)
    runNext()
    check("keys let go (another app in front): the repeat stops", ran2 == [.palette, .nextTab])
    keys.rebind(ShortcutSet.bindings)
    check("new keys while let go: none held", fake.held.isEmpty && !keys.isActive)

    // A held ⌃⌘→ with several profiles: it repeats, but goes through the window's own
    // profile's spaces only, so a press starts one switch of profile at most (Margin 2:
    // Safari reliability). The shell's spaceKey with its chained aim, against the real key repeat.
    let order = BrowserProfiles(browser: "safari", root: nil)
    order.refresh(spaces: ["s-a": ["a1", "a2"], "s-b": ["b1"], "s-c": ["c1"]], linked: ["s-a", "s-b", "s-c"])
    func holdNextSpace(from start: SpaceKey, ticks: Int) -> (repeats: Int, across: [SpaceKey], aim: SpaceKey) {
      waits = []
      mods = true
      var aim = start
      var across: [SpaceKey] = []
      var repeated = 0
      let reg = FakeRegistrar()
      let shortcuts = AppShortcuts(registrar: reg, keyRepeat: rep)
      shortcuts.onCommand = { command, isRepeat in
        guard command == .nextSpace else { return }
        if isRepeat { repeated += 1 }
        switch order.spaceStep(from: aim, profile: "s-a", dir: 1, isRepeat: isRepeat) {
        case .own(let next)?: aim = next
        case .across(let next)?: aim = next; across.append(next)
        case .held?, nil: break
        }
      }
      shortcuts.set(active: true)
      let right = reg.held.first { $0.value == Combo.parse("Ctrl+Meta+ArrowRight") }!.key
      reg.onHit?(right)
      for _ in 0..<ticks { runNext() }
      reg.onRelease?(right)
      shortcuts.set(active: false)
      return (repeated, across, aim)
    }
    let a1 = SpaceKey(profile: "s-a", space: "a1"), a2 = SpaceKey(profile: "s-a", space: "a2"), b1 = SpaceKey(profile: "s-b", space: "b1")
    let fromA1 = holdNextSpace(from: a1, ticks: 8)
    check("held next space, several profiles: it repeats", fromA1.repeats == 8)
    check("held next space from the profile's first: on to its own second, never into another profile", fromA1.across.isEmpty && fromA1.aim == a2, "\(fromA1)")
    let fromA2 = holdNextSpace(from: a2, ticks: 8)
    check("held next space from the profile's last: one switch of profile, at the press, none from the repeats", fromA2.across == [b1], "\(fromA2)")
    check("space step: a press goes across; a repeat doesn't", order.spaceStep(from: a2, profile: "s-a", dir: 1, isRepeat: false) == .across(b1) && order.spaceStep(from: a2, profile: "s-a", dir: 1, isRepeat: true) == .held)
    check("space step: on from another profile's aim (a switch under way): across, to that profile's next", order.spaceStep(from: b1, profile: "s-a", dir: 1, isRepeat: false) == .across(SpaceKey(profile: "s-c", space: "c1")))
    check("space step: one profile with spaces: the copy's own navigate", BrowserProfiles(browser: "safari", root: nil).spaceStep(from: a1, profile: "s-a", dir: 1, isRepeat: false) == nil)
    // Carbon itself, with a key no one uses (held for a moment, never pressed).
    let carbon = CarbonHotKeys()
    let odd = Combo.parse("Ctrl+Alt+Shift+Meta+F19")!
    check("Carbon: a key registered and let go", carbon.register(odd, id: 99))
    carbon.unregister(id: 99)
    check("Carbon: again after letting go", carbon.register(odd, id: 99))
    carbon.unregister(id: 99)
  }

  static func geometry() {
    check("window server to AppKit: flipped on the main display", ScreenGeometry.appKitRect(CGRect(x: 10, y: 20, width: 300, height: 200), mainHeight: 1000) == CGRect(x: 10, y: 780, width: 300, height: 200))
    check("and back", ScreenGeometry.appKitRect(CGRect(x: 10, y: 780, width: 300, height: 200), mainHeight: 1000) == CGRect(x: 10, y: 20, width: 300, height: 200))
    check("off screen stays off screen", ScreenGeometry.appKitRect(CGRect(x: -20000, y: -20000, width: 1280, height: 800), mainHeight: 982).minY == 982 + 20000 - 800)
    check("a pointer flipped", ScreenGeometry.topLeftPoint(CGPoint(x: 5, y: 990), mainHeight: 1000) == CGPoint(x: 5, y: 10))
    check("the overlay's window: in every Space, beside full screen, out of the window cycle",
          OverlayController.collectionBehavior == [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle])
    check("the experiment: only the Space it's shown in, beside full screen", OverlayController.ownSpaceBehavior == [.managed, .fullScreenAuxiliary, .ignoresCycle])
    // A full-screen window fills its display's height; one going into full screen doesn't (Phase 2 step 8).
    let displays: [(frame: CGRect, topInset: CGFloat)] = [(CGRect(x: 0, y: 0, width: 1512, height: 982), 32), (CGRect(x: 1512, y: -200, width: 2560, height: 1440), 0)]
    check("full screen: the whole display", ScreenGeometry.fillsDisplay(CGRect(x: 0, y: 0, width: 1512, height: 982), displays: displays))
    check("full screen below the camera housing", ScreenGeometry.fillsDisplay(CGRect(x: 0, y: 32, width: 1512, height: 950), displays: displays))
    check("one side of a Split View, on the second display", ScreenGeometry.fillsDisplay(CGRect(x: 1512, y: -200, width: 1280, height: 1440), displays: displays))
    check("not a window still on the desktop, going full screen", !ScreenGeometry.fillsDisplay(CGRect(x: 100, y: 120, width: 1200, height: 760), displays: displays))
    check("not a window across two displays", !ScreenGeometry.fillsDisplay(CGRect(x: 1000, y: 0, width: 1200, height: 982), displays: displays))
    check("not off every display", !ScreenGeometry.fillsDisplay(CGRect(x: -20000, y: -20000, width: 1280, height: 800), displays: displays))
  }

  // Safari's own parts of the window (Phase 2 step 8): the full-screen toolbar, a window of its own,
  // from Tirth's recorded list (scratchpad winrec/rec.log, 2026-11-05), and the docked Web Inspector.
  static func safariParts() {
    let pid: pid_t = 501
    let main = ServerWindow(number: 14375, pid: pid, bounds: CGRect(x: 0, y: 33, width: 1512, height: 949), order: 165)
    let overlay = ServerWindow(number: 14589, pid: 9, bounds: main.bounds, order: 9)
    let parked = ServerWindow(number: 14553, pid: pid, bounds: CGRect(x: 0, y: -19, width: 1512, height: 52), order: 113)
    let sliding = ServerWindow(number: 14553, pid: pid, bounds: CGRect(x: 0, y: 13, width: 1512, height: 52), order: 113)
    let down = ServerWindow(number: 14553, pid: pid, bounds: CGRect(x: 0, y: 33, width: 1512, height: 52), order: 112)
    check("the toolbar parked above the window's top: found", WindowMatcher.fullScreenToolbar([overlay, parked, main], browser: main)?.number == 14553)
    check("sliding down, and down over the window's top: found", WindowMatcher.fullScreenToolbar([overlay, sliding, main], browser: main)?.number == 14553 && WindowMatcher.fullScreenToolbar([overlay, down, main], browser: main)?.number == 14553)
    let tall = ServerWindow(number: 3, pid: pid, bounds: CGRect(x: 0, y: -85, width: 1512, height: 118), order: 100)
    check("taller with a tab bar and Favorites: found", WindowMatcher.fullScreenToolbar([tall, main], browser: main)?.number == 3)
    let popover = ServerWindow(number: 4, pid: pid, bounds: CGRect(x: 600, y: 40, width: 300, height: 120), order: 50)
    let otherApp = ServerWindow(number: 5, pid: 77, bounds: parked.bounds, order: 60)
    let below = ServerWindow(number: 6, pid: pid, bounds: parked.bounds, order: 200)
    let lower = ServerWindow(number: 7, pid: pid, bounds: CGRect(x: 0, y: 500, width: 1512, height: 52), order: 100)
    check("not a popover, another app's window, one behind the window, nor one lower down", WindowMatcher.fullScreenToolbar([popover, otherApp, below, lower, main], browser: main) == nil)
    check("no toolbar (windowed, or none drawn yet): none", WindowMatcher.fullScreenToolbar([overlay, main], browser: main) == nil)
    // Margin goes between the window and its toolbar: the toolbar slides over Margin as over the page.
    let between = ServerWindow(number: 14589, pid: 9, bounds: main.bounds, order: 120)
    check("the overlay above the toolbar (as recorded): put back", !WindowMatcher.stackedAbove([overlay, parked, main], overlay: 14589, browser: 14375, toolbar: 14553))
    check("between the toolbar and the window: in place", WindowMatcher.stackedAbove([parked, between, main], overlay: 14589, browser: 14375, toolbar: 14553))
    check("and with the toolbar down over the window", WindowMatcher.stackedAbove([down, between, main], overlay: 14589, browser: 14375, toolbar: 14553))
    check("no toolbar: just above the window, as before", WindowMatcher.stackedAbove([overlay, main], overlay: 14589, browser: 14375, toolbar: nil))
    // The docked Web Inspector: the overlay over the page's part only, setLayout's insets still from the window's edges.
    let win = CGRect(x: 0, y: 33, width: 1512, height: 949)
    check("no viewport said: the whole window", Shell.overlayFrame(window: win, viewport: nil) == win)
    check("docked at the bottom: the part above it", Shell.overlayFrame(window: win, viewport: CGRect(x: 0, y: 0, width: 1512, height: 600)) == CGRect(x: 0, y: 33, width: 1512, height: 600))
    check("docked on the right: the part left of it", Shell.overlayFrame(window: win, viewport: CGRect(x: 0, y: 0, width: 1000, height: 949)) == CGRect(x: 0, y: 33, width: 1000, height: 949))
    check("docked on the left: the part right of it", Shell.overlayFrame(window: win, viewport: CGRect(x: 512, y: 0, width: 1000, height: 949)) == CGRect(x: 512, y: 33, width: 1000, height: 949))
    check("a part too small to lay out in, or outside the window: the whole window", Shell.overlayFrame(window: win, viewport: CGRect(x: 0, y: 0, width: 150, height: 949)) == win && Shell.overlayFrame(window: win, viewport: CGRect(x: 4000, y: 0, width: 800, height: 900)) == win)
    // Safari's own sidebar sliding in (Tirth's log, 19:37:14.956-18.706) under Margin's docked one (260 pt).
    let xs: [CGFloat] = [19, 213, 238, 239, 240, 177, 54, 2, 115, 222, 237, 240, 215, 84, 2]
    check("Safari's sidebar at each logged step, guessed, under a docked 260 pt sidebar: the whole window",
          xs.allSatisfy { Shell.overlayFrame(window: win, viewport: CGRect(x: $0, y: 0, width: 1512 - $0, height: 949), dockedLeft: 260) == win })
    check("its last step, 1 pt short on the right: the whole window", Shell.overlayFrame(window: win, viewport: CGRect(x: 0, y: 0, width: 1511, height: 949), dockedLeft: 260) == win
          && Shell.overlayFrame(window: win, viewport: CGRect(x: 0, y: 0, width: 1511, height: 949)) == win)
    check("2 pt or less off the window's edge: the edge (no docked sidebar needed)", Shell.overlayFrame(window: win, viewport: CGRect(x: 2, y: 0, width: 1510, height: 949)) == win)
    check("wider than the docked sidebar (a 500 pt inspector on the left): carved out", Shell.overlayFrame(window: win, viewport: CGRect(x: 500, y: 0, width: 1012, height: 949), dockedLeft: 260) == CGRect(x: 500, y: 33, width: 1012, height: 949))
    check("one 1 pt wider than the docked sidebar: carved out", Shell.overlayFrame(window: win, viewport: CGRect(x: 261, y: 0, width: 1251, height: 949), dockedLeft: 260) == CGRect(x: 261, y: 33, width: 1251, height: 949))
    check("Margin's sidebar not docked: Safari's carved out at once, as before", Shell.overlayFrame(window: win, viewport: CGRect(x: 240, y: 0, width: 1272, height: 949)) == CGRect(x: 240, y: 33, width: 1272, height: 949))
    check("under the docked sidebar with an inspector at the bottom too: only the bottom carved", Shell.overlayFrame(window: win, viewport: CGRect(x: 240, y: 0, width: 1272, height: 600), dockedLeft: 260) == CGRect(x: 0, y: 33, width: 1512, height: 600))
    let parsedVp = ExtWindow.parse([["windowId": 3, "viewport": ["x": 240, "y": 0, "width": 1272, "height": 949, "measured": true]], ["windowId": 4, "viewport": ["x": 240, "y": 0, "width": 1272, "height": 949]]], link: "safari:P")
    check("a viewport's `measured` read, false when it isn't said", parsedVp.count == 2 && parsedVp[0].viewportMeasured && !parsedVp[1].viewportMeasured)
    let measured = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 10, radii: [10, 10, 10, 10], width: 1000, height: 949, mode: "fullscreen")
    let right = measured.inWindow(overlay: CGRect(x: 512, y: 33, width: 1000, height: 949), window: win)
    check("insets from the window's edges: the inspector on the left adds its width to the left", right.left == 772 && right.right == 8 && right.top == 8 && right.width == 1512)
    let bottom = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 10, radii: [10, 10, 10, 10], width: 1512, height: 600, mode: "fullscreen").inWindow(overlay: CGRect(x: 0, y: 33, width: 1512, height: 600), window: win)
    check("at the bottom: its height added to the bottom", bottom.bottom == 357 && bottom.left == 260 && bottom.height == 949)
    check("the whole window: as measured", measured.inWindow(overlay: win, window: win) == measured)
    // Over the inspector the overlay isn't there at all: the pointer is Safari's.
    let slot = PassThrough.slot(in: CGRect(x: 0, y: 33, width: 1512, height: 600), layout: PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 0, radii: [0, 0, 0, 0], width: 1512, height: 600, mode: "fullscreen"))
    check("the slot ends above the inspector", slot.rect.maxY == 33 + 600 - 8)
  }

  // One Margin.app at a time (BundleWatch.swift, AppDelegate.swift): a new instance ends the others of its bundle.
  static func oneMargin() {
    let here = "/Users/t/Applications/Margin.app"
    let running = [BundleWatch.Running(pid: 10, bundlePath: here), BundleWatch.Running(pid: 11, bundlePath: here + "/"),
                   BundleWatch.Running(pid: 12, bundlePath: here + ".old"), BundleWatch.Running(pid: 13, bundlePath: "/Users/t/Projects/margin/xcode/build/Build/Products/Release/Margin.app"),
                   BundleWatch.Running(pid: 14, bundlePath: nil), BundleWatch.Running(pid: 15, bundlePath: "/Users/t/Library/Developer/Xcode/DerivedData/Margin-x/Build/Products/Debug/Margin.app")]
    check("one Margin.app: the others of this bundle (and one an update moved aside) end, never this one", BundleWatch.othersToEnd(running, me: 10, bundlePath: here) == [11, 12])
    check("never a build folder's or Xcode's copy, nor one whose bundle isn't known", !BundleWatch.othersToEnd(running, me: 99, bundlePath: here).contains { [13, 14, 15].contains($0) })
    check("alone: nothing to end", BundleWatch.othersToEnd([BundleWatch.Running(pid: 10, bundlePath: here)], me: 10, bundlePath: here).isEmpty)
    // The executable's identity, read from a real file (in a temporary folder) as scripts/safari.sh swaps the bundle.
    let fm = FileManager.default
    let dir = fm.temporaryDirectory.appendingPathComponent("margin-bundle-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: dir) }
    try? fm.createDirectory(at: dir.appendingPathComponent("Margin.app/Contents/MacOS"), withIntermediateDirectories: true)
    let exe = dir.appendingPathComponent("Margin.app/Contents/MacOS/Margin")
    try? Data("old build".utf8).write(to: exe)
    let first = FileIdentity.of(exe)
    check("an executable's identity: read, and the same when nothing changed", first != nil && FileIdentity.of(exe) == first)
    try? fm.createDirectory(at: dir.appendingPathComponent("Margin.app.new/Contents/MacOS"), withIntermediateDirectories: true)
    try? Data("new build".utf8).write(to: dir.appendingPathComponent("Margin.app.new/Contents/MacOS/Margin"))
    try? fm.moveItem(at: dir.appendingPathComponent("Margin.app"), to: dir.appendingPathComponent("Margin.app.old"))
    check("mid-swap (the bundle moved aside): can't be read", FileIdentity.of(exe) == nil)
    try? fm.moveItem(at: dir.appendingPathComponent("Margin.app.new"), to: dir.appendingPathComponent("Margin.app"))
    check("the new bundle in its place: another file at the same path", FileIdentity.of(exe) != nil && FileIdentity.of(exe) != first)
    var quit = 0
    let watch = BundleWatch(read: { FileIdentity.of(exe) }, quit: { quit += 1 })
    try? fm.removeItem(at: dir.appendingPathComponent("Margin.app.old"))
    check("its own build in place: no quit", !watch.check("test") && quit == 0)
  }

  static func edgeAndPointer() {
    let frame = CGRect(x: 100, y: 50, width: 1280, height: 800)
    let hidden = PassThrough.slot(in: frame, layout: PageLayout(geometry: ["insets": ["left": 0, "top": 0, "right": 0, "bottom": 0], "container": ["width": 1280, "height": 800]])!)
    let docked = PassThrough.slot(in: frame, layout: PageLayout(geometry: ["insets": ["left": 260, "top": 8, "right": 8, "bottom": 8], "container": ["width": 1280, "height": 800]])!)
    let edge = CGRect(x: 100, y: 50, width: EdgeGuard.width, height: 800)
    check("the edge guard: the window's left edge, its height, the sidebar hidden", EdgeGuard.frame(for: frame, slot: hidden) == edge)
    check("docked too (a quick move from the page reaches the edge in one step), and before a layout", EdgeGuard.frame(for: frame, slot: docked) == edge && EdgeGuard.frame(for: frame, slot: nil) == edge)
    check("none while the overlay takes the whole window", EdgeGuard.frame(for: frame, slot: Slot(rect: hidden.rect, captureAll: true)) == nil)
    check("none with no width", EdgeGuard.frame(for: frame, slot: hidden, width: 0) == nil)
    let size = CGSize(width: 1280, height: 800)
    let edges = PointerWant(["mode": "edges", "edges": ["left"], "zone": 24])
    check("pointer: the reveal zone only while hidden", edges.wants(CGPoint(x: 3, y: 400), in: size) && edges.wants(CGPoint(x: 24, y: 400), in: size) && !edges.wants(CGPoint(x: 25, y: 400), in: size) && !edges.wants(CGPoint(x: 1279, y: 400), in: size))
    check("a right-hand theme's", PointerWant(["mode": "edges", "edges": ["right"], "zone": 10]).wants(CGPoint(x: 1275, y: 1), in: size))
    check("none while docked", !PointerWant(["mode": "none"]).wants(CGPoint(x: 0, y: 0), in: size))
    check("all while out, and before the page says", PointerWant(["mode": "all"]).wants(CGPoint(x: 600, y: 400), in: size) && PointerWant([:]).mode == .all)
  }
}
