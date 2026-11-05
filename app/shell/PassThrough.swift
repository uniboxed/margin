// Clicks, scrolling and selection reach the page under an overlay (Spike 1,
// PLAN.md §6): a transparent window still takes the mouse wherever it is, so
// the overlay ignores the mouse while the pointer is over the theme's page
// slot, and takes it everywhere else. Where the pointer is comes from mouse
// monitors (a global one for when another app's window gets the events, a
// local one for the overlay's own), which need no Accessibility.
//
// Over the slot the theme can still draw things that take the pointer (the
// palette, a menu, a notice, the sidebar out over the page): the overlay's
// page reports their boxes (`hits`, extension/ui/host-app.js), and the
// overlay takes the mouse over them, as the in-page host's pass-through does
// (its root ignores the pointer, its children keep theirs). While a button
// is held, nothing changes: a drag that started on the page stays the
// page's, one that started on Margin stays Margin's.

import AppKit

// The page slot of one overlay, in the window server's coordinates (top left).
struct Slot: Equatable {
    var rect: CGRect
    var radius: CGFloat = 0
    // What the theme draws over the slot that takes the pointer.
    var hits: [CGRect] = []
    // The page asked for the whole window (more over the slot than it could list).
    var captureAll = false
}

enum PassThrough {
    // Whether the page gets the pointer at `point` (the overlay ignores the mouse there).
    static func pageGets(_ point: CGPoint, _ slot: Slot?) -> Bool {
        guard let slot, !slot.captureAll, slot.rect.contains(point) else { return false }
        if slot.hits.contains(where: { $0.contains(point) }) { return false }
        // Outside a rounded corner of the slot: the theme's.
        let r = min(slot.radius, slot.rect.width / 2, slot.rect.height / 2)
        if r > 0 {
            let cx = point.x < slot.rect.minX + r ? slot.rect.minX + r : (point.x > slot.rect.maxX - r ? slot.rect.maxX - r : nil)
            let cy = point.y < slot.rect.minY + r ? slot.rect.minY + r : (point.y > slot.rect.maxY - r ? slot.rect.maxY - r : nil)
            if let cx, let cy, hypot(point.x - cx, point.y - cy) > r { return false }
        }
        return true
    }

    // What the overlay should do now: `ignoring` is what it does; a held button keeps it.
    static func decide(_ point: CGPoint, _ slot: Slot?, buttonsDown: Bool, ignoring: Bool) -> Bool {
        buttonsDown ? ignoring : pageGets(point, slot)
    }

    // The slot from the page's layout report: the overlay's frame (top left) with the insets.
    static func slot(in frame: CGRect, layout: PageLayout, hits: [CGRect] = [], captureAll: Bool = false) -> Slot {
        let rect = CGRect(x: frame.minX + layout.left, y: frame.minY + layout.top,
                          width: max(0, frame.width - layout.left - layout.right), height: max(0, frame.height - layout.top - layout.bottom))
        return Slot(rect: rect, radius: layout.radius, hits: hits.map { $0.offsetBy(dx: frame.minX, dy: frame.minY) }, captureAll: captureAll)
    }
}

// The pointer, wherever it is (no Accessibility): every move and drag, and
// each press (a press in the browser re-orders the overlays above it).
final class PointerWatch {
    var onMove: ((CGPoint) -> Void)? // top-left coordinates
    var onPress: ((CGPoint) -> Void)?
    private var monitors: [Any] = []

    var isStarted: Bool { !monitors.isEmpty }

    func start() {
        guard monitors.isEmpty else { return }
        let moves: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseUp, .rightMouseUp]
        let presses: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        let handle: (NSEvent) -> Void = { [weak self] event in
            let at = ScreenGeometry.topLeftPoint(NSEvent.mouseLocation)
            if presses.contains(NSEvent.EventTypeMask(rawValue: 1 << event.type.rawValue)) { self?.onPress?(at) } else { self?.onMove?(at) }
        }
        if let global = NSEvent.addGlobalMonitorForEvents(matching: moves.union(presses), handler: { event in MainActor.assumeIsolated { handle(event) } }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: moves.union(presses), handler: { event in handle(event); return event }) {
            monitors.append(local)
        }
    }

    func stop() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
    }

    static var location: CGPoint { ScreenGeometry.topLeftPoint(NSEvent.mouseLocation) }
    static var buttonsDown: Bool { NSEvent.pressedMouseButtons != 0 }
}
