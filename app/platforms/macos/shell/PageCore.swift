// One Margin window's page in the core (margin-ffi page.rs over margin-core's page::Page, docs/CORE-REFACTOR.md step 3
// part 11 and part 7's page area): what MarginWindowController decides with, read and told through typed calls. Its
// page card's state and the loader's grace (a deadline: the window's timer calls `graceOver` then), the holes and the
// ground, in front of what it hosts, the page area from its page's layout, the placements, and its pointer (the slot,
// the catch region, each pointer event's way: passthrough.rs PagePointer). The main thread's. Here: the calls and
// their values as Margin's window holds them; nothing decided.

import AppKit
import MarginCore

// A rect as it is (CGRect's own `minX`, `width`… would standardize it: the core does, as CGRect does).
nonisolated extension CGRect {
    var raw: MarginRect { MarginRect(x: Double(origin.x), y: Double(origin.y), width: Double(size.width), height: Double(size.height)) }
}

nonisolated extension CGPoint {
    var margin: MarginPoint { MarginPoint(x: Double(x), y: Double(y)) }
}

// CGRects as the core's rects, in place (one layout: four doubles), for the length of a call.
nonisolated func withRects<T>(_ list: [CGRect], _ body: (UnsafePointer<MarginRect>?, Int) -> T) -> T {
    list.withUnsafeBufferPointer { b in b.withMemoryRebound(to: MarginRect.self) { body($0.baseAddress, $0.count) } }
}

nonisolated func rects(_ p: UnsafePointer<MarginRect>?, _ n: Int) -> [CGRect] {
    guard let p, n > 0 else { return [] }
    return UnsafeBufferPointer(start: p, count: n).map(CGRect.init)
}

// A text for the length of a call: its bytes, their count, and whether there's one (nil: none).
nonisolated func withText<T>(_ s: String?, _ body: (UnsafePointer<UInt8>?, Int, Bool) -> T) -> T {
    guard var s else { return body(nil, 0, false) }
    return s.withUTF8 { body($0.baseAddress, $0.count, true) }
}

extension NSColor {
    // The core's colour, as PageFill made it (sRGB).
    convenience init(_ c: MarginRgba) { self.init(srgbRed: CGFloat(c.r), green: CGFloat(c.g), blue: CGFloat(c.b), alpha: CGFloat(c.a)) }
}

// How long a show is expected to take, as the core's session says it (core/page/mod.rs `Pace`: the page's grace follows):
// carried through to the page, never decided here.
enum ShowPace: UInt8 { case usual = 0, quick = 1, slow = 2 }

final class PageCore {
    private let page: OpaquePointer?

    init(pointerEvery: TimeInterval) {
        page = margin_page_new()
        margin_page_set_pointer_every(page, pointerEvery)
    }

    deinit { margin_page_free(page) }

    // The page object, for the session's typed read of a drag's frame (`margin_session_page_rect`).
    var pointer: OpaquePointer? { page }

    // The loader's grace and a quick switch's (nil: the core's own, page/mod.rs LOADER_GRACE and SWITCH_GRACE), the start's
    // loader label, how it's kept in front (the mechanism asked for, the window levels).
    func configure(grace: TimeInterval?, switchGrace: TimeInterval?, startupLabel: String, order: Bool, raised: Int, normal: Int) {
        withText(startupLabel) { t, n, _ in margin_page_configure(page, grace ?? -1, switchGrace ?? -1, t, n, order, Int64(raised), Int64(normal)) }
    }

    // ---- its page's layout ----

    private var layoutRev = 0
    private var layoutBuilt = -1
    private var layoutValue: PageLayout?

    // The page's layout report (`geometry`'s JSON as the page sent it): kept if it's one; whether a split's panes changed.
    func setLayout(_ bytes: UnsafeBufferPointer<UInt8>) -> (taken: Bool, panesChanged: Bool) {
        let bits = margin_page_set_layout(page, bytes.baseAddress, bytes.count)
        if bits & 1 != 0 { layoutRev += 1 }
        return (bits & 1 != 0, bits & 2 != 0)
    }

    // ---- what its page says, and its hello (core/page/said.rs, hello.rs) ----

    // An op's route (`Said`): what the window's mechanism does with it; the Page's own (its layout, the theme's hits,
    // the pointer's wants) kept in the core already.
    enum Said {
        case none, ready, want, fullScreen
        case haptic(level: Bool)
        case layout(taken: Bool, panesChanged: Bool)
        case peekRect(CGRect?)
        case hits([CGRect], all: Bool)
        case chrome(controls: CGRect?, drags: [CGRect])
        case focus(Bool, was: Bool) // a field of Margin's wants the keys (kept by the core), and whether one did before
        case counts(spaces: Int, items: Int)
        case resizing(on: Bool, divider: Bool)
        case slide(item: String, side: PaneSide)
        case ask(String, JSONObject)
        case log(warn: Bool, String)
    }

    // An op and its body's JSON (a layout's: its report) as the page sent it; `content`: the window's content rect.
    func said(_ op: String, _ body: UnsafeBufferPointer<UInt8>, content: CGRect) -> Said {
        var out = MarginSaid()
        var op = op
        let kind = op.withUTF8 { margin_page_said(page, $0.baseAddress, $0.count, body.baseAddress, body.count, content.raw, &out) }
        let text = out.text.map { p -> String in
            defer { margin_buffer_free(p, out.text_len) }
            return String(decoding: UnsafeBufferPointer(start: p, count: out.text_len), as: UTF8.self)
        }
        func listed() -> [CGRect] {
            guard out.rects > 0 else { return [] }
            var list = [MarginRect](repeating: MarginRect(), count: out.rects)
            let n = list.withUnsafeMutableBufferPointer { margin_page_said_rects(page, $0.baseAddress, $0.count) }
            return list.prefix(n).map(CGRect.init)
        }
        let rect = out.has_rect ? CGRect(out.rect) : nil
        switch kind {
        case 1: return .ready
        case 2:
            if out.flag { layoutRev += 1 }
            return .layout(taken: out.flag, panesChanged: out.flag2)
        case 3: return .peekRect(rect)
        case 4: return .hits(listed(), all: out.flag)
        case 5: return .chrome(controls: rect, drags: listed())
        case 6: return .focus(out.flag, was: out.flag2)
        case 7: return .counts(spaces: Int(out.a), items: Int(out.b))
        case 8: return .want
        case 9: return .fullScreen
        case 10: return .resizing(on: out.flag, divider: out.flag2)
        case 11: return .haptic(level: out.flag)
        case 12: return .slide(item: text ?? "", side: [PaneSide.left, .right, .up, .down][Int(out.a) & 3])
        case 13:
            let o = text.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? JSONObject } ?? [:]
            return .ask(o["name"] as? String ?? "", o["arg"] as? JSONObject ?? [:])
        case 14: return .log(warn: out.flag, text ?? "")
        default: return .none
        }
    }

    // The page's hello (the core's: its fields, their order, its card's state and words): `texts` in
    // MarginHelloFacts' order (browser, mode, state, windows, themes, apps, marginPage, paneMin, appMin, paneLoading,
    // paneCut, picture, hostedFrame, hostedFrames, theme; nil: none).
    func hello(windowId: Int, pageMinimum: CGFloat?, texts: [String?]) -> String {
        var all: [UInt8] = [0]
        var spans: [(Int, Int)?] = []
        for t in texts {
            guard let t else { spans.append(nil); continue }
            spans.append((all.count, t.utf8.count))
            all.append(contentsOf: t.utf8)
        }
        return all.withUnsafeBufferPointer { base -> String in
            let b = { (i: Int) -> MarginBytes in
                guard i < spans.count, let (at, n) = spans[i], let p = base.baseAddress else { return MarginBytes(ptr: nil, len: 0) }
                return MarginBytes(ptr: p + at, len: n)
            }
            var f = MarginHelloFacts(window_id: Int64(windowId), page_minimum: pageMinimum.map(Double.init) ?? .nan,
                                     browser: b(0), mode: b(1), state: b(2), windows: b(3), themes: b(4), apps: b(5), margin_page: b(6),
                                     pane_min: b(7), app_min: b(8), pane_loading: b(9), pane_cut: b(10), picture: b(11),
                                     hosted_frame: b(12), hosted_frames: b(13), theme: b(14))
            var len = 0
            guard let p = margin_page_hello(page, &f, &len) else { return "null" }
            defer { margin_buffer_free(p, len) }
            return String(decoding: UnsafeBufferPointer(start: p, count: len), as: UTF8.self)
        }
    }

    // The layout kept, as Margin's window and the tests read it (made when it's asked for after a change).
    var layout: PageLayout? {
        guard layoutBuilt != layoutRev else { return layoutValue }
        layoutBuilt = layoutRev
        var l = MarginPageLayout()
        var text = [UInt8](repeating: 0, count: 1024)
        let read = { (text: inout [UInt8]) in text.withUnsafeMutableBufferPointer { margin_page_layout_get(self.page, &l, $0.baseAddress, $0.count) } }
        var need = read(&text)
        if need > text.count { text = [UInt8](repeating: 0, count: need); need = read(&text) }
        layoutValue = need < 0 || need > text.count ? nil : PageLayout(l, text: text)
        return layoutValue
    }

    func setHits(_ hits: [CGRect], captureAll: Bool) {
        withRects(hits) { margin_page_set_hits(page, $0, $1, captureAll) }
    }

    func setFullScreen(_ on: Bool) { margin_page_set_full_screen(page, on) }

    // ---- the page area ----

    // The page area again (the window's content and its display's frame, top left): nil, left as it is; else what the
    // window's page area is set to.
    func update(content: CGRect, display: CGRect?) -> (rect: CGRect?, radius: CGFloat)? {
        var out = MarginRect(), radius = 0.0
        let said: UInt8 = if var d = display?.raw { margin_page_update(page, content.raw, &d, &out, &radius) } else { margin_page_update(page, content.raw, nil, &out, &radius) }
        switch said {
        case 1: return (nil, CGFloat(radius))
        case 2: return (CGRect(out), CGFloat(radius))
        default: return nil
        }
    }

    func hostedPlacement(content: CGRect, display: CGRect?) -> HostPlacement? {
        var out = MarginPlacement()
        let ok = if var d = display?.raw { margin_page_hosted_placement(page, content.raw, &d, &out) } else { margin_page_hosted_placement(page, content.raw, nil, &out) }
        return ok ? HostPlacement(page: CGRect(out.page), area: CGRect(out.area), display: CGRect(out.display)) : nil
    }

    func idlePlacement(content: CGRect) -> HostPlacement? {
        var out = MarginPlacement()
        return margin_page_idle_placement(page, content.raw, &out) ? HostPlacement(page: CGRect(out.page), area: CGRect(out.area), display: CGRect(out.display)) : nil
    }

    // A split's panes on the screen (hosting, a split laid out), in the split's order.
    func panes(content: CGRect) -> (split: String, panes: [PagePane])? {
        var o = MarginPagePanes()
        var text = [UInt8](repeating: 0, count: 1024)
        let read = { (text: inout [UInt8]) in text.withUnsafeMutableBufferPointer { margin_page_panes(self.page, content.raw, &o, $0.baseAddress, $0.count) } }
        var need = read(&text)
        if need > text.count { text = [UInt8](repeating: 0, count: need); need = read(&text) }
        guard need >= 0, need <= text.count else { return nil }
        let s = { (m: MarginText) in String(decoding: text[m.at..<(m.at + m.len)], as: UTF8.self) }
        let items = [o.items.0, o.items.1, o.items.2, o.items.3], boxes = [o.rects.0, o.rects.1, o.rects.2, o.rects.3]
        return (s(o.split), (0..<min(Int(o.count), 4)).map { PagePane(item: s(items[$0]), rect: CGRect(boxes[$0])) })
    }

    // ---- what it shows ----

    // Hosting, or not: nil, no change; else whether several hosts were visible (none now).
    func setHosting(_ on: Bool) -> Bool? {
        let bits = margin_page_set_hosting(page, on)
        return bits & 1 == 0 ? nil : bits & 2 != 0
    }
    // The hosted window in a tile of Margin's Space (it can be placed past the window's edge), the engine's word.
    func setHostedTile(_ on: Bool) { margin_page_set_hosted_tile(page, on) }
    // Whether the page area may pass the window's edge, when it changed since the page was told: nil, no change.
    func slidesChange() -> Bool? {
        switch margin_page_slides_change(page) { case 1: return false; case 2: return true; default: return nil }
    }
    func setLoading(_ label: String?, app: String?) -> Bool {
        withText(label) { l, ln, lh in withText(app) { a, an, ah in margin_page_set_loading(page, l, ln, lh, a, an, ah) } }
    }
    func setShowing(_ label: String?, app: String?, pace: ShowPace) -> Bool {
        withText(label) { l, ln, lh in withText(app) { a, an, ah in margin_page_set_showing(page, l, ln, lh, a, an, ah, pace.rawValue) } }
    }
    func setElsewhere(_ label: String?, app: String?) -> Bool {
        withText(label) { l, ln, lh in withText(app) { a, an, ah in margin_page_set_elsewhere(page, l, ln, lh, a, an, ah) } }
    }
    func setStuck(_ why: String?) -> Bool { withText(why) { margin_page_set_stuck(page, $0, $1, $2) } }
    func setCopySlow(_ on: Bool) -> Bool { margin_page_set_copy_slow(page, on) }
    var copySlow: Bool { margin_page_copy_slow(page) }
    // A field of Margin's wants the keys (its page's `focus`, kept as it's read), and whether a press on Margin's UI
    // leaves the keyboard where it is now (an app shown, no field of Margin's: core/page/press.rs).
    var fieldKeys: Bool { margin_page_field_keys(page) }
    var keysStay: Bool { margin_page_keys_stay(page) }
    enum HostedSaid { case same, moved, changed }
    func setHosted(_ number: Int?) -> HostedSaid {
        switch margin_page_set_hosted(page, number != nil, Int64(number ?? 0)) {
        case 1: return .moved
        case 2: return .changed
        default: return .same
        }
    }
    func setHostedFrame(_ frame: CGRect?) {
        guard var f = frame?.raw else { return margin_page_set_hosted_frame(page, nil) }
        margin_page_set_hosted_frame(page, &f)
    }
    // Every visible host's window while several are; true: more than their rects changed.
    func setVisible(_ list: [HostShownWindow]) -> Bool {
        let shown = list.map { MarginShown(window: Int64($0.window), rect: $0.rect.raw, z: Int64($0.z), role: $0.role.code, focused: $0.focused) }
        return shown.withUnsafeBufferPointer { margin_page_set_visible(page, $0.baseAddress, $0.count) }
    }
    func setFrames(_ frames: [Int: CGRect]) {
        let list = frames.map { MarginFrame(window: Int64($0.key), rect: $0.value.raw) }
        list.withUnsafeBufferPointer { margin_page_set_frames(page, $0.baseAddress, $0.count) }
    }
    func frame(of window: Int) -> CGRect? {
        var out = MarginRect()
        return margin_page_frame(page, Int64(window), &out) ? CGRect(out) : nil
    }
    func setFollowing(_ on: Bool) -> Bool { margin_page_set_following(page, on) }

    // ---- the page card's state ----

    func settle(now: Double) -> MarginSettled {
        var out = MarginSettled()
        margin_page_settle(page, now, &out)
        return out
    }
    func graceOver() -> MarginSettled {
        var out = MarginSettled()
        margin_page_grace_over(page, &out)
        return out
    }

    // What it holds, at once.
    var read: MarginPageRead {
        var out = MarginPageRead()
        margin_page_read(page, &out)
        return out
    }

    enum Text: UInt8 { case loader = 0, loaderApp, loading, showing, stuck }
    func text(_ which: Text) -> String? {
        var buf = [UInt8](repeating: 0, count: 256)
        var n = buf.withUnsafeMutableBufferPointer { margin_page_text(page, which.rawValue, $0.baseAddress, $0.count) }
        if n > buf.count {
            buf = [UInt8](repeating: 0, count: n)
            n = buf.withUnsafeMutableBufferPointer { margin_page_text(page, which.rawValue, $0.baseAddress, $0.count) }
        }
        return n < 0 ? nil : String(decoding: buf[0..<n], as: UTF8.self)
    }

    // ---- the holes ----

    enum Ground { case none, one(hole: CGRect, radii: [CGFloat]), several([WindowGroundView.Hole]) }
    struct HolePlaced {
        var slot: Bool
        var region: Bool
        var ground: Ground
        var fill: MarginRgba?
    }
    func placeHole(content: CGRect) -> HolePlaced {
        var o = MarginHolePlaced()
        margin_page_place_hole(page, content.raw, &o)
        let ground: Ground
        switch o.ground {
        case 1:
            let r = o.hole.radii
            ground = .one(hole: CGRect(o.hole.rect), radii: [CGFloat(r.0), CGFloat(r.1), CGFloat(r.2), CGFloat(r.3)])
        case 2:
            ground = .several(UnsafeBufferPointer(start: o.holes, count: o.holes_len).map { h in
                let r = h.radii
                return WindowGroundView.Hole(rect: CGRect(h.rect), radii: h.has_radii ? [CGFloat(r.0), CGFloat(r.1), CGFloat(r.2), CGFloat(r.3)] : [])
            })
        default:
            ground = .none
        }
        return HolePlaced(slot: o.slot, region: o.region, ground: ground, fill: o.has_fill ? o.fill : nil)
    }

    var holes: [CGRect] {
        let n = margin_page_holes(page, nil, 0)
        guard n > 0 else { return [] }
        var out = [MarginRect](repeating: MarginRect(), count: n)
        _ = out.withUnsafeMutableBufferPointer { margin_page_holes(page, $0.baseAddress, $0.count) }
        return out.map(CGRect.init)
    }

    var paneHoles: [(rect: CGRect, window: Int, card: Bool)] {
        let n = margin_page_pane_holes(page, nil, 0)
        guard n > 0 else { return [] }
        var out = [MarginPaneHole](repeating: MarginPaneHole(), count: n)
        _ = out.withUnsafeMutableBufferPointer { margin_page_pane_holes(page, $0.baseAddress, $0.count) }
        return out.map { (CGRect($0.rect), Int($0.window), $0.card) }
    }

    // ---- in front ----

    func setYielding(_ number: Int?) -> Bool { margin_page_set_yielding(page, number != nil, Int64(number ?? 0)) }
    func setCovering(_ number: Int?) -> Bool { margin_page_set_covering(page, number != nil, Int64(number ?? 0)) }
    func spaceChanged(now: Double) { margin_page_space_changed(page, now) }

    // The caller's clock for the length of a call, read where the core reads it.
    private struct Clock { let now: () -> Double }
    private static let tick: MarginClock = { ctx in ctx?.assumingMemoryBound(to: Clock.self).pointee.now() ?? 0 }

    func keepFront(level: Int, now: () -> Double) -> MarginKeepFront {
        var out = MarginKeepFront()
        withoutActuallyEscaping(now) { now in
            var clock = Clock(now: now)
            withUnsafeMutablePointer(to: &clock) { margin_page_keep_front(page, Int64(level), $0, Self.tick, &out) }
        }
        return out
    }
    func frontReads(_ hosted: Int) -> Bool { margin_page_front_reads(page, Int64(hosted)) }
    func frontRead(hosted: Int, layer: Int, above: Bool, level: Int, now: () -> Double) -> [MarginFrontOp] {
        var out = MarginFrontOps()
        withoutActuallyEscaping(now) { now in
            var clock = Clock(now: now)
            withUnsafeMutablePointer(to: &clock) { margin_page_front_read(page, Int64(hosted), Int64(layer), above, Int64(level), $0, Self.tick, &out) }
        }
        let all = [out.ops.0, out.ops.1, out.ops.2, out.ops.3, out.ops.4, out.ops.5, out.ops.6, out.ops.7]
        return Array(all.prefix(Int(out.len)))
    }

    // ---- its pointer ----

    var slot: Slot? {
        var v = MarginSlotView()
        return margin_page_slot(page, &v) ? Slot(v) : nil
    }
    var region: CatchRegion {
        var v = MarginCatchView()
        margin_page_catch(page, &v)
        return CatchRegion(v)
    }

    func setButtons(_ controls: CGRect?, fullScreen: Bool) {
        guard var c = controls?.raw else { return margin_page_set_buttons(page, nil, fullScreen) }
        margin_page_set_buttons(page, &c, fullScreen)
    }

    func setWant(_ want: PointerWant) { margin_page_set_want(page, want.code, want.bits, Double(want.zone)) }

    // The visible hosts' windows (back to front), each marked when it's a cut pane, and whether any is cut. True: the
    // cut pane the pointer was over is forgotten, to be said.
    func setCuts(cutting: Bool, _ list: [(window: Int, rect: CGRect, cut: Bool)]) -> Bool {
        let cuts = list.map { MarginCut(window: Int64($0.window), rect: $0.rect.raw, cut: $0.cut) }
        return cuts.withUnsafeBufferPointer { margin_page_set_cuts(page, cutting, $0.baseAddress, $0.count) }
    }

    // What a pointer event decided: its way (`pass`: the panel lets it through), whether it's over the content, the
    // cut pane it's over when that changed (`hover`: .some(nil) none now), the position its page is told.
    struct Moved {
        enum Push: Equatable { case at(Double, Double), left(Double, Double) }
        var pass: Bool
        var inside: Bool
        var hover: Int??
        var push: Push?
    }
    func moved(_ at: CGPoint, content: CGRect, buttonsDown: Bool, now: TimeInterval) -> Moved {
        var out = MarginPointer()
        margin_page_pointer(page, at.margin, content.raw, buttonsDown, now, &out)
        let push: Moved.Push? = out.push == 1 ? .at(out.x, out.y) : out.push == 2 ? .left(out.x, out.y) : nil
        return Moved(pass: out.pass, inside: out.inside, hover: out.hover_said ? .some(out.has_hover ? Int(out.hover) : nil) : nil, push: push)
    }
    func again(_ at: CGPoint, content: CGRect) -> Bool { margin_page_pointer_again(page, at.margin, content.raw) }
    func gets(_ at: CGPoint) -> Bool { margin_page_gets(page, at.margin) }
    var ignoring: Bool { margin_page_ignoring(page) }
}

extension HostRole {
    // As the page has it: 0 main, 1 a pane, 2 the card.
    var code: UInt8 { switch self { case .main: 0; case .pane: 1; case .card: 2 } }
}
