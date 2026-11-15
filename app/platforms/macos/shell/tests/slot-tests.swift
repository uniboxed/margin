// The slot keeper (Slot.swift), part of tests.swift's run, against a stand-in
// for the Spaces (no private call is made): a reservation set and verified
// from the window's own bounds, sent once more and then given back when the
// window doesn't take it, the page box for that window and the slot off after
// two in a row, the model's bounds for the rest of the shell, a Space found
// reserved given back first, and the crash marker in a temporary folder.
import AppKit
import Foundation

final class FakeSlotSpaces: SlotSpaces {
    var reservedNow: [UInt64: SlotEdges] = [:] // a full-screen Space is one with an entry
    var refuse = false
    private(set) var calls: [String] = [] // "reserve 7 248/8/8/8"
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool {
        guard !refuse else { return false }
        calls.append("reserve \(space) \(edges.text)")
        if reservedNow[space] != nil { reservedNow[space] = edges }
        return true
    }
    func reserved(space: UInt64) -> SlotEdges? { reservedNow[space] }
    func clear() { calls = [] }
}

func slotTests() {
    let full = CGRect(x: 0, y: 33, width: 1512, height: 949)
    let edges = SlotEdges(left: 248, right: 8, top: 8, bottom: 8)
    let rect = CGRect(x: 248, y: 41, width: 1256, height: 933)
    func window(_ number: Int, _ bounds: CGRect, onScreen: Bool = true) -> ServerWindow {
        ServerWindow(number: number, pid: 77, layer: 0, bounds: bounds, onScreen: onScreen, alpha: 1, order: 0)
    }
    func quiet<T>(_ body: () -> T) -> T { let echo = Diagnostics.echo; Diagnostics.echo = { _ in }; defer { Diagnostics.echo = echo }; return body() }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-slot-tests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: folder) }
    let markerURL = folder.appendingPathComponent(SlotMarker.fileName)

    // ---- the edges ----
    check("slot edges: a frame less its edges, and back", edges.inset(full) == rect && edges.outset(rect) == full)
    check("slot edges: whole points", SlotEdges(left: 247.6, right: 8.4, top: 7.5, bottom: 0.2).whole == SlotEdges(left: 248, right: 8, top: 8, bottom: 0))
    check("slot edges: negative or not a number isn't usable", !SlotEdges(left: -1).usable && !SlotEdges(top: .nan).usable && !SlotEdges(right: .infinity).usable && edges.usable && SlotEdges.zero.isZero)

    quiet {
        // ---- a slot set, verified, kept ----
        let spaces = FakeSlotSpaces()
        spaces.reservedNow = [7: .zero, 9: .zero]
        let keeper = SlotKeeper(spaces: spaces, marker: markerURL, pid: 500)
        check("slot: a layout for a full-screen window: its Space read, the edges reserved, the slot answered",
              keeper.want(number: 12, space: 7, bounds: full, edges: edges, now: 10) == .slot && spaces.calls == ["reserve 7 248/8/8/8"], "\(spaces.calls)")
        check("slot: the crash marker names the Space and this Margin", SlotMarker.read(markerURL) == SlotMarker(pid: 500, spaces: [7]))
        check("slot: kept with its full frame, not landed yet", keeper.slot(of: 12)?.full == full && keeper.slot(of: 12)?.rect == rect && keeper.slot(of: 12)?.landedAt == nil)
        check("slot: still resizing: the model gives its full frame, other windows as they are",
              keeper.model([window(12, CGRect(x: 100, y: 37, width: 1400, height: 940)), window(13, rect)]).map(\.bounds) == [full, rect])
        check("slot: not landed, within its time: nothing said", keeper.read([window(12, full)], now: 10.4).isEmpty)
        check("slot: the window at its slot's size: landed, with the time it took", keeper.read([window(12, rect)], now: 10.6) == [.landed(12, ms: 600)] && keeper.slot(of: 12)?.landedAt == 10.6)
        check("slot: landed: said once", keeper.read([window(12, rect)], now: 10.8).isEmpty)
        check("slot: landed: the model gives the bounds it would have with nothing reserved", keeper.model([window(12, rect)]).first?.bounds == full && keeper.model(rect, of: 12) == full)
        check("slot: a landed window sliding with its Space slides in the model too", keeper.model([window(12, rect.offsetBy(dx: 900, dy: 0))]).first?.bounds == full.offsetBy(dx: 900, dy: 0))
        check("slot: a window with no slot: its bounds as given", keeper.model(rect, of: 99) == rect && !keeper.serves(99) && keeper.serves(12))
        spaces.clear()
        check("slot: the same layout again: the slot, nothing sent", keeper.want(number: 12, space: 7, bounds: full, edges: edges, now: 11) == .slot && spaces.calls.isEmpty)
        check("slot: fractions that round to the same edges: nothing sent", keeper.want(number: 12, space: 7, bounds: full, edges: SlotEdges(left: 248.3, right: 7.8, top: 8, bottom: 8.4), now: 11) == .slot && spaces.calls.isEmpty)
        let hidden = SlotEdges(left: 8, right: 8, top: 8, bottom: 8)
        check("slot: another layout (the sidebar hidden): reserved again from the same full frame, to be verified again",
              keeper.want(number: 12, space: 7, bounds: full, edges: hidden, now: 12) == .slot && spaces.calls == ["reserve 7 8/8/8/8"] && keeper.slot(of: 12)?.landedAt == nil && keeper.slot(of: 12)?.full == full, "\(spaces.calls)")
        check("slot: the change under way: the model's full frame", keeper.model([window(12, CGRect(x: 120, y: 41, width: 1384, height: 933))]).first?.bounds == full)
        check("slot: landed in the new edges", keeper.read([window(12, hidden.inset(full))], now: 12.2) == [.landed(12, ms: 200)])

        // ---- a layout that takes no room, a window in another Space, given back ----
        spaces.clear()
        check("slot: a layout with no insets: given back, the box's answer (there's nothing to box)",
              keeper.want(number: 12, space: 7, bounds: full, edges: .zero, now: 13) == .box("its layout takes no room") && spaces.calls == ["reserve 7 0/0/0/0"] && !keeper.serves(12), "\(spaces.calls)")
        check("slot: nothing held: the marker is gone", !FileManager.default.fileExists(atPath: markerURL.path))
        _ = keeper.want(number: 12, space: 7, bounds: full, edges: edges, now: 14)
        spaces.clear()
        check("slot: its window now in another Space: the old one given back, the new one reserved",
              keeper.want(number: 12, space: 9, bounds: full, edges: edges, now: 15) == .slot && spaces.calls == ["reserve 7 0/0/0/0", "reserve 9 248/8/8/8"] && keeper.slot(of: 12)?.space == 9, "\(spaces.calls)")
        spaces.clear()
        keeper.release(12, why: "a test")
        check("slot: released: zeros sent, forgotten", spaces.calls == ["reserve 9 0/0/0/0"] && !keeper.serves(12) && keeper.model([window(12, rect)]).first?.bounds == rect)
        keeper.release(12, why: "again")
        check("slot: released twice: nothing more sent", spaces.calls.count == 1)

        // ---- what isn't given to the window manager ----
        spaces.clear()
        check("slot: a Desktop (no layout to read): the page box, nothing sent", keeper.want(number: 20, space: 1, bounds: full, edges: edges, now: 16) == .box("its Space's reservation didn't read") && spaces.calls.isEmpty)
        check("slot: a layout leaving too small a page: the page box, nothing sent",
              keeper.want(number: 20, space: 7, bounds: full, edges: SlotEdges(left: 1300, right: 8, top: 8, bottom: 8), now: 16) == .box("the page would be too small") && spaces.calls.isEmpty)
        check("slot: insets that aren't numbers: the page box, nothing sent", keeper.want(number: 20, space: 7, bounds: full, edges: SlotEdges(left: .nan), now: 16) == .box("its insets aren't usable") && spaces.calls.isEmpty)
        spaces.refuse = true
        check("slot: a reservation that can't be sent: the page box this time", keeper.want(number: 20, space: 7, bounds: full, edges: edges, now: 16) == .box("the reservation wasn't sent") && !keeper.serves(20))
        spaces.refuse = false
        spaces.reservedNow[7] = SlotEdges(left: 300, right: 0, top: 0, bottom: 0)
        check("slot: a Space found reserved already: given back first, the page box meanwhile",
              keeper.want(number: 20, space: 7, bounds: rect, edges: edges, now: 17) == .box("its Space had a reservation already") && spaces.calls == ["reserve 7 0/0/0/0"] && !keeper.serves(20), "\(spaces.calls)")
        check("slot: and used once it reads as free", keeper.want(number: 20, space: 7, bounds: full, edges: edges, now: 18) == .slot && keeper.slot(of: 20)?.full == full)
        keeper.releaseAll(why: "a test")
    }

    quiet {
        // ---- a window that doesn't take its slot ----
        let spaces = FakeSlotSpaces()
        spaces.reservedNow = [7: .zero, 8: .zero, 9: .zero]
        let keeper = SlotKeeper(spaces: spaces, marker: markerURL, pid: 500)
        let stuck = CGRect(x: 0, y: 33, width: 1512, height: 949)
        _ = keeper.want(number: 12, space: 7, bounds: full, edges: edges, now: 0)
        spaces.clear()
        check("slot: not landed past its time: sent once more", keeper.read([window(12, stuck)], now: 1.6).isEmpty && spaces.calls == ["reserve 7 248/8/8/8"] && keeper.slot(of: 12)?.sends == 2, "\(spaces.calls)")
        spaces.clear()
        let failed = keeper.read([window(12, stuck)], now: 3.3)
        check("slot: still not landed: given back, the page box for that window from then on",
              failed == [.failed(12, "its window didn't take the slot (1512×949 for 1256×933)")] && spaces.calls == ["reserve 7 0/0/0/0"] && !keeper.serves(12) && !keeper.isOff, "\(failed) \(spaces.calls)")
        spaces.clear()
        check("slot: that window asked again: the page box, nothing sent", keeper.want(number: 12, space: 7, bounds: full, edges: edges, now: 4) == .box("its window didn't take the slot (1512×949 for 1256×933)") && spaces.calls.isEmpty)
        check("slot: a failed window's bounds are its own again in the model", keeper.model([window(12, stuck)]).first?.bounds == stuck)

        // One that lands in between: the count of failures in a row starts again.
        _ = keeper.want(number: 13, space: 8, bounds: full, edges: edges, now: 5)
        _ = keeper.read([window(13, rect)], now: 5.1)
        _ = keeper.want(number: 14, space: 9, bounds: full, edges: edges, now: 6)
        _ = keeper.read([window(13, rect), window(14, stuck)], now: 7.7)
        let second = keeper.read([window(13, rect), window(14, stuck)], now: 9.4)
        check("slot: a failure after a landing: that window boxed, the slot still on", second.count == 1 && !keeper.isOff && keeper.serves(13) && !keeper.serves(14), "\(second)")
        // Two in a row: off for the session, everything given back.
        keeper.gone(14)
        _ = keeper.want(number: 14, space: 9, bounds: full, edges: edges, now: 10)
        _ = keeper.read([window(13, rect), window(14, stuck)], now: 11.7)
        spaces.clear()
        let off = keeper.read([window(13, rect), window(14, stuck)], now: 13.4)
        check("slot: two windows failing in a row: the slot off for the run, every reservation given back, the marker gone",
              off.count == 2 && off.last == .off("the slot is off for this run (2 windows in a row didn't take it)") && keeper.isOff && !keeper.serves(13)
              && spaces.calls == ["reserve 9 0/0/0/0", "reserve 8 0/0/0/0"] && !FileManager.default.fileExists(atPath: markerURL.path), "\(off) \(spaces.calls)")
        spaces.clear()
        check("slot: off: every layout gets the page box, nothing sent", keeper.want(number: 30, space: 7, bounds: full, edges: edges, now: 14) == .box("the slot is off for this run (2 windows in a row didn't take it)") && spaces.calls.isEmpty)
    }

    quiet {
        // ---- a landed window that leaves its slot, and one that's gone ----
        let spaces = FakeSlotSpaces()
        spaces.reservedNow = [7: .zero, 8: .zero]
        let keeper = SlotKeeper(spaces: spaces, marker: markerURL, pid: 500)
        _ = keeper.want(number: 12, space: 7, bounds: full, edges: edges, now: 0)
        _ = keeper.read([window(12, rect)], now: 0.1)
        let other = CGRect(x: 200, y: 120, width: 900, height: 700)
        check("slot: landed, then read at another size: given a moment", keeper.read([window(12, other)], now: 1).isEmpty && keeper.serves(12))
        check("slot: back at its size within that moment: kept", keeper.read([window(12, rect)], now: 1.5).isEmpty && keeper.read([window(12, other)], now: 2).isEmpty && keeper.read([window(12, other)], now: 3).isEmpty && keeper.serves(12))
        spaces.clear()
        let left = keeper.read([window(12, other)], now: 3.6)
        check("slot: at another size past that moment (it left full screen, or won't stay that small): given back, the page box",
              left == [.failed(12, "its window left the slot (900×700 for 1256×933)")] && spaces.calls == ["reserve 7 0/0/0/0"], "\(left) \(spaces.calls)")

        _ = keeper.want(number: 15, space: 8, bounds: full, edges: edges, now: 4)
        _ = keeper.read([window(15, rect)], now: 4.1)
        spaces.clear()
        for i in 0..<7 { _ = keeper.read([], now: 5 + Double(i)) }
        check("slot: its window missing from a few reads: kept", keeper.serves(15))
        _ = keeper.read([], now: 12)
        check("slot: missing from eight reads: forgotten, nothing sent (its Space went with it), the marker gone",
              !keeper.serves(15) && spaces.calls.isEmpty && !FileManager.default.fileExists(atPath: markerURL.path), "\(spaces.calls)")
        spaces.reservedNow[8] = .zero // (a new window's new Space, in truth: the old one went with its window)
        _ = keeper.want(number: 16, space: 8, bounds: full, edges: edges, now: 13)
        spaces.clear()
        keeper.releaseAll(why: "quit")
        check("slot: quit: every reservation given back, the marker removed", spaces.calls == ["reserve 8 0/0/0/0"] && !FileManager.default.fileExists(atPath: markerURL.path))
    }

    quiet {
        // ---- the marker a crashed Margin left ----
        let spaces = FakeSlotSpaces()
        spaces.reservedNow = [7: edges, 8: .zero, 9: edges]
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        func leave(_ marker: SlotMarker) { try? JSONEncoder().encode(marker).write(to: markerURL) }
        leave(SlotMarker(pid: 400, spaces: [7, 8, 9, 11]))
        let keeper = SlotKeeper(spaces: spaces, marker: markerURL, pid: 500)
        check("slot: a marker whose Margin is still running isn't a crash's: left alone", keeper.recover(fullScreen: [7, 8, 9], running: { $0 == 400 }) == 0 && spaces.calls.isEmpty && FileManager.default.fileExists(atPath: markerURL.path))
        check("slot: a crashed Margin's marker: its Spaces still reserved given back, the file taken",
              keeper.recover(fullScreen: [7, 8], running: { _ in false }) == 1 && spaces.calls == ["reserve 7 0/0/0/0"] && !FileManager.default.fileExists(atPath: markerURL.path), "\(spaces.calls)")
        spaces.clear()
        leave(SlotMarker(pid: 400, spaces: [9]))
        check("slot: the Space reads unknown: the marker's Spaces tried anyway", keeper.recover(fullScreen: nil, running: { _ in false }) == 1 && spaces.calls == ["reserve 9 0/0/0/0"], "\(spaces.calls)")
        check("slot: no marker: nothing", keeper.recover(fullScreen: [7], running: { _ in false }) == 0)
        let none = SlotKeeper(spaces: spaces, marker: nil)
        check("slot: a keeper with no marker file keeps none", none.want(number: 1, space: 8, bounds: full, edges: edges, now: 0) == .slot && none.recover(fullScreen: nil, running: { _ in false }) == 0)
    }

    quiet {
        // ---- the full-screen toolbar, a window of the browser's own (a real Safari's list, 2026-11-15) ----
        // The windows in front of a slotted Safari window as the window server gave them when a profile switch's
        // cover never saw Margin's layout stacked: Margin's cover, the Dock's, the menu bar's, Margin's catchers and
        // overlay, and last Safari's hidden toolbar, 8 pt lower than with nothing reserved.
        let spaces = FakeSlotSpaces()
        spaces.reservedNow = [6301: .zero]
        let keeper = SlotKeeper(spaces: spaces, marker: nil)
        let safari: pid_t = 53329, margin: pid_t = 53063
        func w(_ number: Int, _ pid: pid_t, _ layer: Int, _ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat, order: Int) -> ServerWindow {
            ServerWindow(number: number, pid: pid, layer: layer, bounds: CGRect(x: x, y: y, width: width, height: height), onScreen: true, alpha: 1, order: order)
        }
        let browser = w(40428, safari, 0, 250, 41, 1254, 933, order: 10)
        let above = [
            w(40462, margin, 0, 0, 0, 1512, 982, order: 0), w(24008, 925, 2147483628, 1511, 981, 1, 1, order: 1),
            w(24006, 925, 2147483628, 0, 0, 1512, 491, order: 2), w(24005, 925, 2147483628, 0, 491, 1512, 491, order: 3),
            w(40461, 637, 25, 0, 0, 1512, 33, order: 4), w(40435, 417, 24, 0, 0, 1512, 33, order: 5),
            w(40448, margin, 0, 0, 33, 4, 949, order: 6), w(40445, margin, 0, 0, 33, 1512, 949, order: 7),
            w(40447, margin, 0, 0, 33, 1512, 949, order: 8), w(40432, safari, 0, 250, -11, 1254, 52, order: 9),
        ]
        func stacked(_ rows: [ServerWindow]) -> Bool {
            WindowMatcher.stackedAboveExactly(aboveBrowser: rows, aboveToolbar: nil, overlay: 40445, browser: full, browserPid: safari, own: [40447, 40462])
        }
        check("slot: (the failure) the toolbar at its real bounds reads as a window between the layout and the page's model frame", !stacked(above))
        _ = keeper.want(number: 40428, space: 6301, bounds: full, edges: SlotEdges(left: 250, right: 8, top: 8, bottom: 8), now: 0)
        check("slot: a toolbar isn't moved before its window has landed", keeper.model(above) == above)
        _ = keeper.read([browser], now: 0.1)
        let modelled = keeper.model(above)
        check("slot: its toolbar is put where it would be with nothing reserved (the window's full width, the top's reservation higher)",
              modelled.last?.bounds == CGRect(x: 0, y: -19, width: 1512, height: 52), "\(String(describing: modelled.last?.bounds))")
        check("slot: nothing else in the list is touched", Array(modelled.dropLast()) == Array(above.dropLast()))
        check("slot: the list in front of the window, which doesn't have the window itself: the layout reads as stacked", stacked(modelled))
        let whole = keeper.model(above + [browser])
        check("slot: the shell finds the toolbar by its place again", WindowMatcher.fullScreenToolbar(whole, browser: whole.last!)?.number == 40432)
        check("slot: hidden, it isn't an ordering anchor (it doesn't draw over the page)", WindowMatcher.orderingToolbar(whole, browser: whole.last!) == nil)
        let slidDown = above.dropLast() + [w(40432, safari, 0, 250, 41, 1254, 52, order: 9), browser]
        let shown = keeper.model(Array(slidDown))
        check("slot: slid down over the page, it's the anchor, at the model's top", WindowMatcher.orderingToolbar(shown, browser: shown.last!)?.bounds == CGRect(x: 0, y: 33, width: 1512, height: 52))
        check("slot: another process's window of the same shape isn't a toolbar", keeper.model([w(7, 999, 0, 250, -11, 1254, 52, order: 0)]).first?.bounds.minX == 250)
        check("slot: the browser's own popover (not layer 0) stays where it is", keeper.model([w(8, safari, 3, 250, -11, 1254, 52, order: 0)]).first?.bounds.minX == 250)
        check("slot: a short window that doesn't have the slot's left edge and width stays where it is",
              keeper.model([w(9, safari, 0, 250, -11, 1512, 52, order: 0)]).first?.bounds == CGRect(x: 250, y: -11, width: 1512, height: 52))
        check("slot: the window sliding with its Space: its toolbar slides with it in the model",
              keeper.model([w(40432, safari, 0, 1150, -11, 1254, 52, order: 0), w(40428, safari, 0, 1150, 41, 1254, 933, order: 1)]).first?.bounds == CGRect(x: 900, y: -19, width: 1512, height: 52))
        _ = keeper.want(number: 40428, space: 6301, bounds: full, edges: SlotEdges(left: 8, right: 8, top: 8, bottom: 8), now: 1)
        _ = keeper.read([w(40428, safari, 0, 8, 41, 1496, 933, order: 1)], now: 1.1)
        check("slot: the sidebar hidden: the toolbar follows the new slot", keeper.model([w(40432, safari, 0, 8, -11, 1496, 52, order: 0)]).first?.bounds == CGRect(x: 0, y: -19, width: 1512, height: 52))
        keeper.release(40428, why: "test")
        check("slot: given back: the toolbar's bounds are its own again", keeper.model([w(40432, safari, 0, 0, -19, 1512, 52, order: 0)]).first?.bounds == CGRect(x: 0, y: -19, width: 1512, height: 52))
    }
}
