// Margin.app's real end of the link (app/shell/ExtensionLink.swift, LinkSocket.swift,
// LinkMessage.swift, Chunks.swift), on its own, for the WebKit host's `app*` steps: the
// host passes what the extension's native messaging does to it (wantLink) on stdin, and
// puts what this dispatches into the extension (SFSafariApplication.dispatchMessage in the
// app) into the copy's native port. No overlays, no window tracking: it plays the app's
// part of the link and says on stdout, one JSON object a line, what it heard:
//   { dispatch: name, info }  for the host to deliver into the extension's port
//   { ev: ... }               what happened (logged by the host)
// As the copy links, it sends a setLayout for the copy's first window (300/40/20/24, or
// MARGIN_LINK_LAYOUT="left,top,right,bottom"), and once the theme's pieces add up, a request
// (`updateSettings`, the sidebar's shortcut to ⌥J) whose effect a page can see. Stdin:
// { wantLink: nonce } | { bye: true } | { layout: [left, top, right, bottom] } (a new
// setLayout for the linked copy's first window: the host's `appLayout` step).
// Built by run.sh with the app's flags; never shows anything.
import AppKit
import Foundation

func say(_ object: JSONObject) {
  guard let text = jsonString(object) else { return }
  print(text)
  fflush(stdout)
}

struct StdoutDispatch: ExtensionDispatch {
  func dispatch(_ name: String, _ info: JSONObject) { say(["dispatch": name, "info": info]) }
}

// The insets the app's overlay would measure for the page slot (left, top, right, bottom).
var insets: [Double] = {
  let parts = (ProcessInfo.processInfo.environment["MARGIN_LINK_LAYOUT"] ?? "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
  return parts.count == 4 ? parts : [300, 40, 20, 24]
}()

final class Harness: ExtensionLinkDelegate {
  let link: SocketLink
  var assembler = ChunkAssembler()
  var laidOut = Set<String>()
  var asked = Set<String>()
  var firstWindow: [String: Int] = [:]
  var size: [String: (Double, Double)] = [:]
  var seq: [String: Int] = [:]
  var current: LinkConnection?

  func layout(_ c: LinkConnection, _ epoch: String) {
    guard let id = firstWindow[epoch], let (width, height) = size[epoch] else { return }
    let n = (seq[epoch] ?? 0) + 1
    seq[epoch] = n
    let layout = PageLayout(left: insets[0], top: insets[1], right: insets[2], bottom: insets[3], radius: 10, radii: [10, 10, 10, 10], width: width, height: height, mode: "fullscreen")
    c.send(.setLayout(epoch: epoch, windowId: id, seq: n, layout: layout))
    say(["ev": "setLayout sent", "windowId": id, "insets": insets, "seq": n])
  }

  init() {
    link = SocketLink(dispatch: StdoutDispatch(), safariSince: { nil }, wake: Notification.Name("io.tirth.margin.test.link.\(getpid())"))
    // The host's extension pages are webkit-extension:// (Safari's are safari-web-extension://).
    link.allowedOrigins = ["safari-web-extension://", "webkit-extension://"]
    link.delegate = self
  }

  func linkUp(_ c: LinkConnection) {
    current = c
    let h = c.hello
    say(["ev": "hello", "profile": h.profile, "browser": h.browser, "owner": h.owner, "ext": h.ext ?? NSNull(), "origin": h.origin ?? NSNull()])
  }

  func linkReceived(_ c: LinkConnection, _ message: LinkMessage) {
    switch message {
    case .snapshot(let epoch, let seq, let state, let windows):
      let spaces = (state["spaces"] as? [Any])?.count ?? -1
      say(["ev": "snapshot", "seq": seq, "keys": Array(state.keys).sorted(), "spaces": spaces, "windows": windows])
      guard !laidOut.contains(epoch), let w = windows.first, let id = int(w["windowId"]) else { return }
      laidOut.insert(epoch)
      firstWindow[epoch] = id
      let width = num(w["width"]) ?? 1200, height = num(w["height"]) ?? 800
      size[epoch] = (width > 0 ? width : 1200, height > 0 ? height : 800)
      layout(c, epoch)
    case .delta(_, let seq, let changes, _):
      say(["ev": "delta", "seq": seq, "keys": Array(changes.keys).sorted()])
    case .windows(_, let seq, let list):
      say(["ev": "windows", "seq": seq, "count": list.count])
    case .theme(let epoch, let chunk):
      switch assembler.add(chunk) {
      case .complete(let id, let data):
        say(["ev": "theme", "id": id, "bytes": data.count])
        guard !asked.contains(epoch) else { return }
        asked.insert(epoch)
        let windowId = firstWindow[epoch]
        Task { @MainActor in
          do {
            let reply = try await c.request(type: "updateSettings", payload: ["patch": ["sidebarShortcut": "Alt+KeyJ"]], windowId: windowId)
            say(["ev": "reply", "ok": reply["ok"] ?? NSNull(), "error": reply["error"] ?? NSNull()])
          } catch {
            say(["ev": "reply failed", "error": "\(error)"])
          }
        }
      case .refused(let why): say(["ev": "theme refused", "why": why])
      case .waiting: break
      }
    case .keys(_, let bindings):
      say(["ev": "keys", "bindings": bindings])
    case .push(_, let windowId, let msg):
      say(["ev": "push", "windowId": windowId ?? NSNull(), "msg": msg])
    case .other(let k):
      say(["ev": "other", "k": k])
    default:
      break
    }
  }

  func linkDown(_ c: LinkConnection, _ why: String) {
    if current === c { current = nil }
    say(["ev": "down", "why": why])
  }
}

let harness = Harness()
harness.link.start()
say(["ev": "started"])

FileHandle.standardInput.readabilityHandler = { handle in
  let data = handle.availableData
  if data.isEmpty { DispatchQueue.main.async { exit(0) }; return }
  for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
    guard let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? JSONObject else { continue }
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        if let nonce = object["wantLink"] as? String { harness.link.wantLink(nonce: nonce) }
        if object["bye"] as? Bool == true { harness.link.stop(why: "Margin.app quit") { say(["ev": "stopped"]); exit(0) } }
        if let given = object["layout"] as? [Double], given.count == 4 {
          insets = given
          if let c = harness.current { harness.layout(c, c.epoch) } else { say(["ev": "layout kept: no copy linked"]) }
        }
      }
    }
  }
}
RunLoop.main.run()
