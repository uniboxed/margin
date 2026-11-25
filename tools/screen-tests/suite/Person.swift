// The person: away (idle by the hardware's events, the suite's own posts left out) and the Mac not locked, checked
// before the run and before each step; the suite's own clicks and keys (only on its Chameleon copies and on Margin,
// after the window list says so); the modifier keys always let go.
import AppKit

func hidIdle() -> Double { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!) }
nonisolated(unsafe) var lastPost: Date?
nonisolated(unsafe) var idleAtPost = 0.0
func userIdle() -> Double {
  let i = hidIdle()
  guard let p = lastPost else { return i }
  let since = Date().timeIntervalSince(p)
  return i < since - 0.5 ? i : idleAtPost + since // (an event after the suite's own last one: the person's)
}
// The handoff between parts (each its own process): the last post's time and the idle time at it, so the next part's
// gate leaves the last part's own posts out too. Only taken if under 15 minutes old.
struct Handoff: Codable { let lastPost: Double; let idleAtPost: Double }
func loadHandoff(_ path: String) {
  guard let d = FileManager.default.contents(atPath: path), let h = try? JSONDecoder().decode(Handoff.self, from: d), Date().timeIntervalSince1970 - h.lastPost < 900 else { return }
  lastPost = Date(timeIntervalSince1970: h.lastPost)
  idleAtPost = h.idleAtPost
}
func saveHandoff(_ path: String) {
  guard let p = lastPost, let d = try? JSONEncoder().encode(Handoff(lastPost: p.timeIntervalSince1970, idleAtPost: idleAtPost)) else { return }
  FileManager.default.createFile(atPath: path, contents: d)
}
func locked() -> Bool {
  if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.loginwindow" { return true }
  return (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool == true
}
let startIdle = 180.0, stepIdle = 60.0
// Before each step: the person still away for a minute, the Mac not locked; else everything back and out (6).
func gate(_ next: String) {
  if locked() { restore("the Mac locked before \(next)"); exit(6) }
  if userIdle() < stepIdle { restore("the Mac is in use before \(next) (idle \(Int(userIdle())) s)"); exit(6) }
}

// ---- posting: only on its own Chameleon copies or on Margin ----
let canPost = AXIsProcessTrusted()
func post(_ make: () -> CGEvent?) { idleAtPost = userIdle(); make()?.post(tap: .cghidEventTap); lastPost = Date() }
func click(_ p: CGPoint) {
  post { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) }
  spin(0.25) // (Margin decides who has the pointer as it moves: PassThrough)
  for type in [CGEventType.leftMouseDown, .leftMouseUp] { post { CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left) }; spin(0.06) }
  spin(0.5)
}
// A double-click at `p`: the pointer there first (as `click`), then two presses and releases, the second pair with its
// click count 2 (as the window server's own double-click).
func doubleClick(_ p: CGPoint) {
  post { CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) }
  spin(0.25)
  for count: Int64 in [1, 2] {
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
      post {
        let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
        e?.setIntegerValueField(.mouseEventClickState, value: count)
        return e
      }
      spin(0.04)
    }
    spin(0.06)
  }
  spin(0.5)
}
// A plain key, no modifier: down and up (only ever to its own copy or Margin's own field: checked first).
func plainKey(_ code: UInt16) {
  for down in [true, false] { post { let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down); e?.flags = []; return e }; spin(0.06) }
}
// The modifiers the window server reads as held now (2026-11-15: a simulated press with modifier flags can leave
// Control or Fn held system-wide).
func modsHeld() -> CGEventFlags { CGEventSource.flagsState(.combinedSessionState).intersection([.maskControl, .maskSecondaryFn, .maskCommand, .maskAlternate, .maskShift]) }
nonisolated(unsafe) var fnPosted = false
nonisolated(unsafe) var controlPosted = false
// Control let go (a flagsChanged with no flags, as the key's own release), Fn too if a press posted it; true: none held.
@discardableResult func releaseModifiers() -> Bool {
  guard controlPosted else { return modsHeld().isEmpty }
  for i in 0..<3 {
    if i > 0, !modsHeld().contains(.maskControl) { break }
    post { let e = CGEvent(keyboardEventSource: nil, virtualKey: 59, keyDown: false); e?.type = .flagsChanged; e?.flags = []; return e }
    spin(0.12)
  }
  if fnPosted, modsHeld().contains(.maskSecondaryFn) {
    post { let e = CGEvent(keyboardEventSource: nil, virtualKey: 63, keyDown: false); e?.type = .flagsChanged; e?.flags = []; return e }
    spin(0.12)
  }
  return modsHeld().isEmpty
}
// Mission Control's "Move left a space" (79) and "Move right a space" (81) as the person's settings have them (read
// only): off, rebound to keys this suite doesn't post, or ⌃ and the arrow (macOS's default, also when not in the file).
enum SpaceKey { case off, other(String), arrow(UInt16) }
func spaceKey(_ id: String, _ arrow: UInt16) -> SpaceKey {
  let all = CFPreferencesCopyAppValue("AppleSymbolicHotKeys" as CFString, "com.apple.symbolichotkeys" as CFString) as? [String: Any]
  guard let entry = all?[id] as? [String: Any] else { return .arrow(arrow) }
  if let on = entry["enabled"] as? NSNumber, !on.boolValue { return .off }
  if let p = (entry["value"] as? [String: Any])?["parameters"] as? [NSNumber], p.count >= 3 {
    let key = p[1].intValue, mods = p[2].intValue
    guard key == Int(arrow), mods & 0x40000 != 0, mods & ~(0x40000 | 0x800000 | 0x200000) == 0 else { return .other("key \(key), modifiers 0x\(String(mods, radix: 16))") }
  }
  return .arrow(arrow)
}
// One press of ⌃ and an arrow, then every modifier checked released. False: one still reads held.
func pressSpaceKey(_ arrow: UInt16, fn: Bool) -> Bool {
  var flags: CGEventFlags = [.maskControl, .maskNumericPad]
  if fn { flags.insert(.maskSecondaryFn); fnPosted = true }
  controlPosted = true
  post { let e = CGEvent(keyboardEventSource: nil, virtualKey: 59, keyDown: true); e?.type = .flagsChanged; e?.flags = .maskControl; return e }
  spin(0.04)
  for down in [true, false] { post { let e = CGEvent(keyboardEventSource: nil, virtualKey: arrow, keyDown: down); e?.flags = flags; return e }; spin(0.04) }
  return releaseModifiers()
}

// ---- Accessibility on its own Chameleon copies only (their full screen) ----
func axWindow(_ pid: pid_t) -> AXUIElement? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &v) == .success, let list = v as? [AXUIElement] else { return nil }
  return list.first
}
func axFullScreen(_ pid: pid_t) -> Bool? {
  guard let w = axWindow(pid) else { return nil }
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &v) == .success ? (v as? Bool) : nil
}
// Its app made the front app by Accessibility (the app activates itself, as at a Dock-icon click).
func setAXFrontmost(_ pid: pid_t) -> Bool {
  AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success
}
func setAXFullScreen(_ pid: pid_t, _ on: Bool) -> Bool {
  guard let w = axWindow(pid) else { return false }
  return AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, on ? kCFBooleanTrue : kCFBooleanFalse) == .success
}
