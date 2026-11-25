// The suite's basics: its log (the watchdog's clock), the results, waiting, commands that can't hang, text matching.
import AppKit

let t0 = Date()
// (The watchdog's clock: when the suite last said something.)
let progress = NSLock()
nonisolated(unsafe) var lastSaid = Date()
func log(_ s: String) { print(String(format: "%6.2f ", Date().timeIntervalSince(t0)) + s); progress.lock(); lastSaid = Date(); progress.unlock() }

struct Result { let scenario: String; let name: String; let ok: Bool?; let detail: String }
nonisolated(unsafe) var results: [Result] = []
nonisolated(unsafe) var currentScenario = "-"
func step(_ name: String, _ ok: Bool, _ detail: String) { results.append(Result(scenario: currentScenario, name: name, ok: ok, detail: detail)); log("\(ok ? "PASS" : "FAIL") \(name): \(detail)") }
func skip(_ name: String, _ why: String) { results.append(Result(scenario: currentScenario, name: name, ok: nil, detail: why)); log("SKIP \(name): \(why)") }

// Waits up to `s` seconds for `f`, the main run loop turning meanwhile (Margin's notifications, AppKit's).
@discardableResult func spin(_ s: Double, _ f: () -> Bool = { false }) -> Bool {
  let end = Date().addingTimeInterval(s)
  while Date() < end { if f() { return true }; if Thread.isMainThread { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) } else { usleep(50_000) } }
  return f()
}

// A command's output, read AS IT COMES (check10's runs of 2026-11-17 hung for good when `log show` filled a pipe nothing
// read), cut off after `timeout` seconds (said).
final class Output: @unchecked Sendable { let lock = NSLock(); var data = Data() }
@discardableResult func sh(_ path: String, _ args: [String], timeout: Double = 45, input: Data? = nil) -> String {
  let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
  let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
  let inPipe = input.map { _ in Pipe() }
  if let inPipe { p.standardInput = inPipe }
  let out = Output()
  pipe.fileHandleForReading.readabilityHandler = { h in let d = h.availableData; out.lock.lock(); out.data.append(d); out.lock.unlock() }
  guard (try? p.run()) != nil else { pipe.fileHandleForReading.readabilityHandler = nil; return "" }
  if let inPipe, let input { inPipe.fileHandleForWriting.write(input); try? inPipe.fileHandleForWriting.close() }
  let end = Date().addingTimeInterval(timeout)
  while p.isRunning, Date() < end { usleep(20_000) }
  if p.isRunning {
    p.terminate(); usleep(300_000)
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    print(String(format: "%6.2f ", Date().timeIntervalSince(t0)) + "(\((path as NSString).lastPathComponent) cut off after \(Int(timeout)) s)")
  }
  p.waitUntilExit()
  pipe.fileHandleForReading.readabilityHandler = nil
  let rest = (try? pipe.fileHandleForReading.readToEnd()) ?? nil
  out.lock.lock(); defer { out.lock.unlock() }
  return String(decoding: out.data + (rest ?? Data()), as: UTF8.self)
}
let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

func match(_ line: String?, _ pattern: String) -> [String]? {
  guard let line, let re = try? NSRegularExpression(pattern: pattern), let m = re.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { return nil }
  return (1..<m.numberOfRanges).map { Range(m.range(at: $0), in: line).map { String(line[$0]) } ?? "" }
}
func rect(_ r: CGRect?) -> String { r.map { "\(Int($0.minX)),\(Int($0.minY)) \(Int($0.width))x\(Int($0.height))" } ?? "none" }
func near(_ a: CGRect, _ b: CGRect, _ tolerance: CGFloat = 2) -> Bool {
  abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
}
func app(_ id: String) -> NSRunningApplication? { NSRunningApplication.runningApplications(withBundleIdentifier: id).first { !$0.isTerminated } }
func home(_ path: String) -> String { NSHomeDirectory() + "/" + path }
