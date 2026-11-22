// Margin's own window's page layout as its page reports it (ui/host.ts Geometry): where the page area is, its corners,
// a split's panes. Margin's window's, not the link's (it moved here from LinkMessage.swift with step 1.5 of
// docs/CORE-REFACTOR.md; it goes into the core with the page states, step 3).

import CoreGraphics
import Foundation

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

    // From the page's report ({ insets, radius, radii, container, mode, pageOutside, split, panes }); nil if it isn't one.
    init?(geometry g: JSONObject) {
        guard let insets = g["insets"] as? JSONObject,
              let l = num(insets["left"]), let t = num(insets["top"]), let r = num(insets["right"]), let b = num(insets["bottom"]),
              let container = g["container"] as? JSONObject, let w = num(container["width"]), let h = num(container["height"]),
              [l, t, r, b, w, h].allSatisfy({ $0.isFinite }), w > 0, h > 0 else { return nil }
        let radius = num(g["radius"]) ?? 0
        let radii = (g["radii"] as? [Any])?.compactMap(num) ?? []
        self.init(left: l, top: t, right: r, bottom: b, radius: radius.isFinite ? max(0, radius) : 0,
                  radii: radii.count == 4 ? radii : [radius, radius, radius, radius], width: w, height: h,
                  mode: g["mode"] as? String ?? "fullscreen")
        outside = g["pageOutside"] as? Bool == true
        hosted = g["pageHosted"] as? Bool == true
        let said = (g["fills"] as? [Any])?.prefix(4).map { ($0 as? String).flatMap { $0.count <= 80 ? $0 : nil } ?? "" } ?? []
        fills = said.count == 4 ? said : []
        // (At most 4 panes, each an item's id and a finite box of its own; anything else: no split said.)
        if let id = g["split"] as? String, PagePane.idOk(id), let list = g["panes"] as? [Any], (2...4).contains(list.count) {
            let parsed = list.compactMap { PagePane($0) }
            if parsed.count == list.count, Set(parsed.map(\.item)).count == parsed.count { split = id; panes = parsed }
        }
    }

    init(left: Double, top: Double, right: Double, bottom: Double, radius: Double, radii: [Double], width: Double, height: Double, mode: String) {
        (self.left, self.top, self.right, self.bottom, self.radius, self.radii, self.width, self.height, self.mode) = (left, top, right, bottom, radius, radii, width, height, mode)
    }
}

// One pane of a split as the page laid it out (PageLayout `panes`): its item and its box in the page, top left.
struct PagePane: Equatable {
    var item: String
    var rect: CGRect
    static func idOk(_ s: String) -> Bool { !s.isEmpty && s.count <= 256 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "-_:.".contains($0)) } }
    init(item: String, rect: CGRect) { (self.item, self.rect) = (item, rect) }
    init?(_ raw: Any) {
        guard let o = raw as? JSONObject, let item = o["id"] as? String, Self.idOk(item), let r = o["rect"] as? [Any], r.count == 4 else { return nil }
        let n = r.compactMap(num)
        guard n.count == 4, n.allSatisfy(\.isFinite), n[2] > 0, n[3] > 0 else { return nil }
        self.init(item: item, rect: CGRect(x: n[0], y: n[1], width: n[2], height: n[3]))
    }
}
