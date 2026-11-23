//! Which window of the hosted app the person opened in Margin's Space is let in front of Margin's window (until it's
//! gone): the rules of the Mac's `lookForOthers`, any OS's. Read at each look at rest, from the window server's list
//! (front to back): layer 0, visible, not a hosted window, not Margin's, on Margin's display and reaching outside the page
//! area (one inside it shows through the hole and takes its clicks as it is: a sheet, a small Settings window).
//!
//! Only when all of these hold (2026-11-17, the person's log: Margin let his own other apps' full-screen windows of other
//! Spaces in front as he swiped, again and again):
//! - the list is a picture of Margin's Space at rest (the caller's: it asks `unsteady` otherwise);
//! - the window's Space, read in the same look, is Margin's and nothing else (`margin_only`, the caller's read);
//! - it was seen so at two looks in a row at least `confirm` apart;
//! - its app is the one shown. Never a window of an app Margin doesn't host (such an app can't put a normal window in
//!   another app's full-screen Space; what it shows there is a Space change's picture or a panel at a higher layer).
//!   Never one of a hosted app that isn't the one shown (the person can't have opened it: its app is out of sight), nor
//!   one first seen right after an operation (`fresh`: it came with it), nor a full-screen window's toolbar strip, one
//!   over Margin's sidebar, or one the observed model keeps behind (`kept_behind`: a leftover, a strip, a transient one).
//!   No per-app rules.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::kinds;
use super::layout::Placement;
use crate::geometry::Rect;

/// The least side of a window that may be let in front.
pub const LEAST_SIDE: f64 = 80.0;
/// A window reaching over Margin's sidebar more than this each way is never let in front.
pub const SIDEBAR_SLIVER: f64 = 8.0;
/// The least time between the two looks that see a window before it's let in front.
pub const CONFIRM: f64 = 0.2;
/// The narrowest sidebar (less: hidden, nothing to keep clear).
const SIDEBAR_LEAST: f64 = 40.0;

/// One window of the list, as the caller read it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OtherWin {
    pub number: i64,
    pub pid: u32,
    pub layer: i64,
    pub alpha: f64,
    pub bounds: Rect,
    /// The observed model keeps it behind (its kind: leftover, strip, transient).
    pub kept_behind: bool,
    /// Its Spaces, read in this look, are Margin's alone (read only for the shown app's windows; false otherwise).
    pub margin_only: bool,
}

/// What a look reads.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Look {
    pub now: f64,
    pub windows: Vec<OtherWin>,
    pub own_pid: u32,
    pub margin_window: i64,
    pub hosted: Vec<i64>,
    /// The app of the host shown (none: nothing shown).
    pub shown_pid: Option<u32>,
    /// The apps of every visible host (docs/PEEK-SPLIT.md §1: a card's, a split's panes'), the shown one's among them
    /// or not: their windows count as the shown app's.
    pub visible_pids: Vec<u32>,
    /// The visible hosts' own rects (a card's, a pane's): a window as wide as one of them, short, is its toolbar strip.
    pub rects: Vec<Rect>,
    pub placement: Placement,
    /// An operation ran since the last look: what's first seen now came with it.
    pub fresh: bool,
}

/// What's kept from look to look.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Others {
    /// Each window seen at the last look, and whether it may be let in front (decided when first seen).
    seen: BTreeMap<i64, bool>,
    /// When each window that may be let in front was first seen so, in looks in a row.
    since: BTreeMap<i64, f64>,
    /// The one let in front now.
    pub said: Option<i64>,
}

impl Others {
    /// Nothing hosted: nothing seen, nothing let in front.
    pub fn reset(&mut self) {
        self.seen.clear();
        self.since.clear();
        self.said = None;
    }

    /// Margin's Space not at rest: seen again from the start at the next look at rest (the one let in front kept).
    pub fn unsteady(&mut self) {
        self.since.clear();
    }

    /// The window let in front now (None: none).
    pub fn look(&mut self, l: &Look) -> Option<i64> {
        let page = l.placement.page.inset_by(-1.0, -1.0);
        let area = l.placement.area;
        let sidebar = sidebar(&l.placement);
        let mut front = None;
        let mut seen = BTreeMap::new();
        let mut since = BTreeMap::new();
        for w in &l.windows {
            if w.layer != 0
                || w.pid == l.own_pid
                || w.number == l.margin_window
                || w.alpha <= 0.0
                || l.hosted.contains(&w.number)
            {
                continue;
            }
            let b = &w.bounds;
            if b.width < LEAST_SIDE || b.height < LEAST_SIDE || !b.intersects(&area) || page.contains_rect(b) {
                continue;
            }
            let shown = l.shown_pid == Some(w.pid) || l.visible_pids.contains(&w.pid);
            let lets = self.seen.get(&w.number).copied().unwrap_or(!l.fresh && shown);
            seen.insert(w.number, lets);
            if !lets
                || !shown
                || kinds::is_strip_of_any(b, &l.placement, &l.rects)
                || over(b, sidebar.as_ref())
                || w.kept_behind
                || !w.margin_only
            {
                continue;
            }
            let first = self.since.get(&w.number).copied().unwrap_or(l.now);
            since.insert(w.number, first);
            if front.is_none() && l.now - first >= CONFIRM - 1e-9 {
                front = Some(w.number);
            }
        }
        self.seen = seen;
        // (The one let in front still there, still in Margin's Space alone: kept until it's gone.)
        if front.is_none() {
            front = self.said.filter(|was| since.contains_key(was));
        }
        self.since = since;
        self.said = front;
        front
    }
}

/// Margin's sidebar: the display's area left of the page area (none narrower than `SIDEBAR_LEAST`: hidden).
fn sidebar(p: &Placement) -> Option<Rect> {
    let width = p.page.min_x() - p.area.min_x();
    (width >= SIDEBAR_LEAST && p.area.height > 0.0)
        .then(|| Rect::new(p.area.min_x(), p.area.min_y(), width, p.area.height))
}

/// Whether `b` reaches over the sidebar more than `SIDEBAR_SLIVER` each way.
fn over(b: &Rect, side: Option<&Rect>) -> bool {
    side.is_some_and(|s| {
        let i = b.intersection(s);
        !i.is_empty() && i.width > SIDEBAR_SLIVER && i.height > SIDEBAR_SLIVER
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHOWN: u32 = 50;
    fn placement() -> Placement {
        Placement {
            page: Rect::new(260.0, 0.0, 1252.0, 982.0),
            area: Rect::new(0.0, 0.0, 1512.0, 982.0),
            display: Rect::ZERO,
        }
    }
    fn win(number: i64, pid: u32, bounds: Rect) -> OtherWin {
        OtherWin { number, pid, layer: 0, alpha: 1.0, bounds, kept_behind: false, margin_only: true }
    }
    fn look(now: f64, windows: Vec<OtherWin>, fresh: bool) -> Look {
        Look {
            now,
            windows,
            own_pid: 1,
            margin_window: 10,
            hosted: vec![20],
            shown_pid: Some(SHOWN),
            visible_pids: vec![],
            rects: vec![],
            placement: placement(),
            fresh,
        }
    }
    // A window of the shown app reaching outside the page area (a second document window, over the page's top edge).
    fn second() -> OtherWin {
        win(30, SHOWN, Rect::new(400.0, -20.0, 900.0, 600.0))
    }

    #[test]
    fn the_shown_apps_window_is_let_in_front_at_the_second_look_and_kept_until_its_gone() {
        let mut o = Others::default();
        assert_eq!(o.look(&look(0.0, vec![second()], false)), None, "first seen: not yet");
        assert_eq!(o.look(&look(0.1, vec![second()], false)), None, "too soon after");
        assert_eq!(o.look(&look(0.25, vec![second()], false)), Some(30));
        // (Kept while it's there, though another of its app's opens meanwhile.)
        let third = win(31, SHOWN, Rect::new(300.0, 100.0, 700.0, 900.0));
        assert_eq!(o.look(&look(0.5, vec![third.clone(), second()], false)), Some(30));
        assert_eq!(o.look(&look(0.75, vec![third.clone()], false)), Some(31), "gone: the next one confirmed meanwhile");
        assert_eq!(o.look(&look(1.0, vec![], false)), None);
    }

    #[test]
    fn never_one_that_came_with_an_operation_or_of_another_app_or_kept_behind() {
        let mut o = Others::default();
        // First seen right after an operation: never, though it stays.
        for i in 0..4 {
            assert_eq!(o.look(&look(i as f64 * 0.3, vec![second()], i == 0)), None);
        }
        let mut o = Others::default();
        let other_app = win(40, 77, Rect::new(400.0, -20.0, 900.0, 600.0));
        let mut kept = second();
        kept.kept_behind = true;
        let mut elsewhere = win(32, SHOWN, Rect::new(500.0, -30.0, 800.0, 500.0));
        elsewhere.margin_only = false;
        let strip = win(33, SHOWN, Rect::new(260.0, -40.0, 1252.0, 52.0));
        let sidebar = win(34, SHOWN, Rect::new(200.0, 100.0, 900.0, 560.0));
        let inside = win(35, SHOWN, Rect::new(400.0, 100.0, 600.0, 400.0));
        let tiny = win(36, SHOWN, Rect::new(250.0, -10.0, 60.0, 60.0));
        let mut hidden = second();
        hidden.number = 37;
        hidden.alpha = 0.0;
        let mut panel = second();
        panel.number = 38;
        panel.layer = 3;
        let all = vec![other_app, kept, elsewhere, strip, sidebar, inside, tiny, hidden, panel];
        for i in 0..4 {
            assert_eq!(o.look(&look(i as f64 * 0.3, all.clone(), false)), None, "look {i}");
        }
        // (A sliver over the sidebar is fine: up to 8 pt.)
        let mut o = Others::default();
        let sliver = win(39, SHOWN, Rect::new(255.0, -20.0, 900.0, 600.0));
        o.look(&look(0.0, vec![sliver.clone()], false));
        assert_eq!(o.look(&look(0.3, vec![sliver], false)), Some(39));
    }

    #[test]
    fn its_app_not_shown_any_more_or_margins_space_moving() {
        let mut o = Others::default();
        o.look(&look(0.0, vec![second()], false));
        assert_eq!(o.look(&look(0.3, vec![second()], false)), Some(30));
        let mut away = look(0.6, vec![second()], false);
        away.shown_pid = Some(99);
        assert_eq!(o.look(&away), None, "another app shown: never its windows");
        // A look not at rest: seen again from the start.
        let mut o = Others::default();
        o.look(&look(0.0, vec![second()], false));
        o.unsteady();
        assert_eq!(o.look(&look(0.3, vec![second()], false)), None);
        assert_eq!(o.look(&look(0.6, vec![second()], false)), Some(30));
        o.reset();
        assert_eq!((o.said, o.seen.len(), o.since.len()), (None, 0, 0));
    }

    // Several visible (docs/PEEK-SPLIT.md §1): a card of another app's over the one shown (focused: `shown_pid`); a
    // window the person opened from the app under it (visible, not focused) is let in front too; a card's toolbar strip
    // never is.
    #[test]
    fn every_visible_hosts_app_counts_and_a_cards_own_toolbar_never_comes_in_front() {
        const UNDER: u32 = 60;
        let theirs = win(40, UNDER, Rect::new(400.0, -20.0, 900.0, 600.0));
        let mut o = Others::default();
        let mut l = look(0.0, vec![theirs.clone()], false);
        assert_eq!(o.look(&l), None);
        l.now = 0.3;
        assert_eq!(o.look(&l), None, "only the focused app's, as before: the app under the card's isn't");
        let mut o = Others::default();
        let mut l = look(0.0, vec![theirs.clone()], false);
        l.visible_pids = vec![SHOWN, UNDER];
        o.look(&l);
        l.now = 0.3;
        assert_eq!(o.look(&l), Some(40), "a visible host's app: its window let in front");
        // The card's own full-screen toolbar: as wide as the card's rect, reaching above the page area.
        let card = Rect::new(360.0, 106.0, 1000.0, 800.0);
        let strip = win(41, SHOWN, Rect::new(360.0, -40.0, 1000.0, 120.0));
        let mut o = Others::default();
        let mut l = look(0.0, vec![strip.clone()], false);
        assert_eq!(o.look(&l), None);
        l.now = 0.3;
        assert_eq!(o.look(&l), Some(41), "against the page area alone it was let in front");
        let mut o = Others::default();
        let mut l = look(0.0, vec![strip], false);
        l.rects = vec![card];
        o.look(&l);
        l.now = 0.3;
        assert_eq!(o.look(&l), None, "a card's toolbar strip is its own: never let in front");
    }
}
