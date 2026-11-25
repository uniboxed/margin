// Which device a gesture comes from (M2.9 step 6, docs/SPACE-BACKGROUNDS.md Part B §6; PointerKind.swift), for Edit
// Theme Color's ticks: a mouse unless proven a trackpad. The events a plain mouse sends, made as CGEvents (a press, a
// wheel's notch: no touch, no precise deltas, no phase), read as a mouse's; a trackpad's scroll (precise, with its
// phase) and a pressure event as a trackpad's; what's told and when; the Mac's haptics and interface sounds read; the
// message the page gets. The real trackpads (a click, tap-to-click, a force click, the dial scrolled) and a real
// mouse: TESTING.md's manual checks.

import AppKit

@MainActor func pointerKindTests() {
    // ---- the facts, from events as a mouse sends them ----
    let at = CGPoint(x: 10, y: 10)
    let press = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: at, mouseButton: .left).flatMap(NSEvent.init(cgEvent:))
    check("pointer: a mouse's press read: a press, not a touch", press.flatMap(PointerFacts.init) == PointerFacts(kind: .press, touch: false),
          "\(String(describing: press.flatMap(PointerFacts.init)))")
    let right = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: at, mouseButton: .right).flatMap(NSEvent.init(cgEvent:))
    check("pointer: a right press too", right.flatMap(PointerFacts.init)?.kind == .press)
    let notch = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: -3, wheel2: 0, wheel3: 0).flatMap(NSEvent.init(cgEvent:))
    check("pointer: a wheel's notch read: not precise, no phase", notch.flatMap(PointerFacts.init) == PointerFacts(kind: .scroll, precise: false, phased: false, began: false),
          "\(String(describing: notch.flatMap(PointerFacts.init)))")
    // A trackpad's scroll as macOS makes one: continuous (precise deltas), its phase began.
    let swipe = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -12, wheel2: 0, wheel3: 0)
    swipe?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    swipe?.setIntegerValueField(CGEventField(rawValue: 99)!, value: 1) // kCGScrollWheelEventScrollPhase: began
    let swiped = swipe.flatMap(NSEvent.init(cgEvent:)).flatMap(PointerFacts.init)
    check("pointer: a trackpad's scroll read: precise, its phase begun", swiped == PointerFacts(kind: .scroll, precise: true, phased: true, began: true), "\(String(describing: swiped))")
    let moved = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left).flatMap(NSEvent.init(cgEvent:))
    check("pointer: a move says nothing", moved.flatMap(PointerFacts.init) == nil)

    // ---- the classifier ----
    let c = PointerClassifier()
    check("pointer: a mouse until proven a trackpad", c.kind == .mouse)
    check("pointer: a mouse's press: a mouse, told (each press tells)", c.see(PointerFacts(kind: .press)) == .mouse && c.see(PointerFacts(kind: .press)) == .mouse)
    check("pointer: a pressure event in the gesture: a trackpad (a Force Touch trackpad's press), told once",
          c.see(PointerFacts(kind: .pressure)) == .trackpad && c.see(PointerFacts(kind: .pressure)) == nil && c.kind == .trackpad)
    check("pointer: a touch's press: a trackpad", c.see(PointerFacts(kind: .press, touch: true)) == .trackpad)
    check("pointer: a wheel's notch: a mouse (changed: told)", c.see(PointerFacts(kind: .scroll)) == .mouse && c.see(PointerFacts(kind: .scroll)) == nil)
    check("pointer: a trackpad's scroll begun: a trackpad, told; its moves after, not again",
          c.see(PointerFacts(kind: .scroll, precise: true, phased: true, began: true)) == .trackpad && c.see(PointerFacts(kind: .scroll, precise: true, phased: true)) == nil)
    check("pointer: a precise scroll with no phase (a Magic Mouse may send them): says nothing",
          c.see(PointerFacts(kind: .scroll, precise: true)) == nil && c.kind == .trackpad)
    _ = c.see(PointerFacts(kind: .press))
    check("pointer: momentum after a mouse's press (a trackpad's fingers lifted): a trackpad again",
          c.see(PointerFacts(kind: .scroll, precise: true, phased: true)) == .trackpad)
    // Through a window's events: what its page is told.
    if let swiped, let press = press.flatMap(PointerFacts.init) {
        let d = PointerClassifier()
        check("pointer: the events a mouse sends: a mouse throughout", [press, PointerFacts(kind: .scroll)].compactMap(d.see) == [.mouse] && d.kind == .mouse)
        check("pointer: a trackpad's scroll then: a trackpad", d.see(swiped) == .trackpad)
    }

    // ---- what the Mac has, and the message ----
    let hasActuator = PointerClassifier.readActuators()
    check("pointer: the IORegistry read (a trackpad that plays haptics here: \(hasActuator))", PointerClassifier.hapticTrackpad() == hasActuator)
    let suite = "margin-tests-\(UUID().uuidString)"
    if let defaults = UserDefaults(suiteName: suite) {
        check("pointer: interface sounds: on unless said off", PointerClassifier.interfaceSounds(defaults))
        defaults.set(0, forKey: "com.apple.sound.uiaudio.enabled")
        check("pointer: interface sounds off: read so", !PointerClassifier.interfaceSounds(defaults))
        defaults.set(1, forKey: "com.apple.sound.uiaudio.enabled")
        check("pointer: on again", PointerClassifier.interfaceSounds(defaults))
        defaults.removePersistentDomain(forName: suite)
    }
    let message = PointerClassifier.message(.trackpad, haptics: true, uiSounds: false)
    let read = (try? JSONSerialization.jsonObject(with: Data(message.utf8))) as? [String: Any]
    check("pointer: what the page is told: its kind, the haptics, the sounds", read?["type"] as? String == "pointerKind" && read?["kind"] as? String == "trackpad"
          && read?["haptics"] as? Bool == true && read?["uiSounds"] as? Bool == false, message)
}
