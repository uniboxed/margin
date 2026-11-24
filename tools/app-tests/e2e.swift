// Margin.app's shell end to end, with no browser and nothing on screen: the harness the scenarios share (a stand-in
// for the extension's copies, fake-extension.mts in Node; scripted apps and hot keys), then the lasting data
// (e2e-data.swift: the first link, a relink with a queue, two profiles kept apart, a wiped cache refilled, the app's
// own change, and a crash mid-write followed by a relaunch, all in a temporary folder), the link's requests ending on
// evidence against a stalled copy (e2e-link.swift), Margin's own window
// (e2e-hosted.swift) and the hosted parts joined (e2e-glue.swift). The app never activates, nothing is made key, no
// real hot key is taken (FakeKeys).
import AppKit
import WebKit

var failures = 0
var passed = 0
// `check` for scenarios that wrap it in a local one of the same name.
func e2eCheck(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") { check(label, ok, detail()) }
func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
  if ok { passed += 1; print("ok   \(label)") } else { failures += 1; print("FAIL \(label)" + (detail().isEmpty ? "" : ": \(detail())")) }
}
let env = ProcessInfo.processInfo.environment
let browserPid: pid_t = 77_777
let fakeBundle = "test.margin.fake-safari"

// ---- the stand-in extension -------------------------------------------------------------

final class Fake {
  let process = Process()
  let input = Pipe()
  let output = Pipe()
  var events: [JSONObject] = []
  private var buffer = Data()

  init() {
    process.executableURL = URL(fileURLWithPath: env["MARGIN_NODE"] ?? "/opt/homebrew/bin/node")
    process.arguments = [env["MARGIN_FAKE_EXTENSION"]!]
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    output.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      DispatchQueue.main.async { MainActor.assumeIsolated { Fake.current?.take(data) } }
    }
    Fake.current = self
  }
  nonisolated(unsafe) static weak var current: Fake?

  func start() throws { try process.run() }

  private func take(_ data: Data) {
    buffer.append(data)
    while let nl = buffer.firstIndex(of: 0x0a) {
      let line = buffer[buffer.startIndex..<nl]
      buffer = Data(buffer[(nl + 1)...])
      if var o = (try? JSONSerialization.jsonObject(with: line)) as? JSONObject {
        if env["MARGIN_APP_VERBOSE"] != nil { print("  fake:", String(decoding: line, as: UTF8.self).prefix(200)) }
        o["_at"] = Date().timeIntervalSince1970 // when it was heard here
        events.append(o)
      }
    }
  }

  func tell(_ command: JSONObject) {
    guard var data = jsonText(command) else { return }
    data.append(0x0a)
    input.fileHandleForWriting.write(data)
  }

  // The first event (from `since` on) that matches.
  func first(_ ev: String, since: Int = 0, _ test: (JSONObject) -> Bool = { _ in true }) -> JSONObject? {
    events.dropFirst(since).first { $0["ev"] as? String == ev && test($0) }
  }
  func all(_ ev: String, since: Int = 0, _ test: (JSONObject) -> Bool = { _ in true }) -> [JSONObject] {
    events.dropFirst(since).filter { $0["ev"] as? String == ev && test($0) }
  }

  func stop() { process.terminate() }
}

// `refuse`: each dispatch refused for this reason (as Safari refuses one: "SFErrorDomain 1"), nothing delivered.
final class FakeDispatch: ExtensionDispatch {
  var refuse: String?
  func dispatch(_ name: String, _ info: JSONObject, done: @escaping @MainActor (String?) -> Void) {
    if let refuse { return done(refuse) }
    Fake.current?.tell(["native": ["name": name, "info": info]])
    done(nil)
  }
}

final class ScriptedApps: AppWatch {
  var frontPid: pid_t? = 1
  var onChange: ((String) -> Void)?
  func pids(of bundleId: String) -> Set<pid_t> { bundleId == fakeBundle ? [browserPid] : [] }
  func start() {}
  func stop() {}
  func bringToFront(_ pid: pid_t?) { frontPid = pid; onChange?("app activated") }
}

final class FakeKeys: HotKeyRegistrar {
  var onHit: ((UInt32) -> Void)?
  var onRelease: ((UInt32) -> Void)?
  var held: [UInt32: Combo] = [:]
  func register(_ combo: Combo, id: UInt32) -> Bool { held[id] = combo; return true }
  func unregister(id: UInt32) { held[id] = nil }
  func press(_ text: String) { if let id = held.first(where: { $0.value == Combo.parse(text) })?.key { onHit?(id) } }
}

func until(_ seconds: Double, _ test: () -> Bool) async -> Bool {
  let end = Date().addingTimeInterval(seconds)
  while Date() < end {
    if test() { return true }
    try? await Task.sleep(nanoseconds: 20_000_000)
  }
  return test()
}

func js(_ web: WKWebView, _ code: String) async -> Any? {
  try? await web.callAsyncJavaScript(code, arguments: [:], in: nil, contentWorld: .page)
}

func rect(_ v: Any?) -> CGRect? {
  guard let a = v as? [Any], a.count == 4 else { return nil }
  let n = a.compactMap(num)
  return n.count == 4 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
}

func waitJS(_ web: WKWebView, _ code: String) async -> Bool {
  for _ in 0..<60 {
    if await js(web, code) as? Bool == true { return true }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  return false
}

func same(_ a: Any?, _ b: Any?) -> Bool {
  guard let a, let b else { return a == nil && b == nil }
  return NSDictionary(dictionary: ["v": a]).isEqual(to: ["v": b])
}

final class Runner: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    if env["MARGIN_APP_VERBOSE"] != nil { Diagnostics.echo = { print("  app:", $0) } }
    Task { @MainActor in
      if env["MARGIN_E2E_ONLY"] == "split" {
        await glueSplitScenario()
        print(failures == 0 ? "all \(passed) split view checks passed" : "\(failures) split view checks failed")
        exit(failures == 0 ? 0 : 1)
      }
      if env["MARGIN_E2E_ONLY"] == "glue" {
        await glueScenario()
        await glueResumeScenario()
        await glueSplitScenario() // e2e-split.swift
        print(failures == 0 ? "all \(passed) hosting checks passed" : "\(failures) hosting checks failed")
        exit(failures == 0 ? 0 : 1)
      }
      if env["MARGIN_E2E_ONLY"] == "link" {
        await linkScenario()
        print(failures == 0 ? "all \(passed) link checks passed" : "\(failures) link checks failed")
        exit(failures == 0 ? 0 : 1)
      }
      if env["MARGIN_E2E_ONLY"] == "hosted" {
        await hostedScenario()
        print(failures == 0 ? "all \(passed) Margin window checks passed" : "\(failures) Margin window checks failed")
        exit(failures == 0 ? 0 : 1)
      }
      await dataScenario()
      await carryScenario() // e2e-data.swift
      await linkScenario() // e2e-link.swift
      await hostedScenario() // e2e-hosted.swift
      await glueScenario() // e2e-glue.swift
      await glueResumeScenario()
      await glueSplitScenario() // e2e-split.swift
      print(failures == 0 ? "all \(passed) end-to-end checks passed" : "\(failures) of \(passed + failures) end-to-end checks failed")
      exit(failures == 0 ? 0 : 1)
    }
  }
}

@main enum E2E {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let runner = Runner()
    app.delegate = runner
    Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { _ in print("FAIL timed out"); exit(1) }
    withExtendedLifetime(runner) { app.run() }
  }
}
