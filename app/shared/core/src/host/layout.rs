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

/// The edges that make a full-screen window the page area: the page's distances from the area's edges, whole
/// points. None: the page can't be reached that way (it passes the area, or leaves less than a point).
pub fn plan(p: &Placement) -> Option<Edges> {
    let edges = Edges {
        left: p.page.min_x() - p.area.min_x(),
        right: p.area.max_x() - p.page.max_x(),
        top: p.page.min_y() - p.area.min_y(),
        bottom: p.area.max_y() - p.page.max_y(),
    }
    .whole();
    if !edges.usable() || p.page.width < 1.0 || p.page.height < 1.0 || p.area.width < 1.0 || p.area.height < 1.0 {
        return None;
    }
    Some(edges)
}

/// A hosted window's tile rect in Margin's Space that puts its full-screen window at the page area: `home` (Margin's
/// own tile, the display's from its top left, the menu bar's band included) less the plan's edges. Measured in the
/// kit (2026-11-17): home 0,0 1512×982, page 248,41 1256×933 in 0,33 1512×949 → tile 248,8 1256×966.
pub fn tile(p: &Placement, home: &Rect) -> Option<Rect> {
    let edges = plan(p)?;
    if home.width < p.area.width - 1.0 || home.height < p.area.height - 1.0 {
        return None;
    }
    let r = edges.inset(home);
    (r.width >= 1.0 && r.height >= 1.0).then_some(r)
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

/// Margin's own tile: the display's whole frame from its top left (None: the display isn't known).
pub fn home(p: &Placement) -> Option<Rect> {
    (p.display.width >= 1.0 && p.display.height >= 1.0).then(|| Rect::new(0.0, 0.0, p.display.width, p.display.height))
}

/// Each of x, y, width and height within `within` points.
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
    fn edges_round_trip() {
        let e = Edges { left: 248.0, right: 8.0, top: 8.0, bottom: 8.0 };
        let frame = Rect::new(0.0, 33.0, 1512.0, 949.0);
        assert_eq!(e.outset(&e.inset(&frame)), frame);
        assert_eq!(e.text(), "248/8/8/8");
        assert!(!Edges { left: -1.0, ..Edges::ZERO }.usable());
        assert!(!Edges { top: f64::NAN, ..Edges::ZERO }.usable());
    }
}
