// Clicks, scrolling and selection reach what's under Margin's window in its page area (MarginWindowController.swift:
// a hosted window in window mode; first built for the overlay over a browser window, Spike 1, PLAN.md §6): a
// transparent window still takes the mouse wherever it is, so Margin's window ignores the mouse while the pointer is
// over the theme's page slot, and takes it everywhere else. Where the pointer is comes from mouse
// monitors (a global one for when another app's window gets the events, a
// local one for the overlay's own), which need no Accessibility.
//
// Over the slot the theme can still draw things that take the pointer (the
// palette, a menu, a notice, the sidebar out over the page): the overlay's
// page reports their boxes (`hits`, app/shared/ui/host-app.ts), and the
// overlay takes the mouse over them, as the in-page host's pass-through does
// (its root ignores the pointer, its children keep theirs). While a button
// is held, nothing changes: a drag that started on the page stays the
// page's, one that started on Margin stays Margin's.
//
// The rules are margin-core's (app/shared/core/src/passthrough.rs, with CGRect's edges: docs/CORE-REFACTOR.md step 3
// part 12): who gets the pointer, the slot, the catch region, the positions a page wants, and Margin's window's
// pointer (its page's, PageCore.swift: each pointer event one typed call). Here: the values Margin's window and the
// pane click tap hold, read through the core, and the mechanism (the mouse monitors, the catch fill's drawing).

import AppKit
import MarginCore

// The page slot of one overlay, in the window server's coordinates (top left). (Nonisolated: the pane click tap reads it
// on its own thread, PaneClickTap.swift.)
nonisolated struct Slot: Equatable, Sendable {
    var rect: CGRect
    var radius: CGFloat = 0
    // What the theme draws over the slot that takes the pointer.
    var hits: [CGRect] = []
    // The page asked for the whole window (more over the slot than it could list).
    var captureAll = false
    // Several visible hosts (docs/PEEK-SPLIT.md §1): the pointer goes through only inside these (each one's hole; a
    // card's content alone while a card is open), the rest of the slot Margin's. Nil: the whole slot, as before.
    var holes: [CGRect]? = nil
}

// (Its rects to and from the core's: PageCore.swift's `raw`, `withRects`, `rects`.)

nonisolated extension Slot {
    // The slot as the core reads it, its rects borrowed for the call.
    func withView<T>(_ body: (UnsafePointer<MarginSlotView>) -> T) -> T {
        withRects(hits) { h, hn in
            withRects(holes ?? []) { o, on in
                var v = MarginSlotView(rect: rect.raw, radius: Double(radius), hits: h, hits_len: hn, capture_all: captureAll,
                                       has_holes: holes != nil, holes: o, holes_len: on)
                return withUnsafePointer(to: &v) { body($0) }
            }
        }
    }

    // A slot the core holds, copied.
    init(_ v: MarginSlotView) {
        self.init(rect: CGRect(v.rect), radius: CGFloat(v.radius), hits: rects(v.hits, v.hits_len), captureAll: v.capture_all,
                  holes: v.has_holes ? rects(v.holes, v.holes_len) : nil)
    }
}

extension PageLayout {
    var insets: MarginInsets { MarginInsets(left: left, top: top, right: right, bottom: bottom, radius: radius) }
}

enum PassThrough {
    // Whether the page gets the pointer at `point` (the overlay ignores the mouse there).
    nonisolated static func pageGets(_ point: CGPoint, _ slot: Slot?) -> Bool {
        guard let slot else { return margin_pass_page_gets(point.margin, nil) }
        return slot.withView { margin_pass_page_gets(point.margin, $0) }
    }

    // What the overlay should do now: `ignoring` is what it does; a held button keeps it.
    static func decide(_ point: CGPoint, _ slot: Slot?, buttonsDown: Bool, ignoring: Bool) -> Bool {
        guard let slot else { return margin_pass_decide(point.margin, nil, buttonsDown, ignoring) }
        return slot.withView { margin_pass_decide(point.margin, $0, buttonsDown, ignoring) }
    }

    // The slot from the page's layout report: the overlay's frame (top left) with the insets.
    static func slot(in frame: CGRect, layout: PageLayout, hits: [CGRect] = [], captureAll: Bool = false) -> Slot {
        var out = [CGRect](repeating: .zero, count: hits.count)
        let rect = withRects(hits) { h, n in
            out.withUnsafeMutableBufferPointer { o in
                o.withMemoryRebound(to: MarginRect.self) { margin_pass_slot(frame.raw, layout.insets, h, n, $0.baseAddress) }
            }
        }
        return Slot(rect: CGRect(rect), radius: CGFloat(layout.radius), hits: out, captureAll: captureAll)
    }
}

// Where the overlay's own windows take the mouse whatever its `ignoresMouseEvents` says (seen 2026-11-06:
// a scroll over the sidebar scrolled the page behind it; sometimes nothing in the layout took a click): the
// window server passes the pointer through a window's fully transparent pixels, and the overlay's one
// window follows the pointer after the fact (the first event over Margin's UI, coming from over the page,
// still reached Safari). So the region that isn't the page's, known from the layout (everything but the
// slot, less its rounded corners, plus what the theme draws over it, `hits`; all of it with `captureAll`
// or no layout yet), is filled at alpha 0.01: under the overlay's web view (a transparent part of the theme
// still takes the mouse). Only the page slot lets the pointer through.
struct CatchRegion: Equatable {
    var all: Bool // the whole frame
    var hole: CGRect? // the slot, in the frame's coordinates (top left), cut out
    var radius: CGFloat = 0
    var hits: [CGRect] = [] // filled again over the hole
    var holes: [CGRect]? = nil // (several visible hosts: only these cut out of the hole, the rest of it filled)

    // For an overlay at `frame` (top left) with this slot (window server coordinates).
    static func of(frame: CGRect, slot: Slot?) -> CatchRegion {
        var hits = [MarginRect](repeating: MarginRect(), count: slot?.hits.count ?? 0)
        var holes = [MarginRect](repeating: MarginRect(), count: slot?.holes?.count ?? 0)
        var v = MarginCatchView()
        hits.withUnsafeMutableBufferPointer { h in
            holes.withUnsafeMutableBufferPointer { o in
                if let slot { slot.withView { margin_pass_catch(frame.raw, $0, h.baseAddress, o.baseAddress, &v) } }
                else { margin_pass_catch(frame.raw, nil, h.baseAddress, o.baseAddress, &v) }
            }
        }
        return CatchRegion(v)
    }

    // A region the core made, copied (its rects read now).
    init(_ v: MarginCatchView) {
        self.init(all: v.all, hole: v.has_hole ? CGRect(v.hole) : nil, radius: CGFloat(v.radius), hits: rects(v.hits, v.hits_len),
                  holes: v.has_holes ? rects(v.holes, v.holes_len) : nil)
    }

    init(all: Bool, hole: CGRect?, radius: CGFloat = 0, hits: [CGRect] = [], holes: [CGRect]? = nil) {
        (self.all, self.hole, self.radius, self.hits, self.holes) = (all, hole, radius, hits, holes)
    }

    // Whether a point (in the frame, top left) is filled: the same answer as !PassThrough.pageGets.
    func contains(_ p: CGPoint, in size: CGSize) -> Bool {
        withRects(hits) { h, hn in
            withRects(holes ?? []) { o, on in
                var v = MarginCatchView(all: all, has_hole: hole != nil, hole: (hole ?? .zero).raw, radius: Double(radius), hits: h, hits_len: hn,
                                        has_holes: holes != nil, holes: o, holes_len: on)
                return margin_pass_catch_contains(&v, p.margin, Double(size.width), Double(size.height))
            }
        }
    }
}

// Which pointer positions an overlay's page wants handed in (app/shared/host/overlay.ts
// reportWant; only peek uses them): none while its sidebar is docked, those within
// `zone` points of its peek edges while the sidebar is hidden, every one while it's
// out over the page. Before 2026-11-05 every move over an overlay went in, at 30 a second.
// (Read from the page's message here; which positions it wants is the core's.)
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

    // As the core has it: the mode's number, the edges' bits (1 left, 2 right, 4 top, 8 bottom).
    var code: UInt8 { switch mode { case .none: 0; case .edges: 1; case .all: 2 } }
    var bits: UInt8 {
        [("left", 1), ("right", 2), ("top", 4), ("bottom", 8)].reduce(0) { $0 | (edges.contains($1.0) ? UInt8($1.1) : 0) }
    }

    // Whether a position (in the overlay, top left) is wanted.
    func wants(_ p: CGPoint, in size: CGSize) -> Bool {
        margin_pass_wants(code, bits, Double(zone), p.margin, Double(size.width), Double(size.height))
    }
}

// The pointer, wherever it is (no Accessibility): every move and drag, and
// each press (a press in the browser re-orders the overlays above it).
final class PointerWatch {
    var onMove: ((CGPoint) -> Void)? // top-left coordinates
    var onPress: ((CGPoint, Int) -> Void)? // (and the press's event number: the window server's, its CGEvent's mouseEventNumber)
    private var monitors: [Any] = []

    var isStarted: Bool { !monitors.isEmpty }

    func start() {
        guard monitors.isEmpty else { return }
        let moves: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseUp, .rightMouseUp]
        let presses: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        let handle: (NSEvent) -> Void = { [weak self] event in
            let at = ScreenGeometry.topLeftPoint(NSEvent.mouseLocation)
            if presses.contains(NSEvent.EventTypeMask(rawValue: 1 << event.type.rawValue)) { self?.onPress?(at, event.eventNumber) } else { self?.onMove?(at) }
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

// The region that isn't the page's (PassThrough.swift CatchRegion), filled at alpha 0.01 so the window
// server never passes the pointer through it; the rest left fully transparent. Top-left coordinates.
// Each point once, at 0.01 however many boxes cover it (copied, not laid over: before 2026-11-20 each `hits` box
// was drawn over the others, and a space swipe's overlapping boxes showed over the page as a grey band).
final class CatchView: NSView {
    var region = CatchRegion(all: true, hole: nil) { didSet { if region != oldValue { needsDisplay = true } } }
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil } // (under the web view: never the one that takes an event)
    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        bounds.fill(using: .copy)
        let fill = NSColor(calibratedWhite: 0, alpha: 0.01)
        fill.setFill()
        NSGraphicsContext.current?.compositingOperation = .copy
        let path = NSBezierPath(rect: bounds)
        if !region.all, let holes = region.holes {
            // (Several visible hosts: each one's hole cut out, never overlapping; the rest of the slot filled.)
            for h in holes { path.append(NSBezierPath(rect: h)) }
            path.windingRule = .evenOdd
        } else if !region.all, let hole = region.hole {
            path.append(NSBezierPath(roundedRect: hole, xRadius: region.radius, yRadius: region.radius))
            path.windingRule = .evenOdd
        }
        path.fill()
        for r in region.hits { NSBezierPath(rect: r).fill() }
    }
}
