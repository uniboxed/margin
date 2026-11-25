//! A split's room and a drag's line (HostedSession.swift `paneLeast`, `noRoomReason`, `isNoRoom`, `noRoom`,
//! `dragLine`; docs/CORE-REFACTOR.md step 3, parts 3 and 7).

use super::unicode::contains_characters;
use crate::geometry::{Rect, cg};
use crate::host::layout::Size;
use crate::host::model::Role;

/// A pane's least size, Arc's (its split view's `minimumPaneWidth`, 220 pt, also the least height of stacked panes:
/// read from Arc 1.174.0's binary, 2026-11-21). A pane's window may be wider: it's shown cut (docs/PEEK-SPLIT.md §4b).
pub const PANE_LEAST: Size = Size::new(220.0, 220.0);

/// Why a pane didn't come, as `leaveSplit` and the toast say it.
pub const NO_ROOM_REASON: &str = "below a pane's least (220 pt) or past the page area";

/// Whether a failure's words mean no room for it: below a pane's least, below its window's minimum, past the page
/// area, or its page area can't be reached from the display's (the engine's `enterFullScreen`). Found as Swift's
/// `contains` finds them: as whole characters (not where a combining mark joins the last letter).
pub fn is_no_room(why: &str) -> bool {
    ["below a pane's least", "below its window's minimum", "no room for it"].iter().any(|n| contains_characters(why, n))
}

/// One pane of a split laid out, as `no_room` weighs it: its item, its role, its rect (none: not laid out), its
/// window's known minimum.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaneRoom<'a> {
    pub item: &'a str,
    pub role: Role,
    pub rect: Option<Rect>,
    pub least: Option<Size>,
}

/// The panes that must leave a split laid out at these rects (`None`: every pane fits): one whose rect isn't within
/// the page area (1 pt either way) or is under its window's known minimum (1 pt slack) makes it not fit. Then the
/// panes coming in (not in `had`, main never), else the ones that don't fit (main never), else the last pane: the
/// split as it was before stays. Cards aren't panes (their own rect). Main is the first pane given; rects measured as
/// CoreGraphics does (standardized).
pub fn no_room(panes: &[PaneRoom<'_>], page: Rect, had: &[&str]) -> Option<Vec<String>> {
    let page = cg::standard(&page);
    let fits = |r: &Rect, m: Option<Size>| {
        let r = cg::standard(r);
        let inside = r.min_x() >= page.min_x() - 1.0
            && r.max_x() <= page.max_x() + 1.0
            && r.min_y() >= page.min_y() - 1.0
            && r.max_y() <= page.max_y() + 1.0;
        inside && m.is_none_or(|m| r.width + 1.0 >= m.width && r.height + 1.0 >= m.height)
    };
    // (Each pane with its place in the whole list: main is the first, whatever comes after it.)
    let laid = || panes.iter().enumerate().filter(|(_, p)| p.role != Role::Card);
    let cramped = || laid().filter(|(_, p)| p.rect.is_some_and(|r| !fits(&r, p.least)));
    cramped().next()?;
    let others = || laid().filter(|(i, _)| *i > 0);
    let incoming: Vec<String> =
        others().filter(|(_, p)| !had.contains(&p.item)).map(|(_, p)| p.item.to_owned()).collect();
    if !incoming.is_empty() {
        return Some(incoming);
    }
    let cut: Vec<String> = cramped().filter(|(i, _)| *i > 0).map(|(_, p)| p.item.to_owned()).collect();
    if !cut.is_empty() {
        return Some(cut);
    }
    others().next_back().map(|(_, p)| vec![p.item.to_owned()])
}

/// A drag's line in the log: what's dragged (a split's divider, the sidebar's edge) and how many hosted windows follow
/// it live (`follow` of `visible`), the others (plain members) placed again when it's let go.
pub fn drag_line(divider: bool, window: i64, following: bool, follow: i64, visible: i64) -> String {
    let what = if divider { "a split's divider" } else { "the sidebar's edge" };
    let windows = |n: i64| format!("{n} hosted window{}", if n == 1 { "" } else { "s" });
    let how = if !following || follow == 0 {
        format!("the page area's changes held until it's let go ({} placed again then)", windows(visible))
    } else if follow >= visible {
        if visible == 1 {
            "the hosted window follows it live".to_owned()
        } else {
            format!("{} follow it live", windows(visible))
        }
    } else {
        format!(
            "{follow} of {} follow it live, the other{} placed again when it's let go",
            windows(visible),
            if visible - follow == 1 { "" } else { "s" }
        )
    };
    format!("{what} dragged in Margin's window {window}: {how}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(item: &str, role: Role, rect: Option<Rect>) -> PaneRoom<'_> {
        PaneRoom { item, role, rect, least: Some(PANE_LEAST) }
    }
    const PAGE: Rect = Rect::new(240.0, 41.0, 1264.0, 933.0);
    fn r(x: f64, y: f64, w: f64, h: f64) -> Option<Rect> {
        Some(Rect::new(x, y, w, h))
    }

    // ---- T/split-real-use-tests.swift splitRoomTests, and T/session-rules-tests.swift's edges ----

    #[test]
    fn a_split_with_room_keeps_every_pane() {
        let notes = no_room(
            &[pane("s", Role::Main, r(240.0, 41.0, 628.0, 933.0)), pane("n", Role::Pane, r(876.0, 41.0, 628.0, 933.0))],
            PAGE,
            &[],
        );
        assert_eq!(notes, None);
    }

    #[test]
    fn past_the_page_area_or_under_the_least() {
        let past = no_room(
            &[pane("s", Role::Main, r(949.0, 41.0, 574.0, 933.0)), pane("n", Role::Pane, r(240.0, 41.0, 701.0, 933.0))],
            PAGE,
            &[],
        );
        assert_eq!(past, Some(vec!["n".to_owned()]), "the newcomer goes, main never");
        let thin = no_room(
            &[
                pane("a", Role::Main, r(240.0, 41.0, 836.0, 933.0)),
                pane("b", Role::Pane, r(1084.0, 41.0, 200.0, 933.0)),
                pane("c", Role::Pane, r(1292.0, 41.0, 212.0, 933.0)),
            ],
            PAGE,
            &["a", "b"],
        );
        assert_eq!(thin, Some(vec!["c".to_owned()]), "the newcomer first, though another is cramped");
        let four: Vec<PaneRoom<'_>> = ["p0", "p1", "p2", "p3"]
            .iter()
            .enumerate()
            .map(|(i, id)| {
                pane(id, if i == 0 { Role::Main } else { Role::Pane }, r(240.0 + i as f64 * 316.0, 41.0, 308.0, 933.0))
            })
            .collect();
        assert_eq!(no_room(&four, PAGE, &["p0", "p1", "p2"]), None, "four of 308 in 1264: room");
        let edge = no_room(
            &[pane("s", Role::Main, r(239.5, 41.0, 628.0, 933.0)), pane("n", Role::Pane, r(876.0, 41.0, 219.4, 933.0))],
            PAGE,
            &[],
        );
        assert_eq!(edge, None, "within a point either way (rounding): fits");
    }

    #[test]
    fn the_slack_at_its_edges() {
        let full = r(240.0, 41.0, 628.0, 933.0);
        let at = |rect| no_room(&[pane("m", Role::Main, full), pane("p", Role::Pane, rect)], PAGE, &[]);
        assert_eq!(
            no_room(
                &[
                    pane("m", Role::Main, r(239.0, 40.0, 629.0, 935.0)),
                    pane("p", Role::Pane, r(876.0, 41.0, 629.0, 934.0))
                ],
                PAGE,
                &[]
            ),
            None
        );
        assert_eq!(at(r(876.0, 41.0, 629.001, 933.0)), Some(vec!["p".to_owned()]));
        assert_eq!(at(r(876.0, 39.99, 300.0, 933.0)), Some(vec!["p".to_owned()]));
        assert_eq!(at(r(876.0, 41.0, 219.0, 933.0)), None, "1 pt under the least still fits");
        assert_eq!(at(r(876.0, 41.0, 218.99, 933.0)), Some(vec!["p".to_owned()]));
        assert_eq!(at(r(876.0, 41.0, 628.0, 218.99)), Some(vec!["p".to_owned()]));
        assert_eq!(at(r(1100.0, 41.0, -200.0, 933.0)), Some(vec!["p".to_owned()]), "standardized: 200 wide");
        assert_eq!(
            no_room(
                &[
                    PaneRoom { least: None, ..pane("m", Role::Main, full) },
                    PaneRoom { least: None, ..pane("p", Role::Pane, r(876.0, 41.0, 10.0, 10.0)) }
                ],
                PAGE,
                &[]
            ),
            None
        );
        assert_eq!(no_room(&[pane("m", Role::Main, None), pane("p", Role::Pane, None)], PAGE, &[]), None);
        assert_eq!(
            no_room(&[pane("m", Role::Main, r(0.0, 0.0, 10.0, 10.0))], PAGE, &[]),
            None,
            "main alone: nothing to take out"
        );
        assert_eq!(
            no_room(&[pane("m", Role::Main, full), pane("p", Role::Pane, full)], Rect::ZERO, &[]),
            Some(vec!["p".to_owned()])
        );
    }

    #[test]
    fn which_leave_when_every_pane_was_had() {
        let main_cramped = no_room(
            &[
                pane("m", Role::Main, r(240.0, 41.0, 100.0, 933.0)),
                pane("p", Role::Pane, r(876.0, 41.0, 300.0, 933.0)),
                pane("q", Role::Pane, r(1180.0, 41.0, 300.0, 933.0)),
            ],
            PAGE,
            &["m", "p", "q"],
        );
        assert_eq!(main_cramped, Some(vec!["q".to_owned()]), "the last pane");
        let one = no_room(
            &[
                pane("m", Role::Main, r(240.0, 41.0, 628.0, 933.0)),
                pane("p", Role::Pane, r(876.0, 41.0, 100.0, 933.0)),
                pane("q", Role::Pane, r(1180.0, 41.0, 300.0, 933.0)),
            ],
            PAGE,
            &["m", "p", "q"],
        );
        assert_eq!(one, Some(vec!["p".to_owned()]), "the cramped ones");
        let new = no_room(
            &[
                pane("m", Role::Main, r(240.0, 41.0, 628.0, 933.0)),
                pane("p", Role::Pane, r(876.0, 41.0, 300.0, 933.0)),
                pane("q", Role::Pane, r(1180.0, 41.0, 100.0, 933.0)),
            ],
            PAGE,
            &["m"],
        );
        assert_eq!(new, Some(vec!["p".to_owned(), "q".to_owned()]), "every newcomer");
    }

    #[test]
    fn a_card_is_never_a_pane() {
        let full = r(240.0, 41.0, 628.0, 933.0);
        assert_eq!(
            no_room(&[pane("m", Role::Main, full), pane("k", Role::Card, r(-5000.0, 0.0, 1.0, 1.0))], PAGE, &[]),
            None
        );
        assert_eq!(
            no_room(&[pane("m", Role::Main, r(0.0, 0.0, 10.0, 10.0)), pane("k", Role::Card, full)], PAGE, &[]),
            None
        );
        // (A card first: its place still counts, so the pane after it isn't main.)
        assert_eq!(
            no_room(&[pane("k", Role::Card, full), pane("p", Role::Pane, r(0.0, 0.0, 10.0, 10.0))], PAGE, &["p"]),
            Some(vec!["p".to_owned()])
        );
    }

    #[test]
    fn the_reasons_that_mean_no_room() {
        assert!(is_no_room(NO_ROOM_REASON));
        assert!(is_no_room("its card rect 1,2 3×4 is below its window's minimum 5×6"));
        assert!(is_no_room("no room for it: its page area can't be reached from the display's (page …)"));
        assert!(!is_no_room("main wasn't shown"));
        assert!(
            !is_no_room("no room for it\u{301}"),
            "a mark on its last letter: not the phrase, as Swift's characters"
        );
        assert!(is_no_room("no room for it\u{301} or no room for it"));
    }

    // ---- T/screen-engine-tests.swift, T/split-real-use-tests.swift: the drag's line ----

    #[test]
    fn a_drags_line() {
        assert_eq!(
            drag_line(false, 1, true, 1, 1),
            "the sidebar's edge dragged in Margin's window 1: the hosted window follows it live"
        );
        assert_eq!(
            drag_line(true, 2, true, 3, 3),
            "a split's divider dragged in Margin's window 2: 3 hosted windows follow it live"
        );
        assert_eq!(
            drag_line(true, 1, true, 1, 3),
            "a split's divider dragged in Margin's window 1: 1 of 3 hosted windows follow it live, the others placed again when it's let go"
        );
        assert_eq!(
            drag_line(true, 1, true, 2, 3),
            "a split's divider dragged in Margin's window 1: 2 of 3 hosted windows follow it live, the other placed again when it's let go"
        );
        assert_eq!(
            drag_line(false, 1, false, 0, 1),
            "the sidebar's edge dragged in Margin's window 1: the page area's changes held until it's let go (1 hosted window placed again then)"
        );
        assert_eq!(
            drag_line(false, 1, true, 0, 2),
            "the sidebar's edge dragged in Margin's window 1: the page area's changes held until it's let go (2 hosted windows placed again then)"
        );
        assert_eq!(
            drag_line(true, 1, true, 2, 2),
            "a split's divider dragged in Margin's window 1: 2 hosted windows follow it live"
        );
        assert_eq!(
            drag_line(false, 3, true, 0, 0),
            "the sidebar's edge dragged in Margin's window 3: the page area's changes held until it's let go (0 hosted windows placed again then)"
        );
        assert_eq!(
            drag_line(false, 3, true, 1, 0),
            "the sidebar's edge dragged in Margin's window 3: 0 hosted windows follow it live"
        );
    }
}
