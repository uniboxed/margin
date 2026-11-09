//! Rectangles and points in the window server's coordinates: from the top left of the main display, y down,
//! in points (the browser's `windows.get` units: CSS pixels on the Mac, DIPs on Windows). The Swift shell's
//! CGRect, top-left origin (app/shell/WindowServer.swift).

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

#[cfg(test)]
mod tests {
    use super::*;

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
