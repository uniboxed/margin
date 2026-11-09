//! Clicks, scrolling and selection reach the page under an overlay (app/shell/PassThrough.swift; Spike 1, PLAN.md
//! §6): a transparent window still takes the pointer wherever it is, so the overlay lets the pointer through while
//! it's over the theme's page slot, and takes it everywhere else.
//!
//! Over the slot the theme can still draw things that take the pointer (the palette, a menu, a notice, the sidebar
//! out over the page): the overlay's page reports their boxes (`hits`, extension/ui/host-app.ts), and the overlay
//! takes the pointer over them, as the in-page host's pass-through does. While a button is held, nothing changes: a
//! drag that started on the page stays the page's, one that started on Margin stays Margin's.
//!
//! **What the shell does (the Swift `PointerWatch`, left out here: it's the OS's).** It watches the pointer
//! wherever it is, with no special permission: every move and drag, and each press (a press in the browser
//! re-orders the overlays above it), in the window server's coordinates (top left). On each move it asks
//! [`PassThrough::decide`] with whether a button is down and what the overlay does now, and applies the answer:
//! on the Mac `NSWindow.ignoresMouseEvents`; on Windows the overlay's `WS_EX_TRANSPARENT` extended style, turned on
//! (the page gets the pointer) and off (Margin's) with `SetWindowLongPtrW(GWL_EXSTYLE)` from a low-level mouse hook
//! (`WH_MOUSE_LL`) or a timer reading `GetCursorPos` and `GetAsyncKeyState(VK_LBUTTON…)`. It runs only while some
//! overlay is shown (Shell.track: started with the first shown overlay, stopped with the last). The decision is
//! after the fact, so the first move over Margin from the page still reaches the browser: [`CatchRegion`] and
//! [`EdgeGuard`] cover that.

use crate::geometry::{Point, Rect};
use crate::json::{self, Object};
use std::collections::BTreeSet;

/// The page slot of one overlay, in the window server's coordinates (top left).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Slot {
    pub rect: Rect,
    pub radius: f64,
    /// What the theme draws over the slot that takes the pointer.
    pub hits: Vec<Rect>,
    /// The page asked for the whole window (more over the slot than it could list).
    pub capture_all: bool,
}

impl Slot {
    pub fn new(rect: Rect) -> Self {
        Self { rect, ..Self::default() }
    }
}

/// The page's layout report as the slot needs it: the insets of the page slot from the overlay's edges, and its
/// corner radius (the Swift `PageLayout`'s `left`, `top`, `right`, `bottom`, `radius`; the shell reads the rest).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SlotInsets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub radius: f64,
}

pub struct PassThrough;

impl PassThrough {
    /// Whether the page gets the pointer at `point` (the overlay lets it through there).
    pub fn page_gets(point: Point, slot: Option<&Slot>) -> bool {
        let Some(slot) = slot else { return false };
        if slot.capture_all || !slot.rect.contains(point) {
            return false;
        }
        if slot.hits.iter().any(|h| h.contains(point)) {
            return false;
        }
        // Outside a rounded corner of the slot: the theme's.
        let r = slot.radius.min(slot.rect.width / 2.0).min(slot.rect.height / 2.0);
        if r > 0.0 {
            let (min_x, max_x, min_y, max_y) =
                (slot.rect.min_x(), slot.rect.max_x(), slot.rect.min_y(), slot.rect.max_y());
            let cx = if point.x < min_x + r {
                Some(min_x + r)
            } else if point.x > max_x - r {
                Some(max_x - r)
            } else {
                None
            };
            let cy = if point.y < min_y + r {
                Some(min_y + r)
            } else if point.y > max_y - r {
                Some(max_y - r)
            } else {
                None
            };
            if let (Some(cx), Some(cy)) = (cx, cy)
                && (point.x - cx).hypot(point.y - cy) > r
            {
                return false;
            }
        }
        true
    }

    /// What the overlay should do now (true: let the pointer through). `ignoring` is what it does; a held button
    /// keeps it.
    pub fn decide(point: Point, slot: Option<&Slot>, buttons_down: bool, ignoring: bool) -> bool {
        if buttons_down { ignoring } else { Self::page_gets(point, slot) }
    }

    /// The slot from the page's layout report: the overlay's frame (top left) less the insets. `hits` are in the
    /// overlay's coordinates (top left), as the page reports them.
    pub fn slot(frame: Rect, layout: SlotInsets, hits: &[Rect], capture_all: bool) -> Slot {
        let rect = Rect::new(
            frame.min_x() + layout.left,
            frame.min_y() + layout.top,
            (frame.width - layout.left - layout.right).max(0.0),
            (frame.height - layout.top - layout.bottom).max(0.0),
        );
        Slot {
            rect,
            radius: layout.radius,
            hits: hits.iter().map(|h| h.offset_by(frame.min_x(), frame.min_y())).collect(),
            capture_all,
        }
    }
}

/// Where the overlay's own windows take the pointer whatever the pointer-following says (Tirth, 2026-11-06: a
/// scroll over the sidebar scrolled the page behind it; sometimes nothing in the layout took a click). The window
/// server passes the pointer through a window's fully transparent pixels, and the overlay follows the pointer after
/// the fact. So the region that isn't the page's, known from the layout (everything but the slot, less its rounded
/// corners, plus what the theme draws over it; all of it with `capture_all` or no layout yet), is filled at alpha
/// 0.01: under the overlay's web view, and in a catcher just below the overlay that never lets the pointer through
/// and hands what it gets to the overlay (Overlay.swift OverlayCatcher; on Windows a layered window's region or
/// alpha). Only the page slot lets the pointer through.
#[derive(Clone, Debug, PartialEq)]
pub struct CatchRegion {
    /// The whole frame.
    pub all: bool,
    /// The slot, in the frame's coordinates (top left), cut out.
    pub hole: Option<Rect>,
    pub radius: f64,
    /// Filled again over the hole.
    pub hits: Vec<Rect>,
}

impl CatchRegion {
    pub const ALL: CatchRegion = CatchRegion { all: true, hole: None, radius: 0.0, hits: Vec::new() };

    /// For an overlay at `frame` (top left) with this slot (window server coordinates).
    pub fn of(frame: Rect, slot: Option<&Slot>) -> CatchRegion {
        let Some(slot) = slot.filter(|s| !s.capture_all) else { return Self::ALL };
        let hole = slot.rect.offset_by(-frame.min_x(), -frame.min_y()).intersection(&Rect::new(
            0.0,
            0.0,
            frame.width,
            frame.height,
        ));
        if !(hole.width > 0.0 && hole.height > 0.0) {
            return Self::ALL;
        }
        CatchRegion {
            all: false,
            hole: Some(hole),
            radius: slot.radius.min(hole.width / 2.0).min(hole.height / 2.0),
            hits: slot.hits.iter().map(|h| h.offset_by(-frame.min_x(), -frame.min_y())).collect(),
        }
    }

    /// Whether a point (in the frame, top left) is filled: the same answer as `!PassThrough::page_gets`.
    pub fn contains(&self, p: Point, width: f64, height: f64) -> bool {
        if !Rect::new(0.0, 0.0, width, height).contains(p) {
            return false;
        }
        let Some(hole) = self.hole.filter(|_| !self.all) else { return true };
        if self.hits.iter().any(|h| h.contains(p)) {
            return true;
        }
        !PassThrough::page_gets(p, Some(&Slot { rect: hole, radius: self.radius, ..Slot::default() }))
    }
}

/// Which pointer positions an overlay's page wants handed in (app/overlay/overlay.ts reportWant; only peek uses
/// them): none while its sidebar is docked, those within `zone` points of its peek edges while the sidebar is
/// hidden, every one while it's out over the page. Before 2026-11-05 every move over an overlay went in, at 30 a
/// second.
#[derive(Clone, Debug, PartialEq)]
pub struct PointerWant {
    pub mode: WantMode,
    /// "left", "right", "top", "bottom".
    pub edges: BTreeSet<String>,
    pub zone: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WantMode {
    None,
    Edges,
    All,
}

impl WantMode {
    pub fn parse(s: &str) -> Option<WantMode> {
        match s {
            "none" => Some(WantMode::None),
            "edges" => Some(WantMode::Edges),
            "all" => Some(WantMode::All),
            _ => None,
        }
    }
}

impl Default for PointerWant {
    fn default() -> Self {
        Self::ALL
    }
}

impl PointerWant {
    pub const DEFAULT_ZONE: f64 = 24.0;
    pub const ALL: PointerWant = PointerWant { mode: WantMode::All, edges: BTreeSet::new(), zone: Self::DEFAULT_ZONE };

    /// From the page's `pointerWant` body: a mode not known (or none) is `all`, as before the page says.
    pub fn from_json(body: &Object) -> Self {
        let mode = json::string(body.get("mode")).and_then(WantMode::parse).unwrap_or(WantMode::All);
        let edges = json::array(body.get("edges"))
            .map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        let zone = json::num(body.get("zone")).unwrap_or(Self::DEFAULT_ZONE);
        PointerWant { mode, edges, zone }
    }

    /// Whether a position (in the overlay, top left) is wanted.
    pub fn wants(&self, p: Point, width: f64, height: f64) -> bool {
        match self.mode {
            WantMode::None => false,
            WantMode::All => true,
            WantMode::Edges => {
                let has = |e: &str| self.edges.contains(e);
                (has("left") && p.x <= self.zone)
                    || (has("right") && p.x >= width - self.zone)
                    || (has("top") && p.y <= self.zone)
                    || (has("bottom") && p.y >= height - self.zone)
            }
        }
    }
}

/// What keeps the browser's own edge reveal from the pointer (Tirth, 2026-11-05: in full-screen Safari the pointer
/// at the left edge also opened Safari's sidebar behind Margin's). The overlay follows the pointer after the fact,
/// so the first moves at the edge, coming from over the page, still reached the browser. A thin panel at the
/// window's left edge that never lets the pointer through takes them first. Always while its overlay is shown,
/// docked sidebar or not: a quick move from over the page can reach the edge in one step. Not while the overlay
/// takes the whole window anyway (`capture_all`). (Windows: Chrome's full screen has no edge reveal on the left,
/// but its top edge shows the "exit full screen" button; whether a guard is wanted there is unverified.)
pub struct EdgeGuard;

impl EdgeGuard {
    pub const WIDTH: f64 = 4.0;

    /// Its frame (top left) for an overlay at `frame` with this slot, or `None` when none is needed.
    pub fn frame(frame: Rect, slot: Option<&Slot>, width: f64) -> Option<Rect> {
        if width.is_nan() || width <= 0.0 || slot.is_some_and(|s| s.capture_all) {
            return None;
        }
        Some(Rect::new(frame.min_x(), frame.min_y(), width, frame.height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(x: f64, y: f64) -> Point {
        Point::new(x, y)
    }
    const FRAME: Rect = Rect::new(100.0, 50.0, 1280.0, 800.0);
    const DOCKED: SlotInsets = SlotInsets { left: 260.0, top: 8.0, right: 8.0, bottom: 8.0, radius: 10.0 };

    // tools/app-tests/tests.swift passThrough()
    #[test]
    fn the_slot_and_who_gets_the_pointer() {
        let slot = PassThrough::slot(FRAME, DOCKED, &[], false);
        assert_eq!(slot.rect, Rect::new(360.0, 58.0, 1012.0, 784.0), "the slot from the insets, in screen points");
        let s = Some(&slot);
        assert!(PassThrough::page_gets(p(800.0, 400.0), s), "over the page: the page's");
        assert!(!PassThrough::page_gets(p(200.0, 400.0), s), "over the sidebar: Margin's");
        assert!(!PassThrough::page_gets(p(800.0, 54.0), s), "on the frame above the page: Margin's");
        assert!(!PassThrough::page_gets(p(361.0, 59.0), s), "just inside the slot's corner: Margin's (rounded)");
        assert!(PassThrough::page_gets(p(364.0, 62.0), s), "inside the rounding: the page's");
        assert!(PassThrough::page_gets(p(361.0, 400.0), s), "along an edge, past the corner: the page's");
        assert!(!PassThrough::page_gets(p(800.0, 400.0), None), "no slot reported: Margin's everywhere");
        let palette = PassThrough::slot(FRAME, DOCKED, &[Rect::new(400.0, 100.0, 480.0, 300.0)], false);
        assert_eq!(palette.hits, vec![Rect::new(500.0, 150.0, 480.0, 300.0)], "hits from the overlay's coordinates");
        assert!(!PassThrough::page_gets(p(600.0, 200.0), Some(&palette)), "over the palette: Margin's");
        assert!(PassThrough::page_gets(p(1200.0, 600.0), Some(&palette)), "beside the palette: the page's");
        let all = Slot { capture_all: true, ..slot.clone() };
        assert!(!PassThrough::page_gets(p(800.0, 400.0), Some(&all)), "too much to list: Margin's everywhere");
        assert!(PassThrough::decide(p(200.0, 400.0), s, true, true), "a drag from the page stays the page's");
        assert!(!PassThrough::decide(p(800.0, 400.0), s, true, false), "a drag from Margin stays Margin's");
        assert!(PassThrough::decide(p(800.0, 400.0), s, false, false), "let go: decided again");
    }

    #[test]
    fn insets_wider_than_the_frame_give_an_empty_slot() {
        let slot = PassThrough::slot(
            Rect::new(0.0, 0.0, 100.0, 100.0),
            SlotInsets { left: 80.0, right: 80.0, ..SlotInsets::default() },
            &[],
            false,
        );
        assert_eq!(slot.rect.width, 0.0);
        assert!(!PassThrough::page_gets(p(50.0, 50.0), Some(&slot)));
        assert_eq!(CatchRegion::of(Rect::new(0.0, 0.0, 100.0, 100.0), Some(&slot)), CatchRegion::ALL);
    }

    #[test]
    fn the_catch_region_is_exactly_what_isnt_the_pages() {
        let slot = PassThrough::slot(FRAME, DOCKED, &[], false);
        let region = CatchRegion::of(FRAME, Some(&slot));
        let local = |q: Point| p(q.x - FRAME.x, q.y - FRAME.y);
        let probes = [
            (800.0, 400.0),
            (200.0, 400.0),
            (800.0, 54.0),
            (361.0, 59.0),
            (364.0, 62.0),
            (361.0, 400.0),
            (1300.0, 845.0),
        ];
        assert!(!region.all);
        for (x, y) in probes {
            assert_eq!(
                region.contains(local(p(x, y)), FRAME.width, FRAME.height),
                !PassThrough::page_gets(p(x, y), Some(&slot)),
                "probe {x},{y}"
            );
        }
        let palette = PassThrough::slot(FRAME, DOCKED, &[Rect::new(400.0, 100.0, 480.0, 300.0)], false);
        let pr = CatchRegion::of(FRAME, Some(&palette));
        assert!(pr.contains(local(p(600.0, 200.0)), FRAME.width, FRAME.height), "the palette caught too");
        assert!(!pr.contains(local(p(1200.0, 600.0)), FRAME.width, FRAME.height));
        let all = Slot { capture_all: true, ..slot.clone() };
        assert!(CatchRegion::of(FRAME, None).all && CatchRegion::of(FRAME, Some(&all)).all, "everything before a slot");
        assert!(!region.contains(p(-1.0, 10.0), FRAME.width, FRAME.height), "nothing outside the overlay");
    }

    // tools/app-tests/tests.swift edgeAndPointer()
    #[test]
    fn the_edge_guard() {
        let hidden = PassThrough::slot(FRAME, SlotInsets::default(), &[], false);
        let docked = PassThrough::slot(FRAME, DOCKED, &[], false);
        let edge = Rect::new(100.0, 50.0, EdgeGuard::WIDTH, 800.0);
        assert_eq!(EdgeGuard::frame(FRAME, Some(&hidden), EdgeGuard::WIDTH), Some(edge), "the sidebar hidden");
        assert_eq!(EdgeGuard::frame(FRAME, Some(&docked), EdgeGuard::WIDTH), Some(edge), "docked too");
        assert_eq!(EdgeGuard::frame(FRAME, None, EdgeGuard::WIDTH), Some(edge), "before a layout");
        let all = Slot { capture_all: true, ..hidden.clone() };
        assert_eq!(EdgeGuard::frame(FRAME, Some(&all), EdgeGuard::WIDTH), None, "the overlay takes the window");
        assert_eq!(EdgeGuard::frame(FRAME, Some(&hidden), 0.0), None, "no width");
    }

    #[test]
    fn pointer_wants() {
        let obj = |v: serde_json::Value| v.as_object().cloned().unwrap_or_default();
        let (w, h) = (1280.0, 800.0);
        let edges = PointerWant::from_json(&obj(json!({"mode": "edges", "edges": ["left"], "zone": 24})));
        assert!(edges.wants(p(3.0, 400.0), w, h) && edges.wants(p(24.0, 400.0), w, h));
        assert!(!edges.wants(p(25.0, 400.0), w, h) && !edges.wants(p(1279.0, 400.0), w, h));
        let right = PointerWant::from_json(&obj(json!({"mode": "edges", "edges": ["right"], "zone": 10})));
        assert!(right.wants(p(1275.0, 1.0), w, h), "a right-hand theme's");
        assert!(!PointerWant::from_json(&obj(json!({"mode": "none"}))).wants(p(0.0, 0.0), w, h), "none while docked");
        assert!(PointerWant::from_json(&obj(json!({"mode": "all"}))).wants(p(600.0, 400.0), w, h));
        assert_eq!(PointerWant::from_json(&obj(json!({}))).mode, WantMode::All, "before the page says");
        let odd = PointerWant::from_json(&obj(json!({"mode": 3, "edges": "left", "zone": "x"})));
        assert_eq!(odd, PointerWant::ALL, "nothing usable: every position");
    }
}
