// The window server: reads only (numbers, owners, layers, bounds, on-screen, alpha, Spaces: never a title or a pixel),
// and one write, the Space the run started on made current again (as check10 and checks 1-9: `setCurrent`).
import AppKit

let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
func fn<T>(_ n: String, _ t: T.Type) -> T { unsafeBitCast(dlsym(sky, n)!, to: t) }
let cid = fn("SLSMainConnectionID", (@convention(c) () -> Int32).self)()
let active = fn("SLSGetActiveSpace", (@convention(c) (Int32) -> UInt64).self)
let copyDisplays = fn("SLSCopyManagedDisplaySpaces", (@convention(c) (Int32) -> Unmanaged<CFArray>?).self)
let setCurrent = fn("SLSManagedDisplaySetCurrentSpace", (@convention(c) (Int32, CFString, UInt64) -> Void).self)
let dispIdent = fn("SLSCopyActiveMenuBarDisplayIdentifier", (@convention(c) (Int32) -> Unmanaged<CFString>?).self)
let spacesFor = fn("SLSCopySpacesForWindows", (@convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?).self)

// Mission Control's list: every Space, its type (0 a Desktop, 4 full screen) and its app's pid.
func mc() -> [String] {
  var out: [String] = []
  for d in (copyDisplays(cid)?.takeRetainedValue() as? [[String: Any]]) ?? [] { for s in (d["Spaces"] as? [[String: Any]]) ?? [] { out.append("\((s["id64"] as? UInt64) ?? 0)/t\((s["type"] as? Int) ?? -1)/pid\((s["pid"] as? Int).map(String.init) ?? "-")") } }
  return out
}

struct Win { let n: Int; let pid: pid_t; let layer: Int; let r: CGRect; let alpha: Double }
// Every window on screen now, front to back.
func onScreen() -> [Win] {
  ((CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []).compactMap { d in
    guard let n = d[kCGWindowNumber as String] as? Int, let pid = d[kCGWindowOwnerPID as String] as? Int32, let b = d[kCGWindowBounds as String] as? [String: Any],
          let r = CGRect(dictionaryRepresentation: b as CFDictionary) else { return nil }
    return Win(n: n, pid: pid, layer: (d[kCGWindowLayer as String] as? Int) ?? 0, r: r, alpha: (d[kCGWindowAlpha as String] as? Double) ?? 1)
  }
}
func big(_ pid: pid_t) -> Win? { onScreen().filter { $0.pid == pid && (0...2).contains($0.layer) && $0.r.width > 200 && $0.r.height > 200 }.max { $0.r.width * $0.r.height < $1.r.width * $1.r.height } }
func win(_ n: Int?) -> Win? { n.flatMap { n in onScreen().first { $0.n == n } } }
func spacesOf(_ n: Int) -> [UInt64] { (spacesFor(cid, 7, [n] as CFArray)?.takeRetainedValue() as? [UInt64]) ?? [] }

// Every window of an app wherever it is (on screen or not, any Space or none): what the desired-state checks read.
struct AnyWin: Codable, Equatable { let n: Int; let r: CGRect; let layer: Int; let on: Bool; let alpha: Double; let spaces: [UInt64] }
func windowsOf(_ pid: pid_t, minSide: CGFloat = 40) -> [AnyWin] {
  let list = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  return list.compactMap { d -> AnyWin? in
    guard let n = d[kCGWindowNumber as String] as? Int, let wp = d[kCGWindowOwnerPID as String] as? Int32, wp == pid, let b = d[kCGWindowBounds as String] as? [String: Any],
          let r = CGRect(dictionaryRepresentation: b as CFDictionary), r.width >= minSide, r.height >= minSide else { return nil }
    return AnyWin(n: n, r: r, layer: (d[kCGWindowLayer as String] as? Int) ?? 0, on: (d[kCGWindowIsOnscreen as String] as? Bool) ?? false, alpha: (d[kCGWindowAlpha as String] as? Double) ?? 1, spaces: spacesOf(n))
  }
}
func allOf(_ pid: pid_t) -> String { windowsOf(pid, minSide: 100).map { "#\($0.n) \(rect($0.r)) layer \($0.layer) alpha \($0.alpha) onscreen \($0.on) spaces \($0.spaces)" }.joined(separator: "; ") }
// An app's largest normal window wherever it is: its number, bounds, whether it's on screen, its Spaces.
func placedWindow(_ pid: pid_t, minWidth: CGFloat = 600, minHeight: CGFloat = 500) -> (n: Int, r: CGRect, on: Bool, spaces: [UInt64])? {
  windowsOf(pid).filter { $0.layer == 0 && $0.r.width > minWidth && $0.r.height > minHeight }.max { $0.r.width * $0.r.height < $1.r.width * $1.r.height }.map { ($0.n, $0.r, $0.on, $0.spaces) }
}
// Each display's "Current Space", and whether that Space is in the display's own list.
func displaysCurrent() -> String {
  ((copyDisplays(cid)?.takeRetainedValue() as? [[String: Any]]) ?? []).map { d -> String in
    let cur = ((d["Current Space"] as? [String: Any])?["id64"] as? UInt64)
    let listed = ((d["Spaces"] as? [[String: Any]]) ?? []).contains { ($0["id64"] as? UInt64) == cur }
    return "\(((d["Display Identifier"] as? String) ?? "?").prefix(8)): \(cur.map(String.init) ?? "none")\(listed ? "" : " (NOT LISTED)")"
  }.joined(separator: ", ")
}
func onList(_ n: Int?) -> String { n.map { num in onScreen().contains { $0.n == num } ? "on screen" : "NOT on screen" } ?? "unknown" }
func diag(_ pid: pid_t, _ marginWindow: Int?) -> String {
  "windows: \(allOf(pid)); its window \(onList(placedWindow(pid)?.n)), Margin's window \(onList(marginWindow)); displays' current Spaces: \(displaysCurrent()); active space \(active(cid)); spaces \(mc())"
}
// The Space the Mac is on now: its type (0 a Desktop, 4 a full-screen one) and its app's pid.
func currentSpaceInfo() -> (id: UInt64, type: Int, pid: Int?) {
  let id = active(cid)
  for d in (copyDisplays(cid)?.takeRetainedValue() as? [[String: Any]]) ?? [] { for sp in (d["Spaces"] as? [[String: Any]]) ?? [] where (sp["id64"] as? UInt64) == id { return (id, (sp["type"] as? Int) ?? -1, sp["pid"] as? Int) } }
  return (id, -1, nil)
}
// The display's Spaces in Mission Control's order (left to right), with each one's type and app's pid.
func displaySpaces(containing space: UInt64) -> [(id: UInt64, type: Int, pid: Int?)] {
  for d in (copyDisplays(cid)?.takeRetainedValue() as? [[String: Any]]) ?? [] {
    let list = ((d["Spaces"] as? [[String: Any]]) ?? []).map { (id: ($0["id64"] as? UInt64) ?? 0, type: ($0["type"] as? Int) ?? -1, pid: $0["pid"] as? Int) }
    if list.contains(where: { $0.id == space }) { return list }
  }
  return []
}
// Every user Space listed (a private one isn't).
func userSpaces() -> Set<UInt64> { Set(mc().compactMap { UInt64($0.split(separator: "/")[0]) }) }
// The windows of layers 0 and 1 under a point, front to back.
func under(_ p: CGPoint) -> [Win] { onScreen().filter { (0...1).contains($0.layer) && $0.alpha > 0 && $0.r.contains(p) } }
func mainDisplay() -> CGRect { CGDisplayBounds(CGMainDisplayID()) }
