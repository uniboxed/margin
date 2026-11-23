//! Where a hosted window goes (Host.swift `HostPlacement`, `HostLayout`; SlotEdges.swift): the page area of Margin's
//! window, the display's full-screen area it sits in, and the shapes a hosted window takes there: a full-screen
//! Space's edge reservation, a tile's rect in Margin's Space, a window held at its own minimum size. Top-left
//! coordinates in points, as the window server's bounds. Pure: the same placement always gives the same answer,
//! never read back from windows' bounds (2026-11-15: a plan read from bounds mid-transition counted a reservation
//! twice and grew at every step).

use serde::{Deserialize, Serialize};

use crate::geometry::Rect;

/// A size in points (a window's minimum, a tile's `SizeConstraints`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

impl Size {
    pub const fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }
}

/// Where a hosted window goes: `page`, the page area of Margin's window (its whole width, the theme's frame drawn
/// around it); `area`, the display's full-screen area (its frame below the camera housing), which a full-screen
/// window's own Space lays its window out in; `display`, that display's whole frame (zero: not known), which a tile in
/// Margin's Space is laid out in (from the display's top left, the menu bar's band included).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub page: Rect,
    pub area: Rect,
    #[serde(default)]
    pub display: Rect,
}

impl Placement {
    pub const ZERO: Placement = Placement { page: Rect::ZERO, area: Rect::ZERO, display: Rect::ZERO };

    pub fn text(&self) -> String {
        format!("page {} in {}", whole(&self.page), whole(&self.area))
    }
}

fn whole(r: &Rect) -> String {
    format!("{},{} {}×{}", r.x as i64, r.y as i64, r.width as i64, r.height as i64)
}

/// The edges a full-screen Space reserves (SlotEdges.swift): left, right, top, bottom, in points.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Edges {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

impl Edges {
    pub const ZERO: Edges = Edges { left: 0.0, right: 0.0, top: 0.0, bottom: 0.0 };

    pub fn is_zero(&self) -> bool {
        self.left == 0.0 && self.right == 0.0 && self.top == 0.0 && self.bottom == 0.0
    }
    /// Whole points: a fractional reservation makes AppKit leave full screen. (Swift's `rounded()`: half away from
    /// zero, as Rust's `round`.)
    pub fn whole(&self) -> Edges {
        Edges { left: self.left.round(), right: self.right.round(), top: self.top.round(), bottom: self.bottom.round() }
    }
    pub fn usable(&self) -> bool {
        [self.left, self.right, self.top, self.bottom].iter().all(|v| v.is_finite() && *v >= 0.0)
    }
    /// The frame less these edges.
    pub fn inset(&self, frame: &Rect) -> Rect {
        Rect::new(
            frame.x + self.left,
            frame.y + self.top,
            frame.width - self.left - self.right,
            frame.height - self.top - self.bottom,
        )
    }
    /// The frame these edges were taken from.
    pub fn outset(&self, frame: &Rect) -> Rect {
        Rect::new(
            frame.x - self.left,
            frame.y - self.top,
            frame.width + self.left + self.right,
            frame.height + self.top + self.bottom,
        )
    }
    /// left/top/right/bottom, as the log has it.
    pub fn text(&self) -> String {
        format!("{}/{}/{}/{}", self.left as i64, self.top as i64, self.right as i64, self.bottom as i64)
    }
}

/// The page's distances from the area's edges, whole points (negative past them).
fn edges_of(p: &Placement) -> Edges {
    Edges {
        left: p.page.min_x() - p.area.min_x(),
        right: p.area.max_x() - p.page.max_x(),
        top: p.page.min_y() - p.area.min_y(),
        bottom: p.area.max_y() - p.page.max_y(),
    }
    .whole()
}

/// The edges that make a full-screen window the page area (its own Space's reservation): the page's distances from the
/// area's edges, whole points. None: the page can't be reached that way (it passes the area, or leaves less than a
/// point): a reservation is never negative.
pub fn plan(p: &Placement) -> Option<Edges> {
    let edges = edges_of(p);
    if !edges.usable() || p.page.width < 1.0 || p.page.height < 1.0 || p.area.width < 1.0 || p.area.height < 1.0 {
        return None;
    }
    Some(edges)
}

/// A hosted window's tile rect in Margin's Space that puts its full-screen window at the page area: `home` (Margin's
/// own tile, the display's from its top left, the menu bar's band included) less the page's edges. Measured in the
/// kit (2026-11-17): home 0,0 1512×982, page 248,41 1256×933 in 0,33 1512×949 → tile 248,8 1256×966. A page past the
/// area's edge (a split's cut pane, docs/PEEK-SPLIT.md §4b) gives a tile past the display's, which macOS keeps
/// (2026-11-22); at least a point of it on the display.
pub fn tile(p: &Placement, home: &Rect) -> Option<Rect> {
    let edges = edges_of(p);
    let finite = [edges.left, edges.right, edges.top, edges.bottom].iter().all(|v| v.is_finite());
    if !finite || p.page.width < 1.0 || p.page.height < 1.0 || p.area.width < 1.0 || p.area.height < 1.0 {
        return None;
    }
    if home.width < p.area.width - 1.0 || home.height < p.area.height - 1.0 {
        return None;
    }
    let r = edges.inset(home);
    let on = r.intersection(home);
    (r.width >= 1.0 && r.height >= 1.0 && on.width >= 1.0 && on.height >= 1.0).then_some(r)
}

/// A frame held within the area (moved, never resized, as far as it fits): where a cut pane's window goes while it
/// isn't a tile in Margin's Space (its own Space's reservation can't pass the display: `plan`).
pub fn within(frame: &Rect, area: &Rect) -> Rect {
    let along = |start: f64, size: f64, lo: f64, hi: f64| start.min(hi - size).max(lo);
    Rect::new(
        along(frame.x, frame.width, area.min_x(), area.max_x()),
        along(frame.y, frame.height, area.min_y(), area.max_y()),
        frame.width,
        frame.height,
    )
}

/// Where a window that can't be smaller than `min` goes for a page area: the page area itself when it's at least
/// that big; else that minimum (within the area), its right edge and top the page area's, what's wider lying under
/// Margin's sidebar. Never a size the window can't take: a tile narrower than its window's minimum makes the app
/// leave it (2026-11-18: Weather, minimum 1048 wide, into a full-screen Space of its own 24 ms after its tile was sent
/// 1046 wide).
pub fn fit(page: &Rect, min: Option<Size>, area: &Rect) -> Rect {
    let Some(min) = min else { return *page };
    if !(min.width > page.width + 0.5 || min.height > page.height + 0.5) {
        return *page;
    }
    let width = page.width.max(min.width.ceil().min(area.width));
    let height = page.height.max(min.height.ceil().min(area.max_y() - page.min_y()));
    Rect::new((page.max_x() - width).max(area.min_x()), page.min_y(), width, height)
}

/// A split pane's window frame when the pane is narrower (or, stacked, lower) than its window can be
/// (docs/PEEK-SPLIT.md §4b): the pane itself when the window can be that small; else the window at its own minimum, the
/// rest of it past its pane: past the display's edge, under Margin's window (the sidebar, the frame) or under a
/// neighbour pane (Margin's hole stays the pane). Along each axis its start (left, top) at the pane's start (`end`
/// false), or its end (right, bottom) at the pane's end (true); `None`, away from the other panes, `page` (the split's
/// whole page area) telling where they are: a pane at the page's end puts the rest past it (its start at the pane's),
/// any other (at the page's start, or between two panes) puts it before the pane (its end at the pane's), so a pane at
/// either edge lies under no other pane and a pane between two lies under the one before it only (a chain, never two
/// panes over each other's). Never held within the display: macOS keeps a full-screen window's tile past the display's
/// edge, drawn clipped there (2026-11-22, an 800 wide tile 388 past the right edge, 300 past the left, 400 past the
/// bottom and 300 past the top, each held with no eject; AppKit takes a window out of its tile only when it can't take
/// the tile's size). Its size never past the area's (a window wider than the display isn't laid out so).
pub fn cut(pane: &Rect, min: Option<Size>, area: &Rect, page: &Rect, end_x: Option<bool>, end_y: Option<bool>) -> Rect {
    let Some(min) = min else { return *pane };
    let width = pane.width.max(min.width.ceil().min(area.width));
    let height = pane.height.max(min.height.ceil().min(area.height));
    if width <= pane.width + 0.5 && height <= pane.height + 0.5 {
        return *pane;
    }
    // (Not asked: the end alignment unless the pane is at the page's end; within a point of it.)
    let along = |start: f64, end: f64, size: f64, page_end: f64, at_end: Option<bool>| {
        if at_end.unwrap_or(end < page_end - 1.0) { end - size } else { start }
    };
    let x = along(pane.min_x(), pane.max_x(), width, page.max_x(), end_x);
    let y = along(pane.min_y(), pane.max_y(), height, page.max_y(), end_y);
    Rect::new(x, y, width, height)
}

/// Margin's own tile: the display's whole frame from its top left (None: the display isn't known).
pub fn home(p: &Placement) -> Option<Rect> {
    (p.display.width >= 1.0 && p.display.height >= 1.0).then(|| Rect::new(0.0, 0.0, p.display.width, p.display.height))
}

/// A full-screen window's room above it for its own toolbar window (Safari's, resting just above its window: 52 pt,
/// measured on the real screen), counted in two visible hosts' overlap. A stacked split's band above a Safari pane is
/// as tall (app/shared/ui/behaviors/split.ts `SAFARI_TOOLBAR`, a copy until the build writes the core's constants).
pub const TOOLBAR_ROOM: f64 = 52.0;

/// Each of x, y, width and height within `within` points (the edge itself included).
pub fn near(a: &Rect, b: &Rect, within: f64) -> bool {
    (a.x - b.x).abs() <= within
        && (a.y - b.y).abs() <= within
        && (a.width - b.width).abs() <= within
        && (a.height - b.height).abs() <= within
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kit() -> Placement {
        Placement {
            page: Rect::new(248.0, 41.0, 1256.0, 933.0),
            area: Rect::new(0.0, 33.0, 1512.0, 949.0),
            display: Rect::new(0.0, 0.0, 1512.0, 982.0),
        }
    }

    #[test]
    fn the_kit_tile() {
        let p = kit();
        let home = home(&p).unwrap();
        assert_eq!(home, Rect::new(0.0, 0.0, 1512.0, 982.0));
        assert_eq!(plan(&p), Some(Edges { left: 248.0, right: 8.0, top: 8.0, bottom: 8.0 }));
        assert_eq!(tile(&p, &home), Some(Rect::new(248.0, 8.0, 1256.0, 966.0)));
    }

    #[test]
    fn plan_whole_points_and_refusals() {
        let mut p = kit();
        p.page.x = 248.4;
        assert_eq!(plan(&p).unwrap().left, 248.0);
        p.page.x = 248.5;
        assert_eq!(plan(&p).unwrap().left, 249.0, "half away from zero, as Swift's rounded()");
        let mut out = kit();
        out.page.width = 2000.0; // passes the area
        assert_eq!(plan(&out), None);
        let mut thin = kit();
        thin.page.height = 0.5;
        assert_eq!(plan(&thin), None);
        assert_eq!(home(&Placement { display: Rect::ZERO, ..kit() }), None);
        // A home smaller than the area: no tile.
        assert_eq!(tile(&kit(), &Rect::new(0.0, 0.0, 1000.0, 982.0)), None);
        // A page past the area (a cut pane's window past the display's edge): no plan (a reservation), but a tile past
        // the display's edge; none wholly off it.
        let home = Rect::new(0.0, 0.0, 1512.0, 982.0);
        let past = Placement { page: Rect::new(876.0, 41.0, 701.0, 933.0), ..kit() };
        assert_eq!(plan(&past), None);
        assert_eq!(tile(&past, &home), Some(Rect::new(876.0, 8.0, 701.0, 966.0)));
        let left = Placement { page: Rect::new(-300.0, -159.0, 800.0, 600.0), ..kit() };
        assert_eq!(tile(&left, &home), Some(Rect::new(-300.0, -192.0, 800.0, 633.0)));
        assert_eq!(
            tile(&Placement { page: Rect::new(1600.0, 41.0, 700.0, 933.0), ..kit() }, &home),
            None,
            "off the display"
        );
        assert_eq!(tile(&Placement { page: Rect::new(f64::NAN, 41.0, 700.0, 933.0), ..kit() }, &home), None);
        // Held within the area: moved, never resized.
        let area = kit().area;
        assert_eq!(within(&past.page, &area), Rect::new(811.0, 41.0, 701.0, 933.0));
        assert_eq!(within(&Rect::new(-73.0, -10.0, 701.0, 600.0), &area), Rect::new(0.0, 33.0, 701.0, 600.0));
        assert_eq!(within(&Rect::new(240.0, 41.0, 701.0, 933.0), &area), Rect::new(240.0, 41.0, 701.0, 933.0));
    }

    #[test]
    fn cut_keeps_a_pane_window_at_its_minimum_away_from_the_other_panes() {
        let area = Rect::new(0.0, 33.0, 1512.0, 949.0);
        let page = Rect::new(240.0, 41.0, 1264.0, 933.0);
        // Two side by side in a 1264 page area at 240: 628 each.
        let left = Rect::new(240.0, 41.0, 628.0, 933.0);
        let right = Rect::new(876.0, 41.0, 628.0, 933.0);
        let notes = Some(Size::new(701.0, 53.0));
        assert_eq!(cut(&left, None, &area, &page, None, None), left, "no minimum: the pane");
        assert_eq!(cut(&left, Some(Size::new(500.0, 300.0)), &area, &page, None, None), left, "fits: the pane");
        // Not asked: the left pane's rest goes left (under the sidebar), the right pane's right (past the display's edge),
        // each under no other pane.
        assert_eq!(cut(&left, notes, &area, &page, None, None), Rect::new(167.0, 41.0, 701.0, 933.0));
        assert_eq!(
            cut(&right, notes, &area, &page, None, None),
            Rect::new(876.0, 41.0, 701.0, 933.0),
            "876…1577: past 1512"
        );
        // Asked: either alignment, never held within the display (a slide at the display's edge).
        assert_eq!(cut(&left, notes, &area, &page, Some(false), None), Rect::new(240.0, 41.0, 701.0, 933.0));
        assert_eq!(cut(&right, notes, &area, &page, Some(true), None), Rect::new(803.0, 41.0, 701.0, 933.0));
        assert_eq!(cut(&right, notes, &area, &page, Some(false), None), Rect::new(876.0, 41.0, 701.0, 933.0));
        // The sidebar hidden, the left pane at the display's edge: past it (-73).
        let full = Rect::new(8.0, 41.0, 1496.0, 933.0);
        let edge = Rect::new(8.0, 41.0, 620.0, 933.0);
        assert_eq!(cut(&edge, notes, &area, &full, None, None), Rect::new(-73.0, 41.0, 701.0, 933.0));
        // Three: the middle one's rest before it (under the left pane), the right one's past the display.
        let a = Rect::new(240.0, 41.0, 416.0, 933.0);
        let b = Rect::new(664.0, 41.0, 416.0, 933.0);
        let c = Rect::new(1088.0, 41.0, 416.0, 933.0);
        assert_eq!(cut(&a, notes, &area, &page, None, None).max_x(), a.max_x());
        assert_eq!(cut(&b, notes, &area, &page, None, None), Rect::new(379.0, 41.0, 701.0, 933.0));
        assert_eq!(cut(&c, notes, &area, &page, None, None), Rect::new(1088.0, 41.0, 701.0, 933.0));
        // A pane as wide as the page (stacked): at its start along x.
        let top = Rect::new(240.0, 41.0, 1264.0, 400.0);
        assert_eq!(cut(&top, Some(Size::new(1300.0, 0.0)), &area, &page, None, None).x, 240.0);
        // A fractional minimum: whole points up.
        assert_eq!(cut(&left, Some(Size::new(700.2, 0.0)), &area, &page, Some(false), None).width, 701.0);
        // Never wider than the area itself.
        assert_eq!(cut(&left, Some(Size::new(4000.0, 0.0)), &area, &page, Some(false), None).width, 1512.0);
        // Stacked (a pane 400 tall, the window's least 600): the top one's rest up (past the display's top), the bottom
        // one's down (past its bottom); asked, either.
        let bottom = Rect::new(240.0, 449.0, 1264.0, 525.0);
        let tall = Some(Size::new(0.0, 600.0));
        assert_eq!(cut(&top, tall, &area, &page, None, None), Rect::new(240.0, -159.0, 1264.0, 600.0));
        assert_eq!(
            cut(&bottom, Some(Size::new(0.0, 700.0)), &area, &page, None, None),
            Rect::new(240.0, 449.0, 1264.0, 700.0)
        );
        assert_eq!(cut(&top, tall, &area, &page, None, Some(false)), Rect::new(240.0, 41.0, 1264.0, 600.0));
    }

    #[test]
    fn fit_holds_a_minimum_right_aligned() {
        let p = kit();
        assert_eq!(fit(&p.page, None, &p.area), p.page);
        assert_eq!(fit(&p.page, Some(Size::new(1000.0, 600.0)), &p.area), p.page, "smaller than the page: the page");
        assert_eq!(fit(&p.page, Some(Size::new(1256.4, 933.0)), &p.area), p.page, "within half a point: the page");
        // Weather, 1048×640, in a page area 1000 wide: 1048 wide, the right edge the page's.
        let page = Rect::new(504.0, 41.0, 1000.0, 933.0);
        assert_eq!(fit(&page, Some(Size::new(1048.0, 640.0)), &p.area), Rect::new(456.0, 41.0, 1048.0, 933.0));
        // A minimum wider than the area: the area's width, from its left.
        assert_eq!(fit(&page, Some(Size::new(1600.2, 640.0)), &p.area), Rect::new(0.0, 41.0, 1512.0, 933.0));
        // Taller: down to the area's bottom at most.
        assert_eq!(fit(&page, Some(Size::new(900.0, 2000.0)), &p.area).height, 941.0);
    }

    #[test]
    fn near_holds_each_side_within_the_tolerance_the_edge_included() {
        let a = Rect::new(248.0, 41.0, 1256.0, 933.0);
        assert!(near(&a, &a, 0.0), "the same rect, no tolerance");
        // Exactly at the tolerance on each side: near; a hair past it, either way: not.
        for (dx, dy, dw, dh) in [(1.0, 0.0, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0)]
        {
            let at = Rect::new(a.x + dx, a.y + dy, a.width + dw, a.height + dh);
            assert!(near(&a, &at, 1.0) && near(&at, &a, 1.0), "{at:?} at the edge");
            let past = Rect::new(a.x + dx * 1.01, a.y + dy * 1.01, a.width + dw * 1.01, a.height + dh * 1.01);
            assert!(!near(&a, &past, 1.0), "{past:?} past the edge");
            let below = Rect::new(a.x - dx * 1.01, a.y - dy * 1.01, a.width - dw * 1.01, a.height - dh * 1.01);
            assert!(!near(&a, &below, 1.0), "{below:?} past the edge the other way");
        }
        // The tolerances the Mac uses: 1 (the default), 2 (Margin's window's corners), 4 (a twin).
        let b = Rect::new(250.0, 43.0, 1254.0, 931.0);
        assert!(!near(&a, &b, 1.0) && near(&a, &b, 2.0) && near(&a, &b, 4.0));
        // Zero-size rects: each side compared as it is, nothing dropped.
        assert!(near(&Rect::ZERO, &Rect::ZERO, 0.0));
        assert!(near(&Rect::ZERO, &Rect::new(1.0, 1.0, 1.0, 1.0), 1.0));
        assert!(!near(&Rect::ZERO, &Rect::new(0.0, 0.0, 0.0, 1.5), 1.0));
        assert!(near(&Rect::new(10.0, 10.0, 0.0, 0.0), &Rect::new(10.5, 9.5, 0.0, 0.0), 1.0), "two points");
        // Touching rects (one's max edge the other's min): apart by their origins.
        let left = Rect::new(0.0, 0.0, 100.0, 100.0);
        assert!(!near(&left, &Rect::new(100.0, 0.0, 100.0, 100.0), 4.0));
        assert!(!near(&left, &Rect::new(0.0, 100.0, 100.0, 100.0), 4.0));
        // A negative tolerance: nothing is near, not even itself; NaN: never near.
        assert!(!near(&a, &a, -1.0));
        assert!(!near(&a, &Rect::new(f64::NAN, 41.0, 1256.0, 933.0), 1.0));
    }

    // The UI's copy (a stacked split's band above a Safari pane) kept equal until the build writes it out.
    #[test]
    fn the_uis_toolbar_room_is_the_cores() {
        let split = include_str!("../../../ui/behaviors/split.ts");
        assert!(split.contains(&format!("export const SAFARI_TOOLBAR = {};", TOOLBAR_ROOM as i64)));
    }

    #[test]
    fn edges_round_trip() {
        let e = Edges { left: 248.0, right: 8.0, top: 8.0, bottom: 8.0 };
        let frame = Rect::new(0.0, 33.0, 1512.0, 949.0);
        assert_eq!(e.outset(&e.inset(&frame)), frame);
        assert_eq!(e.text(), "248/8/8/8");
        assert!(!Edges { left: -1.0, ..Edges::ZERO }.usable());
        assert!(!Edges { top: f64::NAN, ..Edges::ZERO }.usable());
    }
}
