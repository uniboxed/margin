// The window server's event records that keep a split's other panes active (all panes active, DECISIONS.md "Every
// pane of a split draws active"; docs/PRIVATE-APIS.md rows 40-45). AppKit decides inside each app whether it's active
// and which of its windows is key, from records the window server hands it. Margin sends two kinds to a pane's app with
// SkyLight's `SLPSPostEventRecordTo`, as yabai and AltTab do: an application-activated record (an AppKit-defined
// event, type 13, subtype 1; subtype 2 deactivated) and the make-key pair (a left mouse down and up whose byte 0x3a is
// 0x10: the window made key, no click). The app then draws as the active app with that window key (its caret, its
// selection, WebKit's focus) while another app stays the window server's front process, which has the keyboard and
// the menu bar (the research of 2026-11-21, in the scratchpad's allfocus/: e2-e6).
//
// The layout, as macOS 27.2.1 (26B131) has it: 0xf8 bytes (the length at 0x04), the type at 0x08, the window's number
// at 0x3c, the AppKit-defined subtype at 0x8a, its data1 and data2 at 0x8c and 0x90. A record is 0x100 bytes, zeroed
// (AltTab: the window server reads past 0xf8 since macOS 14.7.4). Checked at every launch (`problem`): an AppKit-defined
// event and a mouse press and release made with public calls (NSEvent) and read back as records
// (`SLEventRecordPointer`), each offset compared; anything else turns the part off (today's behaviour), said once in
// the host's launch line. The make-key flag (0x3a = 0x10) can't be made with a public call: it's yabai's and
// AltTab's, and the research's.

import AppKit

nonisolated enum PaneRecords {
    static let size = 0x100 // allocated, zeroed
    static let length: UInt8 = 0xf8 // what a record says it is
    static let lengthAt = 0x04, typeAt = 0x08, locationAt = 0x20, flagsAt = 0x3a, windowAt = 0x3c, subtypeAt = 0x8a, data1At = 0x8c, data2At = 0x90
    static let appKitDefined: UInt8 = 13, activated: UInt8 = 1, deactivated: UInt8 = 2
    static let mouseDown: UInt8 = 1, mouseUp: UInt8 = 2, makeKeyFlag: UInt8 = 0x10

    // A mouse event's own record (`own`: what SLEventRecordPointer reads of it) made `window`'s, the point in it (from its
    // top left) at the window-local location: everything else as it came (its type, button, click count, modifiers, time).
    // Posted to its app, it reaches that window and nothing raises it (the window server's routing is what raises a
    // clicked window: the real screen, 2026-11-22, a press, drags and a release to a window behind another, each at its
    // point, the order kept). A split's cut pane, docs/PEEK-SPLIT.md §4b.
    static func delivered(_ own: [UInt8], window: Int, local: CGPoint) -> [UInt8]? {
        guard own.count >= Int(length), let w = Int32(exactly: window) else { return nil }
        var b = Array(own.prefix(size)) + [UInt8](repeating: 0, count: max(0, size - own.count))
        withUnsafeBytes(of: w.littleEndian) { for i in 0..<4 { b[windowAt + i] = $0[i] } }
        withUnsafeBytes(of: Double(local.x).bitPattern.littleEndian) { for i in 0..<8 { b[locationAt + i] = $0[i] } }
        withUnsafeBytes(of: Double(local.y).bitPattern.littleEndian) { for i in 0..<8 { b[locationAt + 8 + i] = $0[i] } }
        return b
    }

    private static func blank(type: UInt8, window: Int) -> [UInt8] {
        var b = [UInt8](repeating: 0, count: size)
        b[lengthAt] = length
        b[typeAt] = type
        let n = UInt32(truncatingIfNeeded: window)
        for i in 0..<4 { b[windowAt + i] = UInt8(truncatingIfNeeded: n >> (8 * UInt32(i))) }
        return b
    }

    // Its app activated (true) or deactivated (false), as the window server says it, for `window`.
    static func activation(window: Int, activated on: Bool) -> [UInt8] {
        var b = blank(type: appKitDefined, window: window)
        b[subtypeAt] = on ? activated : deactivated
        return b
    }

    // Half of the make-key pair: `window` made its app's key one (no click: the flag, its location unset).
    static func makeKey(window: Int, down: Bool) -> [UInt8] {
        var b = blank(type: down ? mouseDown : mouseUp, window: window)
        b[flagsAt] = makeKeyFlag
        for i in locationAt..<(locationAt + 16) { b[i] = 0xff }
        return b
    }

    // ---- the launch check ----

    // What the check's public events carry (a window that needn't exist: nothing is posted).
    static let probeWindow = 0x5a17, probeData1 = 0x55, probeData2 = 0x66

    static func int32(_ b: [UInt8], at i: Int) -> Int? {
        guard i + 4 <= b.count else { return nil }
        return Int(UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24)
    }

    // The records the window server made of three public events (an AppKit-defined subtype 1 event for `probeWindow`
    // with `probeData1` and `probeData2`, a left mouse press and its release in `probeWindow`) against the layout above;
    // nil: as expected, else what differs (the part off). A record that didn't read: off too.
    static func problem(appKit: [UInt8]?, down: [UInt8]?, up: [UInt8]?) -> String? {
        guard let appKit, let down, let up else { return "a public event's record didn't read" }
        guard appKit.count >= Int(length), down.count >= Int(length), up.count >= Int(length) else { return "a record shorter than 0xf8 bytes" }
        var out: [String] = []
        func expect(_ what: String, _ got: Int?, _ want: Int) { if got != want { out.append("\(what) \(got.map { String(format: "0x%x", $0) } ?? "unread"), expected \(String(format: "0x%x", want))") } }
        for (name, r, type) in [("an AppKit-defined event's", appKit, appKitDefined), ("a press's", down, mouseDown), ("a release's", up, mouseUp)] {
            expect("\(name) length at 0x04", Int(r[lengthAt]), Int(length))
            expect("\(name) type at 0x08", Int(r[typeAt]), Int(type))
            expect("\(name) window at 0x3c", int32(r, at: windowAt), probeWindow)
        }
        expect("its subtype at 0x8a", Int(appKit[subtypeAt]), Int(activated))
        expect("its data1 at 0x8c", int32(appKit, at: data1At), probeData1)
        expect("its data2 at 0x90", int32(appKit, at: data2At), probeData2)
        return out.isEmpty ? nil : out.prefix(2).joined(separator: ", ") + (out.count > 2 ? " and \(out.count - 2) more" : "")
    }

    // The three public events, each read back by `read` (the window server's record behind a CGEvent): the check's input.
    static func publicRecords(read: (CGEvent) -> [UInt8]?) -> (appKit: [UInt8]?, down: [UInt8]?, up: [UInt8]?) {
        let appKit = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: probeWindow, context: nil,
                                        subtype: Int16(activated), data1: probeData1, data2: probeData2)?.cgEvent.flatMap(read)
        func mouse(_ type: NSEvent.EventType) -> [UInt8]? {
            NSEvent.mouseEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: probeWindow, context: nil, eventNumber: 0,
                               clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)?.cgEvent.flatMap(read)
        }
        return (appKit, mouse(.leftMouseDown), mouse(.leftMouseUp))
    }
}
