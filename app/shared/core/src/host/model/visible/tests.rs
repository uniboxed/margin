//! The layout's decisions (ported from app/platforms/macos/shell/tests/multi-host-tests.swift's pure parts: the
//! Swift ones stay as the engine's integration tests).

use super::*;
use crate::host::model::Field;

const PAGE: Rect = Rect::new(240.0, 41.0, 1264.0, 933.0);
const LEFT: Rect = Rect::new(240.0, 41.0, 628.0, 933.0);
const RIGHT: Rect = Rect::new(876.0, 41.0, 628.0, 933.0);
const CARD: Rect = Rect::new(400.0, 100.0, 800.0, 700.0);

fn model() -> HostModel {
    let mut m = HostModel::new();
    m.set_placement(Placement { page: PAGE, area: Rect::new(0.0, 33.0, 1512.0, 949.0), display: Rect::ZERO });
    m
}

/// A host made and held by the engine as `id` (the Mac's `opened`), shown when `shown`.
fn host(m: &mut HostModel, id: &str, shown: bool) -> Handle {
    let h = m.add(id, id, 1, 1);
    m.list(id, Some(h));
    if shown {
        m.set_int(h, Field::Phase, 1);
    }
    h
}

fn extra(id: &str, role: Role, rect: Rect) -> LayoutExtra {
    LayoutExtra { id: id.into(), role, rect, min: None }
}

fn visible(m: &HostModel) -> Vec<Handle> {
    let mut out = [0; 16];
    let n = m.visible_hosts(&mut out);
    out[..n].to_vec()
}

#[test]
fn one_host_shown_is_the_layout_alone() {
    let mut m = model();
    let a = host(&mut m, "app:a", true);
    m.set_rect(a, Field::Rect, Some(RIGHT));
    m.set_shown(Some("app:a"), 5.0);
    assert_eq!(m.layout_get("app:a"), Some(Visible::MAIN), "alone, main at the page area");
    assert_eq!(m.get(a).unwrap().rect, None, "a pane's rect never kept on it");
    assert_eq!((m.shown_at(), m.get(a).unwrap().visible_at), (5.0, 5.0));
    // The same again: its time kept; still the layout.
    m.set_shown(Some("app:a"), 9.0);
    assert_eq!(m.shown_at(), 5.0);
    // None shown: it out of the layout.
    m.set_shown(None, 10.0);
    assert_eq!(m.layout_len(), 0);
    // While a layout is applied, the layout is the layout's.
    let b = host(&mut m, "app:b", true);
    m.layout_begin("app:a", Some(LEFT), &[extra("app:b", Role::Pane, RIGHT)]);
    m.set_shown(Some("app:b"), 11.0);
    assert_eq!(m.layout_len(), 2);
    assert_eq!(m.get(b).unwrap().rect, Some(RIGHT));
}

#[test]
fn the_visible_order_and_its_ties() {
    let mut m = model();
    for id in ["safari:p#pane2", "safari:p#pane1", "app:z", "app:a"] {
        host(&mut m, id, true);
    }
    let v = |rect, role, z| Some(Visible { rect, role, z });
    m.layout_set("app:z", v(None, Role::Main, 0));
    m.layout_set("app:a", v(Some(LEFT), Role::Pane, 1));
    m.layout_set("safari:p#pane2", v(Some(RIGHT), Role::Pane, 1));
    m.layout_set("safari:p#pane1", v(Some(CARD), Role::Card, 1));
    let ids = |m: &HostModel| visible(m).iter().map(|h| m.get(*h).unwrap().id.clone()).collect::<Vec<_>>();
    // By z, then by id's bytes (as Swift's `<` on ASCII), the one shown last among equals.
    assert_eq!(ids(&m), ["app:z", "app:a", "safari:p#pane1", "safari:p#pane2"]);
    m.set_shown(Some("app:a"), 1.0);
    assert_eq!(ids(&m), ["app:z", "safari:p#pane1", "safari:p#pane2", "app:a"]);
    // A parked one, one not held: not visible (still laid out); one laid out with no host yet: nothing.
    m.set_int(m.listed("safari:p#pane1").unwrap(), Field::Phase, 2);
    m.list("safari:p#pane2", None);
    m.layout_set("app:new", v(None, Role::Card, 9));
    assert_eq!(ids(&m), ["app:z", "app:a"]);
    assert!(m.is_visible("app:z") && !m.is_visible("safari:p#pane1") && !m.is_visible("app:new"));
    assert_eq!((m.rank("app:a"), m.rank("app:z"), m.rank("safari:p#pane1")), (0, 1, 2));
    // Room for fewer: counted, the first written.
    let mut one = [0; 1];
    assert_eq!(m.visible_hosts(&mut one), 2);
    assert_eq!(one[0], m.listed("app:z").unwrap());
}

#[test]
fn main_alone_page_and_before() {
    let mut m = model();
    let a = host(&mut m, "app:a", true);
    let b = host(&mut m, "app:b", true);
    assert!(m.alone("app:a") && m.alone("app:x"), "nothing laid out; one not held");
    m.set_shown(Some("app:a"), 1.0);
    assert!(m.alone("app:b"));
    assert_eq!(m.before("app:b"), Some(a), "the one shown parked as b comes in its place");
    assert_eq!(m.before("app:a"), None);
    m.set_rect(b, Field::Rect, Some(RIGHT));
    assert!(!m.alone("app:b"), "b in another role's rect");
    assert_eq!(m.page_of(b), RIGHT);
    assert_eq!(m.page_of(a), PAGE);
    assert_eq!(m.placement_for(b).page, RIGHT);
    assert_eq!(m.placement_for(b).area, m.placement().area);
    m.layout_set("app:b", Some(Visible { rect: Some(RIGHT), role: Role::Pane, z: 1 }));
    m.set_int(b, Field::Role, 1);
    assert_eq!(m.before("app:b"), None, "both in the layout: b beside a");
    assert!(!m.alone("app:a"), "two laid out");
    assert_eq!(m.main_host(), Some(a));
    m.set_int(a, Field::Role, 1);
    assert_eq!(m.main_host(), Some(a), "none at main's role: the focused one");
    m.set_int(a, Field::Phase, 2);
    assert_eq!(m.main_host(), Some(a), "the focused one, whatever its phase");
}

#[test]
fn a_card_below_its_minimum() {
    let mut m = model();
    let c = host(&mut m, "app:c", true);
    m.set_int(c, Field::Role, 2);
    m.set_rect(c, Field::Rect, Some(CARD));
    assert_eq!(m.below_minimum(c, None), (false, false), "no minimum known");
    m.minimums.remember("app:c", "1", Size::new(900.0, 400.0));
    assert_eq!(m.below_minimum(c, None), (true, true), "its app's kept one, its version wanted");
    m.set_version(c, "2");
    assert_eq!(m.below_minimum(c, None), (false, false), "another version: none");
    m.set_rect(c, Field::MinSize, Some(Rect::new(0.0, 0.0, 801.0, 0.0)));
    assert_eq!(m.below_minimum(c, None), (false, false), "within the tolerance");
    assert_eq!(m.below_minimum(c, Some(Rect::new(0.0, 0.0, 799.9, 700.0))), (true, false));
    m.set_int(c, Field::Role, 1);
    assert_eq!(m.below_minimum(c, Some(Rect::new(0.0, 0.0, 10.0, 10.0))), (false, false), "a pane never: it's cut");
    m.set_int(c, Field::Role, 2);
    m.set_int(c, Field::Mode, 1);
    assert_eq!(m.below_minimum(c, Some(Rect::new(0.0, 0.0, 10.0, 10.0))), (false, false), "window mode: its own");
}

#[test]
fn settled_at_an_operations_end() {
    let mut m = model();
    let a = host(&mut m, "app:a", true);
    let b = host(&mut m, "app:b", true);
    m.layout_set("app:a", Some(Visible::MAIN));
    m.layout_set("app:b", Some(Visible { rect: Some(RIGHT), role: Role::Pane, z: 1 }));
    m.set_focus(Some("app:b"));
    // Nothing shown: the frontmost to show, then the focus asked.
    let g = m.generation();
    assert_eq!(m.settle_begin(), Some(Some(b)));
    assert_eq!(m.generation(), g, "nothing pruned");
    m.set_shown(Some("app:a"), 1.0);
    assert_eq!(m.settle_focus(), Some(b));
    m.set_shown(Some("app:b"), 2.0);
    assert_eq!(m.settle_focus(), None);
    // A parked one out of the layout (never the one shown); with one left, no focus asked.
    m.set_int(a, Field::Phase, 2);
    assert_eq!(m.settle_begin(), Some(None));
    assert_eq!(m.layout_len(), 1);
    assert_ne!(m.generation(), g);
    assert_eq!(m.focus_wanted(), None);
    m.set_int(b, Field::Phase, 2);
    m.settle_begin();
    assert_eq!(m.layout_get("app:b").map(|v| v.z), Some(1), "the one shown kept, parked or not");
    // While a layout's applied: nothing settled.
    let c = host(&mut m, "app:c", true);
    m.set_int(b, Field::Phase, 1);
    m.layout_begin("app:b", None, &[extra("app:c", Role::Card, CARD)]);
    m.set_int(c, Field::Phase, 2);
    assert_eq!(m.settle_begin(), None);
}

#[test]
fn a_layout_shown_beside_main_defers_when_every_one_relaid_is_in_place() {
    let mut m = model();
    let a = host(&mut m, "app:a", true);
    m.set_shown(Some("app:a"), 1.0);
    // A tile: laid out again in place; the newcomer (not made yet) comes in first, main held at its rect.
    m.set_int(a, Field::Tiled, 1);
    let begun = m.layout_begin("app:a", Some(LEFT), &[extra("app:n", Role::Pane, RIGHT)]);
    assert_eq!(
        begun,
        LayoutBegun { before: vec![a], arriving: vec!["app:n".into()], held: vec!["app:a".into()], deferring: true }
    );
    assert!(m.applying());
    assert_eq!(m.get(a).unwrap().rect, None, "held at its rect");
    assert_eq!(m.layout_get("app:a"), Some(Visible::MAIN));
    assert_eq!(m.layout_get("app:n"), Some(Visible { rect: Some(RIGHT), role: Role::Pane, z: 1 }));
    // Made as it's applied: its role and rect from the start.
    let n = host(&mut m, "app:n", false);
    assert_eq!((m.get(n).unwrap().rect, m.get(n).unwrap().role), (Some(RIGHT), Role::Pane));
    m.set_int(n, Field::Phase, 1);
    assert_eq!(m.layout_relay_held(), vec![a]);
    assert_eq!(m.get(a).unwrap().rect, Some(LEFT));
    assert_eq!(m.layout_get("app:a"), Some(Visible { rect: Some(LEFT), role: Role::Main, z: 0 }));
    assert_eq!(m.layout_end_alone(), None);
    assert!(!m.applying());
    assert_eq!(m.layout_focus(None, "app:a"), ShownSet::Keep, "main shown already");
    assert_eq!(m.focus_wanted(), Some("app:a"));
}

#[test]
fn a_plain_member_relaid_first_no_deferring() {
    let mut m = model();
    let a = host(&mut m, "app:a", true);
    m.set_shown(Some("app:a"), 1.0);
    // Not a tile, not a window: placed first (out of full screen and in), the newcomer still last.
    let begun = m.layout_begin("app:a", Some(LEFT), &[extra("app:n", Role::Pane, RIGHT)]);
    assert!(!begun.deferring && begun.held.is_empty());
    assert_eq!(m.get(a).unwrap().rect, Some(LEFT), "its rect now");
    // A tile held below tiles is no tile: not in place.
    m.layout_end_alone();
    m.set_int(a, Field::Tiled, 1);
    m.set_int(a, Field::NoTiles, 1);
    m.set_rect(a, Field::Rect, None);
    m.layout_set("app:n", None);
    assert!(!m.layout_begin("app:a", Some(LEFT), &[extra("app:n", Role::Pane, RIGHT)]).deferring);
    m.layout_end_alone();
    // A window: in place. Nothing arriving: nothing deferred.
    m.set_int(a, Field::Mode, 1);
    m.set_rect(a, Field::Rect, None);
    assert!(m.layout_begin("app:a", Some(LEFT), &[extra("app:n", Role::Pane, RIGHT)]).deferring);
    m.layout_end_alone();
    let n = host(&mut m, "app:n", true);
    m.set_shown(Some("app:a"), 2.0);
    m.layout_set("app:n", Some(Visible { rect: Some(RIGHT), role: Role::Pane, z: 1 }));
    let begun = m.layout_begin("app:a", Some(RIGHT), &[extra("app:n", Role::Pane, LEFT)]);
    assert_eq!(begun.arriving, Vec::<String>::new());
    assert!(!begun.deferring);
    assert_eq!(begun.before, vec![a, n]);
}

#[test]
fn duplicates_and_a_card_below_its_minimum_refused_first() {
    let m = model();
    let x = |id: &str, role, rect, min| LayoutExtra { id: id.into(), role, rect, min };
    let refused = m.layout_refuse(
        "app:a",
        &[
            x("app:a", Role::Pane, RIGHT, None),
            x("app:b", Role::Pane, RIGHT, None),
            x("app:b", Role::Card, CARD, None),
            x("app:c", Role::Card, CARD, Some(Size::new(900.0, 400.0))),
            x("app:d", Role::Pane, RIGHT, Some(Size::new(900.0, 400.0))),
            x("app:c", Role::Card, CARD, Some(Size::new(801.0, 701.0))),
        ],
    );
    assert_eq!(
        refused,
        [(0, Refusal::Twice), (2, Refusal::Twice), (3, Refusal::Below(Size::new(900.0, 400.0)))],
        "main's id, an extra's again; a card below (a pane never); a card refused leaves its id free"
    );
}

#[test]
fn one_left_alone_at_the_page_area_and_the_focus_falls_back() {
    let mut m = model();
    let a = host(&mut m, "app:a", true);
    m.set_shown(Some("app:a"), 1.0);
    m.layout_begin("app:a", Some(LEFT), &[extra("app:n", Role::Pane, RIGHT)]);
    // The newcomer failed: out of the layout; main alone at the page area.
    m.layout_set("app:n", None);
    assert_eq!(m.layout_end_alone(), Some(a));
    let s = m.get(a).unwrap();
    assert_eq!((s.rect, s.role), (None, Role::Main));
    assert_eq!(m.layout_get("app:a"), Some(Visible::MAIN));
    assert_eq!(m.layout_focus(Some("app:n"), "app:a"), ShownSet::Keep, "the focus asked gone: main, shown");
    assert_eq!(m.focus_wanted(), None, "one visible: none asked");
    // Main failed: the frontmost left.
    let b = host(&mut m, "app:b", true);
    let c = host(&mut m, "app:c", true);
    m.layout_begin("app:x", None, &[extra("app:b", Role::Pane, LEFT), extra("app:c", Role::Pane, RIGHT)]);
    m.layout_set("app:x", None);
    assert_eq!(m.layout_end_alone(), None);
    assert_eq!(m.layout_focus(None, "app:x"), ShownSet::Set(Some(c)));
    assert_eq!(m.focus_wanted(), Some("app:c"));
    let _ = b;
    // Nothing left: none shown when the one shown isn't laid out.
    m.set_shown(Some("app:c"), 2.0);
    m.layout_begin("app:y", None, &[]);
    m.layout_set("app:y", None);
    m.layout_end_alone();
    assert_eq!(m.layout_focus(None, "app:y"), ShownSet::Set(None));
}

#[test]
fn the_hold_both_ways() {
    let mut m = model();
    let a = host(&mut m, "app:a", true);
    let b = host(&mut m, "app:b", true);
    m.set_shown(Some("app:a"), 1.0);
    m.layout_begin("app:a", Some(LEFT), &[extra("app:b", Role::Pane, RIGHT)]);
    m.layout_end_alone();
    m.layout_focus(Some("app:b"), "app:a");
    assert_eq!(m.focus_wanted(), Some("app:b"));
    // A placing of b on its own: held; meanwhile the one shown made the layout alone? No: the layout is held.
    assert!(!m.hold("app:x", HoldKind::Layout), "not laid out");
    assert!(m.hold("app:b", HoldKind::Layout));
    assert!(!m.hold("app:b", HoldKind::Layout), "one hold at a time");
    m.set_shown(Some("app:b"), 2.0);
    m.set_rect(b, Field::Rect, None);
    m.set_focus(None);
    assert_eq!(m.release(), ShownSet::Keep, "the focus kept was b, shown");
    assert_eq!(m.get(b).unwrap().rect, Some(RIGHT), "back at its rect as held");
    assert_eq!(m.focus_wanted(), Some("app:b"), "asked again with several");
    // Its window parked meanwhile: out; the focus (a, as shown when held) where it was.
    m.set_focus(None);
    m.set_shown(Some("app:a"), 3.0);
    assert!(m.hold("app:a", HoldKind::Layout));
    m.set_int(b, Field::Phase, 2);
    m.set_shown(None, 4.0);
    assert_eq!(m.release(), ShownSet::Set(Some(a)));
    assert_eq!(m.layout_len(), 1);
    // A page area's change: held whenever several are visible; nothing put back but what's still laid out.
    m.set_int(b, Field::Phase, 1);
    m.layout_set("app:b", Some(Visible { rect: Some(RIGHT), role: Role::Pane, z: 1 }));
    assert!(m.hold("app:a", HoldKind::Page));
    m.layout_set("app:b", None);
    m.set_shown(None, 5.0);
    assert_eq!(m.release(), ShownSet::Set(Some(a)), "nothing shown: the one placed");
    assert_eq!(m.layout_len(), 1, "b left the layout while held: not put back");
    assert!(!m.hold("app:a", HoldKind::Page), "one visible: nothing to hold");
    assert_eq!(m.release(), ShownSet::Keep, "nothing held");
}

#[test]
fn bring_in_at_each_point() {
    let mut m = model();
    let h = host(&mut m, "app:a", false);
    let f = BringInFacts::default();
    assert_eq!(m.bring_in(h, BringInPoint::Start, f), BringIn::Go);
    m.set_int(h, Field::Gone, 1);
    assert_eq!(m.bring_in(h, BringInPoint::Start, f), BringIn::Reopen);
    let new_app = BringInFacts { is_new: true, is_app: true, ..f };
    assert_eq!(m.bring_in(h, BringInPoint::Take, new_app), BringIn::Take);
    assert_eq!(m.bring_in(h, BringInPoint::Take, BringInFacts { taken: true, ..new_app }), BringIn::Go);
    assert_eq!(m.bring_in(h, BringInPoint::Take, BringInFacts { is_app: false, ..new_app }), BringIn::Go);
    // Window mode after a failed full screen: full screen again, once, only shown from parked.
    m.set_int(h, Field::Mode, 1);
    m.set_int(h, Field::RetryFullScreen, 1);
    for no in [
        BringInFacts { is_new: true, ..f },
        BringInFacts { retrying: true, ..f },
        BringInFacts { preparing: true, ..f },
    ] {
        assert_eq!(m.bring_in(h, BringInPoint::Route, no), BringIn::Window);
    }
    assert_eq!(m.bring_in(h, BringInPoint::Route, f), BringIn::FullScreenAgain);
    assert_eq!((m.get(h).unwrap().mode, m.get(h).unwrap().retry_full_screen), (Mode::FullScreen, false));
    assert_eq!(m.bring_in(h, BringInPoint::Route, f), BringIn::Go);
    // A tile: sized first; held below tiles: placed again, its page forgotten.
    m.set_int(h, Field::Member, 1);
    m.set_int(h, Field::Tiled, 1);
    m.set_rect(h, Field::PlacedPage, Some(PAGE));
    assert_eq!(m.bring_in(h, BringInPoint::Route, f), BringIn::SizeFirst);
    assert_eq!(m.bring_in(h, BringInPoint::Placed, f), BringIn::SwitchIn);
    m.set_rect(h, Field::PlacedPage, Some(Rect::new(241.0, 42.0, 1263.0, 932.0)));
    assert_eq!(m.bring_in(h, BringInPoint::Placed, f), BringIn::SwitchIn, "within the tolerance");
    m.set_rect(h, Field::PlacedPage, Some(LEFT));
    assert_eq!(m.bring_in(h, BringInPoint::Placed, f), BringIn::PlacedElsewhere);
    m.set_int(h, Field::NoTiles, 1);
    assert_eq!(m.bring_in(h, BringInPoint::Route, f), BringIn::PlacedAgain);
    assert_eq!(m.get(h).unwrap().placed_page, None);
    assert_eq!(m.bring_in(h, BringInPoint::Placed, f), BringIn::PlacedElsewhere);
    m.set_int(h, Field::Member, 0);
    assert_eq!(m.bring_in(h, BringInPoint::Placed, f), BringIn::PlaceFullScreen);
    // Its own page: a pane's rect.
    m.set_int(h, Field::Member, 1);
    m.set_rect(h, Field::Rect, Some(RIGHT));
    m.set_rect(h, Field::PlacedPage, Some(RIGHT));
    assert_eq!(m.bring_in(h, BringInPoint::Placed, f), BringIn::SwitchIn);
    assert_eq!(m.bring_in(99, BringInPoint::Start, f), BringIn::Go);
}

#[test]
fn a_page_area_change_moves_a_laid_out_rect() {
    let mut m = model();
    let a = host(&mut m, "app:a", true);
    m.layout_move("app:a", LEFT);
    assert_eq!(m.get(a).unwrap().rect, None, "not laid out: nothing");
    m.set_shown(Some("app:a"), 1.0);
    m.layout_move("app:a", LEFT);
    assert_eq!((m.get(a).unwrap().rect, m.layout_get("app:a").unwrap().rect), (Some(LEFT), Some(LEFT)));
    assert_eq!(m.shown_min_width(), None, "at a rect: not the page area's");
    m.set_rect(a, Field::Rect, None);
    m.set_rect(a, Field::MinSize, Some(Rect::new(0.0, 0.0, 641.0, 0.0)));
    assert_eq!(m.shown_min_width(), Some(641.0));
    m.set_int(a, Field::Mode, 1);
    assert_eq!(m.shown_min_width(), None);
    // A host gone from the model: no longer held.
    m.remove(a);
    assert_eq!(m.listed("app:a"), None);
}
