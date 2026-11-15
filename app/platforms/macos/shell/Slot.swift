// The slot: a browser's full-screen window sized by macOS itself to the page's
// place in Margin's layout, in place of the page box (the extension sizing the
// page inside a full-size window). docs/PRIVATE-APIS.md rows 21-22.
//
// - Every full-screen Space lays its window out in a tile and can reserve room
//   at its edges. With the layout's insets reserved, the window manager lays
//   the tile out again and the browser sizes its own window to what's left:
//   the page is the whole window, with nothing added to it.
// - The keeper holds one slot per browser window (by its window number): the
//   Space, the window's full frame (its bounds with nothing reserved), the
//   edges reserved, and whether the window has landed in them.
// - Every reservation is verified: the window's own bounds must become the
//   full frame less the edges within `landWithin`. One that doesn't land is
//   sent once more, then given back (zeros) and that window keeps the page box
//   for the session. Two windows failing in a row turn the slot off for the
//   session. Nothing is ever taken on trust.
// - The rest of the shell works on windows that fill their display (overlay
//   frames, the planner, the handoff's readiness, the covers). `model` gives a
//   slotted window's bounds as they would be with nothing reserved, so that
//   code reads a slotted window as the full-size window it stands for. With no
//   slot set it changes nothing.
// - A reservation outlives the process that set it. So: zeros at a clean quit
//   (`releaseAll`), a marker file (slots.json: Space numbers and a pid only)
//   for a crash, read at the next launch (`recover`), and a Space found with a
//   reservation nobody remembers is given back before it's used.
// - It logs numbers only: window numbers, Space numbers, points, milliseconds.

import AppKit

nonisolated struct SlotEdges: Equatable, Sendable {
    var left = 0.0, right = 0.0, top = 0.0, bottom = 0.0
    static let zero = SlotEdges()

    var isZero: Bool { left == 0 && right == 0 && top == 0 && bottom == 0 }
    // Whole points: a fractional reservation makes AppKit leave full screen.
    var whole: SlotEdges { SlotEdges(left: left.rounded(), right: right.rounded(), top: top.rounded(), bottom: bottom.rounded()) }
    var usable: Bool { [left, right, top, bottom].allSatisfy { $0.isFinite && $0 >= 0 } }
    // The frame less these edges (top-left coordinates).
    func inset(_ frame: CGRect) -> CGRect {
        CGRect(x: frame.minX + left, y: frame.minY + top, width: frame.width - left - right, height: frame.height - top - bottom)
    }
    // The frame these edges were taken from.
    func outset(_ frame: CGRect) -> CGRect {
        CGRect(x: frame.minX - left, y: frame.minY - top, width: frame.width + left + right, height: frame.height + top + bottom)
    }
    var text: String { "\(Int(left))/\(Int(top))/\(Int(right))/\(Int(bottom))" } // left/top/right/bottom
}

// The Space side: the system's (SkyLightSlots), or a test's.
protocol SlotSpaces: AnyObject {
    // True: sent. Whether it landed is the keeper's to verify.
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool
    // What the Space reserves now; nil: unknown, or not a Space that lays a window out (a Desktop).
    func reserved(space: UInt64) -> SlotEdges?
}

final class SkyLightSlots: SlotSpaces {
    private let sky: SkyLight
    init(sky: SkyLight) { self.sky = sky }
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool {
        sky.reserveEdges(of: space, left: edges.left, right: edges.right, top: edges.top, bottom: edges.bottom)
    }
    func reserved(space: UInt64) -> SlotEdges? {
        sky.reservedEdges(of: space).map { SlotEdges(left: $0.left, right: $0.right, top: $0.top, bottom: $0.bottom) }
    }
}

// The crash marker: which Spaces hold a reservation of this Margin's.
nonisolated struct SlotMarker: Codable, Equatable, Sendable {
    static let fileName = "slots.json"
    var pid: Int32
    var spaces: [UInt64]

    static func read(_ url: URL) -> SlotMarker? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SlotMarker.self, from: data)
    }
}

final class SlotKeeper {
    struct Options {
        var landWithin = 1.5 // seconds for the window to reach its slot (apps animate the resize)
        var sends = 2 // the first, and one more
        var offAfter = 2 // windows failing in a row before the slot is off for the session
        var minPage = CGSize(width: 320, height: 240) // a layout leaving less than this isn't given to the window manager
        var tolerance: CGFloat = 1
        var goneAfter = 8 // reads without the window before its slot is forgotten
    }

    struct Slot: Equatable {
        let number: Int
        let space: UInt64
        let full: CGRect // the window's bounds with nothing reserved
        var edges: SlotEdges
        var sentAt: Double
        var sends: Int
        var landedAt: Double?
        var rect: CGRect { edges.inset(full) }
    }

    // What a layout gets: the slot (the extension is sent no insets), or the page box, and why.
    enum Answer: Equatable {
        case slot
        case box(String)
    }

    enum Event: Equatable {
        case landed(Int, ms: Int)
        case failed(Int, String)
        case off(String)
    }

    var options = Options()
    private let spaces: SlotSpaces
    private let markerURL: URL?
    private let pid: Int32
    private(set) var slots: [Int: Slot] = [:]
    private(set) var boxed: [Int: String] = [:] // windows that keep the page box for the session, and why
    private(set) var offWhy: String? // the slot off for the session
    private var failuresInARow = 0
    private var missing: [Int: Int] = [:]
    private var strayAt: [Int: Double] = [:] // a landed window first read at another size

    init(spaces: SlotSpaces, marker: URL?, pid: Int32 = ProcessInfo.processInfo.processIdentifier) {
        self.spaces = spaces
        markerURL = marker
        self.pid = pid
    }

    var isOff: Bool { offWhy != nil }

    private func sameSize(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.width - b.width) <= options.tolerance && abs(a.height - b.height) <= options.tolerance
    }

    // A layout for a window: `bounds` are its bounds as the shell reads them (its full frame: the
    // model's, or the real ones when nothing is reserved), `space` its full-screen Space.
    func want(number: Int, space: UInt64, bounds: CGRect, edges asked: SlotEdges, now: Double) -> Answer {
        if let offWhy { return .box(offWhy) }
        if let why = boxed[number] { return .box(why) }
        let edges = asked.whole
        guard edges.usable else { return .box("its insets aren't usable") }
        if edges.isZero {
            release(number, why: "its layout takes no room")
            return .box("its layout takes no room")
        }
        if var slot = slots[number], slot.space == space {
            if slot.edges == edges { return .slot }
            let page = edges.inset(slot.full)
            guard page.width >= options.minPage.width, page.height >= options.minPage.height else {
                release(number, why: "the page would be too small")
                return .box("the page would be too small")
            }
            guard spaces.reserve(edges, space: space) else { return fail(number, "the reservation wasn't sent", now: now).answer }
            Diagnostics.note("slot: window \(number) in Space \(space): \(slot.edges.text) → \(edges.text)")
            slot.edges = edges
            slot.sentAt = now
            slot.sends = 1
            slot.landedAt = nil
            slots[number] = slot
            strayAt[number] = nil
            return .slot
        }
        if slots[number] != nil { release(number, why: "its window is in another Space") }
        // Its Space as it is now: one that already reserves room (a Margin that crashed, or another
        // tool) is given back first. The window's full frame isn't known until it has grown back.
        guard let current = spaces.reserved(space: space) else { return .box("its Space's reservation didn't read") }
        guard current.isZero else {
            _ = spaces.reserve(.zero, space: space)
            Diagnostics.note("slot: Space \(space) already reserved \(current.text): given back before it's used")
            return .box("its Space had a reservation already")
        }
        let page = edges.inset(bounds)
        guard page.width >= options.minPage.width, page.height >= options.minPage.height else { return .box("the page would be too small") }
        guard spaces.reserve(edges, space: space) else { return .box("the reservation wasn't sent") }
        slots[number] = Slot(number: number, space: space, full: bounds, edges: edges, sentAt: now, sends: 1, landedAt: nil)
        missing[number] = nil
        strayAt[number] = nil
        saveMarker()
        Diagnostics.note("slot: window \(number) in Space \(space): \(edges.text) reserved of \(Int(bounds.width))×\(Int(bounds.height))")
        return .slot
    }

    // Each read of the window server, with the windows' real bounds: every slot checked.
    @discardableResult
    func read(_ raw: [ServerWindow], now: Double) -> [Event] {
        var events: [Event] = []
        let byNumber = Dictionary(raw.map { ($0.number, $0) }, uniquingKeysWith: { a, _ in a })
        for number in slots.keys.sorted() {
            guard var slot = slots[number] else { continue }
            guard let window = byNumber[number] else {
                missing[number, default: 0] += 1
                if missing[number, default: 0] >= options.goneAfter { gone(number) }
                continue
            }
            missing[number] = nil
            if sameSize(window.bounds, slot.rect) {
                strayAt[number] = nil
                if slot.landedAt == nil {
                    slot.landedAt = now
                    slots[number] = slot
                    failuresInARow = 0
                    let ms = Int(((now - slot.sentAt) * 1000).rounded())
                    Diagnostics.note("slot: window \(number) landed in \(ms) ms (\(Int(slot.rect.width))×\(Int(slot.rect.height)))")
                    events.append(.landed(number, ms: ms))
                }
                continue
            }
            if slot.landedAt == nil {
                guard now - slot.sentAt > options.landWithin else { continue }
                if slot.sends < options.sends, spaces.reserve(slot.edges, space: slot.space) {
                    slot.sends += 1
                    slot.sentAt = now
                    slots[number] = slot
                    Diagnostics.note("slot: window \(number) not in its slot after \(Int(options.landWithin * 1000)) ms (\(Int(window.bounds.width))×\(Int(window.bounds.height)) for \(Int(slot.rect.width))×\(Int(slot.rect.height))): sent once more")
                    continue
                }
                events.append(contentsOf: fail(number, "its window didn't take the slot (\(Int(window.bounds.width))×\(Int(window.bounds.height)) for \(Int(slot.rect.width))×\(Int(slot.rect.height)))", now: now).events)
                continue
            }
            // Landed, and now another size: left full screen, or the app won't stay that small. Given a moment
            // (a resize under way reads like this too), then given back.
            if let since = strayAt[number] {
                if now - since > options.landWithin {
                    events.append(contentsOf: fail(number, "its window left the slot (\(Int(window.bounds.width))×\(Int(window.bounds.height)) for \(Int(slot.rect.width))×\(Int(slot.rect.height)))", now: now).events)
                }
            } else {
                strayAt[number] = now
            }
        }
        return events
    }

    // The window list as the rest of the shell reads it: a slotted window at the bounds it would have with
    // nothing reserved. Landed and at its slot's size, its real place is kept (a window sliding with its Space
    // slides in the model too); while it's still resizing, its full frame (steady, so the layout isn't
    // measured against a window in motion).
    func model(_ list: [ServerWindow]) -> [ServerWindow] {
        guard !slots.isEmpty else { return list }
        return list.map { w in
            guard let slot = slots[w.number] else { return w }
            let bounds = slot.landedAt != nil && sameSize(w.bounds, slot.rect) ? slot.edges.outset(w.bounds) : slot.full
            return ServerWindow(number: w.number, pid: w.pid, layer: w.layer, bounds: bounds, onScreen: w.onScreen, alpha: w.alpha, order: w.order)
        }
    }

    // One window's bounds as the extension or another read gave them (real ones), in the model.
    func model(_ bounds: CGRect, of number: Int) -> CGRect {
        guard let slot = slots[number] else { return bounds }
        return slot.landedAt != nil && sameSize(bounds, slot.rect) ? slot.edges.outset(bounds) : slot.full
    }

    func slot(of number: Int) -> Slot? { slots[number] }
    func serves(_ number: Int) -> Bool { slots[number] != nil }

    // Given back: its window leaves full screen, its page takes the screen, its link is gone.
    func release(_ number: Int, why: String) {
        guard let slot = slots.removeValue(forKey: number) else { return }
        missing[number] = nil
        strayAt[number] = nil
        _ = spaces.reserve(.zero, space: slot.space)
        saveMarker()
        Diagnostics.note("slot: window \(number) in Space \(slot.space) given back (\(why))")
    }

    // Quit, or the slot turned off: every reservation given back, the marker removed.
    func releaseAll(why: String) {
        for number in slots.keys.sorted() { release(number, why: why) }
        removeMarker()
    }

    // Its window is gone (and its Space with it): nothing to give back.
    func gone(_ number: Int) {
        let had = slots.removeValue(forKey: number) != nil
        missing[number] = nil
        strayAt[number] = nil
        boxed[number] = nil
        if had { saveMarker() }
    }

    private func fail(_ number: Int, _ why: String, now: Double) -> (answer: Answer, events: [Event]) {
        var events: [Event] = [.failed(number, why)]
        if let slot = slots.removeValue(forKey: number) { _ = spaces.reserve(.zero, space: slot.space) }
        strayAt[number] = nil
        boxed[number] = why
        failuresInARow += 1
        Diagnostics.warn("slot: window \(number): \(why): given back, the page box for this window")
        if failuresInARow >= options.offAfter {
            let off = "the slot is off for this run (\(failuresInARow) windows in a row didn't take it)"
            offWhy = off
            Diagnostics.warn("slot: \(off)")
            releaseAll(why: "the slot is off")
            events.append(.off(off))
        } else {
            saveMarker()
        }
        return (.box(why), events)
    }

    // ---- the crash marker ----

    private func saveMarker() {
        guard let markerURL else { return }
        let held = Set(slots.values.map(\.space)).sorted()
        guard !held.isEmpty else { return removeMarker() }
        do {
            try FileManager.default.createDirectory(at: markerURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(SlotMarker(pid: pid, spaces: held)).write(to: markerURL, options: .atomic)
        } catch {
            Diagnostics.warn("slot: the crash marker wasn't written (\((error as NSError).code))")
        }
    }

    private func removeMarker() {
        guard let markerURL else { return }
        try? FileManager.default.removeItem(at: markerURL)
    }

    // At launch: the Spaces a Margin that didn't quit cleanly left reserved, given back (those that are still
    // full-screen Spaces; the rest went with their windows). One whose Margin is still running isn't a crash's.
    // Returns how many were given back.
    @discardableResult
    func recover(fullScreen: Set<UInt64>?, running: (pid_t) -> Bool) -> Int {
        guard let markerURL, let marker = SlotMarker.read(markerURL) else { return 0 }
        guard marker.pid == pid || !running(marker.pid) else { return 0 }
        try? FileManager.default.removeItem(at: markerURL)
        var given = 0
        for space in marker.spaces where fullScreen?.contains(space) ?? true {
            guard let now = spaces.reserved(space: space), !now.isZero else { continue }
            if spaces.reserve(.zero, space: space) { given += 1 }
        }
        Diagnostics.note("slot: a marker from a Margin that didn't quit cleanly: \(marker.spaces.count) Space\(marker.spaces.count == 1 ? "" : "s"), \(given) given back")
        return given
    }
}
