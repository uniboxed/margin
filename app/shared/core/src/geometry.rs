//! Rectangles and points in the window server's coordinates: from the top left of the main display, y down,
//! in points (the browser's `windows.get` units: CSS pixels on the Mac, DIPs on Windows). The Swift shell's
//! CGRect, top-left origin (app/platforms/macos/shell/WindowServer.swift).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const ZERO: Rect = Rect { x: 0.0, y: 0.0, width: 0.0, height: 0.0 };

    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }
    pub fn min_x(&self) -> f64 {
        self.x
    }
    pub fn min_y(&self) -> f64 {
        self.y
    }
    pub fn max_x(&self) -> f64 {
        self.x + self.width
    }
    pub fn max_y(&self) -> f64 {
        self.y + self.height
    }
    pub fn mid_x(&self) -> f64 {
        self.x + self.width / 2.0
    }
    pub fn mid_y(&self) -> f64 {
        self.y + self.height / 2.0
    }
    pub fn is_empty(&self) -> bool {
        !(self.width > 0.0 && self.height > 0.0)
    }
    /// CGRect.contains: the min edges in, the max edges out.
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.min_x() && p.x < self.max_x() && p.y >= self.min_y() && p.y < self.max_y()
    }
    pub fn contains_rect(&self, r: &Rect) -> bool {
        r.min_x() >= self.min_x() && r.max_x() <= self.max_x() && r.min_y() >= self.min_y() && r.max_y() <= self.max_y()
    }
    pub fn intersects(&self, r: &Rect) -> bool {
        !self.intersection(r).is_empty()
    }
    pub fn intersection(&self, r: &Rect) -> Rect {
        let x0 = self.min_x().max(r.min_x());
        let y0 = self.min_y().max(r.min_y());
        let x1 = self.max_x().min(r.max_x());
        let y1 = self.max_y().min(r.max_y());
        if x1 <= x0 || y1 <= y0 { Rect::ZERO } else { Rect::new(x0, y0, x1 - x0, y1 - y0) }
    }
    pub fn union(&self, r: &Rect) -> Rect {
        if self.is_empty() {
            return *r;
        }
        if r.is_empty() {
            return *self;
        }
        let x0 = self.min_x().min(r.min_x());
        let y0 = self.min_y().min(r.min_y());
        Rect::new(x0, y0, self.max_x().max(r.max_x()) - x0, self.max_y().max(r.max_y()) - y0)
    }
    pub fn offset_by(&self, dx: f64, dy: f64) -> Rect {
        Rect::new(self.x + dx, self.y + dy, self.width, self.height)
    }
    pub fn inset_by(&self, dx: f64, dy: f64) -> Rect {
        Rect::new(self.x + dx, self.y + dy, (self.width - 2.0 * dx).max(0.0), (self.height - 2.0 * dy).max(0.0))
    }
    /// "x,y w×h" in whole points, as the Swift shell's logs write a rect (WindowMatcher.describe).
    pub fn describe(&self) -> String {
        format!("{},{} {}×{}", self.x as i64, self.y as i64, self.width as i64, self.height as i64)
    }
}

/// The edge rules of CoreGraphics' CGRect, which the Mac's hosting decisions were written, measured and tuned with
/// (docs/CORE-REFACTOR.md "Geometry semantics"): a zero-size rect is a rect (not "empty"), touching edges don't
/// meet, a rect inset past its size is none (CG's null). Each rect standardized first (a negative size counted from
/// its other edge), as CG does. Checked against CGRect over millions of generated rects (zero, negative and half
/// sizes): the same answers. The decisions that moved from the Mac use these; the rest of the core keeps `Rect`'s own.
pub mod cg {
    use super::Rect;

    /// The rect with a non-negative size, the same area (CGRectStandardize).
    pub fn standard(r: &Rect) -> Rect {
        let (x, width) = if r.width < 0.0 { (r.x + r.width, -r.width) } else { (r.x, r.width) };
        let (y, height) = if r.height < 0.0 { (r.y + r.height, -r.height) } else { (r.y, r.height) };
        Rect::new(x, y, width, height)
    }

    /// Whether two rects meet (CGRectIntersectsRect): along each axis, the one starting first ends past the other's
    /// start; starting at the same point, they meet whatever their sizes (zero ones too). Touching edges: no.
    pub fn meets(a: &Rect, b: &Rect) -> bool {
        let (a, b) = (standard(a), standard(b));
        let axis = |a0: f64, a1: f64, b0: f64, b1: f64| {
            if a0 < b0 {
                a1 > b0
            } else if b0 < a0 {
                b1 > a0
            } else {
                true
            }
        };
        axis(a.min_x(), a.max_x(), b.min_x(), b.max_x()) && axis(a.min_y(), a.max_y(), b.min_y(), b.max_y())
    }

    /// The rect inset by `dx`, `dy` on each side (CGRectInset); None (CG's null) when that leaves a negative size.
    pub fn inset(r: &Rect, dx: f64, dy: f64) -> Option<Rect> {
        let r = standard(r);
        let (width, height) = (r.width - 2.0 * dx, r.height - 2.0 * dy);
        (width >= 0.0 && height >= 0.0).then(|| Rect::new(r.x + dx, r.y + dy, width, height))
    }

    /// The smallest rect holding both (CGRectUnion of two rects that aren't null): a zero-size one counts.
    pub fn union(a: &Rect, b: &Rect) -> Rect {
        let (a, b) = (standard(a), standard(b));
        let (x0, y0) = (a.min_x().min(b.min_x()), a.min_y().min(b.min_y()));
        Rect::new(x0, y0, a.max_x().max(b.max_x()) - x0, a.max_y().max(b.max_y()) - y0)
    }

    /// What two rects share (CGRectIntersection); None (CG's null) when they're apart. Touching edges share a
    /// zero-size rect.
    pub fn intersection(a: &Rect, b: &Rect) -> Option<Rect> {
        let (a, b) = (standard(a), standard(b));
        let (x0, x1) = (a.min_x().max(b.min_x()), a.max_x().min(b.max_x()));
        let (y0, y1) = (a.min_y().max(b.min_y()), a.max_y().min(b.max_y()));
        (x1 >= x0 && y1 >= y0).then(|| Rect::new(x0, y0, x1 - x0, y1 - y0))
    }

    /// The same rect (CGRectEqualToRect: both standardized).
    pub fn same(a: &Rect, b: &Rect) -> bool {
        standard(a) == standard(b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coregraphics_edges() {
        use super::cg;
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        // Touching: apart, sharing a zero-width rect.
        let touch = Rect::new(10.0, 0.0, 10.0, 10.0);
        assert!(!cg::meets(&a, &touch));
        assert_eq!(cg::intersection(&a, &touch), Some(Rect::new(10.0, 0.0, 0.0, 10.0)));
        assert_eq!(cg::intersection(&a, &Rect::new(20.0, 0.0, 5.0, 5.0)), None);
        // A zero-size rect inside, or at the other's start: it meets; at its end: no.
        assert!(cg::meets(&a, &Rect::new(5.0, 0.0, 0.0, 10.0)));
        assert!(cg::meets(&a, &Rect::new(0.0, 0.0, 0.0, 0.0)));
        assert!(!cg::meets(&a, &Rect::new(10.0, 10.0, 0.0, 0.0)));
        assert!(cg::meets(&Rect::new(1.0, 1.0, 0.0, 0.0), &Rect::new(1.0, 1.0, 0.0, 0.0)));
        assert!(!a.intersects(&Rect::new(5.0, 0.0, 0.0, 10.0)), "Rect's own: a zero size never meets");
        // Inset to exactly nothing: a zero-size rect (meeting); past it: none.
        assert_eq!(cg::inset(&a, 5.0, 1.0), Some(Rect::new(5.0, 1.0, 0.0, 8.0)));
        assert_eq!(cg::inset(&a, 6.0, 1.0), None);
        // A zero size kept in a union; a negative size standardized.
        assert_eq!(cg::union(&Rect::new(5.0, 0.0, 0.0, 10.0), &touch), Rect::new(5.0, 0.0, 15.0, 10.0));
        assert!(cg::same(&Rect::new(10.0, 0.0, -10.0, 10.0), &a));
        assert!(cg::meets(&Rect::new(10.0, 0.0, -10.0, 10.0), &a));
    }

    #[test]
    fn contains_is_half_open() {
        let r = Rect::new(0.0, 0.0, 10.0, 10.0);
        assert!(r.contains(Point::new(0.0, 0.0)));
        assert!(!r.contains(Point::new(10.0, 5.0)));
    }

    #[test]
    fn intersection_and_union() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(5.0, 5.0, 10.0, 10.0);
        assert_eq!(a.intersection(&b), Rect::new(5.0, 5.0, 5.0, 5.0));
        assert_eq!(a.union(&b), Rect::new(0.0, 0.0, 15.0, 15.0));
        assert!(!a.intersects(&Rect::new(10.0, 0.0, 5.0, 5.0)));
    }
}
