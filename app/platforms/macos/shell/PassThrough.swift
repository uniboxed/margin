// Clicks, scrolling and selection reach the page under an overlay (Spike 1,
// PLAN.md §6): a transparent window still takes the mouse wherever it is, so
// the overlay ignores the mouse while the pointer is over the theme's page
// slot, and takes it everywhere else. Where the pointer is comes from mouse
// monitors (a global one for when another app's window gets the events, a
// local one for the overlay's own), which need no Accessibility.
//
// Over the slot the theme can still draw things that take the pointer (the
// palette, a menu, a notice, the sidebar out over the page): the overlay's
// page reports their boxes (`hits`, extension/ui/host-app.ts), and the
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

// Where the overlay's own windows take the mouse whatever its `ignoresMouseEvents` says (seen 2026-11-06:
// a scroll over the sidebar scrolled the page behind it; sometimes nothing in the layout took a click): the
// window server passes the pointer through a window's fully transparent pixels, and the overlay's one
// window follows the pointer after the fact (the first event over Margin's UI, coming from over the page,
// still reached Safari). So the region that isn't the page's, known from the layout (everything but the
// slot, less its rounded corners, plus what the theme draws over it, `hits`; all of it with `captureAll`
// or no layout yet), is filled at alpha 0.01: under the overlay's web view (a transparent part of the theme
// still takes the mouse), and in a catcher just below the overlay that never ignores the mouse and hands
// what it gets to the overlay (Overlay.swift OverlayCatcher). Only the page slot lets the pointer through.
struct CatchRegion: Equatable {
    var all: Bool // the whole frame
    var hole: CGRect? // the slot, in the frame's coordinates (top left), cut out
    var radius: CGFloat = 0
    var hits: [CGRect] = [] // filled again over the hole

    // For an overlay at `frame` (top left) with this slot (window server coordinates).
    static func of(frame: CGRect, slot: Slot?) -> CatchRegion {
        guard let slot, !slot.captureAll else { return CatchRegion(all: true, hole: nil) }
        let hole = slot.rect.offsetBy(dx: -frame.minX, dy: -frame.minY).intersection(CGRect(origin: .zero, size: frame.size))
        guard !hole.isNull, hole.width > 0, hole.height > 0 else { return CatchRegion(all: true, hole: nil) }
        return CatchRegion(all: false, hole: hole, radius: min(slot.radius, hole.width / 2, hole.height / 2), hits: slot.hits.map { $0.offsetBy(dx: -frame.minX, dy: -frame.minY) })
    }

    // Whether a point (in the frame, top left) is filled: the same answer as !PassThrough.pageGets.
    func contains(_ p: CGPoint, in size: CGSize) -> Bool {
        guard CGRect(origin: .zero, size: size).contains(p) else { return false }
        guard !all, let hole else { return true }
        if hits.contains(where: { $0.contains(p) }) { return true }
        return !PassThrough.pageGets(p, Slot(rect: hole, radius: radius))
    }
}

// Which pointer positions an overlay's page wants handed in (app/shared/host/overlay.ts
// reportWant; only peek uses them): none while its sidebar is docked, those within
// `zone` points of its peek edges while the sidebar is hidden, every one while it's
// out over the page. Before 2026-11-05 every move over an overlay went in, at 30 a second.
struct PointerWant: Equatable {
    enum Mode: String { case none, edges, all }
    var mode: Mode
    var edges: Set<String> = []
    var zone: CGFloat = 24

    static let all = PointerWant(mode: .all)

    init(mode: Mode, edges: Set<String> = [], zone: CGFloat = 24) { (self.mode, self.edges, self.zone) = (mode, edges, zone) }

    init(_ body: JSONObject) {
        mode = Mode(rawValue: body["mode"] as? String ?? "") ?? .all
        edges = Set((body["edges"] as? [Any] ?? []).compactMap { $0 as? String })
        zone = CGFloat((body["zone"] as? NSNumber)?.doubleValue ?? 24)
    }

    // Whether a position (in the overlay, top left) is wanted.
    func wants(_ p: CGPoint, in size: CGSize) -> Bool {
        switch mode {
        case .none: return false
        case .all: return true
        case .edges:
            return (edges.contains("left") && p.x <= zone) || (edges.contains("right") && p.x >= size.width - zone)
                || (edges.contains("top") && p.y <= zone) || (edges.contains("bottom") && p.y >= size.height - zone)
        }
    }
}

// What keeps the browser's own edge reveal from the pointer (seen 2026-11-05: in full-screen
// Safari the pointer at the left edge also opened Safari's sidebar behind Margin's). The overlay
// is one window whose `ignoresMouseEvents` follows the pointer after the fact, so the first moves
// at the edge, coming from over the page, still reached Safari. A thin panel at the window's left
// edge that never ignores the mouse takes them first. Always while its overlay is shown, docked
// sidebar or not: a quick move from over the page can reach the edge in one step, before the
// overlay takes the mouse back. Not while the overlay takes the whole window anyway (`captureAll`).
enum EdgeGuard {
    static let width: CGFloat = 4

    // Its frame (top left) for an overlay at `frame` with this slot, or nil when none is needed.
    static func frame(for frame: CGRect, slot: Slot?, width: CGFloat = width) -> CGRect? {
        guard width > 0, slot?.captureAll != true else { return nil }
        return CGRect(x: frame.minX, y: frame.minY, width: width, height: frame.height)
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
