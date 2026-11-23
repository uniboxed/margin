// Margin's own window's page layout as its page reports it (ui/host.ts Geometry): where the page area is, its corners,
// a split's panes. Read by the core (protocol.rs `PageLayout::from_geometry`, through margin-ffi's
// `margin_page_layout_parse`: docs/CORE-REFACTOR.md step 3, commit 1); this is what Margin's window keeps of it.

import CoreGraphics
import Foundation
import MarginCore

// Where the theme put the page in Margin's window (ui/host.ts Geometry): `<m-page>`'s content box as insets from the
// window's edges, in points (CSS pixels at zoom 1 in the window's page). The hosted window goes there
// (MarginWindowController.swift).
struct PageLayout: Equatable {
    var left: Double, top: Double, right: Double, bottom: Double
    var radius: Double
    var radii: [Double] // top-left, top-right, bottom-right, bottom-left
    var width: Double, height: Double // the window's size it was measured at
    var mode: String
    // Measured with no page area of its own (Margin's own window hosting beside it: the sidebar alone, `pageOutside`).
    var outside = false
    // Measured while hosting in its page area (`pageHosted`): the sidebar as the person keeps it (hidden: the frame's
    // page area), not the launcher's, whose sidebar is always docked. A hosted window is placed only by such a layout.
    var hosted = false
    // What the theme draws around the page area's rounded corners (Margin's own window only: host-app.ts cornerFill):
    // each corner's colour outside the card (CSS colours, top left clockwise; empty: not said). The ground under the
    // page area is the colour most of them have (MarginWindowController `pageGround`).
    var fills: [String] = []
    // A split shown (docs/PEEK-SPLIT.md §4): its id and each pane's box as Margin's renderer laid it out in `<m-page>`
    // (`<m-pane>`, in the page's coordinates, top left), in the split's order, each by its item; none: no split.
    var split: String?
    var panes: [PagePane] = []

    // From the page's report ({ insets, radius, radii, container, mode, pageOutside, pageHosted, fills, split, panes }),
    // as the core reads it; nil if it isn't one.
    init?(geometry g: JSONObject) {
        // (Each report of a drag comes here: its JSON made once, without sorting, and without the walk for numbers
        // that aren't finite unless it has one; the answer typed, its texts in a buffer.)
        let valid = JSONSerialization.isValidJSONObject(g) ? g : SessionRules.json(g)
        guard let data = try? JSONSerialization.data(withJSONObject: valid) else { return nil }
        var l = MarginPageLayout()
        var text = [UInt8](repeating: 0, count: 1024)
        let read = { (text: inout [UInt8]) in
            data.withUnsafeBytes { b in text.withUnsafeMutableBufferPointer { t in margin_page_layout_read(b.bindMemory(to: UInt8.self).baseAddress, b.count, &l, t.baseAddress, t.count) } }
        }
        var need = read(&text)
        if need > text.count { text = [UInt8](repeating: 0, count: need); need = read(&text) }
        guard need >= 0, need <= text.count else { return nil }
        let s = { (m: MarginText) in String(decoding: text[m.at..<(m.at + m.len)], as: UTF8.self) }
        self.init(left: l.left, top: l.top, right: l.right, bottom: l.bottom, radius: l.radius,
                  radii: [l.radii.0, l.radii.1, l.radii.2, l.radii.3], width: l.width, height: l.height, mode: s(l.mode))
        outside = l.outside
        hosted = l.hosted
        let allFills = [l.fills.0, l.fills.1, l.fills.2, l.fills.3]
        fills = allFills.prefix(Int(l.fill_count)).map(s)
        split = l.has_split ? s(l.split) : nil
        let items = [l.pane_items.0, l.pane_items.1, l.pane_items.2, l.pane_items.3], rects = [l.pane_rects.0, l.pane_rects.1, l.pane_rects.2, l.pane_rects.3]
        panes = (0..<min(Int(l.pane_count), 4)).map { PagePane(item: s(items[$0]), rect: CGRect(rects[$0])) }
    }

    init(left: Double, top: Double, right: Double, bottom: Double, radius: Double, radii: [Double], width: Double, height: Double, mode: String) {
        (self.left, self.top, self.right, self.bottom, self.radius, self.radii, self.width, self.height, self.mode) = (left, top, right, bottom, radius, radii, width, height, mode)
    }
}

// One pane of a split as the page laid it out (PageLayout `panes`): its item and its box in the page, top left.
struct PagePane: Equatable {
    var item: String
    var rect: CGRect
    init(item: String, rect: CGRect) { (self.item, self.rect) = (item, rect) }
}
