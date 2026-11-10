//! The overlay planner (app/platforms/macos/shell/OverlayPlanner.swift, OverlayPlacer.swift, and `Shell.overlayFrame` /
//! `ScreenGeometry.fillsDisplay`), without macOS Spaces: what each overlay should do on a read, decided from facts
//! only ([`OverlayFacts`]), never from the screen: a pure function, so every case is a test and a trace replays
//! through it. Then where it goes ([`overlay_frame`]), and the check, on the next reads, that the OS put it there
//! ([`PlacementCheck`]).
//!
//! **Left out: everything Spaces** (the Space bridge's `join`, the own-Space suspicion `suspect`, a placement
//! ahead read as stale `misplaced`, `spaceToJoin`, `checksOwnSpace`, the placer's Space check). Windows has no
//! Spaces: an overlay is a window owned by its browser window, so the OS keeps it with that window (minimized with
//! it, on its virtual desktop). Every other rule is the Swift's, in the same order, with the same words for the log.
//!
//! What the facts mean on Windows (the shell gathers them): `on_screen` of a [`ServerWindow`] is visible, not
//! minimized (`IsIconic`) and not cloaked (`DWMWA_CLOAKED`: another virtual desktop); `fills` is the window
//! covering its monitor ([`fills_display`], with no top inset: Chrome's full screen covers the whole monitor);
//! `follows_window` is the Swift `ownSpace`, true for an owned overlay.

use crate::geometry::Rect;
use crate::system::ServerWindow;
use crate::time::Secs;

/// What's known of one overlay's window and the overlay on a read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OverlayFacts {
    // Its window, as its copy and the switch say.
    /// In full screen (or windowed overlays allowed).
    pub full: bool,
    /// Its copy's theme is here.
    pub has_theme: bool,
    /// Parked (the Mac's handoff; always false on Windows, kept so the rules stay one).
    pub parked: bool,
    /// A profile switch's target (the handoff's; false for the close-based switch).
    pub target: bool,
    /// The window a switch is making: its overlay's page loads while it goes full screen.
    pub early: bool,
    /// The window the switch leaves, held out (the handoff's).
    pub leaving: bool,
    /// A target the switch has shown (the handoff's R2).
    pub target_ready: bool,
    // Its window, as the window server says.
    /// The window server's window it's bound to.
    pub bound: Option<i64>,
    /// Bound, but missing from this read.
    pub absent: bool,
    pub window: Option<ServerWindow>,
    /// The window fills its display (or windowed overlays allowed).
    pub fills: bool,
    // The overlay as it is (a fresh one if it isn't made yet).
    /// It goes where its window goes (the Mac: in its window's own Space; Windows: owned by its window).
    pub follows_window: bool,
    pub shown: bool,
    /// The window it's shown over.
    pub over: Option<i64>,
    /// Its window's bounds when it was last shown.
    pub window_frame: Option<Rect>,
    /// The active Space changed in the last second (Windows: the virtual desktop), for the log's words.
    pub space_changed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OverlayDecision {
    /// Put away if it's made (not made for this).
    NotWanted(String),
    /// Its window is parked: put away if made.
    Parked,
    /// The window a switch leaves: put away if made.
    Leaving,
    /// Put away.
    Hide(String),
    /// Kept where it is, unseen (its window missing from one read).
    Conceal,
    /// Kept with its window, which isn't showing (minimized, another desktop).
    Reveal,
    /// Placed with its window ahead of a visit if the shell can, else put away with these words.
    PlaceAhead { or_hide: String },
    /// Moving with its window: left as it is.
    Keep,
    /// Shown over that window.
    Show(i64),
}

impl OverlayDecision {
    /// Whether the overlay is made for it (the first three put away only one that's made).
    pub fn needs_overlay(&self) -> bool {
        !matches!(self, Self::NotWanted(_) | Self::Parked | Self::Leaving)
    }
    /// Whether the read went past the switch's held-out check (a key held out but no longer leaving is let go then).
    pub fn past_held_out(&self) -> bool {
        !matches!(self, Self::NotWanted(_) | Self::Parked)
    }
}

pub fn decide(f: &OverlayFacts) -> OverlayDecision {
    let wanted = (f.full || f.parked || f.target) && f.has_theme;
    if !(wanted || f.early) {
        return OverlayDecision::NotWanted(
            if f.has_theme { "its window isn't in full screen" } else { "no theme yet" }.into(),
        );
    }
    if f.parked && !f.target {
        return OverlayDecision::Parked;
    }
    if f.leaving {
        return OverlayDecision::Leaving;
    }
    // Never shown over a window that isn't bound, isn't on screen, or doesn't fill its display yet.
    if !(f.full || f.target_ready) {
        return OverlayDecision::Hide("its window is still being made".into());
    }
    let Some(number) = f.bound else {
        return OverlayDecision::Hide("its window isn't bound to one of the window server's".into());
    };
    if f.absent {
        return OverlayDecision::Conceal;
    }
    let Some(server) = &f.window else {
        return OverlayDecision::Hide("its window is gone from the window server".into());
    };
    // Kept where it is over its window: shown over this window, at its size (a slide moves the window, it doesn't
    // resize it).
    let kept = f.follows_window
        && f.shown
        && f.over == Some(number)
        && f.window_frame.is_some_and(|w| same_size(&w, &server.bounds));
    if !server.on_screen {
        if kept {
            return OverlayDecision::Reveal;
        }
        let or_hide = if f.space_changed {
            "the active Space changed and its window isn't on screen"
        } else {
            "its window isn't on screen"
        };
        return OverlayDecision::PlaceAhead { or_hide: or_hide.into() };
    }
    if !f.fills {
        return if kept {
            OverlayDecision::Keep
        } else {
            OverlayDecision::Hide("its window doesn't fill its display (going into or out of full screen)".into())
        };
    }
    OverlayDecision::Show(number)
}

/// Whether two bounds have the same size (to a point): a window offset in a slide is the same window.
pub fn same_size(a: &Rect, b: &Rect) -> bool {
    (a.width - b.width).abs() <= 1.0 && (a.height - b.height).abs() <= 1.0
}

/// A part of the window this close to its edge is taken as at the edge (Shell.edgeSnap).
pub const EDGE_SNAP: f64 = 2.0;

/// Where an overlay goes over its window (Shell.overlayFrame): the whole window, or the part the browser gives
/// the page (`viewport`, in the window's coordinates: the Web Inspector docked takes the rest), rounded, snapped to
/// the window's edges within [`EDGE_SNAP`]. A part too small to lay out in (under 200 points either way) or outside
/// the window: the whole window. `docked_left`: the overlay's docked sidebar's width ([`docked_left`]); a part on
/// the left no wider than it is kept under the overlay (the browser's own sidebar sliding in under Margin's, step
/// by step: no back and forth), a wider one carved out at once.
pub fn overlay_frame(window: Rect, viewport: Option<Rect>, docked_left: Option<f64>) -> Rect {
    let Some(viewport) = viewport else { return window };
    let part = viewport.offset_by(window.min_x(), window.min_y()).intersection(&window);
    if !(part.width >= 200.0 && part.height >= 200.0) {
        return window;
    }
    let part = Rect::new(part.x.round(), part.y.round(), part.width.round(), part.height.round());
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (part.min_x(), part.min_y(), part.max_x(), part.max_y());
    if min_x - window.min_x() <= EDGE_SNAP {
        min_x = window.min_x();
    }
    if min_y - window.min_y() <= EDGE_SNAP {
        min_y = window.min_y();
    }
    if window.max_x() - max_x <= EDGE_SNAP {
        max_x = window.max_x();
    }
    if window.max_y() - max_y <= EDGE_SNAP {
        max_y = window.max_y();
    }
    if let Some(docked) = docked_left
        && min_x > window.min_x()
        && min_x - window.min_x() <= docked
    {
        min_x = window.min_x();
    }
    Rect::new(min_x, min_y, max_x - min_x, max_y - min_y)
}

/// The widest a window's border beside its page area is taken to be (Windows: Chrome's 1 px frame line inside the
/// visible frame; the invisible resize borders are outside it). More than this each side: something else (DevTools
/// docked, the browser's side panel) has that width.
pub const PAGE_BORDER_MAX: f64 = 4.0;

/// Where an overlay goes over a window that isn't in full screen (the shell's `windowed_too`, on Windows), and the
/// window its layout's insets are measured from. Not the Mac's (windowed is its Phase 4); there the window is
/// [`overlay_frame`]'s.
///
/// - `window`: the window's visible frame, as the OS lists it; `outer`: its bounds as the browser reports them
///   (`windows.get`, which on Windows has the invisible resize borders too: about 7 points left, right and below);
///   `viewport`: where its page area sits in `outer`, as its copy said (`x` and `y` a guess unless `measured`: all of
///   the missing width taken to be on the left, the missing height on top, as `boxFromLayout` takes them).
/// - The overlay goes over the page area only, the viewport's size: never over the browser's tabs and toolbar.
///   Horizontally it's centred in the visible frame when the width beyond it is only the borders, else where the
///   copy said; its bottom is the visible frame's, less a border as wide as a side's, unless measured.
/// - The second rect is the window the insets are measured from: placed so that the copy, taking its page area to be
///   where it said in its own window (`boxFromLayout`: insets less its offsets), puts the page's box exactly where
///   the slot is. Its size is the copy's window's (`container` matches its `windows.get` size).
/// - No viewport said yet, or a page area under 200 points either way: the whole window, both ways.
pub fn windowed_frame(window: Rect, outer: Option<Rect>, viewport: Option<Rect>, measured: bool) -> (Rect, Rect) {
    let outer = outer.filter(|o| !o.is_empty()).unwrap_or(window);
    let Some(v) = viewport.filter(|v| v.width >= 200.0 && v.height >= 200.0) else { return (window, window) };
    let beyond = window.width - v.width;
    let spans = (-1.0..=2.0 * PAGE_BORDER_MAX).contains(&beyond);
    let border = if spans { (beyond / 2.0).max(0.0) } else { 0.0 };
    let x = if spans {
        window.min_x() + border
    } else if measured {
        outer.min_x() + v.x
    } else {
        window.max_x() - v.width
    };
    let y = if measured { outer.min_y() + v.y } else { window.max_y() - border - v.height };
    let part = Rect::new(x.round(), y.round(), v.width.round(), v.height.round()).intersection(&window);
    if !(part.width >= 200.0 && part.height >= 200.0) {
        return (window, window);
    }
    let from = Rect::new(part.x - v.x, part.y - v.y, outer.width, outer.height);
    (part, from)
}

/// How wide an overlay's docked sidebar is (Shell.dockedLeft): its last layout's left inset, while its page wants
/// no pointer positions (`PointerWant` none: Margin's sidebar docked); `None` otherwise.
pub fn docked_left(wants_no_pointer: bool, layout_left: Option<f64>) -> Option<f64> {
    layout_left.filter(|l| wants_no_pointer && *l > 0.0)
}

/// Room below a display's top a full-screen window's top may be at (a notched display's camera housing, the menu
/// bar kept in full screen; ScreenGeometry.topRoom).
pub const TOP_ROOM: f64 = 60.0;

/// One display as [`fills_display`] needs it: its frame (top left) and its own top inset.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    pub frame: Rect,
    pub top_inset: f64,
}

/// Whether a window's bounds fill one display's height, as a full-screen window's do (ScreenGeometry.fillsDisplay):
/// inside the display, its bottom at the display's, its top at the display's or a little below (`TOP_ROOM`, or the
/// display's top inset if that's more). A window going into or out of full screen doesn't, mostly, while the OS
/// animates it. (Windows: a maximized window stops at the taskbar, so it doesn't; Chrome's full screen does.)
pub fn fills_display(bounds: &Rect, displays: &[Display]) -> bool {
    displays.iter().any(|d| {
        bounds.min_x() >= d.frame.min_x() - 1.0
            && bounds.max_x() <= d.frame.max_x() + 1.0
            && (bounds.max_y() - d.frame.max_y()).abs() <= 1.0
            && bounds.min_y() >= d.frame.min_y() - 1.0
            && bounds.min_y() <= d.frame.min_y() + d.top_inset.max(TOP_ROOM) + 1.0
    })
}

/// What's recorded at each show (OverlayPlacer.swift `PlacedOverlay`).
#[derive(Clone, Debug, PartialEq)]
pub struct PlacedOverlay {
    /// Its own window's number.
    pub overlay: i64,
    /// The window it's shown over.
    pub window: i64,
    /// The frame asked (top left).
    pub frame: Rect,
    /// Its window's bounds then.
    pub window_bounds: Rect,
    pub at: Secs,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlacementFix {
    /// Ordered in again over its window (why).
    Reorder(String),
    /// What the OS has instead of the frame asked (only said).
    Frame(Rect),
}

/// The placer's check (OverlayPlacer.swift), Spaces left out: on the next reads, for an overlay over a window on
/// screen at the bounds it had (a window moving isn't judged: nothing's settled), (1) on screen: not, while its
/// window is → ordered in again; (2) its frame: not the one asked → said. Each only once the placement is `GRACE`
/// old and on two reads in a row (a read just after an order can lag). Not its order against its window: the
/// list's order isn't front to back between Margin's windows and the browser's (a real session's trace 2026-11-07).
pub struct PlacementCheck;

impl PlacementCheck {
    pub const GRACE: Secs = 0.2;

    /// What's wrong with a placement on this read, if anything: (wrong, the fix). `overlay` and `window`: those
    /// windows in the read (`None`: not in it). `misses`: how many reads in a row it was already wrong on; a fix
    /// comes on the second.
    pub fn check(
        p: &PlacedOverlay,
        overlay: Option<&ServerWindow>,
        window: Option<&ServerWindow>,
        now: Secs,
        misses: u32,
    ) -> (bool, Option<PlacementFix>) {
        let (Some(w), Some(o)) = (window, overlay) else { return (false, None) };
        if now - p.at < Self::GRACE || !w.on_screen || w.bounds != p.window_bounds {
            return (false, None);
        }
        let fix = |f: PlacementFix| (true, (misses >= 1).then_some(f));
        if !o.on_screen {
            return fix(PlacementFix::Reorder("not on screen while its window is".into()));
        }
        let (a, b) = (&o.bounds, &p.frame);
        if (a.min_x() - b.min_x()).abs() > 1.0
            || (a.min_y() - b.min_y()).abs() > 1.0
            || (a.width - b.width).abs() > 1.0
            || (a.height - b.height).abs() > 1.0
        {
            return fix(PlacementFix::Frame(o.bounds));
        }
        (false, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_windowed_overlay_is_over_the_page_area_and_lays_out_in_the_copys_window() {
        // Chrome on Windows at 100 %: visible frame 100,50 1200×800; windows.get 7 points wider each side and below;
        // its page 1198×710 (1 point frame lines), said at x 16 (all the missing width on the left), y 97.
        let window = Rect::new(100.0, 50.0, 1200.0, 800.0);
        let outer = Rect::new(93.0, 50.0, 1214.0, 807.0);
        let viewport = Rect::new(16.0, 97.0, 1198.0, 710.0);
        let (frame, from) = windowed_frame(window, Some(outer), Some(viewport), false);
        assert_eq!(frame, Rect::new(101.0, 139.0, 1198.0, 710.0), "under the toolbar, between the frame lines");
        assert_eq!((from.width, from.height), (1214.0, 807.0), "the copy's window's size, its container");
        // A slot 300 points in from the overlay's left: the copy takes its page to start at its x, so the box is 300.
        let slot_left = frame.x + 300.0;
        let inset = slot_left - from.x;
        assert_eq!(inset - viewport.x, 300.0);
        let slot_right = frame.max_x() - 20.0;
        let right_inset = from.max_x() - slot_right;
        assert_eq!(right_inset - (outer.width - viewport.width - viewport.x), 20.0);
        let slot_top = frame.y + 10.0;
        assert_eq!((slot_top - from.y) - viewport.y, 10.0);
    }

    #[test]
    fn a_windowed_page_beside_something_docked_goes_where_the_copy_says() {
        let window = Rect::new(0.0, 0.0, 1200.0, 800.0);
        let outer = Rect::new(-7.0, 0.0, 1214.0, 807.0);
        // DevTools docked right, 400 wide, and the page's place measured.
        let measured = Rect::new(8.0, 90.0, 790.0, 709.0);
        let (frame, from) = windowed_frame(window, Some(outer), Some(measured), true);
        assert_eq!(frame, Rect::new(1.0, 90.0, 790.0, 709.0));
        assert_eq!((from.x, from.y), (-7.0, 0.0), "measured: the copy's own window");
        // Not measured: the missing width is the copy's left, so is the overlay's.
        let guessed = Rect::new(424.0, 98.0, 790.0, 709.0);
        let (frame, _) = windowed_frame(window, Some(outer), Some(guessed), false);
        assert_eq!((frame.x, frame.max_x(), frame.max_y()), (410.0, 1200.0, 800.0));
    }

    #[test]
    fn a_windowed_overlay_with_no_page_area_said_is_over_the_whole_window() {
        let window = Rect::new(0.0, 0.0, 1200.0, 800.0);
        assert_eq!(windowed_frame(window, None, None, false), (window, window));
        let tiny = Rect::new(8.0, 90.0, 150.0, 709.0);
        assert_eq!(windowed_frame(window, Some(window), Some(tiny), false), (window, window));
    }

    const FULL: Rect = Rect::new(0.0, 0.0, 1512.0, 982.0);

    fn win(n: i64, on: bool, b: Rect) -> ServerWindow {
        ServerWindow { on_screen: on, ..ServerWindow::new(n, 50, b) }
    }
    // A full-screen window of a linked copy, bound, on screen, filling its display, its overlay not shown yet.
    fn base() -> OverlayFacts {
        OverlayFacts {
            full: true,
            has_theme: true,
            bound: Some(100),
            window: Some(win(100, true, FULL)),
            fills: true,
            follows_window: true,
            ..OverlayFacts::default()
        }
    }
    fn d(change: impl FnOnce(&mut OverlayFacts)) -> OverlayDecision {
        let mut f = base();
        change(&mut f);
        decide(&f)
    }
    fn hide(s: &str) -> OverlayDecision {
        OverlayDecision::Hide(s.into())
    }
    fn kept(f: &mut OverlayFacts) {
        f.shown = true;
        f.over = Some(100);
        f.window_frame = Some(FULL);
        f.window = Some(win(100, false, FULL));
    }

    // app/platforms/macos/shell/tests/window-tests.swift overlayPlanner(), its Spaces-free rules.
    #[test]
    fn wanted_or_not() {
        assert_eq!(d(|_| {}), OverlayDecision::Show(100), "a bound full-screen window on screen");
        let none = d(|f| f.has_theme = false);
        assert_eq!(none, OverlayDecision::NotWanted("no theme yet".into()));
        assert!(!none.needs_overlay());
        assert_eq!(d(|f| f.full = false), OverlayDecision::NotWanted("its window isn't in full screen".into()));
        assert_eq!(
            d(|f| {
                f.full = false;
                f.early = true
            }),
            hide("its window is still being made"),
            "the window a switch is making: made early, held until it's full screen"
        );
    }

    #[test]
    fn the_handoffs_facts_keep_their_rules() {
        assert_eq!(d(|f| f.parked = true), OverlayDecision::Parked);
        assert_eq!(
            d(|f| {
                f.parked = true;
                f.target = true
            }),
            OverlayDecision::Show(100)
        );
        let leaving = d(|f| f.leaving = true);
        assert_eq!(leaving, OverlayDecision::Leaving);
        assert!(leaving.past_held_out() && !leaving.needs_overlay());
        assert!(!OverlayDecision::Parked.past_held_out());
        assert_eq!(
            d(|f| {
                f.full = false;
                f.target = true
            }),
            hide("its window is still being made")
        );
        assert_eq!(
            d(|f| {
                f.full = false;
                f.target = true;
                f.target_ready = true
            }),
            OverlayDecision::Show(100)
        );
    }

    #[test]
    fn bound_and_listed() {
        assert_eq!(
            d(|f| {
                f.bound = None;
                f.window = None
            }),
            hide("its window isn't bound to one of the window server's")
        );
        assert_eq!(d(|f| f.absent = true), OverlayDecision::Conceal, "missing from one read: concealed where it is");
        assert_eq!(d(|f| f.window = None), hide("its window is gone from the window server"));
    }

    #[test]
    fn off_screen() {
        let ahead = |s: &str| OverlayDecision::PlaceAhead { or_hide: s.into() };
        assert_eq!(d(|f| f.window = Some(win(100, false, FULL))), ahead("its window isn't on screen"));
        assert_eq!(
            d(|f| {
                f.window = Some(win(100, false, FULL));
                f.space_changed = true
            }),
            ahead("the active Space changed and its window isn't on screen")
        );
        assert_eq!(d(kept), OverlayDecision::Reveal, "kept with its window that isn't showing: left there");
        assert_eq!(
            d(|f| {
                kept(f);
                f.follows_window = false
            }),
            ahead("its window isn't on screen"),
            "an overlay that doesn't follow its window: never kept"
        );
    }

    #[test]
    fn sliding_and_resizing() {
        let offset = Rect::new(600.0, 0.0, 1512.0, 982.0);
        let shown_over = |f: &mut OverlayFacts| {
            f.shown = true;
            f.over = Some(100);
            f.window_frame = Some(FULL);
        };
        assert_eq!(
            d(|f| {
                shown_over(f);
                f.window = Some(win(100, true, offset));
                f.fills = false
            }),
            OverlayDecision::Keep,
            "on screen at its size but offset (a swipe): left to slide with it"
        );
        let leaves = hide("its window doesn't fill its display (going into or out of full screen)");
        assert_eq!(
            d(|f| {
                f.window = Some(win(100, true, offset));
                f.fills = false
            }),
            leaves,
            "not kept: put away for the slide"
        );
        assert_eq!(
            d(|f| {
                shown_over(f);
                f.window = Some(win(100, true, Rect::new(100.0, 100.0, 900.0, 700.0)));
                f.fills = false
            }),
            leaves,
            "resized (out of full screen)"
        );
        assert_eq!(
            d(|f| {
                f.shown = true;
                f.over = Some(99);
                f.window_frame = Some(FULL)
            }),
            OverlayDecision::Show(100),
            "shown over another window before: shown over this one"
        );
        assert!(
            same_size(&FULL, &Rect::new(5.0, 5.0, 1513.0, 981.0))
                && !same_size(&FULL, &Rect::new(0.0, 0.0, 1510.0, 982.0))
        );
    }

    // app/platforms/macos/shell/tests/tests.swift safariParts(): the docked Web Inspector.
    #[test]
    fn the_overlays_frame() {
        let w = Rect::new(0.0, 33.0, 1512.0, 949.0);
        let f = |v: Rect, docked: Option<f64>| overlay_frame(w, Some(v), docked);
        assert_eq!(overlay_frame(w, None, None), w, "no viewport said: the whole window");
        assert_eq!(
            f(Rect::new(0.0, 0.0, 1512.0, 600.0), None),
            Rect::new(0.0, 33.0, 1512.0, 600.0),
            "docked at the bottom"
        );
        assert_eq!(f(Rect::new(0.0, 0.0, 1000.0, 949.0), None), Rect::new(0.0, 33.0, 1000.0, 949.0), "on the right");
        assert_eq!(f(Rect::new(512.0, 0.0, 1000.0, 949.0), None), Rect::new(512.0, 33.0, 1000.0, 949.0), "on the left");
        assert_eq!(f(Rect::new(0.0, 0.0, 150.0, 949.0), None), w, "too small to lay out in");
        assert_eq!(f(Rect::new(4000.0, 0.0, 800.0, 900.0), None), w, "outside the window");
        for x in [19.0, 213.0, 238.0, 239.0, 240.0, 177.0, 54.0, 2.0, 115.0, 222.0, 237.0, 240.0, 215.0, 84.0, 2.0] {
            assert_eq!(f(Rect::new(x, 0.0, 1512.0 - x, 949.0), Some(260.0)), w, "under a docked sidebar at {x}");
        }
        assert_eq!(f(Rect::new(0.0, 0.0, 1511.0, 949.0), Some(260.0)), w, "1 pt short on the right");
        assert_eq!(f(Rect::new(0.0, 0.0, 1511.0, 949.0), None), w);
        assert_eq!(f(Rect::new(2.0, 0.0, 1510.0, 949.0), None), w, "2 pt or less off the edge: the edge");
        assert_eq!(f(Rect::new(500.0, 0.0, 1012.0, 949.0), Some(260.0)), Rect::new(500.0, 33.0, 1012.0, 949.0));
        assert_eq!(f(Rect::new(261.0, 0.0, 1251.0, 949.0), Some(260.0)), Rect::new(261.0, 33.0, 1251.0, 949.0));
        assert_eq!(f(Rect::new(240.0, 0.0, 1272.0, 949.0), None), Rect::new(240.0, 33.0, 1272.0, 949.0), "not docked");
        assert_eq!(
            f(Rect::new(240.0, 0.0, 1272.0, 600.0), Some(260.0)),
            Rect::new(0.0, 33.0, 1512.0, 600.0),
            "under the docked sidebar with an inspector at the bottom too: only the bottom carved"
        );
        assert_eq!(docked_left(true, Some(260.0)), Some(260.0));
        assert_eq!(docked_left(false, Some(260.0)), None);
        assert_eq!(docked_left(true, Some(0.0)), None);
        assert_eq!(docked_left(true, None), None);
    }

    #[test]
    fn filling_a_display() {
        let laptop = [Display { frame: Rect::new(0.0, 0.0, 1512.0, 982.0), top_inset: 33.0 }];
        assert!(fills_display(&Rect::new(0.0, 33.0, 1512.0, 949.0), &laptop), "below the notch");
        assert!(fills_display(&Rect::new(0.0, 0.0, 1512.0, 982.0), &laptop), "the whole display");
        assert!(fills_display(&Rect::new(0.0, 0.0, 756.0, 982.0), &laptop), "one side of a split");
        assert!(!fills_display(&Rect::new(0.0, 0.0, 1512.0, 940.0), &laptop), "above a taskbar: not");
        assert!(!fills_display(&Rect::new(0.0, 100.0, 1512.0, 882.0), &laptop), "its top too far down");
        assert!(!fills_display(&Rect::new(1600.0, 0.0, 1512.0, 982.0), &laptop), "on no display");
        assert!(!fills_display(&FULL, &[]));
    }

    // app/platforms/macos/shell/tests/window-tests.swift placementCheck(), less the Space bridge's.
    #[test]
    fn the_placement_check() {
        let side = Rect::new(0.0, 0.0, 300.0, 982.0);
        let p = PlacedOverlay { overlay: 900, window: 100, frame: side, window_bounds: FULL, at: 9.5 };
        let ov = |on: bool, b: Rect| ServerWindow { on_screen: on, ..ServerWindow::new(900, 7, b) };
        let c = |o: Option<ServerWindow>, w: Option<ServerWindow>, misses: u32, now: Secs| {
            PlacementCheck::check(&p, o.as_ref(), w.as_ref(), now, misses)
        };
        let w = Some(win(100, true, FULL));
        assert_eq!(c(Some(ov(true, side)), w.clone(), 1, 10.0), (false, None), "where it was asked");
        let reorder = PlacementFix::Reorder("not on screen while its window is".into());
        assert_eq!(c(Some(ov(false, side)), w.clone(), 1, 10.0), (true, Some(reorder)), "ordered in again");
        assert_eq!(c(Some(ov(false, side)), w.clone(), 0, 10.0), (true, None), "on the second read in a row");
        let narrow = Rect::new(0.0, 0.0, 260.0, 982.0);
        assert_eq!(c(Some(ov(true, narrow)), w.clone(), 1, 10.0), (true, Some(PlacementFix::Frame(narrow))), "said");
        assert_eq!(
            c(Some(ov(true, Rect::new(1.0, 0.5, 300.5, 982.0))), w.clone(), 1, 10.0),
            (false, None),
            "to a point"
        );
        assert_eq!(c(Some(ov(false, side)), w.clone(), 1, 9.6), (false, None), "within the grace");
        assert_eq!(
            c(Some(ov(false, side)), Some(win(100, false, FULL)), 1, 10.0),
            (false, None),
            "its window off screen"
        );
        let slid = Some(win(100, true, Rect::new(600.0, 0.0, 1512.0, 982.0)));
        assert_eq!(c(Some(ov(false, side)), slid, 1, 10.0), (false, None), "its window moved or sliding");
        assert_eq!(c(None, w.clone(), 1, 10.0), (false, None), "the overlay not in the read");
        assert_eq!(c(Some(ov(false, side)), None, 1, 10.0), (false, None), "its window not in the read");
    }
}
